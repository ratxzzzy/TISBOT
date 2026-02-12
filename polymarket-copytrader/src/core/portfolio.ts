import { config } from "../config";
import { logger } from "../utils/logger";
import { formatUsd } from "../utils/helpers";
import { getUsdcBalance } from "../services/wallet/signer";

/**
 * Manages position sizing for copytrading using a tiered strategy.
 *
 * Sizing tiers (applied to both BUY and SELL):
 *   Trader ≤ $5      → copy exact amount
 *   $5 < Trader ≤ $15 → copy amount / 2
 *   Trader > $15      → copy 10% of amount
 *
 * Examples:
 *   Trader $3    → We $3      (tier 1: exact copy)
 *   Trader $5    → We $5      (tier 1: exact copy)
 *   Trader $10   → We $5      (tier 2: $10 / 2)
 *   Trader $15   → We $7.50   (tier 2: $15 / 2)
 *   Trader $20   → We $2      (tier 3: 10% of $20)
 *   Trader $100  → We $10     (tier 3: 10% of $100)
 */
export class PortfolioManager {
  /** Cached Safe USDC balance */
  private cachedBalance: number = 0;

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
        `Estrategia de sizing: ≤$5 → copia exacta | $5-$15 → mitad | >$15 → 10%`
      );
    } catch (err) {
      logger.error(
        "Failed to refresh balance",
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Calculates the copy trade size using tiered strategy.
   *
   * Tiers:
   *   ≤ $5       → exact copy (1:1)
   *   $5 to $15  → amount / 2
   *   > $15      → 10% of amount
   */
  calculateTradeSize(traderSizeUsdc: number): number {
    let ourSize: number;

    if (traderSizeUsdc <= 5) {
      // Tier 1: copia exacta
      ourSize = traderSizeUsdc;
    } else if (traderSizeUsdc <= 15) {
      // Tier 2: mitad del importe
      ourSize = traderSizeUsdc / 2;
    } else {
      // Tier 3: 10% del importe
      ourSize = traderSizeUsdc * 0.10;
    }

    // Redondear a 2 decimales (centavos USDC)
    ourSize = Math.round(ourSize * 100) / 100;

    // Protección mínima: no abrir posiciones ridículas
    if (ourSize < config.minPositionSizeUsdc) {
      logger.debug(
        `Trade ${formatUsd(ourSize)} por debajo del mínimo ${formatUsd(config.minPositionSizeUsdc)}, skipping`
      );
      return 0;
    }

    const tier = traderSizeUsdc <= 5 ? "exacta" : traderSizeUsdc <= 15 ? "÷2" : "10%";
    logger.debug(`Sizing: trader=${formatUsd(traderSizeUsdc)} → nuestro=${formatUsd(ourSize)} (${tier})`);

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
