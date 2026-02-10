import { ethers } from "ethers";
import WebSocket from "ws";
import { config } from "../../config";
import { logger } from "../../utils/logger";

let wsProvider: ethers.WebSocketProvider | null = null;
let httpProvider: ethers.JsonRpcProvider | null = null;

/**
 * Returns a JSON-RPC HTTP provider for Polygon.
 */
export function getHttpProvider(): ethers.JsonRpcProvider {
  if (!httpProvider) {
    httpProvider = new ethers.JsonRpcProvider(config.polygonHttpUrl);
    logger.info("HTTP provider connected to Polygon");
  }
  return httpProvider;
}

/**
 * Creates a WebSocket provider for Polygon with auto-reconnect.
 * Uses the raw `ws` library underneath ethers to handle reconnection.
 */
export function createWsProvider(
  onReconnect?: () => void
): ethers.WebSocketProvider {
  const wsUrl = config.polygonWsUrl;

  const provider = new ethers.WebSocketProvider(wsUrl);

  // Access the underlying WebSocket to handle close/error events
  const rawWs = (provider as unknown as { _websocket: WebSocket })._websocket;
  if (rawWs) {
    rawWs.on("close", () => {
      logger.warn("WebSocket connection closed, reconnecting...");
      wsProvider = null;
      setTimeout(() => {
        wsProvider = createWsProvider(onReconnect);
        if (onReconnect) onReconnect();
      }, config.wsReconnectDelayMs);
    });

    rawWs.on("error", (err: Error) => {
      logger.error("WebSocket error", err.message);
    });
  }

  wsProvider = provider;
  logger.info("WebSocket provider connected to Polygon");
  return provider;
}

/**
 * Returns the current WS provider, creating one if needed.
 */
export function getWsProvider(
  onReconnect?: () => void
): ethers.WebSocketProvider {
  if (!wsProvider) {
    return createWsProvider(onReconnect);
  }
  return wsProvider;
}

/**
 * Gracefully closes all providers
 */
export async function closeProviders(): Promise<void> {
  if (wsProvider) {
    await wsProvider.destroy();
    wsProvider = null;
  }
  if (httpProvider) {
    httpProvider.destroy();
    httpProvider = null;
  }
  logger.info("All providers closed");
}
