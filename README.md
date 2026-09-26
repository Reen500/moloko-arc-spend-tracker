# Arc Spend Tracker

**An on-chain audit log for autonomous-agent purchases, on Circle's Arc L1 —
with the spending policy each agent was operating under, and the buyer's own
record of what it got.**

Agents are starting to buy things — API calls, data, compute — and pay for them
with stablecoins over [x402](https://x402.org). Once that becomes a business
operation, someone has to govern, reconcile and audit it. This is v0 of that
layer: a small Solidity ledger, an x402-paid service that writes to it, an agent
that refuses to pay outside its rulebook, and a reconciliation tool that proves
the ledger matches the money.

```
                 policy.json ──hash──▶ setPolicy() (controller only)
                      │                        │
┌─────────────┐   402 + price     ┌──────────────────┐   logPurchase(…, policyHash)   ┌──────────────┐
│  agent      │ ───────────────▶  │  service         │ ────────────────────────────▶  │  SpendLogger │
│  checks     │ ◀───────────────  │  (Arc-Service)   │                                │  v2          │
│  policy,    │   200 + plan      │  in-process x402 │       recordOutcome(id, 0-5)   │  Arc Mainnet │
│  then signs │ ──────────────────┼──────────────────┼─────────────────────────────▶  │              │
└─────────────┘                   │  facilitator     │                                └──────────────┘
       │        USDC.transferWithAuthorization ($0.01)     ▲
       └────────────────────────────────────────────────────┘
```

Every paid call leaves three transactions on Arc, all signed by real wallets:
the USDC transfer (agent → service), a `PurchaseLogged` event carrying the
policy hash in force, and the agent's `OutcomeRecorded` score.

## Live on Arc Mainnet

| | |
|---|---|
| **Public ledger** | **https://service-production-33b0.up.railway.app**: every purchase, the policy it ran under, and the buyer's rating, read live from the contract |
| **Service** (x402, $0.01 USDC per call) | `POST /api/process-description` on the same host · [`/health`](https://service-production-33b0.up.railway.app/health) · [`/api/ledger`](https://service-production-33b0.up.railway.app/api/ledger) · [`/api/policy`](https://service-production-33b0.up.railway.app/api/policy) |
| `SpendLogger` **v2** | [`0x3afcBef1C1cC1DED0550a24Abd8dfA8c377C9aDd`](https://explorer.arc.io/address/0x3afcBef1C1cC1DED0550a24Abd8dfA8c377C9aDd) — runtime bytecode identical to the source-verified testnet v2 · deployed in [`0x7ed932ae…339a`](https://explorer.arc.io/tx/0x7ed932ae3828315258676b7bffc62581143d789685338f241d9d511b3b74339a) |
| Agent's policy | [`policies/arc-agent-mainnet.json`](policies/arc-agent-mainnet.json) → `0x15156bec…b5bc` ($0.02 per call, $0.50 per day, one allowed payee), committed by the controller in [`0x6a1e94c9…32e1`](https://explorer.arc.io/tx/0x6a1e94c98cc740202281ce2870ea1906277a729229485d1d6b7013e39b8132e1) |
| Controller (Arc-Owner) | [`0x37B2E138…6cB3`](https://explorer.arc.io/address/0x37B2E138337445A3288015e10C880b69401D6cB3). Deployed the contract and set the policy, signing in MetaMask; its key is never on disk. |
| Service wallet (Arc-Service) | [`0xa29Ffc6C…3CB8`](https://explorer.arc.io/address/0xa29Ffc6C04012678b5Cc2115587689F409673CB8). Receives payments, settles them, logs them. |
| Agent wallet (Arc-Agent-MN) | [`0x76c60B33…58a0`](https://explorer.arc.io/address/0x76c60B33cBa6Db251d7FedA4f7f09363c85f58a0) |

As of 26 Sept 2026: 12 paid calls, each paid, logged and rated. The latest one
went through the hosted service on Railway. `reconcile.js` on mainnet matches
every USDC payment to exactly one ledger entry. An offer above the per-call
limit ($0.05) was refused before signing, with nothing sent.

### Call it

```powershell
node agent/agent.js --network arcMainnet --service https://service-production-33b0.up.railway.app --calls 1
```

The agent needs an Arc Mainnet wallet with a little USDC and a policy that
lists the service wallet as a payee. Any x402 client that can sign an EIP-3009
`transferWithAuthorization` for Arc USDC works too: `POST /api/process-description`
with `{"description": "…"}`, answer the 402, and your purchase appears in the ledger.

## Testnet history

| | |
|---|---|
| `SpendLogger` **v2** | [`0xD0238CFb58186eC0735de147eB83E4c66F28b94f`](https://testnet.arcscan.app/address/0xD0238CFb58186eC0735de147eB83E4c66F28b94f) — source verified · [Logs](https://testnet.arcscan.app/address/0xD0238CFb58186eC0735de147eB83E4c66F28b94f?tab=logs) |
| `SpendLogger` v1 (ledger only) | [`0x683D3D53a86359132ed19BD9270033f31c647f83`](https://testnet.arcscan.app/address/0x683D3D53a86359132ed19BD9270033f31c647f83) — first 6 paid calls live here |
| Agent's policy | [`policies/arc-agent.json`](policies/arc-agent.json) → `0x569b59c8…5031`, committed by the controller in [`0x664660fc…72ce`](https://testnet.arcscan.app/tx/0x664660fca512b906312c7c87644c4d44d0b086101284a04ff56b715c692e72ce) |
| Service wallet / controller | [`0x52DF4736…7C77`](https://testnet.arcscan.app/address/0x52DF4736C94BA91cf7d49b84b642089F85A47C77) (Arc-Deployer) |
| Agent wallet | [`0xaAf71446…DC8D`](https://testnet.arcscan.app/address/0xaAf714460A9FbEc7C3f0618cf04E84938b86DC8D) (Arc-Agent) |

As of 15 Sept 2026: 48 paid calls on testnet v2, every one reconciled against
its USDC transfer. Every policy case in *What was tested* below ran there first.

## What's in the box

| Path | What |
|---|---|
| [`contracts/SpendLogger.sol`](contracts/SpendLogger.sol) | v2 ledger. `logPurchase` → `PurchaseLogged` (with `policyHash`). `setController` / `setPolicy` for policy attestation. `recordOutcome` (0–5, once, by the buyer). No owner, holds no funds, no token. |
| [`test/`](test/) | 50 tests: contract (33), policy engine + UTC rollover (11), end-to-end policy flow on a local chain (6). |
| [`policies/`](policies/) | Rulebooks. `arc-agent-mainnet.json` is live on mainnet, `arc-agent.json` on testnet; `-tight.json` was used for the daily-cap trial. |
| [`shared/policy.js`](shared/policy.js) | Canonical JSON → keccak256 policy hash; `evaluate(policy, offer, spentToday)`; day-boundary helpers. |
| [`shared/arc.js`](shared/arc.js) | Both Arc networks (picked by `ARC_NETWORK` or `--network`), USDC address + EIP-712 domain, per-network keys, ABIs, retrying RPC transport. |
| [`service/`](service/) | Express + `@x402/express`. `POST /api/process-description` costs $0.01 USDC; runs its **own x402 facilitator in-process**; logs to `SpendLogger` after settlement with retry + durable fallback. |
| [`agent/`](agent/) | `@x402/fetch` client. Verifies its policy hash against the chain, refuses out-of-policy offers **before signing**, pays, checks the ledger entry matches, rates the result. Trial drivers for policy and concurrency. |
| [`scripts/deploy.js`](scripts/deploy.js) · [`policy.js`](scripts/policy.js) · [`reconcile.js`](scripts/reconcile.js) · [`replay-audit.js`](scripts/replay-audit.js) | Deploy (testnet) · bind/set policy · prove ledger ↔ payments · replay any audit entry the service couldn't write. |
| [`scripts/owner-sign.js`](scripts/owner-sign.js) | Mainnet owner actions (deploy, set policy) on a one-shot local page, signed in MetaMask. |
| [`railway.json`](railway.json) | Hosting config for the service: build, start, `/health` check. |
| [`SETUP.md`](SETUP.md) | Zero-to-deployed for a beginner on Windows. |

## Quick start

```powershell
git clone https://github.com/Reen500/moloko-arc-spend-tracker.git
cd moloko-arc-spend-tracker
npm install
npx hardhat test                                   # 50 passing

copy .env.example .env                             # fill in the two private keys (testnet-only!)
npx hardhat run scripts/deploy.js --network arcTestnet
node scripts/policy.js bind                        # agent binds to its controller   (Arc-Agent signs)
node scripts/policy.js set                         # controller commits policy hash  (Arc-Deployer signs)

cd service; npm install; npm start                 # http://localhost:3001  (terminal 1)
cd agent;   npm install; node agent.js --calls 5   # pays, calls, rates, prints tx hashes  (terminal 2)
node ..\scripts\reconcile.js                       # every payment ↔ one ledger entry
```

Full walkthrough, including MetaMask and faucet steps: [SETUP.md](SETUP.md).
Every command takes `--network arcMainnet` (or set `ARC_NETWORK`). The
mainnet path is in [SETUP.md, Part D](SETUP.md#part-d--arc-mainnet).

## Running on mainnet: how the keys are split

| Wallet | Key lives | Can do |
|---|---|---|
| Arc-Owner (controller) | MetaMask only, separate seed | Deploy; set or rotate the agent's policy |
| Arc-Service | Railway sealed variable | Receive, settle, log. Holds a few USDC. |
| Arc-Agent-MN | Local `.env` | Pay, within its on-chain policy |

The mainnet wallets come from a new seed phrase, not the testnet one. Testnet
keys sat in a plaintext `.env`, and MetaMask accounts from the same seed are
not isolated from each other. The contract has no owner, so the service's hot
key can't change anyone's policy; only the controller can.

The free routes (`/health`, `/api/ledger`) are rate-limited per IP (60 a
minute) and the ledger is cached for 15 s. That's because the public RPC's
rate limit is shared with settlement, and a flood of free reads mustn't starve
paid calls.

## How the policy layer works

1. A **rulebook** (`policies/arc-agent.json`): `maxPerCall`, `dailyCap`,
   `allowedPayees`, `asset`, `network`. Hashed canonically (sorted keys) so
   anyone can recompute the fingerprint from the file.
2. The agent **binds itself to a controller** once (`setController`). After that
   only the controller can change the agent's policy or transfer control.
3. The **controller commits the hash** on-chain (`setPolicy`). The agent refuses
   to start if its local file doesn't hash to what the chain says.
4. Before signing any payment the agent evaluates the 402 offer against the
   rulebook inside x402's `onBeforePaymentCreation` hook. A refusal aborts
   there — **no signature exists**, so no money can move. If the chain can't be
   read to check the daily cap, the agent fails closed.
5. Every `logPurchase` records `policyOf[agent]` at that moment, so an auditor
   can open the rulebook a given purchase claims and check it.
6. The buyer records an **outcome** (0–5 + reason hash) against the purchase —
   its own procurement record, not a public reputation score.

This is **attestation, not on-chain enforcement**: a rogue agent that ignores
its rulebook would produce a ledger entry that visibly violates its declared
policy. Enforcement in the contract (funds held behind policy) is a v3 question.

### What was tested on Arc Testnet

| Case | Result |
|---|---|
| Price above `maxPerCall` ($0.05, $0.10) | refused, no signature |
| Exactly at the cap ($0.02) vs one base unit over ($0.020001) | paid / refused |
| Daily cap at the exact boundary (cap $0.105, spent $0.095) | one call allowed, next refused |
| Controller rotates policy while agent holds the old file | agent refuses to start |
| Service asks to be paid at an address not on the allow-list | refused |
| Service prices in EURC instead of USDC | refused (x402 asset allow-list + policy) |
| Paid request that the handler rejects (400) | settlement cancelled, **not charged** |
| Replay of an identical signed authorization | 402, **not charged twice** (EIP-3009 nonce) |
| Service logs a different amount than paid | agent flags `LEDGER MISMATCH` |
| 4–8 agents at once | see *Concurrency* below |
| UTC midnight rollover | unit-tested; live via `--day-start` override |

## Concurrency, and the one ceiling that isn't code

Running 4–8 agents simultaneously against one service exposed two real bugs,
both fixed: nonce collisions between the service's settlement and audit writes
(→ viem `nonceManager` on both wallets), and audit entries lost when the RPC
throttled the `logPurchase` call (→ retry with backoff, then a durable
`pending-audit.jsonl` replayed by `scripts/replay-audit.js`).

What remains is infrastructure: **Arc's public RPC rate-limits at roughly 16
concurrent `eth_getLogs` from one IP** (JSON-RPC `-32005`). With the default
endpoint expect ~4 concurrent agents to be reliable and 6+ to degrade — safely:
the agent refuses before signing, or the facilitator rejects settlement and the
client gets a 402 with `PAYMENT-RESPONSE: success=false`. Across every load
level, `reconcile.js` stayed at *N payments ↔ N entries*. For more throughput
set `ARC_TESTNET_RPC` / `ARC_MAINNET_RPC` to a keyed provider (Alchemy, QuickNode, dRPC — listed in
the Arc docs).

## Arc facts used here

From [docs.arc.io](https://docs.arc.io/arc/references/connect-to-arc), then checked against each chain.

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | `5042` | `5042002` |
| RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| `eth_getLogs` max range | **10,000 blocks** (probed) | ~20,000 blocks |
| Explorer | https://explorer.arc.io | https://testnet.arcscan.app |

Both public RPCs are rate-limited (see above). The rest applies to both chains:

| | |
|---|---|
| Gas token | USDC (native, 18 dec) — same balance as the ERC-20 view (6 dec) at `0x3600000000000000000000000000000000000000` |
| USDC EIP-712 domain | `name: "USDC", version: "2"` — read from chain, `DOMAIN_SEPARATOR` reconstructed and matched |
| USDC `Transfer` events | **two per transfer**: one from the native-balance address `0xfff…fffe` (18 dec) and the ERC-20 one from `0x3600…` (6 dec). Filter by contract address when reconciling. |
| Blocks | ~0.6 s |
| Testnet faucet | https://faucet.circle.com (20 USDC / address / 2 h) |

Measured costs on testnet (21 gwei; mainnet runs at ~20 gwei and the same gas): deploy v2 1,144,141 gas ≈ 0.028 USDC · settlement
87,145 gas ≈ 0.0018 · `logPurchase` ≈ 267k gas ≈ 0.0056 · `recordOutcome` ≈
0.003 (paid by the agent).

## Design notes

- **Why is the facilitator in-process?** x402's `exact` scheme needs a
  facilitator to verify the EIP-3009 signature and submit
  `transferWithAuthorization`. As of Sept 2026 neither x402.org's nor Coinbase's
  hosted facilitator lists Arc. Arc USDC is a standard Circle `FiatTokenV2_2`,
  so `@x402/core`'s facilitator works unchanged — the service runs it itself,
  signing settlement with the wallet that receives the payment. Swapping to a
  hosted facilitator later is a one-line change (`HTTPFacilitatorClient({ url })`).
- **Why is `logPurchase` permissionless?** In an x402 trade either side can
  attest. The `reporter` field records who did.
- **Why can only the controller set policy?** If an agent could loosen its own
  rulebook the attestation would be worthless. The agent consents once by
  binding; the organisation's wallet governs from then on.
- **Why once-only outcomes?** An audit record that can be edited is not an
  audit record.
- **What this is not.** No token, no rewards, no staking, no launchpad, no
  public reputation market. Circle asked Arc builders not to ship speculative
  token features; this is infrastructure.
- **Porting to mainnet** took a network switch, not a rewrite. USDC has the
  same address and EIP-712 domain on both chains (read from chain, not
  assumed). Two things only showed up on mainnet: a smaller `eth_getLogs`
  range limit, and a cached day-start block that had to be keyed by network.
  Without that key, a testnet block number read on mainnet would have counted
  $0 spent and quietly switched off the daily cap.

## Roadmap

- Source verification on explorer.arc.io
- Policy rules driven by outcomes ("stop paying vendor X below score 2")
- Batch settlement via Circle Gateway to cut the ~74% gas overhead at $0.01/call
- Replace the heuristic planner with a real model behind the same interface

## License

MIT — Moloko Labs.
