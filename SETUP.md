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
Expect `50 passing`. This runs on a local simulated chain; nothing touches Arc.

### C3. Configure `.env`
```powershell
copy .env.example .env
notepad .env
```
Fill in `DEPLOYER_PRIVATE_KEY` (Arc-Deployer) and `AGENT_PRIVATE_KEY` (Arc-Agent) —
see Part B "Exporting private keys". Save and close. Confirm git ignores it:
```powershell
git status --short    # .env must NOT appear
```
If your wallet addresses differ from the ones in this repo, also edit
`policies/arc-agent.json` (`agent`, `controller`, `allowedPayees`) — the agent
refuses to run with a policy written for a different wallet.

### C4. Deploy to Arc Testnet — *Step 4*
```powershell
npx hardhat run scripts/deploy.js --network arcTestnet
```
Costs ≈ 0.03 USDC in gas. Prints the address, tx hash and ArcScan links, and
writes `deployed.json`. Then publish the source so ArcScan decodes your events:
```powershell
npx hardhat verify blockscout --network arcTestnet <address-from-deployed.json>
```

### C5. Bind the agent to its controller and commit the policy
Two small transactions. The first is signed by **Arc-Agent** (it consents to be
governed), the second by **Arc-Deployer** (the controller sets the rulebook).
```powershell
node scripts/policy.js show     # reads what the chain currently says
node scripts/policy.js bind     # Arc-Agent signs setController(agent, controller)   ~0.001 USDC
node scripts/policy.js set      # Arc-Deployer signs setPolicy(agent, hash of policies/arc-agent.json)
node scripts/policy.js show     # should now print "matches file"
```
To change the rules later: edit the JSON, run `set` again. Every purchase
records the hash that was in force when it was logged.

### C6. Run the paid service — *Step 5*
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

### C7. Run the paying agent — *Steps 6 and 7*
Terminal 2:
```powershell
cd C:\dev\arc-spend-tracker\agent
npm install
node agent.js --dry-run                    # reads the 402, shows the policy decision, signs nothing
node agent.js                              # one paid call + outcome record
node agent.js --calls 5 --delay 30-120     # build history, randomly spaced
```
Each call prints three tx hashes with ArcScan links: the USDC payment, the
`logPurchase`, and the agent's `recordOutcome`. The agent checks that the ledger
entry matches what it paid before rating it.

To watch the policy refuse a payment, start a second service at a price above
the cap and point the agent at it:
```powershell
# terminal 3
$env:SERVICE_PORT="3002"; $env:SERVICE_PRICE_BASE_UNITS="50000"; npm start      # $0.05, above the $0.02 cap
# terminal 2
$env:SERVICE_URL="http://localhost:3002"; node agent.js                          # REFUSED by policy rule "maxPerCall"
```

### C8. Prove the ledger matches the money
```powershell
cd C:\dev\arc-spend-tracker
node scripts/reconcile.js        # every agent-to-service USDC transfer must match exactly one PurchaseLogged
```
If the service ever could not write an audit entry (RPC outage), it is queued in
`service/pending-audit.jsonl` and `/health` shows `pendingAudit > 0`. Replay with
`node scripts/replay-audit.js`.

### C9. See it on ArcScan
- Contract → **Logs**: https://testnet.arcscan.app/address/0xD0238CFb58186eC0735de147eB83E4c66F28b94f?tab=logs
- Contract → **Read contract**: `purchaseCount`, `getPurchase(id)`, `policyOf(agent)`, `getOutcome(id)`
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
| Public RPC limit | ~16 concurrent `eth_getLogs` per IP → `-32005 rate limit exceeded`; ~4 concurrent agents is the practical ceiling. Use a keyed RPC via `ARC_TESTNET_RPC` for more. | measured 2026-09-15 |

## Troubleshooting

- **Agent says "Local policy hash does not match the on-chain policy"** — the
  controller committed a different rulebook than the file you have. Get the
  current file, or run `node scripts/policy.js set` as the controller.
- **Agent says "policy check unavailable"** — the public RPC is throttling; the
  agent fails closed on purpose. Wait a minute or set a keyed `ARC_TESTNET_RPC`.
- **`/health` shows `pendingAudit > 0`** — a payment settled but the audit write
  could not reach the chain. Run `node scripts/replay-audit.js`.

- **Faucet says "unsupported network"** — pick *Arc Testnet* explicitly in the
  network dropdown; the default is usually another chain.
- **MetaMask "Add network" rejects the chain ID** — make sure it's the decimal
  `5042002`, no spaces.
- **Balance shows in MetaMask but ArcScan shows nothing** — wrong network
  selected in MetaMask. Confirm the dropdown says *Arc Testnet*.
- **"insufficient funds for gas"** on deploy — the Deployer wallet needs USDC
  (it *is* the gas). Hit the faucet again after the 2-hour cooldown.
