# service — x402-paid API on Arc

Live on Arc Mainnet at https://service-production-33b0.up.railway.app (hosted on
Railway; see [`railway.json`](../railway.json) and [SETUP.md Part D](../SETUP.md#part-d--arc-mainnet)).

An Express server with one paid endpoint. Agents pay **$0.01 USDC** per call via
the [x402](https://x402.org) protocol; after payment settles, the service writes
an audit entry to the `SpendLogger` contract, capturing the policy the agent was
operating under.

## Endpoints

| Method | Path | Cost | What |
|---|---|---|---|
| `POST` | `/api/process-description` | $0.01 USDC | Body `{ "description": "<business process in plain text>" }` → structured automation plan (`steps`, `inputs`, `outputs`, `decision_points`, `suggested_tools`, `assessment`). |
| `GET` | `/api/ledger?limit=10` | free | Latest `SpendLogger` purchases (max 50) with policy hash and outcome, read from chain, cached 15 s. |
| `GET` | `/health` | free | Network, payTo, contract, price, `pendingAudit` count, whether test overrides are active. |

Free routes are rate-limited to 60 requests a minute per IP (429 above that).
They fan out to RPC reads, and the public RPC's limit is shared with settlement.

Response headers on a paid 200: `PAYMENT-RESPONSE` (x402 settlement, includes the
USDC tx), `X-Spend-Log-Tx`, `X-Spend-Log-Id`, `X-Spend-Log-Contract`. If the audit
write had to be deferred: `X-Spend-Log-Pending: 1`.

## Run

```powershell
cd C:\dev\arc-spend-tracker\service
npm install
npm start                          # testnet, http://localhost:3001
$env:ARC_NETWORK="arcMainnet"; npm start   # mainnet
```

Reads `../.env`:

| Var | Purpose |
|---|---|
| `ARC_NETWORK` | `arcTestnet` (default) or `arcMainnet` |
| `DEPLOYER_PRIVATE_KEY` | testnet service wallet (Arc-Deployer). Receives payments, settles them, calls `logPurchase`. |
| `MAINNET_SERVICE_PRIVATE_KEY` | mainnet service wallet (Arc-Service), same job. On Railway: a sealed variable. |
| `PORT` / `SERVICE_PORT` | `PORT` is set by Railway; otherwise `SERVICE_PORT`, default `3001` |
| `SERVICE_PRICE_BASE_UNITS` | default `10000` (= $0.01, USDC has 6 decimals) |
| `SPEND_LOGGER_ADDRESS` | optional override; defaults to `../deployed.json` → `<network>.address` |
| `ARC_TESTNET_RPC` / `ARC_MAINNET_RPC` | optional override of the public RPC. Use a keyed provider under load. |
| `TEST_ONLY_PAYTO`, `TEST_ONLY_ASSET` | **tests only** — make the service advertise a payee / asset the agent's policy must refuse. Refused on mainnet and under `NODE_ENV=production`; printed loudly at startup. |

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
