import { ethers } from "ethers";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { shortAddress } from "../../utils/helpers";

let walletInstance: ethers.Wallet | null = null;

/**
 * Creates and returns the EOA wallet signer connected to the Polygon HTTP provider.
 * This EOA is an owner of the Gnosis Safe and signs orders on its behalf.
 * Singleton pattern: only creates one instance.
 */
export function getWallet(): ethers.Wallet {
  if (walletInstance) return walletInstance;

  const provider = new ethers.JsonRpcProvider(config.polygonHttpUrl);
  const privateKey = config.privateKey.startsWith("0x")
    ? config.privateKey
    : `0x${config.privateKey}`;

  walletInstance = new ethers.Wallet(privateKey, provider);
  logger.info(
    `EOA signer initialized: ${shortAddress(walletInstance.address)} | Safe: ${shortAddress(config.safeAddress)}`
  );
  return walletInstance;
}

/**
 * Returns the EOA wallet address (signer)
 */
export function getWalletAddress(): string {
  return getWallet().address;
}

/**
 * Returns the Gnosis Safe address (where funds are held)
 */
export function getSafeAddress(): string {
  return config.safeAddress;
}

/**
 * Queries the USDC balance of the Gnosis Safe on Polygon.
 * Funds are held in the Safe, not in the EOA.
 */
export async function getUsdcBalance(): Promise<number> {
  const wallet = getWallet();
  const usdcAbi = ["function balanceOf(address) view returns (uint256)"];
  const usdcContract = new ethers.Contract(
    config.contracts.usdc,
    usdcAbi,
    wallet.provider
  );
  // Query the Safe balance (funds are in the Safe)
  const balance: bigint = await usdcContract.balanceOf(config.safeAddress);
  // USDC on Polygon has 6 decimals
  return Number(balance) / 1e6;
}

/**
 * Queries USDC balance of the EOA (needed for direct gas spending)
 */
export async function getEoaUsdcBalance(): Promise<number> {
  const wallet = getWallet();
  const usdcAbi = ["function balanceOf(address) view returns (uint256)"];
  const usdcContract = new ethers.Contract(
    config.contracts.usdc,
    usdcAbi,
    wallet.provider
  );
  const balance: bigint = await usdcContract.balanceOf(wallet.address);
  return Number(balance) / 1e6;
}

/**
 * Queries MATIC balance of EOA for gas fees
 */
export async function getMaticBalance(): Promise<number> {
  const wallet = getWallet();
  const balance = await wallet.provider!.getBalance(wallet.address);
  return Number(ethers.formatEther(balance));
}

/**
 * Queries MATIC balance of the Gnosis Safe
 */
export async function getSafeMaticBalance(): Promise<number> {
  const wallet = getWallet();
  const balance = await wallet.provider!.getBalance(config.safeAddress);
  return Number(ethers.formatEther(balance));
}

/**
 * Queries the ERC-1155 balance of a conditional token in the Gnosis Safe.
 * Used to check if we hold tokens before attempting a SELL.
 * Returns the raw token balance (not USDC-denominated).
 */
export async function getConditionalTokenBalance(tokenId: string): Promise<bigint> {
  const wallet = getWallet();
  const ctf = new ethers.Contract(
    config.contracts.conditionalTokens,
    ["function balanceOf(address owner, uint256 id) view returns (uint256)"],
    wallet.provider
  );
  return await ctf.balanceOf(config.safeAddress, tokenId);
}
