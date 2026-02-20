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
 * Strategy — Opción C (FOK → GTC fallback):
 *   1. Intenta FOK (Fill-or-Kill): se llena al instante o se cancela.
 *   2. Si FOK falla (sin liquidez inmediata), coloca una orden GTC (Good-Till-Cancel)
 *      con precio límite y programa su auto-cancelación tras `config.gtcTtlMs` ms.
 *
 * BUY amounts < $1 se elevan automáticamente a $1 (mínimo Polymarket).
 * SELL orders < 1 share se descartan (no tenemos suficientes acciones).
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

    // Calculate number of shares
    let scaledShares =
      side === Side.SELL
        ? scaledAmountUsdc / trade.price
        : scaledAmountUsdc / roundedPrice;

    // SELL: skip orders below 1 share — we don't have enough tokens
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

    // Polymarket enforces a $1 minimum for BUY orders — bump up if needed.
    // This is reached now that minPositionSizeUsdc defaults to 0.
    if (side === Side.BUY && scaledAmountUsdc < 1) {
      logger.info(`BUY ${formatUsd(scaledAmountUsdc)} below $1 minimum, bumping to $1.00`);
      scaledAmountUsdc = 1;
      scaledShares = scaledAmountUsdc / roundedPrice;
    }

    logger.copy(
      `Placing ${side} ${roundedShares.toFixed(2)} shares @ ${roundedPrice.toFixed(4)} (${formatUsd(scaledAmountUsdc)}) [target: ${trade.price.toFixed(4)}]`
    );

    // FOK uses USDC for BUY, shares for SELL
    const fokAmount =
      side === Side.BUY
        ? Math.floor(scaledAmountUsdc * 100) / 100
        : roundedShares;

    // ── Step 1: Try FOK ──────────────────────────────────────────────────────
    let fokResult: any;
    try {
      fokResult = await retryWithBackoff(async () => {
        return await client.createAndPostMarketOrder(
          {
            tokenID: trade.tokenId,
            price: roundedPrice,
            amount: fokAmount,
            side,
            orderType: OrderType.FOK,
          },
          {
            tickSize: tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
            negRisk,
          },
          OrderType.FOK
        );
      }, config.maxRetries);
    } catch (fokErr) {
      fokResult = {
        success: false,
        errorMsg: fokErr instanceof Error ? fokErr.message : String(fokErr),
      };
    }

    if (fokResult.success) {
      logger.success(
        `[FOK] Filled: ${fokResult.orderID} | ${side} @ ${roundedPrice.toFixed(4)}`
      );
      return {
        success: true,
        orderId: fokResult.orderID,
        executedAmountUsdc: scaledAmountUsdc,
        executedPrice: roundedPrice,
        errorMessage: null,
      };
    }

    // ── Step 2: FOK failed — fallback to GTC with auto-cancel ────────────────
    const ttlSec = config.gtcTtlMs / 1000;
    logger.info(
      `[FOK] Not filled (${fokResult.errorMsg ?? "no liquidity"}). Fallback → GTC con TTL ${ttlSec}s`
    );

    // For GTC limit orders, `size` is always in shares (conditional tokens),
    // not in USDC. Recalculate from the (possibly bumped) scaledAmountUsdc.
    const gtcSize =
      side === Side.BUY
        ? Math.floor((scaledAmountUsdc / roundedPrice) * 100) / 100
        : roundedShares;

    let gtcResult: any;
    try {
      const gtcOrder = await client.createOrder(
        {
          tokenID: trade.tokenId,
          price: roundedPrice,
          size: gtcSize,
          side,
          feeRateBps: 0,
        },
        {
          tickSize: tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
          negRisk,
        }
      );

      gtcResult = await client.postOrder(gtcOrder, OrderType.GTC);
    } catch (gtcErr) {
      const gtcMsg = gtcErr instanceof Error ? gtcErr.message : String(gtcErr);
      logger.error(`[GTC] Placement error: ${gtcMsg}`);
      return {
        success: false,
        orderId: null,
        executedAmountUsdc: 0,
        executedPrice: 0,
        errorMessage: `FOK not filled, GTC failed: ${gtcMsg}`,
      };
    }

    if (gtcResult.success && gtcResult.orderID) {
      const orderId: string = gtcResult.orderID;
      logger.info(`[GTC] Order placed: ${orderId} — auto-cancel en ${ttlSec}s`);

      // Schedule auto-cancellation after TTL.
      // If already filled, cancelOrder will return a benign error — ignored.
      setTimeout(async () => {
        try {
          await client.cancelOrder({ orderID: orderId });
          logger.info(`[GTC] Order ${orderId} cancelled after TTL (${ttlSec}s)`);
        } catch (cancelErr) {
          logger.debug(
            `[GTC] Cancel ${orderId}: ${cancelErr instanceof Error ? cancelErr.message : cancelErr}`
          );
        }
      }, config.gtcTtlMs);

      return {
        success: true,
        orderId,
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
      errorMessage: gtcResult.errorMsg || "GTC order placement failed",
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
