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
 * Uses the target's exact price (with slippage) as a GTC limit order.
 * GTC (Good-Til-Cancelled) lets the order sit on the book until filled,
 * which works well for these active 15-minute binary markets.
 *
 * We do NOT validate against the order book because these fast-moving
 * markets often show stale best-ask/bid prices that differ wildly
 * from the price the target actually traded at.
 */
export async function executeTrade(
  trade: ParsedTrade,
  scaledAmountUsdc: number
): Promise<ExecutionResult> {
  try {
    const client = await getClobClient();
    const side = trade.tradeType === "BUY" ? Side.BUY : Side.SELL;

    // Fetch order book only for tick size and negRisk metadata
    const orderBook = await getOrderBook(trade.tokenId);
    const tickSize = orderBook.tick_size || "0.01";
    const negRisk = orderBook.neg_risk || trade.isNegRisk;

    // Use the target's price with slippage
    const slippageFactor = config.slippageTolerance / 100;
    let price: number;

    if (side === Side.BUY) {
      // Accept paying slightly more than the target
      price = trade.price * (1 + slippageFactor);
      price = Math.min(price, 0.99); // Never buy at >= 1.0
    } else {
      // Accept receiving slightly less than the target
      price = trade.price * (1 - slippageFactor);
      price = Math.max(price, 0.01); // Never sell at <= 0
    }

    // Round price to tick size
    const roundedPrice = roundToTickSize(price, tickSize);

    // Calculate number of shares
    // For SELLs, use scaledAmountUsdc / trade.price to get our actual shares
    // (scaledAmountUsdc already = sharesWeHold * trade.price for SELLs)
    // For BUYs, derive from the rounded price
    let shares =
      side === Side.SELL
        ? scaledAmountUsdc / trade.price
        : scaledAmountUsdc / roundedPrice;

    // Polymarket CLOB requires minimum 5 shares per order
    const MIN_SHARES = 5;
    if (shares < MIN_SHARES) {
      if (side === Side.BUY) {
        // Bump up to minimum shares and adjust USDC accordingly
        shares = MIN_SHARES;
        scaledAmountUsdc = shares * roundedPrice;
        logger.debug(`Bumped to ${MIN_SHARES} shares minimum (${formatUsd(scaledAmountUsdc)})`);
      } else {
        // For SELLs we can't sell more than we have
        logger.warn(`SELL skipped: only ${shares.toFixed(2)} shares (min ${MIN_SHARES})`);
        return {
          success: false,
          orderId: null,
          executedAmountUsdc: 0,
          executedPrice: 0,
          errorMessage: `Only ${shares.toFixed(2)} shares, minimum is ${MIN_SHARES}`,
        };
      }
    }

    logger.copy(
      `Placing ${side} ${shares.toFixed(2)} shares @ ${roundedPrice.toFixed(4)} (${formatUsd(scaledAmountUsdc)}) [target: ${trade.price.toFixed(4)}]`
    );

    // Execute with retries - use GTC limit orders so they sit on the book
    // until filled (better fill rate than FOK for fast-moving markets)
    const result = await retryWithBackoff(async () => {
      return await client.createAndPostOrder(
        {
          tokenID: trade.tokenId,
          price: roundedPrice,
          size: Math.floor(shares * 100) / 100, // Round down shares
          side,
        },
        {
          tickSize: tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
          negRisk: negRisk,
        },
        OrderType.GTC
      );
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
 * Rounds a price to the nearest valid tick size
 */
function roundToTickSize(price: number, tickSize: string): number {
  const tick = parseFloat(tickSize);
  if (tick <= 0) return price;
  return Math.round(price / tick) * tick;
}
