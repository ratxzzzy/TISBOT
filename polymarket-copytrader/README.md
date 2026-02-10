# Polymarket CopyTrader Bot

A TypeScript/Node.js bot that monitors a target wallet on Polymarket and automatically copies its trades proportionally to your budget.

## How it works

1. Connects to Polygon via WebSocket and monitors all transactions from the target wallet
2. Filters for Polymarket exchange interactions (CTF Exchange + NegRisk CTF Exchange)
3. Parses on-chain calldata to extract trade details (buy/sell, token, amount, price)
4. Calculates a proportional trade size based on: `your_budget / target_portfolio_value`
5. Executes the copy trade via the Polymarket CLOB API with price validation
6. Persists budget state to disk for crash recovery

## Architecture

```
src/
  config/index.ts            - Centralized configuration from .env
  services/
    blockchain/
      provider.ts            - Polygon RPC connections (WS + HTTP)
      monitor.ts             - Block-by-block transaction monitoring
    polymarket/
      client.ts              - CLOB API client + Data API for positions
      parser.ts              - Decodes exchange contract calldata
      executor.ts            - Places orders with price validation
    wallet/
      signer.ts              - Wallet management, balance checks
  core/
    copier.ts                - Main copytrading orchestrator
    portfolio.ts             - Budget management, ratio calculation
    queue.ts                 - Sequential trade execution queue
  utils/
    logger.ts                - Colored terminal logging
    helpers.ts               - Utility functions
  index.ts                   - Entry point
```

## Setup

### Prerequisites

- Node.js 18+
- An Alchemy or Infura API key with Polygon WebSocket access
- A wallet with USDC on Polygon (for trades) and some MATIC (for gas)

### Installation

```bash
cd polymarket-copytrader
npm install
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Description |
|----------|-------------|
| `POLYGON_RPC_URL` | Polygon WebSocket RPC (e.g. `wss://polygon-mainnet.g.alchemy.com/v2/KEY`) |
| `POLYGON_HTTP_URL` | Polygon HTTP RPC (e.g. `https://polygon-mainnet.g.alchemy.com/v2/KEY`) |
| `PRIVATE_KEY` | Your wallet private key (without 0x prefix) |
| `WALLET_TO_COPY` | Target wallet address to monitor |
| `TOTAL_BUDGET_USDC` | Your total budget in USDC (default: 400) |
| `MIN_TRADE_SIZE_USDC` | Minimum trade size in USDC (default: 2) |
| `MAX_SINGLE_TRADE_USDC` | Maximum per-trade cap in USDC (default: 50) |
| `SLIPPAGE_TOLERANCE` | Slippage tolerance in % (default: 2) |

### Run

```bash
# Development (with hot reload via tsx)
npm run dev

# Production
npm run build
npm start
```

## Budget Management

The bot uses proportional scaling:

- **Ratio** = `your_budget / target_wallet_portfolio_value`
- **Copy size** = `original_trade_size * ratio`
- Trades below `MIN_TRADE_SIZE_USDC` are skipped
- Trades are capped at `MAX_SINGLE_TRADE_USDC`
- Budget state is saved to `budget-state.json` and restored on restart
- The target portfolio value is refreshed every hour

Example: Target has $10,000 in positions, your budget is $400.
- Ratio = 4%
- Target buys $500 of YES shares -> you buy $20

## Price Protection

The executor validates prices against the live order book before executing:

- Rejects trades where the target price deviates >10% from the best bid/ask
- Applies configurable slippage tolerance
- Uses FOK (Fill-Or-Kill) for buys to ensure exact fill or no fill
- Uses GTC (Good-Til-Cancelled) limit orders for sells

## Contracts Monitored

| Contract | Address |
|----------|---------|
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| NegRisk CTF Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| USDC (Polygon) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
