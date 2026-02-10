import * as fs from "fs";
import { config } from "../config";
import { logger } from "../utils/logger";
import { formatUsd, formatPercent } from "../utils/helpers";
import { getPortfolioValue } from "../services/polymarket/client";

/**
 * Budget state that gets persisted to disk for crash recovery
 */
interface BudgetState {
  totalBudget: number;
  usedBudget: number;
  targetWalletValue: number;
  copyRatio: number;
  lastUpdated: string;
}

/**
 * Manages the copytrading budget and calculates proportional trade sizes.
 *
 * The core idea: if the target wallet has $10,000 in positions and we have $400,
 * our copy ratio is 4%. When they buy $500 of something, we buy $20.
 */
export class PortfolioManager {
  totalBudget: number;
  usedBudget: number;
  targetWalletValue: number;
  copyRatio: number;

  constructor() {
    this.totalBudget = config.totalBudgetUsdc;
    this.usedBudget = 0;
    this.targetWalletValue = 0;
    this.copyRatio = 0;

    // Try to restore state from disk
    this.loadState();
  }

  get availableBudget(): number {
    return this.totalBudget - this.usedBudget;
  }

  /**
   * Fetches the target wallet's total portfolio value and recalculates
   * the copy ratio.
   */
  async refreshTargetPortfolio(): Promise<void> {
    try {
      const value = await getPortfolioValue(config.walletToCopy);
      this.targetWalletValue = value;

      if (value > 0) {
        this.copyRatio = this.totalBudget / value;
      } else {
        logger.warn("Target portfolio value is 0, using 1% default ratio");
        this.copyRatio = 0.01;
      }

      logger.budget(
        `Portfolio objetivo: ${formatUsd(this.targetWalletValue)} | Ratio: ${formatPercent(this.copyRatio)}`
      );
      logger.budget(
        `Presupuesto: ${formatUsd(this.availableBudget)} disponible de ${formatUsd(this.totalBudget)}`
      );

      this.saveState();
    } catch (err) {
      logger.error(
        "Failed to refresh target portfolio",
        err instanceof Error ? err.message : err
      );
      // Keep existing ratio if refresh fails
    }
  }

  /**
   * Calculates the copy trade size using a fixed-amount strategy.
   *
   * Instead of proportional scaling (which produces amounts too small to
   * execute when the target portfolio is much larger than our budget), we
   * copy every trade at up to MAX_SINGLE_TRADE_USDC. If the original trade
   * is smaller than our max, we mirror its exact size.
   *
   * Returns 0 if the resulting size is below MIN_TRADE_SIZE_USDC.
   */
  calculateTradeSize(originalSizeUsdc: number): number {
    // Use the smaller of: our max trade size, or the original trade amount
    const size = Math.min(originalSizeUsdc, config.maxSingleTradeUsdc);

    // Skip trades that are too small
    if (size < config.minTradeSizeUsdc) {
      logger.debug(
        `Trade size ${formatUsd(size)} below minimum ${formatUsd(config.minTradeSizeUsdc)}, skipping`
      );
      return 0;
    }

    // Round to 2 decimal places (USDC precision)
    return Math.round(size * 100) / 100;
  }

  /**
   * Checks if we have enough budget to execute a trade of the given size.
   */
  canExecuteTrade(sizeUsdc: number): boolean {
    if (sizeUsdc <= 0) return false;
    return this.availableBudget >= sizeUsdc;
  }

  /**
   * Updates the used budget after a successful trade execution.
   * For BUY trades, we spend USDC. For SELL trades, we recover USDC.
   */
  updateBudget(amountUsdc: number, isBuy: boolean): void {
    if (isBuy) {
      this.usedBudget += amountUsdc;
    } else {
      // When selling, we recover some budget
      this.usedBudget = Math.max(0, this.usedBudget - amountUsdc);
    }

    logger.budget(
      `Presupuesto actualizado: ${formatUsd(this.availableBudget)} disponible | Gastado: ${formatUsd(this.usedBudget)}`
    );
    this.saveState();
  }

  /**
   * Persists the current budget state to a JSON file for crash recovery.
   */
  private saveState(): void {
    try {
      const state: BudgetState = {
        totalBudget: this.totalBudget,
        usedBudget: this.usedBudget,
        targetWalletValue: this.targetWalletValue,
        copyRatio: this.copyRatio,
        lastUpdated: new Date().toISOString(),
      };
      fs.writeFileSync(config.budgetStatePath, JSON.stringify(state, null, 2));
    } catch (err) {
      logger.warn(
        "Failed to save budget state",
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Loads budget state from disk if available.
   */
  private loadState(): void {
    try {
      if (fs.existsSync(config.budgetStatePath)) {
        const raw = fs.readFileSync(config.budgetStatePath, "utf-8");
        const state: BudgetState = JSON.parse(raw);

        this.usedBudget = state.usedBudget;
        this.targetWalletValue = state.targetWalletValue;
        this.copyRatio = state.copyRatio;

        logger.info(
          `Restored budget state from ${state.lastUpdated}: ${formatUsd(this.availableBudget)} available`
        );
      }
    } catch (err) {
      logger.warn(
        "Could not load previous budget state, starting fresh",
        err instanceof Error ? err.message : err
      );
    }
  }
}
