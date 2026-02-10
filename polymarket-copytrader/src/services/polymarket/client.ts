import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { shortAddress } from "../../utils/helpers";

let clobClient: ClobClient | null = null;

// Polymarket Data API for fetching positions and portfolio value
const DATA_API_BASE = "https://data-api.polymarket.com";

/**
 * Initializes and returns the Polymarket CLOB client with L2 authentication.
 * Derives API keys from the wallet signer on first call.
 *
 * Note: @polymarket/clob-client uses ethers v5 internally. We cast our ethers v6
 * Wallet to `any` because the signing interface is compatible for the operations
 * the CLOB client uses (signMessage, address).
 */
export async function getClobClient(): Promise<ClobClient> {
  if (clobClient) return clobClient;

  const privateKey = config.privateKey.startsWith("0x")
    ? config.privateKey
    : `0x${config.privateKey}`;
  const signer = new ethers.Wallet(privateKey);

  logger.info(
    `Initializing Polymarket CLOB client for ${shortAddress(signer.address)}`
  );

  // Step 1: Create L1 client to derive API keys
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tempClient = new ClobClient(
    config.polymarketApiUrl,
    137, // Polygon mainnet
    signer as any // ethers v6 Wallet is compatible with v5 for signing
  );

  // Step 2: Derive or create API credentials
  const apiCreds = await tempClient.createOrDeriveApiKey();
  logger.info("API credentials derived successfully");

  // Step 3: Create fully authenticated L2 client
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clobClient = new ClobClient(
    config.polymarketApiUrl,
    137,
    signer as any, // ethers v6 Wallet is compatible with v5 for signing
    apiCreds,
    0 // EOA signature type
  );

  logger.success("Polymarket CLOB client initialized");
  return clobClient;
}

/**
 * Fetches all open positions for a given wallet address from the Polymarket Data API.
 */
export async function getPositions(
  walletAddress: string
): Promise<PositionData[]> {
  const url = `${DATA_API_BASE}/positions?${new URLSearchParams({
    user: walletAddress.toLowerCase(),
    sizeThreshold: "0",
    limit: "500",
    offset: "0",
    sortBy: "CURRENT",
    sortDirection: "DESC",
  })}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch positions: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as PositionData[];
  return data;
}

/**
 * Fetches the total portfolio value in USDC for a given wallet from Polymarket Data API.
 */
export async function getPortfolioValue(
  walletAddress: string
): Promise<number> {
  // Sum up current values of all positions
  const positions = await getPositions(walletAddress);
  let totalValue = 0;
  for (const pos of positions) {
    const currentVal = parseFloat(pos.currentValue || "0");
    if (currentVal > 0) {
      totalValue += currentVal;
    }
  }
  return totalValue;
}

/**
 * Fetches market details by condition ID from the CLOB API
 */
export async function getMarketInfo(
  conditionId: string
): Promise<MarketInfo | null> {
  try {
    const client = await getClobClient();
    const market = await client.getMarket(conditionId);
    return market as unknown as MarketInfo;
  } catch (err) {
    logger.error(
      `Failed to fetch market ${conditionId}`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Fetches the order book for a given token ID
 */
export async function getOrderBook(tokenId: string): Promise<OrderBookData> {
  const client = await getClobClient();
  return (await client.getOrderBook(tokenId)) as unknown as OrderBookData;
}

// -- Type definitions for Data API responses --

export interface PositionData {
  asset: string;
  conditionId: string;
  size: string;
  avgPrice: string;
  initialValue: string;
  currentValue: string;
  cashPnl: string;
  percentPnl: string;
  totalBought: string;
  realizedPnl: string;
  curPrice: string;
  redeemable: boolean;
  title: string;
  slug: string;
  icon: string;
  outcome: string;
  proxyWallet: string;
}

export interface MarketInfo {
  condition_id: string;
  question: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
  active: boolean;
  closed: boolean;
  minimum_order_size: string;
  minimum_tick_size: string;
  neg_risk: boolean;
}

export interface OrderBookData {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  min_order_size: string;
  tick_size: string;
  neg_risk: boolean;
  last_trade_price: string;
}
