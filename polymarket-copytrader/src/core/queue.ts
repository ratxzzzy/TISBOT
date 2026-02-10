import { logger } from "../utils/logger";
import { formatUsd, shortAddress } from "../utils/helpers";
import type { ParsedTrade } from "../services/polymarket/parser";

/**
 * A queued trade operation with its calculated copy parameters
 */
export interface QueuedTrade {
  id: string;
  originalTrade: ParsedTrade;
  scaledAmountUsdc: number;
  enqueuedAt: Date;
  status: "pending" | "processing" | "completed" | "failed";
  result?: string;
}

type TradeProcessor = (trade: QueuedTrade) => Promise<void>;

/**
 * Sequential trade queue to prevent nonce conflicts and ensure orderly execution.
 *
 * Trades are enqueued as they are detected and processed one at a time.
 * This avoids race conditions with blockchain nonce management.
 */
export class TradeQueue {
  private queue: QueuedTrade[] = [];
  private processing: boolean = false;
  private processor: TradeProcessor | null = null;
  private tradeCounter: number = 0;

  /**
   * Registers the function that will process each trade.
   */
  onProcess(handler: TradeProcessor): void {
    this.processor = handler;
  }

  /**
   * Adds a trade to the queue and starts processing if not already running.
   */
  enqueue(originalTrade: ParsedTrade, scaledAmountUsdc: number): string {
    this.tradeCounter++;
    const id = `trade-${this.tradeCounter}-${Date.now()}`;

    const queued: QueuedTrade = {
      id,
      originalTrade,
      scaledAmountUsdc,
      enqueuedAt: new Date(),
      status: "pending",
    };

    this.queue.push(queued);

    logger.info(
      `Enqueued ${originalTrade.tradeType} ${formatUsd(scaledAmountUsdc)} | Token: ${shortAddress(originalTrade.tokenId)} | Queue: ${this.queue.length} pending`
    );

    // Start processing if idle
    if (!this.processing) {
      this.processNext();
    }

    return id;
  }

  /**
   * Returns the current queue length
   */
  get length(): number {
    return this.queue.filter((t) => t.status === "pending").length;
  }

  /**
   * Returns all trades (for status display)
   */
  getAll(): QueuedTrade[] {
    return [...this.queue];
  }

  /**
   * Processes trades one at a time from the queue.
   */
  private async processNext(): Promise<void> {
    if (this.processing) return;
    if (!this.processor) {
      logger.error("No trade processor registered");
      return;
    }

    const nextTrade = this.queue.find((t) => t.status === "pending");
    if (!nextTrade) {
      this.processing = false;
      return;
    }

    this.processing = true;
    nextTrade.status = "processing";

    try {
      await this.processor(nextTrade);
      nextTrade.status = "completed";
    } catch (err) {
      nextTrade.status = "failed";
      nextTrade.result =
        err instanceof Error ? err.message : String(err);
      logger.error(
        `Queue processing failed for ${nextTrade.id}: ${nextTrade.result}`
      );
    }

    this.processing = false;

    // Clean up old completed/failed trades (keep last 100)
    if (this.queue.length > 100) {
      this.queue = this.queue.slice(-100);
    }

    // Process next item if available
    await this.processNext();
  }
}
