import { config } from "../config";
import { logger } from "../utils/logger";
import { formatUsd, formatPercent, shortAddress } from "../utils/helpers";
import { TransactionMonitor } from "../services/blockchain/monitor";
import type { DetectedTransaction } from "../services/blockchain/monitor";
import { parseTransaction } from "../services/polymarket/parser";
import type { ParsedTrade } from "../services/polymarket/parser";
import { executeTrade } from "../services/polymarket/executor";
import { PortfolioManager } from "./portfolio";
import { TradeQueue } from "./queue";
import type { QueuedTrade } from "./queue";

/**
 * Main copytrading engine.
 *
 * Orchestrates the flow:
 *   monitor → parse → calculate proportional size → validate budget → queue → execute
 */
export class CopyTrader {
  private monitor: TransactionMonitor;
  private portfolio: PortfolioManager;
  private queue: TradeQueue;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;

  constructor() {
    this.monitor = new TransactionMonitor();
    this.portfolio = new PortfolioManager();
    this.queue = new TradeQueue();

    // Register the trade processor
    this.queue.onProcess((trade) => this.processTrade(trade));
  }

  /**
   * Starts the copytrading bot:
   * 1. Fetch target portfolio value
   * 2. Calculate copy ratio
   * 3. Start monitoring transactions
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

    // Step 2: Start transaction monitoring
    this.monitor.start((tx) => this.onTransactionDetected(tx));

    // Step 3: Schedule hourly portfolio refresh to keep ratio current
    this.refreshInterval = setInterval(async () => {
      logger.info("Refreshing target portfolio value...");
      await this.portfolio.refreshTargetPortfolio();
    }, config.portfolioRefreshIntervalMs);

    logger.success("Bot is running and monitoring transactions");
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
   * Called when a Polymarket transaction from the target wallet is detected.
   */
  private onTransactionDetected(tx: DetectedTransaction): void {
    if (!this.running) return;

    logger.trade(
      `Detected tx ${shortAddress(tx.hash)} from ${shortAddress(tx.from)} → ${shortAddress(tx.to)}`
    );

    // Parse the transaction to extract trade details
    const parsed = parseTransaction(tx);
    if (!parsed) {
      logger.debug(`Tx ${shortAddress(tx.hash)} is not a recognized trade, skipping`);
      return;
    }

    logger.trade(
      `Parsed: ${parsed.tradeType} ${formatUsd(parsed.amountUsdc)} @ ${parsed.price.toFixed(4)} | Token: ${shortAddress(parsed.tokenId)}`
    );

    // Calculate proportional trade size
    const scaledSize = this.portfolio.calculateTradeSize(parsed.amountUsdc);
    if (scaledSize === 0) {
      logger.debug("Scaled trade size is 0, skipping");
      return;
    }

    logger.copy(
      `Calculated: ${formatUsd(parsed.amountUsdc)} × ${formatPercent(this.portfolio.copyRatio)} = ${formatUsd(scaledSize)}`
    );

    // Check budget
    if (parsed.tradeType === "BUY" && !this.portfolio.canExecuteTrade(scaledSize)) {
      logger.warn(
        `Insufficient budget: need ${formatUsd(scaledSize)} but only ${formatUsd(this.portfolio.availableBudget)} available`
      );
      return;
    }

    // Enqueue for execution
    this.queue.enqueue(parsed, scaledSize);
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
