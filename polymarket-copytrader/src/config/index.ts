import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function mustNumber(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Config ${name} must be a number`);
  return n;
}

export const config = {
  // Polygon RPC
  polygonWsUrl: requireEnv("POLYGON_RPC_URL"),
  polygonHttpUrl: requireEnv("POLYGON_HTTP_URL"),

  // Wallet - EOA signer (owner of the Gnosis Safe)
  privateKey: requireEnv("PRIVATE_KEY"),

  // Gnosis Safe - the Safe holds funds, EOA signs on its behalf
  safeAddress: requireEnv("SAFE_ADDRESS").toLowerCase(),
  eoaAddress: requireEnv("EOA_ADDRESS").toLowerCase(),

  // Polymarket
  polymarketApiUrl: optionalEnv(
    "POLYMARKET_API_URL",
    "https://clob.polymarket.com"
  ),

  // Copytrading target
  walletToCopy: requireEnv("WALLET_TO_COPY").toLowerCase(),

  // Copy sizing: flat percentage of the trader's amount
  copyPercentage: parseFloat(optionalEnv("COPY_PERCENTAGE", "10")),

  // Tamaño mínimo de posición — por debajo no se abre trade
  minPositionSizeUsdc: parseFloat(optionalEnv("MIN_POSITION_SIZE_USDC", "0.50")),

  // Budget guardrails
  TOTAL_BUDGET_USDC: mustNumber(optionalEnv("TOTAL_BUDGET_USDC", "100"), "TOTAL_BUDGET_USDC"),
  MAX_SINGLE_TRADE_USDC: mustNumber(optionalEnv("MAX_SINGLE_TRADE_USDC", "25"), "MAX_SINGLE_TRADE_USDC"),

  // Trading
  slippageTolerance: parseFloat(optionalEnv("SLIPPAGE_TOLERANCE", "5")),

  // Polymarket contracts on Polygon
  contracts: {
    ctfExchange: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
    negRiskCtfExchange: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
    usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  },

  // Telegram (optional)
  telegramBotToken: process.env["TELEGRAM_BOT_TOKEN"] || "",
  telegramChatId: process.env["TELEGRAM_CHAT_ID"] || "",

  // State persistence
  budgetStatePath: path.resolve(__dirname, "../../budget-state.json"),

  // Timing
  portfolioRefreshIntervalMs: 60 * 60 * 1000, // 1 hour
  wsReconnectDelayMs: 5000,
  maxRetries: 3,
} as const;

// Startup validation
if (config.MAX_SINGLE_TRADE_USDC > config.TOTAL_BUDGET_USDC) {
  throw new Error("Config invalid: MAX_SINGLE_TRADE_USDC > TOTAL_BUDGET_USDC");
}

export type Config = typeof config;
