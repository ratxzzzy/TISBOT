import { ethers } from "ethers";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { shortAddress, fromBigIntToNumber } from "../../utils/helpers";
import type { DetectedTransaction } from "../blockchain/monitor";

/**
 * Parsed representation of a Polymarket trade from on-chain data.
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
  /** The exchange contract address */
  exchange: string;
  /** Raw decoded function name */
  functionName: string;
}

// ABI fragments for the CTF Exchange and NegRisk CTF Exchange.
// These are the key functions that represent trade execution.
const EXCHANGE_ABI = [
  // fillOrder(Order order, uint256 fillAmount) - taker fills a maker's order
  "function fillOrder(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) order, uint256 fillAmount)",
  // fillOrders(Order[] orders, uint256[] fillAmounts) - batch fill
  "function fillOrders(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature)[] orders, uint256[] fillAmounts)",
  // matchOrders(Order takerOrder, Order[] makerOrders, uint256 takerFillAmount, uint256[] makerFillAmounts)
  "function matchOrders(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) takerOrder, tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature)[] makerOrders, uint256 takerFillAmount, uint256[] makerFillAmounts)",
];

const exchangeIface = new ethers.Interface(EXCHANGE_ABI);

/**
 * Attempts to parse a Polymarket transaction into a structured trade object.
 * Returns null if the transaction is not a recognized trade operation.
 */
export function parseTransaction(tx: DetectedTransaction): ParsedTrade | null {
  try {
    const toAddress = tx.to.toLowerCase();
    const isNegRisk =
      toAddress === config.contracts.negRiskCtfExchange.toLowerCase();
    const isCtf = toAddress === config.contracts.ctfExchange.toLowerCase();

    if (!isNegRisk && !isCtf) {
      return null;
    }

    const decoded = exchangeIface.parseTransaction({ data: tx.data });
    if (!decoded) {
      logger.debug(`Could not decode tx ${shortAddress(tx.hash)}`);
      return null;
    }

    const fnName = decoded.name;

    if (fnName === "fillOrder") {
      return parseFillOrder(tx, decoded, isNegRisk);
    }

    if (fnName === "fillOrders") {
      return parseFillOrders(tx, decoded, isNegRisk);
    }

    if (fnName === "matchOrders") {
      return parseMatchOrders(tx, decoded, isNegRisk);
    }

    logger.debug(`Unhandled function: ${fnName} in tx ${shortAddress(tx.hash)}`);
    return null;
  } catch (err) {
    logger.debug(
      `Failed to parse tx ${shortAddress(tx.hash)}: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

/**
 * Parses a single fillOrder call.
 * The order tuple contains: [salt, maker, signer, taker, tokenId, makerAmount, takerAmount, ...]
 * Side: 0 = BUY, 1 = SELL (this is the MAKER's side)
 *
 * If our target wallet is filling a BUY order, the target is SELLING to the maker.
 * If our target wallet is filling a SELL order, the target is BUYING from the maker.
 */
function parseFillOrder(
  tx: DetectedTransaction,
  decoded: ethers.TransactionDescription,
  isNegRisk: boolean
): ParsedTrade | null {
  const order = decoded.args[0];
  const fillAmount = decoded.args[1] as bigint;

  const tokenId = order[4].toString() as string;
  const makerAmount = order[5] as bigint;
  const takerAmount = order[6] as bigint;
  const makerSide = Number(order[10]); // 0 = BUY, 1 = SELL

  // Determine what the TARGET wallet (the taker/filler) is doing:
  // If maker side is BUY → maker buys tokens, taker sells tokens → target is SELLING
  // If maker side is SELL → maker sells tokens, taker buys tokens → target is BUYING
  const targetTradeType: "BUY" | "SELL" = makerSide === 0 ? "SELL" : "BUY";

  // Calculate amounts based on fill
  // makerAmount = USDC amount (6 decimals) for BUY side, tokens for SELL side
  // takerAmount = tokens for BUY side, USDC for SELL side
  let amountUsdc: number;
  let shares: number;

  if (makerSide === 0) {
    // Maker is buying tokens with USDC
    // makerAmount = USDC the maker spends, takerAmount = tokens the maker receives
    // fillAmount relates to the fill proportion
    const ratio =
      Number(fillAmount) / Number(takerAmount > 0n ? takerAmount : 1n);
    amountUsdc = fromBigIntToNumber(makerAmount, 6) * ratio;
    shares = fromBigIntToNumber(fillAmount, 6);
  } else {
    // Maker is selling tokens for USDC
    // makerAmount = tokens the maker sells, takerAmount = USDC the maker receives
    const ratio =
      Number(fillAmount) / Number(makerAmount > 0n ? makerAmount : 1n);
    amountUsdc = fromBigIntToNumber(takerAmount, 6) * ratio;
    shares = fromBigIntToNumber(fillAmount, 6);
  }

  const price = shares > 0 ? amountUsdc / shares : 0;

  return {
    txHash: tx.hash,
    tradeType: targetTradeType,
    tokenId,
    amountUsdc,
    shares,
    price,
    isNegRisk,
    exchange: tx.to,
    functionName: "fillOrder",
  };
}

/**
 * Parses fillOrders (batch) — aggregates all fills into a single trade summary.
 */
function parseFillOrders(
  tx: DetectedTransaction,
  decoded: ethers.TransactionDescription,
  isNegRisk: boolean
): ParsedTrade | null {
  const orders = decoded.args[0] as unknown[];
  const fillAmounts = decoded.args[1] as bigint[];

  if (!orders || orders.length === 0) return null;

  // Use the first order to determine token and direction, then aggregate amounts
  const firstOrder = orders[0] as unknown[];
  const tokenId = (firstOrder[4] as bigint).toString();
  const makerSide = Number(firstOrder[10]);
  const targetTradeType: "BUY" | "SELL" = makerSide === 0 ? "SELL" : "BUY";

  let totalUsdc = 0;
  let totalShares = 0;

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i] as unknown[];
    const fillAmount = fillAmounts[i];
    if (!fillAmount) continue;

    const makerAmount = order[5] as bigint;
    const takerAmount = order[6] as bigint;
    const side = Number(order[10]);

    if (side === 0) {
      const ratio =
        Number(fillAmount) / Number(takerAmount > 0n ? takerAmount : 1n);
      totalUsdc += fromBigIntToNumber(makerAmount, 6) * ratio;
      totalShares += fromBigIntToNumber(fillAmount, 6);
    } else {
      const ratio =
        Number(fillAmount) / Number(makerAmount > 0n ? makerAmount : 1n);
      totalUsdc += fromBigIntToNumber(takerAmount, 6) * ratio;
      totalShares += fromBigIntToNumber(fillAmount, 6);
    }
  }

  const price = totalShares > 0 ? totalUsdc / totalShares : 0;

  return {
    txHash: tx.hash,
    tradeType: targetTradeType,
    tokenId,
    amountUsdc: totalUsdc,
    shares: totalShares,
    price,
    isNegRisk,
    exchange: tx.to,
    functionName: "fillOrders",
  };
}

/**
 * Parses matchOrders — the taker order determines the target's trade direction.
 */
function parseMatchOrders(
  tx: DetectedTransaction,
  decoded: ethers.TransactionDescription,
  isNegRisk: boolean
): ParsedTrade | null {
  const takerOrder = decoded.args[0] as unknown[];
  const takerFillAmount = decoded.args[2] as bigint;

  const tokenId = (takerOrder[4] as bigint).toString();
  const takerMakerAmount = takerOrder[5] as bigint;
  const takerTakerAmount = takerOrder[6] as bigint;
  const takerSide = Number(takerOrder[10]);

  // For matchOrders, the takerOrder's side IS what the target wallet wants to do
  const targetTradeType: "BUY" | "SELL" = takerSide === 0 ? "BUY" : "SELL";

  let amountUsdc: number;
  let shares: number;

  if (takerSide === 0) {
    // Target is buying: makerAmount = USDC they spend, takerAmount = tokens they get
    const ratio =
      Number(takerFillAmount) /
      Number(takerMakerAmount > 0n ? takerMakerAmount : 1n);
    amountUsdc = fromBigIntToNumber(takerMakerAmount, 6) * ratio;
    shares = fromBigIntToNumber(takerTakerAmount, 6) * ratio;
  } else {
    // Target is selling: makerAmount = tokens they sell, takerAmount = USDC they receive
    const ratio =
      Number(takerFillAmount) /
      Number(takerMakerAmount > 0n ? takerMakerAmount : 1n);
    shares = fromBigIntToNumber(takerMakerAmount, 6) * ratio;
    amountUsdc = fromBigIntToNumber(takerTakerAmount, 6) * ratio;
  }

  const price = shares > 0 ? amountUsdc / shares : 0;

  return {
    txHash: tx.hash,
    tradeType: targetTradeType,
    tokenId,
    amountUsdc,
    shares,
    price,
    isNegRisk,
    exchange: tx.to,
    functionName: "matchOrders",
  };
}
