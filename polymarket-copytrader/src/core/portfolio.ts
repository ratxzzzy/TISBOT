import { config } from "../config";
import { logger } from "../utils/logger";
import { formatUsd, formatPercent } from "../utils/helpers";
import { getUsdcBalance } from "../services/wallet/signer";

/**
 * Manages proportional position sizing for copytrading.
 *
 * Sizing is 100% proportional to the copied trader:
 *   RATIO = MAX_OUR_POSITION_USDC / TRADER_MAX_POSITION_USDC
 *   ourSize = traderSize * RATIO
 *
 * Example with MAX_OUR=10, TRADER_MAX=200 → RATIO=0.05:
 *   Trader $200 → We $10.00 (our max)
 *   Trader $100 → We $5.00
 *   Trader $50  → We $2.50
 *   Trader $20  → We $1.00
 *   Trader $10  → We $0.50
 *
 * Safety: if trader exceeds TRADER_MAX_POSITION, we cap at MAX_OUR_POSITION
 * and log an alert.
 */
export class PortfolioManager {
  /** Cached Safe USDC balance */
  private cachedBalance: number = 0;

  /** Dynamic copy ratio = MAX_OUR_POSITION / TRADER_MAX_POSITION */
  private _ratio: number;

  constructor() {
    this._ratio = config.maxOurPositionUsdc / config.traderMaxPositionUsdc;
  }

  get ratio(): number {
    return this._ratio;
  }

  get availableBudget(): number {
    return this.cachedBalance;
  }

  /**
   * Refreshes the cached Safe USDC balance from chain.
   */
  async refreshBalance(): Promise<void> {
    try {
      this.cachedBalance = await getUsdcBalance();
      logger.budget(`Safe USDC disponible: ${formatUsd(this.cachedBalance)}`);
      logger.budget(
        `Ratio proporcional: ${formatPercent(this._ratio)} (MAX_OUR=${formatUsd(config.maxOurPositionUsdc)} / TRADER_MAX=${formatUsd(config.traderMaxPositionUsdc)})`
      );
    } catch (err) {
      logger.error(
        "Failed to refresh balance",
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Calculates the proportional copy trade size.
   *
   * Logic:
   *   1. ourSize = traderSize * RATIO (exact proportional)
   *   2. If trader exceeds TRADER_MAX_POSITION → cap at MAX_OUR_POSITION + alert
   *   3. If ourSize < MIN_POSITION_SIZE → skip (return 0)
   */
  calculateTradeSize(traderSizeUsdc: number): number {
    let ourSize: number;

    if (traderSizeUsdc > config.traderMaxPositionUsdc) {
      // Trader exceeded their known max — cap at our absolute maximum
      ourSize = config.maxOurPositionUsdc;
      logger.warn(
        `ALERTA: Trader superó su máximo! Trade=${formatUsd(traderSizeUsdc)} > TRADER_MAX=${formatUsd(config.traderMaxPositionUsdc)}. ` +
        `Capeando a nuestro máximo: ${formatUsd(ourSize)}. Considera actualizar TRADER_MAX_POSITION_USDC.`
      );
    } else {
      // Exact proportional sizing
      ourSize = traderSizeUsdc * this._ratio;
    }

    // Round to 2 decimals (USDC cents)
    ourSize = Math.round(ourSize * 100) / 100;

    // Skip trivially small trades
    if (ourSize < config.minPositionSizeUsdc) {
      logger.debug(
        `Trade proporcional ${formatUsd(ourSize)} por debajo del mínimo ${formatUsd(config.minPositionSizeUsdc)}, skipping`
      );
      return 0;
    }

    logger.debug(
      `Sizing: trader=${formatUsd(traderSizeUsdc)} × ratio=${this._ratio.toFixed(4)} → nuestro=${formatUsd(ourSize)}`
    );

    return ourSize;
  }

  /**
   * Checks if we have enough USDC to execute a trade of the given size.
   */
  canExecuteTrade(sizeUsdc: number): boolean {
    if (sizeUsdc <= 0) return false;
    return this.cachedBalance >= sizeUsdc;
  }

  /**
   * Refreshes the cached balance from the chain after a trade.
   */
  async updateBudget(_amountUsdc: number, _isBuy: boolean): Promise<void> {
    try {
      this.cachedBalance = await getUsdcBalance();
      logger.budget(
        `Safe USDC disponible: ${formatUsd(this.cachedBalance)}`
      );
    } catch (err) {
      logger.error(
        "Failed to refresh balance after trade",
        err instanceof Error ? err.message : err
      );
    }
  }
}
