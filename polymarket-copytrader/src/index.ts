import { config } from "./config";
import { logger } from "./utils/logger";
import { isValidAddress, formatUsd, shortAddress } from "./utils/helpers";
import {
  getWallet,
  getUsdcBalance,
  getEoaUsdcBalance,
  getMaticBalance,
  getSafeMaticBalance,
} from "./services/wallet/signer";
import { getClobClient } from "./services/polymarket/client";
import { closeProviders } from "./services/blockchain/provider";
import { CopyTrader } from "./core/copier";
import { AutoRedeemer } from "./services/redeemer";

let copyTrader: CopyTrader | null = null;
let autoRedeemer: AutoRedeemer | null = null;

/**
 * Validates that all required configuration is present and correct.
 */
function validateConfig(): void {
  if (!isValidAddress(config.walletToCopy)) {
    throw new Error(`Invalid target wallet address: ${config.walletToCopy}`);
  }

  if (!isValidAddress(config.safeAddress)) {
    throw new Error(`Invalid Gnosis Safe address: ${config.safeAddress}`);
  }

  if (!isValidAddress(config.eoaAddress)) {
    throw new Error(`Invalid EOA address: ${config.eoaAddress}`);
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

  // Step 2: Initialize wallet (EOA signer for the Gnosis Safe)
  logger.info("Initializing wallet...");
  const wallet = getWallet();
  logger.success(`EOA signer ready: ${wallet.address}`);
  logger.info(`Gnosis Safe: ${shortAddress(config.safeAddress)}`);

  // Step 3: Check balances (Safe holds funds, EOA needs MATIC for gas)
  logger.info("Checking balances...");
  const [safeUsdcBalance, eoaUsdcBalance, eoaMaticBalance, safeMaticBalance] =
    await Promise.all([
      getUsdcBalance(), // Safe USDC
      getEoaUsdcBalance(), // EOA USDC
      getMaticBalance(), // EOA MATIC
      getSafeMaticBalance(), // Safe MATIC
    ]);

  logger.budget(`Safe USDC balance: ${formatUsd(safeUsdcBalance)}`);
  logger.budget(`Safe MATIC balance: ${safeMaticBalance.toFixed(4)} MATIC`);
  logger.budget(`EOA USDC balance: ${formatUsd(eoaUsdcBalance)}`);
  logger.budget(`EOA MATIC balance: ${eoaMaticBalance.toFixed(4)} MATIC`);

  if (safeUsdcBalance < config.minTradeSizeUsdc) {
    logger.warn(
      `Low Safe USDC balance (${formatUsd(safeUsdcBalance)}). The Safe needs at least ${formatUsd(config.minTradeSizeUsdc)} USDC to execute trades.`
    );
  }

  if (eoaMaticBalance < 0.01) {
    logger.warn(
      `Low EOA MATIC balance (${eoaMaticBalance.toFixed(4)}). EOA needs MATIC for gas fees.`
    );
  }

  // Step 4: Initialize Polymarket CLOB client
  logger.info("Connecting to Polymarket CLOB API...");
  await getClobClient();
  logger.success("Polymarket CLOB client ready");

  // Step 5: Start auto-redeemer (claims resolved positions → USDC)
  autoRedeemer = new AutoRedeemer();
  autoRedeemer.start();

  // Step 6: Start the copytrader
  copyTrader = new CopyTrader();
  await copyTrader.start();
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`\nReceived ${signal}, shutting down gracefully...`);

  if (autoRedeemer) {
    autoRedeemer.stop();
  }

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
