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
- A Gnosis Safe on Polygon with USDC (for trades)
- An EOA wallet that is an owner of the Safe (needs MATIC for gas)

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
| `PRIVATE_KEY` | EOA private key - owner of the Safe (without 0x prefix) |
| `SAFE_ADDRESS` | Gnosis Safe address that holds USDC funds |
| `EOA_ADDRESS` | EOA address (must be an owner of the Safe) |
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

## Gnosis Safe Integration

The bot operates through a Gnosis Safe for enhanced security:

- **Safe** (`SAFE_ADDRESS`): Holds all funds (USDC + conditional tokens). This is the `funderAddress` in Polymarket's CLOB API.
- **EOA** (`EOA_ADDRESS`): An owner of the Safe that signs orders. Needs MATIC for gas.
- **Signature Type**: `2` (Gnosis Safe) - the CLOB client uses the EOA to sign and references the Safe as the funder.

### Prerequisites for Safe

1. The EOA must be an owner (or delegate) of the Gnosis Safe
2. The Safe must have USDC on Polygon
3. The Safe must have approved the Polymarket Exchange contracts to spend USDC
4. The EOA needs MATIC on Polygon for gas fees

## Deploying on Vultr (VPS)

### Step 1: SSH into the server

```bash
ssh root@216.238.80.126
# Enter your password or use SSH key
```

### Step 2: Install Node.js on the server

```bash
# Install nvm (Node Version Manager)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc

# Install Node.js 20 LTS
nvm install 20
nvm use 20
node --version  # should show v20.x
```

### Step 3: Clone and setup the project

```bash
cd ~
git clone <your-repo-url> polymarket-copytrader
cd polymarket-copytrader
npm install
cp .env.example .env
nano .env  # edit with your real credentials
```

### Step 4: Run with PM2 (process manager, keeps bot alive)

```bash
# Install PM2 globally
npm install -g pm2

# Build the project
npm run build

# Start with PM2
pm2 start dist/index.js --name "copytrader"

# Useful PM2 commands:
pm2 logs copytrader     # View live logs
pm2 status              # Check if running
pm2 restart copytrader  # Restart
pm2 stop copytrader     # Stop

# Auto-start on server reboot
pm2 startup
pm2 save
```

### Step 5: Connect with VS Code Remote SSH

1. Install the **Remote - SSH** extension in VS Code
2. Open VS Code, press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
3. Type **"Remote-SSH: Connect to Host..."**
4. Enter: `root@216.238.80.126`
5. Enter your password when prompted
6. Once connected, open the folder: `/root/polymarket-copytrader`

**To avoid typing password every time, set up SSH keys:**

```bash
# On your LOCAL machine (not the server):
ssh-keygen -t ed25519 -C "your_email@example.com"
ssh-copy-id root@216.238.80.126
```

After this, VS Code will connect without asking for a password.

### VS Code SSH Config (optional, for easy reconnect)

Add this to your local `~/.ssh/config`:

```
Host vultr-copytrader
    HostName 216.238.80.126
    User root
    IdentityFile ~/.ssh/id_ed25519
```

Then in VS Code Remote-SSH you'll see "vultr-copytrader" as a saved host.

### Step 6: Monitor the bot

```bash
# Live logs
pm2 logs copytrader --lines 50

# Check budget state
cat ~/polymarket-copytrader/budget-state.json

# Restart if needed
pm2 restart copytrader
```
