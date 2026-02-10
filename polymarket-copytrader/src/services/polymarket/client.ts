import { ClobClient } from "@polymarket/clob-client";
import { Wallet as EthersV5Wallet } from "@polymarket/clob-client/node_modules/ethers";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { shortAddress } from "../../utils/helpers";

let clobClient: ClobClient | null = null;

// Polymarket Data API for fetching positions and portfolio value
const DATA_API_BASE = "https://data-api.polymarket.com";

/**
 * Initializes and returns the Polymarket CLOB client with L2 authentication
 * using Gnosis Safe as the funder.
 *
 * Flow:
 *   1. EOA signer derives API keys (L1 auth)
 *   2. Client is created with signatureType=2 (Gnosis Safe) and funderAddress=Safe
 *   3. The Safe holds funds (USDC + conditional tokens), the EOA signs orders
 *
 * Note: @polymarket/clob-client uses ethers v5 internally. We cast our ethers v6
 * Wallet to `any` because the signing interface is compatible.
 */
export async function getClobClient(): Promise<ClobClient> {
  if (clobClient) return clobClient;

  const privateKey = config.privateKey.startsWith("0x")
    ? config.privateKey
    : `0x${config.privateKey}`;

  // CRITICAL: Use ethers v5 Wallet for the CLOB client.
  // @polymarket/clob-client calls signer._signTypedData() which only exists in ethers v5.
  // ethers v6 renamed it to signTypedData() (no underscore), causing the error.
  const signer = new EthersV5Wallet(privateKey);

  logger.info(
    `Initializing CLOB client | EOA: ${shortAddress(signer.address)} | Safe: ${shortAddress(config.safeAddress)}`
  );

  // Step 1: Create L1 client with Gnosis Safe signature type to derive API keys.
  // The EOA signs, but the Safe is the funder that holds funds on Polymarket.
  const tempClient = new ClobClient(
    config.polymarketApiUrl,
    137, // Polygon mainnet
    signer,
    undefined, // no creds yet
    2, // signatureType: 2 = Gnosis Safe
    config.safeAddress // funderAddress: Safe that holds funds
  );

  // Step 2: Derive or create API credentials for this EOA+Safe pair
  const apiCreds = await tempClient.createOrDeriveApiKey();
  logger.info("API credentials derived for Gnosis Safe");

  // Step 3: Create fully authenticated L2 client with Safe as funder
  clobClient = new ClobClient(
    config.polymarketApiUrl,
    137,
    signer, // ethers v5 Wallet with _signTypedData support
    apiCreds,
    2, // signatureType: 2 = Gnosis Safe
    config.safeAddress // funderAddress: Safe holds the funds
  );

  logger.success(
    `Polymarket CLOB client ready (Gnosis Safe mode) | Safe: ${shortAddress(config.safeAddress)}`
  );
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
