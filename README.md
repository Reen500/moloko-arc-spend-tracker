# Arc Spend Tracker

**An on-chain audit log for autonomous-agent purchases, on Circle's Arc L1.**

Agents are starting to buy things — API calls, data, compute — and pay for them
with stablecoins over [x402](https://x402.org). Once that becomes a business
operation, someone has to govern, reconcile and audit it. This is v0 of that
layer: a tiny Solidity ledger, an x402-paid service that writes to it, and an
agent that pays.

```
┌─────────────┐   402 + price     ┌──────────────────┐   logPurchase()   ┌──────────────┐
│  Arc-Agent  │ ───────────────▶  │  service         │ ───────────────▶  │  SpendLogger │
│  (wallet)   │ ◀───────────────  │  (Arc-Deployer)  │                   │  (contract)  │
│             │   200 + plan      │  in-process x402 │                   │  Arc Testnet │
└─────────────┘                   │  facilitator     │                   └──────────────┘
       │        USDC.transferWithAuthorization (0.01 USDC)      ▲
       └────────────────────────────────────────────────────────┘
```

Every paid call leaves two transactions on Arc Testnet, both signed by real
wallets: the USDC transfer (agent → service) and a `PurchaseLogged` event that
records who paid whom, how much, and for what.

## Live on Arc Testnet

| | |
|---|---|
| `SpendLogger` | [`0x683D3D53a86359132ed19BD9270033f31c647f83`](https://testnet.arcscan.app/address/0x683D3D53a86359132ed19BD9270033f31c647f83) — source verified |
| Deploy tx | [`0xf041afee…5343`](https://testnet.arcscan.app/tx/0xf041afee453f41cf227635cd7a938da25aa27094f9172db6fbe935cdd2215343) |
| First paid call | payment [`0xc6e99470…1055`](https://testnet.arcscan.app/tx/0xc6e99470f6fc7638b7316b63bc7cd65bcc6922be0aed6fab2fc889380ac71055) · log [`0x62547ac0…3e3b`](https://testnet.arcscan.app/tx/0x62547ac029cc6ebbaf3271fa1d6e4defa3e2e9cb3d080099a3cdab96e7c43e3b) |
| Events | [Logs tab](https://testnet.arcscan.app/address/0x683D3D53a86359132ed19BD9270033f31c647f83?tab=logs) — `PurchaseLogged` #0…#5 and counting |
| Service wallet | [`0x52DF4736…7C77`](https://testnet.arcscan.app/address/0x52DF4736C94BA91cf7d49b84b642089F85A47C77) (Arc-Deployer) |
| Agent wallet | [`0xaAf71446…DC8D`](https://testnet.arcscan.app/address/0xaAf714460A9FbEc7C3f0618cf04E84938b86DC8D) (Arc-Agent) |

## What's in the box

| Path | What |
|---|---|
| [`contracts/SpendLogger.sol`](contracts/SpendLogger.sol) | Permissionless ledger. `logPurchase(agent, service, amount, memo)` → `PurchaseLogged`. Per-address totals. No owner, holds no funds, no token. |
| [`test/SpendLogger.test.js`](test/SpendLogger.test.js) | 12 Hardhat tests (node:test + viem). |
| [`scripts/deploy.js`](scripts/deploy.js) | Testnet-only deploy; writes `deployed.json`. |
| [`service/`](service/) | Express + `@x402/express`. `POST /api/process-description` costs $0.01 USDC; after settlement it calls `logPurchase`. Runs its **own x402 facilitator in-process** because no public one supports Arc yet. |
| [`agent/`](agent/) | `@x402/fetch` client. Discover → guard → pay → call → verify on-chain. `--calls N --delay 30-120`. |
| [`shared/arc.js`](shared/arc.js) | Arc Testnet chain definition, USDC address + EIP-712 domain, ABIs. |
| [`SETUP.md`](SETUP.md) | Zero-to-deployed for a beginner on Windows. |

## Quick start

```powershell
git clone https://github.com/Reen500/moloko-arc-spend-tracker.git
cd moloko-arc-spend-tracker
npm install
npx hardhat test                                   # 12 passing

copy .env.example .env                             # then fill in the two private keys (testnet-only!)
npx hardhat run scripts/deploy.js --network arcTestnet

cd service; npm install; npm start                 # http://localhost:3001  (terminal 1)
cd agent;   npm install; node agent.js --calls 5   # pays, calls, prints tx hashes  (terminal 2)
```

Full walkthrough, including MetaMask and faucet steps: [SETUP.md](SETUP.md).

## Arc Testnet facts used here

All from [docs.arc.io](https://docs.arc.io/arc/references/connect-to-arc); nothing is mainnet.

| | |
|---|---|
| Chain ID | `5042002` (`eip155:5042002`) |
| RPC | `https://rpc.testnet.arc.io` |
| Gas token | USDC (native, 18 dec) — same balance as the ERC-20 view (6 dec) at `0x3600000000000000000000000000000000000000` |
| USDC EIP-712 domain | `name: "USDC", version: "2"` — read from chain, `DOMAIN_SEPARATOR` reconstructed and matched |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com (20 USDC / address / 2 h) |

## Design notes

- **Why is the facilitator in-process?** x402's `exact` scheme needs a
  facilitator to verify the EIP-3009 signature and submit
  `transferWithAuthorization`. As of Sept 2026 neither x402.org's nor Coinbase's
  hosted facilitator lists Arc. Arc USDC is a standard Circle `FiatTokenV2_2`,
  so `@x402/core`'s facilitator works unchanged — the service just runs it
  itself, signing settlement with the same wallet that receives the payment.
  Swapping to a hosted facilitator later is a one-line change
  (`HTTPFacilitatorClient({ url })`).
- **Why is `logPurchase` permissionless?** In an x402 trade either side can
  attest. The `reporter` field records who did. Enterprise deployments would
  index by reporter and apply their own trust rules.
- **What this is not.** No token, no rewards, no staking, no launchpad. Circle
  asked Arc builders not to ship speculative token features; this is
  infrastructure.
- **Porting to Arc mainnet** when it opens: chain id, RPC, USDC address in
  `shared/arc.js` and `hardhat.config.js`. Nothing else changes.

## Roadmap (v1 thinking)

- Policy layer: per-agent budgets and allow-lists enforced *before* signing
- Reconciliation: match `PurchaseLogged` ↔ USDC `Transfer` ↔ service receipts
- Exports: CSV / accounting-system connectors (the enterprise-ops angle)
- Replace the heuristic planner with a real model behind the same interface

## License

MIT — Moloko Labs.
