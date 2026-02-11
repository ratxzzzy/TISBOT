import { config } from "../config";
import { logger } from "../utils/logger";
import { formatUsd, formatPercent } from "../utils/helpers";
import { getUsdcBalance } from "../services/wallet/signer";

// 🔧 FIX: Reescritura completa del PortfolioManager.
// ANTES: usaba Math.min(traderSize, $5) — un cap plano sin proporcionalidad.
//        El copyRatio se calculaba pero NUNCA se aplicaba al sizing.
//        totalBudgetUsdc se definía en config pero NUNCA se enforceaba.
//        getPortfolioValue() se llamaba pero el ratio resultante se ignoraba en calculateTradeSize().
// AHORA: sizing 100% proporcional al trader copiado usando ratio dinámico configurado por el operador.

/**
 * Manages proportional position sizing for copytrading.
 *
 * The sizing is 100% proportional to the copied trader:
 *   RATIO = MAX_OUR_POSITION / TRADER_MAX_POSITION
 *   ourSize = traderSize * RATIO
 *
 * Example with MAX_OUR=10, TRADER_MAX=200 → RATIO=0.05:
 *   Trader $200 → We $10 (our max)
 *   Trader $100 → We $5
 *   Trader $50  → We $2.50
 *   Trader $10  → We $0.50
 *
 * Safety: if trader exceeds TRADER_MAX_POSITION, we cap at MAX_OUR_POSITION
 * and log an alert (rather than auto-updating the ratio).
 */
export class PortfolioManager {
  /** Cached Safe USDC balance */
  private cachedBalance: number = 0;

  // 🔧 FIX: Ratio calculado desde config, no desde portfolio value del trader
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

  // 🔧 FIX: Reemplaza refreshTargetPortfolio() que llamaba a getPortfolioValue()
  // y calculaba un ratio que nunca se usaba. Ahora solo refresca el balance.
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

  // 🔧 FIX: Reescritura total de calculateTradeSize().
  // ANTES: Math.min(originalSizeUsdc, config.maxSingleTradeUsdc) — cap plano a $5.
  // AHORA: ourSize = traderSize * RATIO — proporcionalidad exacta.
  /**
   * Calculates the proportional copy trade size.
   *
   * Logic:
   *   1. ourSize = traderSize * RATIO (exact proportional)
   *   2. If trader exceeds TRADER_MAX_POSITION → cap at MAX_OUR_POSITION + alert
   *   3. If ourSize < MIN_POSITION_SIZE → skip (return 0)
   *
   * No artificial caps. The proportion is exact.
   */
  calculateTradeSize(traderSizeUsdc: number): number {
    let ourSize: number;

    if (traderSizeUsdc > config.traderMaxPositionUsdc) {
      // Seguridad: trader superó su máximo histórico conocido.
      // Capeamos a nuestro máximo absoluto en lugar de auto-actualizar el ratio.
      ourSize = config.maxOurPositionUsdc;
      logger.warn(
        `ALERTA: Trader superó su máximo histórico! Trade=${formatUsd(traderSizeUsdc)} > TRADER_MAX=${formatUsd(config.traderMaxPositionUsdc)}. ` +
        `Capeando a nuestro máximo: ${formatUsd(ourSize)}. Considera actualizar TRADER_MAX_POSITION_USDC.`
      );
    } else {
      // Proporción exacta: sin caps artificiales
      ourSize = traderSizeUsdc * this._ratio;
    }

    // Redondear a 2 decimales (centavos USDC)
    ourSize = Math.round(ourSize * 100) / 100;

    // Protección mínima: no abrir posiciones ridículas
    if (ourSize < config.minPositionSizeUsdc) {
      logger.debug(
        `Trade proporcional ${formatUsd(ourSize)} por debajo del mínimo ${formatUsd(config.minPositionSizeUsdc)}, skipping`
      );
      return 0;
    }

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
