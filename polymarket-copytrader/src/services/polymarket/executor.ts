import { Side, OrderType } from "@polymarket/clob-client";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { formatUsd, retryWithBackoff } from "../../utils/helpers";
import { getClobClient, getOrderBook } from "./client";
import type { ParsedTrade } from "./parser";

/**
 * Result of a trade execution attempt
 */
export interface ExecutionResult {
  success: boolean;
  orderId: string | null;
  executedAmountUsdc: number;
  executedPrice: number;
  errorMessage: string | null;
}

/**
 * Executes a copy trade on Polymarket via the CLOB API.
 *
 * Uses limit orders at the target's price (with slippage protection)
 * rather than market orders to avoid being frontrun or getting
 * unfavorable fills.
 */
export async function executeTrade(
  trade: ParsedTrade,
  scaledAmountUsdc: number
): Promise<ExecutionResult> {
  try {
    const client = await getClobClient();
    const side = trade.tradeType === "BUY" ? Side.BUY : Side.SELL;

    // Fetch order book to validate price and get tick size / negRisk
    const orderBook = await getOrderBook(trade.tokenId);
    const tickSize = orderBook.tick_size || "0.01";
    const negRisk = orderBook.neg_risk || trade.isNegRisk;

    // Calculate price with slippage protection
    // For BUY: we accept paying slightly more than the target
    // For SELL: we accept receiving slightly less than the target
    const slippageFactor = config.slippageTolerance / 100;
    let targetPrice = trade.price;

    if (side === Side.BUY) {
      targetPrice = trade.price * (1 + slippageFactor);
      // Cap at 0.99 for safety (never buy at >= 1.0)
      targetPrice = Math.min(targetPrice, 0.99);
    } else {
      targetPrice = trade.price * (1 - slippageFactor);
      // Floor at 0.01 for safety (never sell at <= 0)
      targetPrice = Math.max(targetPrice, 0.01);
    }

    // Validate price against current order book to avoid scams
    const validatedPrice = validatePriceAgainstOrderBook(
      targetPrice,
      side,
      orderBook
    );
    if (validatedPrice === null) {
      return {
        success: false,
        orderId: null,
        executedAmountUsdc: 0,
        executedPrice: 0,
        errorMessage: `Price validation failed: target price ${targetPrice.toFixed(4)} deviates too much from order book`,
      };
    }

    // Round price to tick size
    const roundedPrice = roundToTickSize(validatedPrice, tickSize);

    // Calculate number of shares from USDC amount
    const shares = scaledAmountUsdc / roundedPrice;

    logger.copy(
      `Executing ${side} ${shares.toFixed(2)} shares @ ${roundedPrice.toFixed(4)} (${formatUsd(scaledAmountUsdc)})`
    );

    // Execute with retries
    const result = await retryWithBackoff(async () => {
      if (side === Side.BUY) {
        // For buys, use market order with USDC amount to ensure we spend exactly what we want
        return await client.createAndPostMarketOrder(
          {
            tokenID: trade.tokenId,
            amount: scaledAmountUsdc,
            price: roundedPrice,
            side: Side.BUY,
          },
          {
            tickSize: tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
            negRisk: negRisk,
          },
          OrderType.FOK
        );
      } else {
        // For sells, create a limit order with the shares amount
        return await client.createAndPostOrder(
          {
            tokenID: trade.tokenId,
            price: roundedPrice,
            size: Math.floor(shares * 100) / 100, // Round down shares
            side: Side.SELL,
          },
          {
            tickSize: tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
            negRisk: negRisk,
          },
          OrderType.GTC
        );
      }
    }, config.maxRetries);

    if (result.success) {
      logger.success(
        `Order placed: ${result.orderID} | ${side} @ ${roundedPrice.toFixed(4)}`
      );
      return {
        success: true,
        orderId: result.orderID,
        executedAmountUsdc: scaledAmountUsdc,
        executedPrice: roundedPrice,
        errorMessage: null,
      };
    }

    return {
      success: false,
      orderId: null,
      executedAmountUsdc: 0,
      executedPrice: 0,
      errorMessage: result.errorMsg || "Order placement failed",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Trade execution failed: ${message}`);
    return {
      success: false,
      orderId: null,
      executedAmountUsdc: 0,
      executedPrice: 0,
      errorMessage: message,
    };
  }
}

/**
 * Validates the target price against the current order book.
 * Prevents executing trades at manipulated or stale prices.
 *
 * Returns the validated price, or null if the price is suspicious.
 */
function validatePriceAgainstOrderBook(
  targetPrice: number,
  side: Side,
  orderBook: { bids: Array<{ price: string }>; asks: Array<{ price: string }> }
): number | null {
  // Maximum allowed deviation from best bid/ask (10%)
  const MAX_DEVIATION = 0.10;

  if (side === Side.BUY) {
    // For buying, check against the current best ask
    if (orderBook.asks.length > 0) {
      const bestAsk = parseFloat(orderBook.asks[0]!.price);
      if (bestAsk > 0) {
        const deviation = Math.abs(targetPrice - bestAsk) / bestAsk;
        if (deviation > MAX_DEVIATION) {
          logger.warn(
            `BUY price ${targetPrice.toFixed(4)} deviates ${(deviation * 100).toFixed(1)}% from best ask ${bestAsk.toFixed(4)}`
          );
          return null;
        }
        // Use the lower of our target and the best ask (don't overpay)
        return Math.min(targetPrice, bestAsk * (1 + MAX_DEVIATION / 2));
      }
    }
  } else {
    // For selling, check against the current best bid
    if (orderBook.bids.length > 0) {
      const bestBid = parseFloat(orderBook.bids[0]!.price);
      if (bestBid > 0) {
        const deviation = Math.abs(targetPrice - bestBid) / bestBid;
        if (deviation > MAX_DEVIATION) {
          logger.warn(
            `SELL price ${targetPrice.toFixed(4)} deviates ${(deviation * 100).toFixed(1)}% from best bid ${bestBid.toFixed(4)}`
          );
          return null;
        }
        // Use the higher of our target and the best bid (don't undersell)
        return Math.max(targetPrice, bestBid * (1 - MAX_DEVIATION / 2));
      }
    }
  }

  // If no order book data, proceed with target price but log a warning
  logger.warn("No order book data available for price validation");
  return targetPrice;
}

/**
 * Rounds a price to the nearest valid tick size
 */
function roundToTickSize(price: number, tickSize: string): number {
  const tick = parseFloat(tickSize);
  if (tick <= 0) return price;
  return Math.round(price / tick) * tick;
}
