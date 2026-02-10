import { config } from "../config";
import { logger } from "../utils/logger";
import { formatUsd, formatPercent } from "../utils/helpers";
import { getPortfolioValue } from "../services/polymarket/client";
import { getUsdcBalance } from "../services/wallet/signer";

/**
 * Manages the copytrading budget using the real Safe USDC balance.
 *
 * Instead of tracking spent/recovered amounts manually (which drifts
 * when the auto-redeemer claims resolved positions), we query the
 * actual on-chain USDC balance of the Gnosis Safe.
 */
export class PortfolioManager {
  /** Cached Safe USDC balance */
  private cachedBalance: number = 0;
  targetWalletValue: number = 0;
  copyRatio: number = 0;

  get availableBudget(): number {
    return this.cachedBalance;
  }

  /**
   * Fetches the Safe USDC balance and target wallet portfolio value.
   */
  async refreshTargetPortfolio(): Promise<void> {
    try {
      const [value, balance] = await Promise.all([
        getPortfolioValue(config.walletToCopy),
        getUsdcBalance(),
      ]);

      this.targetWalletValue = value;
      this.cachedBalance = balance;

      if (value > 0) {
        this.copyRatio = this.cachedBalance / value;
      } else {
        logger.warn("Target portfolio value is 0, using 1% default ratio");
        this.copyRatio = 0.01;
      }

      logger.budget(
        `Portfolio objetivo: ${formatUsd(this.targetWalletValue)} | Ratio: ${formatPercent(this.copyRatio)}`
      );
      logger.budget(
        `Safe USDC disponible: ${formatUsd(this.cachedBalance)}`
      );
    } catch (err) {
      logger.error(
        "Failed to refresh portfolio",
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Calculates the copy trade size using a fixed-amount strategy.
   *
   * Copies every trade at up to MAX_SINGLE_TRADE_USDC. If the original trade
   * is smaller than our max, we mirror its exact size.
   *
   * Returns 0 if the resulting size is below MIN_TRADE_SIZE_USDC.
   */
  calculateTradeSize(originalSizeUsdc: number): number {
    const size = Math.min(originalSizeUsdc, config.maxSingleTradeUsdc);

    if (size < config.minTradeSizeUsdc) {
      logger.debug(
        `Trade size ${formatUsd(size)} below minimum ${formatUsd(config.minTradeSizeUsdc)}, skipping`
      );
      return 0;
    }

    return Math.round(size * 100) / 100;
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
