# service — x402-paid API on Arc Testnet

An Express server with one paid endpoint. Agents pay **$0.01 USDC** per call via
the [x402](https://x402.org) protocol; after payment settles, the service writes
an audit entry to the `SpendLogger` contract, capturing the policy the agent was
operating under.

## Endpoints

| Method | Path | Cost | What |
|---|---|---|---|
| `POST` | `/api/process-description` | $0.01 USDC | Body `{ "description": "<business process in plain text>" }` → structured automation plan (`steps`, `inputs`, `outputs`, `decision_points`, `suggested_tools`, `assessment`). |
| `GET` | `/api/ledger?limit=10` | free | Latest `SpendLogger` purchases with policy hash and outcome, read from chain. |
| `GET` | `/health` | free | Network, payTo, contract, price, `pendingAudit` count, whether test overrides are active. |

Response headers on a paid 200: `PAYMENT-RESPONSE` (x402 settlement, includes the
USDC tx), `X-Spend-Log-Tx`, `X-Spend-Log-Id`, `X-Spend-Log-Contract`. If the audit
write had to be deferred: `X-Spend-Log-Pending: 1`.

## Run

```powershell
cd C:\dev\arc-spend-tracker\service
npm install
npm start          # http://localhost:3001
```

Reads `../.env`:

| Var | Purpose |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | Arc-Deployer wallet. Receives payments, settles them, calls `logPurchase`. |
| `SERVICE_PORT` | default `3001` |
| `SERVICE_PRICE_BASE_UNITS` | default `10000` (= $0.01, USDC has 6 decimals) |
| `SPEND_LOGGER_ADDRESS` | optional override; defaults to `../deployed.json` → `arcTestnet.address` |
| `ARC_TESTNET_RPC` | optional override; defaults to the public `https://rpc.testnet.arc.io`. Use a keyed provider under load. |
| `TEST_ONLY_PAYTO`, `TEST_ONLY_ASSET` | **tests only** — make the service advertise a payee / asset the agent's policy must refuse. Refused under `NODE_ENV=production`; printed loudly at startup. |

## How payment works here

```
agent ──POST──────────────────────▶ service          402 + requirements
agent ──POST + PAYMENT-SIGNATURE──▶ service
                                    ├─ facilitator.verify()   (in-process: EIP-3009 sig, balance, nonce)
                                    ├─ run handler            (generate plan; a 4xx/5xx here cancels settlement)
                                    ├─ facilitator.settle()   (Arc-Deployer submits USDC.transferWithAuthorization)
                                    ├─ SpendLogger.logPurchase(payer, payTo, amount, memo)   ← memo carries the settlement tx
                                    └─ 200 + plan, headers: PAYMENT-RESPONSE, X-Spend-Log-Tx, X-Spend-Log-Id
```

**Why an in-process facilitator?** As of Sept 2026 neither the public x402.org
facilitator nor Coinbase's CDP facilitator lists Arc Testnet. Arc's USDC is a
standard Circle `FiatTokenV2_2`, so the `exact` scheme works unchanged — the
service just runs `@x402/core`'s facilitator itself and signs settlement with
the same wallet that receives the money.

## Robustness (what the concurrency trials forced)

- **Nonces.** Settlement and audit writes come from one wallet and can overlap
  under concurrent requests. The account uses viem's `nonceManager`; audit writes
  are additionally serialised through a queue.
- **Settlement receipt wait is capped at 60 s** (Arc blocks are ~0.6 s). A
  transaction not mined in a minute is dead; failing fast beats a hung client.
- **Audit writes are never lost.** `logPurchase` retries with backoff (2·2ⁿ s,
  5 attempts) on transient RPC errors. If it still fails the entry is appended
  to `pending-audit.jsonl`, `/health.pendingAudit` increments, and the client
  gets `X-Spend-Log-Pending: 1`. `node ../scripts/replay-audit.js` replays.
- **Purchase id comes from the service's own receipt** (`PurchaseLogged` event),
  not from re-reading `purchaseCount`, which races under load.
- **The public RPC is the ceiling**: ~16 concurrent `eth_getLogs` per IP trips
  `-32005`. When throttled, verify or settle fails and the client receives a 402
  with `PAYMENT-RESPONSE: success=false` — nothing is charged.

On-chain footprint per paid call (all Arc Testnet, 21 gwei):

| Tx | From | Gas | ≈ USDC |
|---|---|---|---|
| `USDC.transferWithAuthorization` (settlement) | Arc-Deployer | 87,145 | 0.0018 |
| `SpendLogger.logPurchase` | Arc-Deployer | ~267k | 0.0056 |

## Swapping in a real model

`plan.js` exports `generatePlan(description) → Promise<AutomationPlan>`. Replace
the heuristic body with an LLM call; the response shape and the endpoint stay
identical.
