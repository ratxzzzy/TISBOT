import { Side, OrderType } from "@polymarket/clob-client";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { formatUsd, retryWithBackoff } from "../../utils/helpers";
import { getClobClient, getOrderBook, getMarketInfo } from "./client";
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
  /** Non-null when the trade was skipped before hitting the CLOB */
  skippedReason?: string;
}

/**
 * Executes a copy trade on Polymarket via the CLOB API.
 *
 * Uses the target's exact price (with slippage) as a FOK limit order.
 * FOK (Fill-or-Kill) ensures the order either fills immediately and completely,
 * or is cancelled — no dangling open orders on the book.
 *
 * We do NOT validate against the order book because these fast-moving
 * markets often show stale best-ask/bid prices that differ wildly
 * from the price the target actually traded at.
 */
export async function executeTrade(
  trade: ParsedTrade,
  scaledAmountUsdc: number,
): Promise<ExecutionResult> {
  try {
    const client = await getClobClient();
    const side = trade.tradeType === "BUY" ? Side.BUY : Side.SELL;

    // Fetch order book for negRisk metadata and fallback tick size
    const orderBook = await getOrderBook(trade.tokenId);
    const negRisk = orderBook.neg_risk || trade.isNegRisk;

    // Use market's minimum_tick_size (authoritative) instead of order book tick_size.
    // The order book sometimes returns a smaller tick_size than the market allows.
    let tickSize = orderBook.tick_size || "0.01";
    const conditionId = orderBook.market;
    if (conditionId) {
      const marketInfo = await getMarketInfo(conditionId);
      if (marketInfo?.minimum_tick_size) {
        tickSize = marketInfo.minimum_tick_size;
      }
    }

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

    // Calculate number of shares (may be recalculated if amount is bumped)
    let scaledShares =
      side === Side.SELL
        ? scaledAmountUsdc / trade.price
        : scaledAmountUsdc / roundedPrice;

    // SELL: skip orders below 1 share
    if (side === Side.SELL && scaledShares < 1) {
      logger.warn(`SELL skipped: only ${scaledShares.toFixed(2)} shares (min 1)`);
      return {
        success: false,
        orderId: null,
        executedAmountUsdc: 0,
        executedPrice: 0,
        errorMessage: `Only ${scaledShares.toFixed(2)} shares, minimum is 1`,
      };
    }

    const roundedShares = Math.floor(scaledShares * 100) / 100;

    logger.copy(
      `Placing ${side} ${roundedShares.toFixed(2)} shares @ ${roundedPrice.toFixed(4)} (${formatUsd(scaledAmountUsdc)}) [target: ${trade.price.toFixed(4)}]`
    );

    // Polymarket enforces a $1 minimum for marketable (FOK) BUY orders.
    // Bump BUY amounts below $1 up to $1.
    if (side === Side.BUY && scaledAmountUsdc < 1) {
      logger.info(`BUY ${formatUsd(scaledAmountUsdc)} below $1 minimum, bumping to $1.00`);
      scaledAmountUsdc = 1;
      scaledShares = scaledAmountUsdc / roundedPrice;
    }

    const amount =
      side === Side.BUY
        ? Math.floor(scaledAmountUsdc * 100) / 100
        : roundedShares;

    let result: any;

    result = await retryWithBackoff(async () => {
      return await client.createAndPostMarketOrder(
        {
          tokenID: trade.tokenId,
          price: roundedPrice,
          amount,
          side,
          orderType: OrderType.FOK,
        },
        {
          tickSize: tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
          negRisk: negRisk,
        },
        OrderType.FOK
      );
    }, config.maxRetries);

    if (result.success) {
      logger.success(
        `Order filled: ${result.orderID} | ${side} @ ${roundedPrice.toFixed(4)}`
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
      errorMessage: result.errorMsg || "Order placement failed (FOK not filled)",
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
