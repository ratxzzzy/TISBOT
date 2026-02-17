import { config } from "../config";
import { logger } from "../utils/logger";
import { formatUsd } from "../utils/helpers";
import { getUsdcBalance } from "../services/wallet/signer";

/**
 * Manages position sizing for copytrading.
 *
 * Simple flat percentage: ourSize = traderSize × (COPY_PERCENTAGE / 100)
 *
 * Example with COPY_PERCENTAGE=10:
 *   Trader $100 → We $10
 *   Trader $50  → We $5
 *   Trader $20  → We $2
 *   Trader $10  → We $1
 *   Trader $5   → We $0.50
 */
export class PortfolioManager {
  /** Cached Safe USDC balance */
  private cachedBalance: number = 0;

  /** Copy ratio as decimal (e.g. 10% → 0.10) */
  private _ratio: number;

  constructor() {
    this._ratio = config.copyPercentage / 100;
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
        `Sizing: ${config.copyPercentage}% del importe del trader`
      );
    } catch (err) {
      logger.error(
        "Failed to refresh balance",
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Calculates the copy trade size as a flat percentage of the trader's amount.
   *
   * ourSize = traderSize × (COPY_PERCENTAGE / 100)
   */
  calculateTradeSize(traderSizeUsdc: number): number {
    let ourSize = traderSizeUsdc * this._ratio;

    // Round to 2 decimals (USDC cents)
    ourSize = Math.round(ourSize * 100) / 100;

    // Skip trivially small trades
    if (ourSize < config.minPositionSizeUsdc) {
      logger.debug(
        `Trade ${formatUsd(ourSize)} por debajo del mínimo ${formatUsd(config.minPositionSizeUsdc)}, skipping`
      );
      return 0;
    }

    logger.debug(
      `Sizing: trader=${formatUsd(traderSizeUsdc)} × ${config.copyPercentage}% → nuestro=${formatUsd(ourSize)}`
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
