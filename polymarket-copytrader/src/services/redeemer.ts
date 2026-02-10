import { ethers } from "ethers";
import { config } from "../config";
import { logger } from "../utils/logger";
import { formatUsd } from "../utils/helpers";
import { getPositions, getMarketInfo, type PositionData } from "./polymarket/client";
import { getWallet } from "./wallet/signer";

// Contract addresses
const CTF_ADDRESS = config.contracts.conditionalTokens;
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
const USDC_ADDRESS = config.contracts.usdc;

// Minimal ABIs
const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
];

const NEG_RISK_ABI = [
  "function redeemPositions(bytes32 conditionId, uint256[] amounts)",
];

const SAFE_ABI = [
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function nonce() view returns (uint256)",
];

/**
 * Automatically redeems resolved Polymarket positions to recover USDC.
 *
 * Checks at :01, :16, :31, :46 (1 minute after each 15-min market closes).
 * Uses the Data API's `redeemable` flag to find positions ready to claim,
 * then executes the redemption through the Gnosis Safe.
 */
export class AutoRedeemer {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastRedeemMinute = -1;
  private processing = false;

  start(): void {
    // Check every 30 seconds
    this.interval = setInterval(() => this.tick(), 30_000);
    logger.info(
      "Auto-redeemer started (claims at :01, :16, :31, :46)"
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.processing) return;

    const minute = new Date().getMinutes();

    // Only run at :01, :16, :31, :46 (1 min after market close)
    if (![1, 16, 31, 46].includes(minute)) return;

    // Don't run multiple times in the same minute
    if (minute === this.lastRedeemMinute) return;
    this.lastRedeemMinute = minute;

    this.processing = true;
    try {
      await this.redeemAll();
    } finally {
      this.processing = false;
    }
  }

  /**
   * Checks all positions and redeems any that are resolved.
   */
  async redeemAll(): Promise<void> {
    try {
      const positions = await getPositions(config.safeAddress);
      const redeemable = positions.filter(
        (p) => p.redeemable && parseFloat(p.size) > 0
      );

      if (redeemable.length === 0) {
        logger.debug("No redeemable positions");
        return;
      }

      logger.info(
        `Found ${redeemable.length} redeemable position(s), claiming...`
      );

      // Group by conditionId (a market may have multiple outcome positions)
      const byCondition = new Map<string, PositionData[]>();
      for (const pos of redeemable) {
        const group = byCondition.get(pos.conditionId) || [];
        group.push(pos);
        byCondition.set(pos.conditionId, group);
      }

      let totalRecovered = 0;
      for (const [conditionId, group] of byCondition) {
        try {
          const recovered = await this.redeemCondition(conditionId, group);
          totalRecovered += recovered;
        } catch (err) {
          logger.error(
            `Redeem failed for ${conditionId.slice(0, 10)}...`,
            err instanceof Error ? err.message : err
          );
        }
      }

      if (totalRecovered > 0) {
        logger.success(`Total recovered: ${formatUsd(totalRecovered)}`);
      }
    } catch (err) {
      logger.error(
        "Auto-redeem check failed",
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Redeems a single condition (market) through the Gnosis Safe.
   */
  private async redeemCondition(
    conditionId: string,
    positions: PositionData[]
  ): Promise<number> {
    // Estimate value from position data
    const totalShares = positions.reduce(
      (sum, p) => sum + parseFloat(p.size),
      0
    );
    const title = positions[0]?.title || "Unknown";

    // Check if neg risk via market API
    const market = await getMarketInfo(conditionId);
    const isNegRisk = market?.neg_risk ?? false;

    logger.info(
      `Redeeming: "${title}" | ${totalShares.toFixed(1)} shares | ${isNegRisk ? "neg-risk" : "regular"}`
    );

    let calldata: string;
    let targetContract: string;

    if (isNegRisk && market) {
      // Neg risk: use NegRiskAdapter (auto-unwraps WrappedCollateral → USDC)
      const wallet = getWallet();
      const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet.provider);

      // Get on-chain balances for each outcome token
      const amounts: bigint[] = [];
      for (const token of market.tokens) {
        const bal: bigint = await ctf.balanceOf(
          config.safeAddress,
          token.token_id
        );
        amounts.push(bal);
      }

      const iface = new ethers.Interface(NEG_RISK_ABI);
      calldata = iface.encodeFunctionData("redeemPositions", [
        conditionId,
        amounts,
      ]);
      targetContract = NEG_RISK_ADAPTER;
    } else {
      // Regular: call ConditionalTokens directly → USDC
      const iface = new ethers.Interface(CTF_ABI);
      calldata = iface.encodeFunctionData("redeemPositions", [
        USDC_ADDRESS,
        ethers.ZeroHash, // parentCollectionId = 0
        conditionId,
        [1n, 2n], // both outcomes
      ]);
      targetContract = CTF_ADDRESS;
    }

    // Check Safe USDC balance before and after to calculate recovered amount
    const wallet = getWallet();
    const usdc = new ethers.Contract(
      USDC_ADDRESS,
      ["function balanceOf(address) view returns (uint256)"],
      wallet.provider
    );
    const balanceBefore: bigint = await usdc.balanceOf(config.safeAddress);

    // Execute redemption through the Safe
    await this.executeSafeTx(targetContract, calldata);

    const balanceAfter: bigint = await usdc.balanceOf(config.safeAddress);
    const recovered = Number(balanceAfter - balanceBefore) / 1e6;

    logger.success(
      `Claimed "${title}" → ${formatUsd(recovered)} recovered`
    );
    return recovered;
  }

  /**
   * Executes a transaction through the Gnosis Safe using the EOA owner's signature.
   * Works for 1-of-1 Safe (single owner with threshold=1).
   */
  private async executeSafeTx(to: string, data: string): Promise<void> {
    const wallet = getWallet();
    const safe = new ethers.Contract(config.safeAddress, SAFE_ABI, wallet);

    const nonce: bigint = await safe.nonce();

    // Calculate the Safe transaction hash
    const txHash: string = await safe.getTransactionHash(
      to,
      0n, // value
      data,
      0, // operation: Call
      0n, // safeTxGas
      0n, // baseGas
      0n, // gasPrice
      ethers.ZeroAddress, // gasToken
      ethers.ZeroAddress, // refundReceiver
      nonce
    );

    // Sign with eth_sign (wallet.signMessage adds EIP-191 prefix)
    const signature = await wallet.signMessage(ethers.getBytes(txHash));

    // Adjust v for Gnosis Safe's eth_sign verification: v += 4
    const sig = ethers.Signature.from(signature);
    const adjustedV = sig.v + 4;
    const packedSig = ethers.solidityPacked(
      ["bytes32", "bytes32", "uint8"],
      [sig.r, sig.s, adjustedV]
    );

    // Submit the transaction (EOA pays gas in MATIC)
    const tx = await safe.execTransaction(
      to,
      0n,
      data,
      0, // Call
      0n,
      0n,
      0n,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      packedSig
    );

    const receipt = await tx.wait();
    logger.debug(`Redeem tx: ${receipt.hash}`);
  }
}
