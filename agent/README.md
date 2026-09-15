# agent — the paying client, with a rulebook

A Node script that plays the role of an autonomous agent buying a service under
a spending policy it cannot loosen itself:

1. **Load the rulebook** (`policies/arc-agent.json`), hash it, and check the hash
   equals `SpendLogger.policyOf(agent)` on-chain. If the controller has committed
   a different policy, the agent refuses to start.
2. **Discover** — `POST`s to the endpoint with no payment, reads the `402`.
3. **Evaluate before signing** — inside x402's `onBeforePaymentCreation` hook the
   offer is checked against `maxPerCall`, `dailyCap` (today's `PurchaseLogged`
   total, read from chain), `allowedPayees`, `asset`, `network`. A refusal aborts
   the hook: **no signature is produced.** If the chain can't be read for the
   daily cap, the agent fails closed.
4. **Pay + call** — `@x402/fetch` signs the EIP-3009 authorization and retries
   with `PAYMENT-SIGNATURE`.
5. **Check the ledger** — reads back the `PurchaseLogged` entry and asserts
   amount, agent, payee and settlement-tx reference match what it paid
   (`LEDGER MISMATCH` otherwise).
6. **Rate** — sends `recordOutcome(id, score, reasonHash)` from its own wallet.
7. **Verify** — USDC balance delta and contract state, independent of the service.

## Run

```powershell
cd C:\dev\arc-spend-tracker\agent
npm install
node agent.js                              # 1 paid call + outcome
node agent.js --calls 5 --delay 30-120     # 5 calls, random 30–120 s apart
node agent.js --dry-run                    # 402 + policy verdict only, signs nothing
node agent.js --no-outcome                 # skip the on-chain rating
node agent.js --policy policies/x.json     # a different rulebook (must match the chain)
node agent.js --process 2                  # start from a different sample process
node agent.js --bad-body                   # pay, but send an invalid body → expect 400 and NOT charged
node agent.js --replay                     # after paying, re-send the same signed request → expect 402, NOT charged twice
node agent.js --day-start 2026-09-15T05:00:00Z   # TEST ONLY: treat this instant as start of "today"
```

Reads `../.env`:

| Var | Purpose |
|---|---|
| `AGENT_PRIVATE_KEY` | Arc-Agent wallet. Signs off-chain payment authorizations (service pays gas) and its own `recordOutcome` transactions (agent pays gas). |
| `SERVICE_URL` | default `http://localhost:3001` |
| `SPEND_LOGGER_ADDRESS` | optional override; defaults to `../deployed.json` |
| `ARC_TESTNET_RPC` | optional keyed RPC; the public one throttles under concurrency |

## Trial drivers

```powershell
# shuffled ALLOW/REFUSE cases against services at different prices (start them first)
node policy-trial.js 3011:10000 3012:15000 3013:20000 3014:20001 3015:50000 3016:100000

# N agents at the same instant against one service
node concurrency-trial.js 4
```

`policy-trial.js` tabulates expected vs actual per case; `concurrency-trial.js`
prints per-agent outcome and the tail of any run that did not fully succeed.
After either, `node ../scripts/reconcile.js` is the authoritative check.

## What the agent wallet actually spends

Exactly the price per call ($0.01) plus ~0.003 USDC gas for each `recordOutcome`.
The payment authorization is submitted on-chain by the service, which pays that
gas. A refused call costs nothing — there is no transaction to pay for.

## Reading the output when something is rejected

- `REFUSED by policy rule "…"` — the agent declined before signing. Nothing moved.
- `REFUSED — policy check unavailable` — RPC throttled; fail-closed. Nothing moved.
- `HTTP 4xx after payment header was sent` followed by
  `PAYMENT-RESPONSE: success=false` — the service verified or settled nothing.
  Not charged. (`success=true` here would mean charged-but-no-result; the agent
  flags that loudly and it has not occurred in testing.)
- The balance delta printed at the end is only meaningful if no other process is
  using the same wallet; with several concurrent agents sharing a key, use
  `scripts/reconcile.js`.
