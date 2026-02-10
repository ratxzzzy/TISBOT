import { config } from "./config";
import { logger } from "./utils/logger";
import { isValidAddress, formatUsd } from "./utils/helpers";
import { getWallet, getUsdcBalance, getMaticBalance } from "./services/wallet/signer";
import { getClobClient } from "./services/polymarket/client";
import { closeProviders } from "./services/blockchain/provider";
import { CopyTrader } from "./core/copier";

let copyTrader: CopyTrader | null = null;

/**
 * Validates that all required configuration is present and correct.
 */
function validateConfig(): void {
  if (!isValidAddress(config.walletToCopy)) {
    throw new Error(`Invalid target wallet address: ${config.walletToCopy}`);
  }

  if (config.totalBudgetUsdc <= 0) {
    throw new Error("TOTAL_BUDGET_USDC must be greater than 0");
  }

  if (config.minTradeSizeUsdc <= 0) {
    throw new Error("MIN_TRADE_SIZE_USDC must be greater than 0");
  }

  if (config.slippageTolerance < 0 || config.slippageTolerance > 50) {
    throw new Error("SLIPPAGE_TOLERANCE must be between 0 and 50");
  }

  if (!config.polygonWsUrl.startsWith("wss://")) {
    throw new Error("POLYGON_RPC_URL must be a WebSocket URL (wss://)");
  }
}

/**
 * Main entry point. Initializes all services and starts the copytrader.
 */
async function main(): Promise<void> {
  logger.info("========================================");
  logger.info("   Polymarket CopyTrader Bot v1.0.0     ");
  logger.info("========================================\n");

  // Step 1: Validate configuration
  logger.info("Validating configuration...");
  validateConfig();
  logger.success("Configuration valid");

  // Step 2: Initialize wallet
  logger.info("Initializing wallet...");
  const wallet = getWallet();
  logger.success(`Wallet ready: ${wallet.address}`);

  // Step 3: Check balances
  logger.info("Checking wallet balances...");
  const [usdcBalance, maticBalance] = await Promise.all([
    getUsdcBalance(),
    getMaticBalance(),
  ]);

  logger.budget(`USDC balance: ${formatUsd(usdcBalance)}`);
  logger.budget(`MATIC balance: ${maticBalance.toFixed(4)} MATIC`);

  if (usdcBalance < config.minTradeSizeUsdc) {
    logger.warn(
      `Low USDC balance (${formatUsd(usdcBalance)}). You need at least ${formatUsd(config.minTradeSizeUsdc)} to execute trades.`
    );
  }

  if (maticBalance < 0.01) {
    logger.warn(
      `Low MATIC balance (${maticBalance.toFixed(4)}). You need MATIC for gas fees.`
    );
  }

  // Step 4: Initialize Polymarket CLOB client
  logger.info("Connecting to Polymarket CLOB API...");
  await getClobClient();
  logger.success("Polymarket CLOB client ready");

  // Step 5: Start the copytrader
  copyTrader = new CopyTrader();
  await copyTrader.start();
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`\nReceived ${signal}, shutting down gracefully...`);

  if (copyTrader) {
    copyTrader.stop();
  }

  await closeProviders();
  logger.info("Goodbye!");
  process.exit(0);
}

// Register shutdown handlers
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.message}`, err.stack);
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error(
    "Unhandled rejection",
    reason instanceof Error ? reason.message : reason
  );
});

// Run
main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`, err.stack);
  process.exit(1);
});
