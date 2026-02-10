import { config } from "../config";
import { logger } from "../utils/logger";
import { formatUsd, formatPercent, shortAddress } from "../utils/helpers";
import { ActivityMonitor } from "../services/blockchain/monitor";
import type { DetectedTrade } from "../services/blockchain/monitor";
import { executeTrade } from "../services/polymarket/executor";
import { PortfolioManager } from "./portfolio";
import { TradeQueue } from "./queue";
import type { QueuedTrade } from "./queue";

/**
 * Main copytrading engine.
 *
 * Orchestrates the flow:
 *   poll activity API → detect new trade → calculate proportional size → validate budget → queue → execute
 */
export class CopyTrader {
  private monitor: ActivityMonitor;
  private portfolio: PortfolioManager;
  private queue: TradeQueue;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;

  constructor() {
    this.monitor = new ActivityMonitor(5000); // Poll every 5 seconds
    this.portfolio = new PortfolioManager();
    this.queue = new TradeQueue();

    // Register the trade processor
    this.queue.onProcess((trade) => this.processTrade(trade));
  }

  /**
   * Starts the copytrading bot:
   * 1. Fetch target portfolio value
   * 2. Calculate copy ratio
   * 3. Start polling activity API
   * 4. Schedule periodic portfolio refresh
   */
  async start(): Promise<void> {
    this.running = true;

    logger.info("========================================");
    logger.info("   Polymarket CopyTrader Bot Starting   ");
    logger.info("========================================");
    logger.info(`Target wallet: ${shortAddress(config.walletToCopy)}`);
    logger.budget(`Total budget: ${formatUsd(config.totalBudgetUsdc)}`);
    logger.info(`Min trade: ${formatUsd(config.minTradeSizeUsdc)} | Max trade: ${formatUsd(config.maxSingleTradeUsdc)}`);
    logger.info(`Slippage tolerance: ${config.slippageTolerance}%`);

    // Step 1: Fetch target portfolio and calculate ratio
    await this.portfolio.refreshTargetPortfolio();
    logger.info(
      `Copy ratio: ${formatPercent(this.portfolio.copyRatio)} (${formatUsd(this.portfolio.availableBudget)} / ${formatUsd(this.portfolio.targetWalletValue)})`
    );

    // Step 2: Start activity polling (this seeds existing trades first)
    await this.monitor.start((trade) => this.onTradeDetected(trade));

    // Step 3: Schedule hourly portfolio refresh to keep ratio current
    this.refreshInterval = setInterval(async () => {
      logger.info("Refreshing target portfolio value...");
      await this.portfolio.refreshTargetPortfolio();
    }, config.portfolioRefreshIntervalMs);

    logger.success("Bot is running and monitoring trades via Polymarket API");
  }

  /**
   * Gracefully stops the bot
   */
  stop(): void {
    this.running = false;

    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    this.monitor.stop();
    logger.info("CopyTrader bot stopped");
  }

  /**
   * Called when a new trade from the target wallet is detected via the activity API.
   */
  private onTradeDetected(trade: DetectedTrade): void {
    if (!this.running) return;

    logger.trade(
      `Target ${trade.side} $${trade.usdcSize.toFixed(2)} of "${trade.outcome}" in "${trade.title}" @ $${trade.price.toFixed(4)}`
    );

    // Calculate proportional trade size
    const scaledSize = this.portfolio.calculateTradeSize(trade.usdcSize);
    if (scaledSize === 0) {
      logger.debug("Scaled trade size is 0 (below minimum), skipping");
      return;
    }

    logger.copy(
      `Copying: ${formatUsd(scaledSize)} (target traded ${formatUsd(trade.usdcSize)}, max ${formatUsd(config.maxSingleTradeUsdc)})`
    );

    // Check budget for buys
    if (trade.side === "BUY" && !this.portfolio.canExecuteTrade(scaledSize)) {
      logger.warn(
        `Insufficient budget: need ${formatUsd(scaledSize)} but only ${formatUsd(this.portfolio.availableBudget)} available`
      );
      return;
    }

    // Convert DetectedTrade to the format the executor expects
    const parsedTrade = {
      txHash: trade.txHash,
      tradeType: trade.side,
      tokenId: trade.tokenId,
      amountUsdc: trade.usdcSize,
      shares: trade.shares,
      price: trade.price,
      isNegRisk: false, // Will be determined by the executor from the order book
      exchange: "",
      functionName: "activity-api",
    } as const;

    // Enqueue for execution
    this.queue.enqueue(parsedTrade, scaledSize);
  }

  /**
   * Processes a single queued trade: executes it and updates the budget.
   */
  private async processTrade(queued: QueuedTrade): Promise<void> {
    const { originalTrade, scaledAmountUsdc } = queued;

    logger.copy(
      `Executing copy: ${originalTrade.tradeType} ${formatUsd(scaledAmountUsdc)} | Token: ${shortAddress(originalTrade.tokenId)}`
    );

    const result = await executeTrade(originalTrade, scaledAmountUsdc);

    if (result.success) {
      // Update budget
      this.portfolio.updateBudget(
        result.executedAmountUsdc,
        originalTrade.tradeType === "BUY"
      );

      queued.result = `Executed: ${formatUsd(result.executedAmountUsdc)} @ ${result.executedPrice.toFixed(4)} | Remaining: ${formatUsd(this.portfolio.availableBudget)}`;

      logger.success(
        `Executed: ${formatUsd(result.executedAmountUsdc)} ${originalTrade.tradeType} @ ${result.executedPrice.toFixed(4)} | Remaining: ${formatUsd(this.portfolio.availableBudget)}`
      );
    } else {
      queued.result = `Failed: ${result.errorMessage}`;
      logger.error(
        `Trade failed: ${result.errorMessage}`
      );
    }
  }
}
