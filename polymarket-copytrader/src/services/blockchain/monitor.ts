import { ethers } from "ethers";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { shortAddress } from "../../utils/helpers";
import { getHttpProvider, getWsProvider } from "./provider";

// Polymarket contract addresses (lowercased for comparison)
const POLYMARKET_CONTRACTS = new Set([
  config.contracts.ctfExchange.toLowerCase(),
  config.contracts.negRiskCtfExchange.toLowerCase(),
]);

export interface DetectedTransaction {
  hash: string;
  from: string;
  to: string;
  data: string;
  value: bigint;
  blockNumber: number | null;
}

type TransactionCallback = (tx: DetectedTransaction) => void;

/**
 * Monitors all transactions from the target wallet and filters for
 * Polymarket-related interactions.
 *
 * Strategy: subscribe to new blocks via WebSocket, then scan each block
 * for transactions from the target address that interact with Polymarket contracts.
 * This is more reliable than pending-tx subscriptions, which many RPC providers
 * limit or don't support.
 */
export class TransactionMonitor {
  private running: boolean = false;
  private callback: TransactionCallback | null = null;
  private targetAddress: string;

  constructor() {
    this.targetAddress = config.walletToCopy.toLowerCase();
  }

  /**
   * Starts monitoring blocks for target wallet transactions
   */
  start(onTransaction: TransactionCallback): void {
    this.callback = onTransaction;
    this.running = true;
    this.subscribeToBlocks();
    logger.info(
      `Monitoring transactions from ${shortAddress(this.targetAddress)}`
    );
  }

  /**
   * Stops monitoring
   */
  stop(): void {
    this.running = false;
    this.callback = null;
    logger.info("Transaction monitor stopped");
  }

  private subscribeToBlocks(): void {
    const wsProvider = getWsProvider(() => {
      // On reconnect, re-subscribe
      if (this.running) {
        logger.info("Re-subscribing to blocks after reconnect");
        this.subscribeToBlocks();
      }
    });

    wsProvider.on("block", async (blockNumber: number) => {
      if (!this.running) return;
      try {
        await this.processBlock(blockNumber);
      } catch (err) {
        logger.error(
          `Error processing block ${blockNumber}`,
          err instanceof Error ? err.message : err
        );
      }
    });
  }

  private async processBlock(blockNumber: number): Promise<void> {
    const httpProvider = getHttpProvider();
    const block = await httpProvider.getBlock(blockNumber, true);
    if (!block || !block.prefetchedTransactions) return;

    for (const tx of block.prefetchedTransactions) {
      if (
        tx.from.toLowerCase() === this.targetAddress &&
        tx.to &&
        POLYMARKET_CONTRACTS.has(tx.to.toLowerCase())
      ) {
        logger.trade(
          `Detected Polymarket tx from ${shortAddress(tx.from)} → ${shortAddress(tx.to)} in block ${blockNumber}`
        );

        const detected: DetectedTransaction = {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          data: tx.data,
          value: tx.value,
          blockNumber,
        };

        if (this.callback) {
          this.callback(detected);
        }
      }
    }
  }
}
