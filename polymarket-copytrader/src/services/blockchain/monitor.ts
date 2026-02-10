import { config } from "../../config";
import { logger } from "../../utils/logger";
import { shortAddress, sleep } from "../../utils/helpers";

const DATA_API_BASE = "https://data-api.polymarket.com";

/**
 * A trade detected from the Polymarket activity API.
 * This is the data we get directly from Polymarket's servers,
 * NOT from on-chain scanning.
 */
export interface DetectedTrade {
  /** Transaction hash on Polygon */
  txHash: string;
  /** "BUY" or "SELL" */
  side: "BUY" | "SELL";
  /** Token ID (large numeric string) */
  tokenId: string;
  /** Amount in USDC */
  usdcSize: number;
  /** Number of shares */
  shares: number;
  /** Price per share */
  price: number;
  /** Human-readable market title */
  title: string;
  /** Outcome label (e.g. "Yes", "No", "Up", "Down") */
  outcome: string;
  /** Condition ID for the market */
  conditionId: string;
  /** Unix timestamp */
  timestamp: number;
}

type TradeCallback = (trade: DetectedTrade) => void;

/**
 * Monitors trades from the target wallet by polling the Polymarket Data API.
 *
 * WHY NOT ON-CHAIN?
 * Polymarket uses a CLOB (Central Limit Order Book). Users sign orders off-chain,
 * the Polymarket matching engine matches them, and a Polymarket operator settles
 * on-chain. The target wallet's address NEVER appears as tx.from on-chain -
 * it's embedded inside the order struct. Scanning blocks for tx.from misses
 * all trades.
 *
 * Instead, we poll /activity?user=<address> which returns exactly what the
 * Polymarket UI shows (Buy/Sell, amount, price, market).
 */
export class ActivityMonitor {
  private running: boolean = false;
  private callback: TradeCallback | null = null;
  private targetAddress: string;
  private lastSeenTimestamp: number = 0;
  private seenTxHashes: Set<string> = new Set();
  private pollIntervalMs: number;

  constructor(pollIntervalMs: number = 5000) {
    this.targetAddress = config.walletToCopy.toLowerCase();
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Starts polling for new trades from the target wallet.
   */
  async start(onTrade: TradeCallback): Promise<void> {
    this.callback = onTrade;
    this.running = true;

    // Seed with current activity so we don't replay old trades
    await this.seedLastSeen();

    logger.info(
      `Monitoring activity for ${shortAddress(this.targetAddress)} (polling every ${this.pollIntervalMs / 1000}s)`
    );

    // Start the poll loop
    this.pollLoop();
  }

  /**
   * Stops monitoring
   */
  stop(): void {
    this.running = false;
    this.callback = null;
    logger.info("Activity monitor stopped");
  }

  /**
   * Fetches the most recent activity to establish a baseline.
   * This prevents copying old trades on first startup.
   */
  private async seedLastSeen(): Promise<void> {
    try {
      const activities = await this.fetchActivity(10);
      for (const act of activities) {
        this.seenTxHashes.add(act.transactionHash);
        const ts = Number(act.timestamp);
        if (ts > this.lastSeenTimestamp) {
          this.lastSeenTimestamp = ts;
        }
      }
      logger.info(
        `Seeded with ${activities.length} existing trades, latest at ${new Date(this.lastSeenTimestamp * 1000).toISOString()}`
      );
    } catch (err) {
      logger.warn(
        "Could not seed activity history, will start fresh",
        err instanceof Error ? err.message : err
      );
      // Use current time minus 60s as baseline
      this.lastSeenTimestamp = Math.floor(Date.now() / 1000) - 60;
    }
  }

  /**
   * Main polling loop
   */
  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.checkForNewTrades();
      } catch (err) {
        logger.error(
          "Error polling activity",
          err instanceof Error ? err.message : err
        );
      }
      await sleep(this.pollIntervalMs);
    }
  }

  /**
   * Fetches recent activity and fires callback for new trades.
   */
  private async checkForNewTrades(): Promise<void> {
    const activities = await this.fetchActivity(20);

    // Process from oldest to newest
    const sorted = activities
      .filter((a) => a.type === "TRADE")
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

    for (const act of sorted) {
      // Skip already-seen trades
      if (this.seenTxHashes.has(act.transactionHash)) continue;

      const ts = Number(act.timestamp);
      // Skip trades older than our baseline (safety check)
      if (ts <= this.lastSeenTimestamp) continue;

      // Mark as seen
      this.seenTxHashes.add(act.transactionHash);
      if (ts > this.lastSeenTimestamp) {
        this.lastSeenTimestamp = ts;
      }

      // Convert to our DetectedTrade format
      const trade: DetectedTrade = {
        txHash: act.transactionHash,
        side: act.side as "BUY" | "SELL",
        tokenId: act.asset,
        usdcSize: parseFloat(act.usdcSize),
        shares: parseFloat(act.size),
        price: parseFloat(act.price),
        title: act.title || "Unknown market",
        outcome: act.outcome || "",
        conditionId: act.conditionId || "",
        timestamp: ts,
      };

      logger.trade(
        `Detected: ${trade.side} ${trade.shares.toFixed(1)} shares of "${trade.outcome}" in "${trade.title}" @ $${trade.price.toFixed(2)} ($${trade.usdcSize.toFixed(2)})`
      );

      if (this.callback) {
        this.callback(trade);
      }
    }

    // Keep seenTxHashes from growing unbounded (keep last 500)
    if (this.seenTxHashes.size > 500) {
      const arr = Array.from(this.seenTxHashes);
      this.seenTxHashes = new Set(arr.slice(-300));
    }
  }

  /**
   * Fetches recent activity from the Polymarket Data API
   */
  private async fetchActivity(limit: number): Promise<ActivityEntry[]> {
    const url = `${DATA_API_BASE}/activity?${new URLSearchParams({
      user: this.targetAddress,
      limit: String(limit),
    })}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Activity API error: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as ActivityEntry[];
  }
}

/** Raw activity entry from the Polymarket Data API */
interface ActivityEntry {
  transactionHash: string;
  type: string;
  side: string;
  size: string;
  usdcSize: string;
  price: string;
  asset: string;
  outcome: string;
  title: string;
  conditionId: string;
  timestamp: string;
  proxyWallet: string;
  [key: string]: unknown;
}
