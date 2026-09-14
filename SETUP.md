# SETUP.md — Zero to deployed on Arc Testnet (Windows, beginner-friendly)

This guide takes you from a blank Windows machine to a `SpendLogger` contract
deployed on **Arc Testnet**, a running x402-paid service, and an agent that pays
it. Every command is PowerShell. Every value is **testnet**.

> **Golden rules**
> 1. **Testnet only.** If you ever see a mainnet RPC or a USDC address that is
>    not the one listed below, stop.
> 2. **Throwaway wallets.** The two wallets you create here must never hold real
>    money. Their private keys will sit in a local `.env` file.
> 3. **Never paste a private key or seed phrase into a chat, an issue, or a
>    commit.** `.env` is git-ignored — check with `git status` before committing.

---

## Part A — Machine prerequisites

| Tool | Minimum | Check (PowerShell) | Install |
|---|---|---|---|
| Node.js | 22+ (Hardhat 3 requirement) | `node --version` | https://nodejs.org → LTS installer, defaults |
| npm | comes with Node | `npm --version` | — |
| Git | any recent | `git --version` | https://git-scm.com → defaults |
| GitHub CLI | optional, makes Step 8 easy | `gh --version` | https://cli.github.com |

Set your git identity once (used for commit authorship):

```powershell
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

---

## Part B — Wallets (MetaMask)

**Status: done.** Two MetaMask accounts exist, Arc Testnet is added, and both are
funded from https://faucet.circle.com (20 USDC each, verified on-chain 2026-09-14).

| Wallet | Address | Role |
|---|---|---|
| **Arc-Deployer** | `0x52DF4736C94BA91cf7d49b84b642089F85A47C77` | Deploys `SpendLogger`, receives x402 payments, settles them on-chain, calls `logPurchase` |
| **Arc-Agent** | `0xaAf714460A9FbEc7C3f0618cf04E84938b86DC8D` | Pays the service via x402 |

- Explorer: https://testnet.arcscan.app/address/0x52DF4736C94BA91cf7d49b84b642089F85A47C77 · https://testnet.arcscan.app/address/0xaAf714460A9FbEc7C3f0618cf04E84938b86DC8D
- Refill: faucet gives 20 USDC per address every 2 hours. USDC is also gas, so keep both topped up.

<details>
<summary>If you need to redo this from scratch (new machine / new wallets)</summary>

1. Install MetaMask from https://metamask.io, create a wallet, write the 12-word phrase on **paper**.
2. Account menu → *Add a new account* twice; name them `Arc-Deployer` and `Arc-Agent`.
3. Network dropdown → *Add a custom network*: name `Arc Testnet`, RPC `https://rpc.testnet.arc.io`, chain ID `5042002`, symbol `USDC`, explorer `https://testnet.arcscan.app`.
4. https://faucet.circle.com → Arc Testnet → USDC → paste each address.
5. Verify each address on ArcScan shows 20 USDC.

</details>

### Exporting private keys into `.env` (Step 4 tells you when)
1. MetaMask → select the account → **⋮** → **Account details** → **Show private key** → password.
2. Copy the 64-hex key; paste into `C:devarc-spend-tracker.env` after `DEPLOYER_PRIVATE_KEY=` / `AGENT_PRIVATE_KEY=` (add `0x` prefix if missing).
3. Never paste a key anywhere else. `.env` is git-ignored.

---

## Part C — Project setup

### C1. Get the code
```powershell
git clone https://github.com/Reen500/moloko-arc-spend-tracker.git C:\dev\arc-spend-tracker
cd C:\dev\arc-spend-tracker
npm install
```
Installs Hardhat 3 + viem (dev-only, ~150 MB). Takes a minute.

### C2. Compile and test the contract — *Step 3*
```powershell
npx hardhat test
```
Expect `12 passing`. This runs on a local simulated chain; nothing touches Arc.

### C3. Configure `.env`
```powershell
copy .env.example .env
notepad .env
```
Fill in `DEPLOYER_PRIVATE_KEY` (Arc-Deployer) now — see Part B "Exporting private
keys". `AGENT_PRIVATE_KEY` can wait until C6. Save and close. Confirm git ignores it:
```powershell
git status --short    # .env must NOT appear
```

### C4. Deploy to Arc Testnet — *Step 4*
```powershell
npx hardhat run scripts/deploy.js --network arcTestnet
```
Costs ≈ 0.013 USDC in gas. Prints the address, tx hash and ArcScan links, and
writes `deployed.json`. Optional — publish the source so ArcScan shows it:
```powershell
npx hardhat verify blockscout --network arcTestnet <address-from-deployed.json>
```

### C5. Run the paid service — *Step 5*
Terminal 1:
```powershell
cd C:\dev\arc-spend-tracker\service
npm install
npm start
```
You should see `listening http://localhost:3001` plus the payTo and SpendLogger
addresses. Prove the paywall works (expect `402 Payment Required`):
```powershell
curl.exe -i -X POST http://localhost:3001/api/process-description -H "content-type: application/json" -d "{\"description\":\"Receive invoice by email, extract totals, post to Xero.\"}"
```

### C6. Run the paying agent — *Steps 6 and 7*
Put `AGENT_PRIVATE_KEY` (Arc-Agent) into `.env` if it is not there yet. Terminal 2:
```powershell
cd C:\dev\arc-spend-tracker\agent
npm install
node agent.js --dry-run                    # reads the 402, signs nothing
node agent.js                              # one paid call
node agent.js --calls 5 --delay 30-120     # build history, randomly spaced
```
Each call prints two tx hashes with ArcScan links: the USDC payment and the
`logPurchase`. The agent then re-reads the chain to confirm the `PurchaseLogged`
event and its own USDC balance change.

### C7. See it on ArcScan
- Contract → **Logs**: https://testnet.arcscan.app/address/0x683D3D53a86359132ed19BD9270033f31c647f83?tab=logs
- Contract → **Read contract**: `purchaseCount`, `getPurchase(id)`, `totalSpentBy(agent)`
- Free JSON view from the running service: http://localhost:3001/api/ledger

---

## Reference: Arc Testnet values (all official, all testnet)

| Item | Value | Source |
|---|---|---|
| RPC (HTTPS) | `https://rpc.testnet.arc.io` | docs.arc.io |
| RPC (WSS) | `wss://rpc.testnet.arc.io` | docs.arc.io |
| Chain ID | `5042002` (CAIP-2: `eip155:5042002`) | docs.arc.io |
| Native gas token | USDC | docs.arc.io |
| USDC ERC-20 | `0x3600000000000000000000000000000000000000` | docs.arc.io/arc/references/contract-addresses |
| Explorer | `https://testnet.arcscan.app` | docs.arc.io |
| Faucet | `https://faucet.circle.com` (20 USDC / 2 h / address) | faucet.circle.com |
| x402 facilitator | **none public for Arc yet** → the service runs its own (in-process) | docs.x402.org, docs.cdp.coinbase.com |

## Troubleshooting

- **Faucet says "unsupported network"** — pick *Arc Testnet* explicitly in the
  network dropdown; the default is usually another chain.
- **MetaMask "Add network" rejects the chain ID** — make sure it's the decimal
  `5042002`, no spaces.
- **Balance shows in MetaMask but ArcScan shows nothing** — wrong network
  selected in MetaMask. Confirm the dropdown says *Arc Testnet*.
- **"insufficient funds for gas"** on deploy — the Deployer wallet needs USDC
  (it *is* the gas). Hit the faucet again after the 2-hour cooldown.
