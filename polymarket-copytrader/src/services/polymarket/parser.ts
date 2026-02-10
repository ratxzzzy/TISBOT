/**
 * Parsed representation of a Polymarket trade.
 *
 * Previously this file decoded on-chain calldata. Now trade data comes
 * directly from the Polymarket activity API, so only the interface is needed.
 */
export interface ParsedTrade {
  txHash: string;
  tradeType: "BUY" | "SELL";
  tokenId: string;
  /** Amount in USDC spent/received */
  amountUsdc: number;
  /** Number of shares (outcome tokens) */
  shares: number;
  /** Price per share */
  price: number;
  /** Whether this is on the NegRisk exchange */
  isNegRisk: boolean;
  /** The exchange contract address (empty if from API) */
  exchange: string;
  /** Source of the data */
  functionName: string;
}
