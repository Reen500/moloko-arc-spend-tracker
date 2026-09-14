# agent — the paying client

A Node script that plays the role of an autonomous agent buying a service:

1. **Discover** — `POST`s to the endpoint with no payment, reads the `402` and the
   `PAYMENT-REQUIRED` header (price, asset, network, payTo).
2. **Guard** — refuses anything that isn't Arc Testnet USDC at ≤ $0.05.
3. **Pay + call** — `@x402/fetch` signs an EIP-3009 `TransferWithAuthorization`
   with the Arc-Agent key and retries with a `PAYMENT-SIGNATURE` header.
4. **Print** — the automation plan, the settlement tx (USDC agent → service) and
   the `SpendLogger.logPurchase` tx, with ArcScan links.
5. **Verify on-chain** — re-reads the agent's USDC balance and the
   `PurchaseLogged` event straight from the chain, independent of the service.

## Run

```powershell
cd C:\dev\arc-spend-tracker\agent
npm install
node agent.js                # 1 paid call
node agent.js --calls 5      # 5 paid calls, cycling through sample processes
node agent.js --dry-run      # inspect the 402 only, sign nothing
node agent.js --calls 5 --delay 60      # 60 s pause between calls
node agent.js --calls 5 --delay 30-120  # random 30–120 s pause between calls
```

Reads `../.env`:

| Var | Purpose |
|---|---|
| `AGENT_PRIVATE_KEY` | Arc-Agent wallet. Only ever signs off-chain authorizations — the service pays gas. |
| `SERVICE_URL` | default `http://localhost:3001` |

## What the agent wallet actually spends

Exactly the price ($0.01 per call). The signed authorization is submitted on-chain
by the service, which pays the gas. The agent wallet's native (gas) balance never
changes; only its USDC balance drops by the price.
