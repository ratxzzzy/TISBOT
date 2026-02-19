import { ethers } from "ethers";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { formatUsd, sleep } from "../../utils/helpers";
import { getPositions, getMarketInfo, type PositionData } from "./client";
import { getWallet, getConditionalTokenBalance } from "../wallet/signer";

// ── Contract addresses ──────────────────────────────────────────────
const USDC_ADDRESS = config.contracts.usdc;
const CTF_ADDRESS = config.contracts.conditionalTokens;
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

// ── ABIs (minimal) ──────────────────────────────────────────────────

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
];

const CTF_REDEEM_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];

const NEG_RISK_REDEEM_ABI = [
  "function redeemPositions(bytes32 conditionId, uint256[] amounts)",
];

// ── AutoClaimer ─────────────────────────────────────────────────────

/**
 * Periodically claims (redeems) resolved winning positions on Polymarket.
 *
 * Only touches positions where `redeemable === true` from the Data API,
 * meaning the market has resolved and we hold winning tokens.
 *
 * Redemption is an on-chain transaction executed through the Gnosis Safe:
 *  - Standard markets → CTF.redeemPositions(USDC, 0x0, conditionId, [1,2])
 *  - NegRisk markets  → NegRiskAdapter.redeemPositions(conditionId, amounts)
 */
export class AutoClaimer {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private claiming = false;

  constructor(intervalMs: number = 2 * 60 * 60 * 1000) {
    this.intervalMs = intervalMs;
  }

  async start(): Promise<void> {
    const hours = (this.intervalMs / (60 * 60 * 1000)).toFixed(1);
    logger.info(`AutoClaimer started — checking every ${hours}h`);

    // Run once immediately, then on interval
    await this.claimAll();

    this.intervalHandle = setInterval(async () => {
      await this.claimAll();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    logger.info("AutoClaimer stopped");
  }

  // ── Main claim cycle ────────────────────────────────────────────

  async claimAll(): Promise<void> {
    if (this.claiming) {
      logger.debug("AutoClaimer: previous cycle still running, skipping");
      return;
    }

    this.claiming = true;
    try {
      logger.info("AutoClaimer: checking for redeemable positions...");

      const positions = await getPositions(config.safeAddress);
      const redeemable = positions.filter((p) => p.redeemable);

      if (redeemable.length === 0) {
        logger.info("AutoClaimer: no redeemable positions");
        return;
      }

      logger.info(
        `AutoClaimer: found ${redeemable.length} redeemable position(s)`
      );

      // Group by conditionId (a condition may have Yes + No positions)
      const byCondition = new Map<string, PositionData[]>();
      for (const pos of redeemable) {
        const arr = byCondition.get(pos.conditionId) || [];
        arr.push(pos);
        byCondition.set(pos.conditionId, arr);
      }

      let claimed = 0;
      for (const [conditionId, condPositions] of byCondition) {
        try {
          const totalValue = condPositions.reduce(
            (sum, p) => sum + parseFloat(p.currentValue || "0"),
            0
          );

          logger.info(
            `AutoClaimer: redeeming "${condPositions[0].title}" — ${condPositions[0].outcome} (${formatUsd(totalValue)})`
          );

          await this.redeemCondition(conditionId, condPositions);
          claimed++;

          // Wait between redemptions to avoid nonce collisions
          if (claimed < byCondition.size) {
            await sleep(5000);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(
            `AutoClaimer: failed to redeem ${conditionId.slice(0, 12)}…: ${msg}`
          );
        }
      }

      if (claimed > 0) {
        logger.success(
          `AutoClaimer: redeemed ${claimed}/${byCondition.size} condition(s)`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`AutoClaimer: error during claim cycle: ${msg}`);
    } finally {
      this.claiming = false;
    }
  }

  // ── Redeem a single condition ───────────────────────────────────

  private async redeemCondition(
    conditionId: string,
    positions: PositionData[]
  ): Promise<void> {
    const isNegRisk = await this.isNegRisk(conditionId);

    const conditionIdHex = conditionId.startsWith("0x")
      ? conditionId
      : `0x${conditionId}`;

    let calldata: string;
    let target: string;

    if (isNegRisk) {
      calldata = await this.buildNegRiskCalldata(conditionIdHex, positions);
      target = NEG_RISK_ADAPTER;
    } else {
      calldata = this.buildStandardCalldata(conditionIdHex);
      target = CTF_ADDRESS;
    }

    await this.executeSafeTransaction(target, calldata);
  }

  // ── Build calldata ──────────────────────────────────────────────

  /**
   * Standard markets: redeemPositions(USDC, 0x0, conditionId, [1, 2])
   * Passing both index sets [1, 2] is safe — only the winning outcome pays.
   */
  private buildStandardCalldata(conditionIdHex: string): string {
    const iface = new ethers.Interface(CTF_REDEEM_ABI);
    return iface.encodeFunctionData("redeemPositions", [
      USDC_ADDRESS,
      ethers.ZeroHash, // parentCollectionId
      conditionIdHex,
      [1n, 2n], // indexSets: Yes=1, No=2
    ]);
  }

  /**
   * NegRisk markets: redeemPositions(conditionId, amounts[])
   * amounts is indexed by outcome: [amountYes, amountNo]
   * We query the on-chain ERC-1155 balance for each token.
   */
  private async buildNegRiskCalldata(
    conditionIdHex: string,
    positions: PositionData[]
  ): Promise<string> {
    // Build amounts array from actual on-chain balances
    // outcome "Yes" = index 0, "No" = index 1
    const amounts: bigint[] = [0n, 0n];

    for (const pos of positions) {
      const balance = await getConditionalTokenBalance(pos.asset);
      const idx = pos.outcome === "Yes" ? 0 : 1;
      amounts[idx] = balance;
    }

    const iface = new ethers.Interface(NEG_RISK_REDEEM_ABI);
    return iface.encodeFunctionData("redeemPositions", [
      conditionIdHex,
      amounts,
    ]);
  }

  // ── Safe transaction execution ──────────────────────────────────

  /**
   * Executes a transaction through the Gnosis Safe.
   *
   * The EOA signs the Safe transaction hash using eth_sign (v += 4).
   * Gas is paid by the EOA in MATIC (Polygon gas is ~$0.001).
   */
  private async executeSafeTransaction(
    to: string,
    data: string
  ): Promise<void> {
    const wallet = getWallet();
    const safeContract = new ethers.Contract(
      config.safeAddress,
      SAFE_ABI,
      wallet
    );

    const nonce: bigint = await safeContract.nonce();

    // Compute the Safe's EIP-712 transaction hash
    const txHash: string = await safeContract.getTransactionHash(
      to,
      0, // value
      data,
      0, // operation: CALL
      0, // safeTxGas
      0, // baseGas
      0, // gasPrice
      ethers.ZeroAddress, // gasToken
      ethers.ZeroAddress, // refundReceiver
      nonce
    );

    // Sign with eth_sign: wallet.signMessage adds "\x19Ethereum Signed Message:\n32" prefix.
    // Gnosis Safe expects v + 4 to indicate this signature type.
    const rawSig = await wallet.signMessage(ethers.getBytes(txHash));
    const sig = ethers.Signature.from(rawSig);
    const adjustedV = sig.v + 4; // 27→31 or 28→32

    const packedSig = ethers.solidityPacked(
      ["bytes32", "bytes32", "uint8"],
      [sig.r, sig.s, adjustedV]
    );

    // Execute the transaction on-chain
    const tx = await safeContract.execTransaction(
      to,
      0, // value
      data,
      0, // operation
      0, // safeTxGas
      0, // baseGas
      0, // gasPrice
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      packedSig
    );

    const receipt = await tx.wait();
    logger.success(
      `AutoClaimer: tx confirmed block ${receipt.blockNumber} (${receipt.hash})`
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async isNegRisk(conditionId: string): Promise<boolean> {
    try {
      const market = await getMarketInfo(conditionId);
      return market?.neg_risk ?? false;
    } catch {
      return false;
    }
  }
}
