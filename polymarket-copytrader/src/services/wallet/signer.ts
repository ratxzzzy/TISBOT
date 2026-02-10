import { ethers } from "ethers";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { shortAddress } from "../../utils/helpers";

let walletInstance: ethers.Wallet | null = null;

/**
 * Creates and returns a wallet signer connected to the Polygon HTTP provider.
 * Singleton pattern: only creates one instance.
 */
export function getWallet(): ethers.Wallet {
  if (walletInstance) return walletInstance;

  const provider = new ethers.JsonRpcProvider(config.polygonHttpUrl);
  const privateKey = config.privateKey.startsWith("0x")
    ? config.privateKey
    : `0x${config.privateKey}`;

  walletInstance = new ethers.Wallet(privateKey, provider);
  logger.info(`Wallet initialized: ${shortAddress(walletInstance.address)}`);
  return walletInstance;
}

/**
 * Returns the wallet address
 */
export function getWalletAddress(): string {
  return getWallet().address;
}

/**
 * Queries the USDC balance of our wallet on Polygon
 */
export async function getUsdcBalance(): Promise<number> {
  const wallet = getWallet();
  const usdcAbi = ["function balanceOf(address) view returns (uint256)"];
  const usdcContract = new ethers.Contract(
    config.contracts.usdc,
    usdcAbi,
    wallet.provider
  );
  const balance: bigint = await usdcContract.balanceOf(wallet.address);
  // USDC on Polygon has 6 decimals
  return Number(balance) / 1e6;
}

/**
 * Queries MATIC balance for gas
 */
export async function getMaticBalance(): Promise<number> {
  const wallet = getWallet();
  const balance = await wallet.provider!.getBalance(wallet.address);
  return Number(ethers.formatEther(balance));
}
