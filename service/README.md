# service — x402-paid API on Arc Testnet

An Express server with one paid endpoint. Agents pay **$0.01 USDC** per call via
the [x402](https://x402.org) protocol; after payment settles, the service writes
an audit entry to the `SpendLogger` contract.

## Endpoints

| Method | Path | Cost | What |
|---|---|---|---|
| `POST` | `/api/process-description` | $0.01 USDC | Body `{ "description": "<business process in plain text>" }` → structured automation plan (`steps`, `inputs`, `outputs`, `decision_points`, `suggested_tools`, `assessment`). |
| `GET` | `/api/ledger?limit=10` | free | Latest `SpendLogger` purchases, read from chain. |
| `GET` | `/health` | free | Network, payTo, contract, price. |

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
| `ARC_TESTNET_RPC` | optional override; defaults to `https://rpc.testnet.arc.io` |

## Test without a paying client

```powershell
curl.exe -i -X POST http://localhost:3001/api/process-description `
  -H "content-type: application/json" `
  -d "{\"description\":\"Receive invoice by email, extract totals, post to Xero.\"}"
```

Expect `HTTP/1.1 402 Payment Required` with a base64 `PAYMENT-REQUIRED` header
describing the price. The `agent/` script is the paying client.

## How payment works here

```
agent ──POST──────────────────────▶ service          402 + requirements
agent ──POST + PAYMENT-SIGNATURE──▶ service
                                    ├─ facilitator.verify()   (in-process: checks EIP-3009 sig, balance, nonce)
                                    ├─ run handler            (generate plan)
                                    ├─ facilitator.settle()   (Arc-Deployer submits USDC.transferWithAuthorization)
                                    ├─ SpendLogger.logPurchase(agent, service, 10000, memo)
                                    └─ 200 + plan, headers: PAYMENT-RESPONSE, X-Spend-Log-Tx, X-Spend-Log-Id
```

**Why an in-process facilitator?** As of Sept 2026 neither the public x402.org
facilitator nor Coinbase's CDP facilitator lists Arc Testnet. Arc's USDC is a
standard Circle `FiatTokenV2_2`, so the `exact` scheme works unchanged — the
service just runs `@x402/core`'s facilitator itself and signs settlement with
the same wallet that receives the money. Every on-chain action (settlement and
audit log) is therefore signed by the Arc-Deployer wallet.

On-chain footprint per paid call, all on Arc Testnet:

1. `USDC.transferWithAuthorization` — agent → service, 0.01 USDC (tx from Arc-Deployer, gas ≈ 0.001 USDC)
2. `SpendLogger.logPurchase` — `PurchaseLogged` event (tx from Arc-Deployer)

## Swapping in a real model

`plan.js` exports `generatePlan(description) → Promise<AutomationPlan>`. Replace
the heuristic body with an LLM call; the response shape and the endpoint stay
identical.
