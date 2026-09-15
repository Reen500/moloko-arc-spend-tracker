// Demo agent: discover -> check policy -> pay -> call -> rate -> verify.
//
//   node agent.js                            # one paid call
//   node agent.js --calls 5                  # five paid calls (builds on-chain history)
//   node agent.js --calls 5 --delay 30-120   # random 30..120 s between calls
//   node agent.js --dry-run                  # show the 402 + policy decision, sign nothing
//   node agent.js --no-outcome               # skip the on-chain outcome record
//   node agent.js --policy policies/x.json   # use a different rulebook
//
// Signs with AGENT_PRIVATE_KEY (Arc-Agent MetaMask account).
//   - Payment: an off-chain EIP-3009 authorization; the service submits it and
//     pays gas, so this wallet spends exactly the price.
//   - Outcome: a real transaction from this wallet (recordOutcome), gas in USDC.
//
// Before signing any payment the agent evaluates the 402 offer against its
// policy file. A refusal aborts inside the x402 client hook — no signature is
// ever produced. The policy's hash must match what the controller committed
// on-chain (SpendLogger.policyOf); the agent refuses to run if it doesn't.
import { config as loadEnv } from "dotenv";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";
import { createWalletClient, publicActions, getAddress, keccak256, toHex, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet, ARC_TESTNET_CAIP2, ARC_TESTNET_USDC, arcTransport,
  spendLoggerAbi, usdcAbi, txUrl, addressUrl, fmtUsdc,
} from "../shared/arc.js";
import { validatePolicy, policyHash, evaluate, utcDayStart, sumSpentSince } from "../shared/policy.js";

loadEnv({ path: new URL("../.env", import.meta.url) });

// ---------------------------------------------------------------------------
// CLI + config
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i === -1 ? def : (argv[i + 1] ?? true); };
const CALLS = Number(flag("--calls", 1));
const DRY_RUN = argv.includes("--dry-run");
const RECORD_OUTCOME = !argv.includes("--no-outcome");
const POLICY_PATH = String(flag("--policy", "policies/arc-agent.json"));
const PROCESS_OFFSET = Number(flag("--process", 0)); // which sample process to start from
const BAD_BODY = argv.includes("--bad-body");   // pay, but send a body the handler rejects (expect: not charged)
const REPLAY = argv.includes("--replay");       // after a paid call, re-send the same signed request (expect: rejected)
const DELAY = String(flag("--delay", "0"));
const [DELAY_MIN, DELAY_MAX] = DELAY.split("-").map(Number).concat([NaN]).slice(0, 2);
const nextDelayMs = () => {
  const max = Number.isFinite(DELAY_MAX) ? DELAY_MAX : DELAY_MIN;
  return Math.round((DELAY_MIN + Math.random() * Math.max(0, max - DELAY_MIN)) * 1000);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVICE_URL = (process.env.SERVICE_URL ?? "http://localhost:3001").replace(/\/$/, "");
const ENDPOINT = `${SERVICE_URL}/api/process-description`;

const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
if (!AGENT_PRIVATE_KEY || AGENT_PRIVATE_KEY === "0x...") {
  throw new Error("AGENT_PRIVATE_KEY missing in .env (Arc-Agent wallet; see SETUP.md Part B).");
}
const account = privateKeyToAccount(AGENT_PRIVATE_KEY, { nonceManager });
const chain = createWalletClient({ account, chain: arcTestnet, transport: arcTransport() }).extend(publicActions);

function resolveSpendLogger() {
  if (process.env.SPEND_LOGGER_ADDRESS) return getAddress(process.env.SPEND_LOGGER_ADDRESS);
  const d = JSON.parse(readFileSync(new URL("../deployed.json", import.meta.url), "utf8"));
  return getAddress(d.arcTestnet.address);
}
const SPEND_LOGGER = resolveSpendLogger();

const PROCESSES = [
  "Receive the supplier invoice by email. Extract the PDF totals and match them to the purchase order. If the amounts differ by more than 2%, a manager must approve. Then post the entry to Xero and send a confirmation to the supplier.",
  "A customer submits a support ticket. Classify it by product. If it mentions a refund, route to finance, otherwise assign to the product team. Update the CRM and notify the customer.",
  "Every Monday export last week's sales from the ERP to a spreadsheet, calculate commission per rep, and email each rep their statement. If a rep's total is negative, flag it for review.",
  "New hire onboarding: HR creates the employee record, IT provisions a laptop and accounts, the manager schedules orientation, and payroll is updated. Send a welcome email when all steps are complete.",
  "Expense claims arrive as scanned receipts. Extract merchant, date and amount, check against policy limits, and if over the limit request director approval. Approved claims are posted to the payroll batch.",
];

const usdcBalance = (addr) => chain.readContract({ address: ARC_TESTNET_USDC, abi: usdcAbi, functionName: "balanceOf", args: [addr] });

// ---------------------------------------------------------------------------
// Policy: load, hash, and check the hash matches what the controller committed
// ---------------------------------------------------------------------------
const policy = validatePolicy(JSON.parse(readFileSync(new URL(`../${POLICY_PATH}`, import.meta.url), "utf8")));
const localPolicyHash = policyHash(policy);
if (policy.agent !== getAddress(account.address)) {
  throw new Error(`policy is for ${policy.agent}, this wallet is ${account.address}`);
}
const [onChainController, onChainPolicyHash] = await Promise.all([
  chain.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "controllerOf", args: [account.address] }),
  chain.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "policyOf", args: [account.address] }),
]);

console.log("Arc Spend Tracker agent");
console.log(`  wallet      ${account.address}  ${addressUrl(account.address)}`);
console.log(`  service     ${ENDPOINT}`);
console.log(`  SpendLogger ${SPEND_LOGGER}`);
console.log(`  policy      ${POLICY_PATH}`);
console.log(`              maxPerCall ${fmtUsdc(policy.maxPerCall)} · dailyCap ${fmtUsdc(policy.dailyCap)} · payees ${policy.allowedPayees.length || "any"}`);
console.log(`              local hash    ${localPolicyHash}`);
console.log(`              on-chain hash ${onChainPolicyHash}  (controller ${onChainController})`);

if (onChainController === "0x0000000000000000000000000000000000000000") {
  throw new Error("This agent has no controller on-chain. Run: node scripts/policy.js bind");
}
if (onChainPolicyHash !== localPolicyHash) {
  throw new Error("Local policy hash does not match the on-chain policy. Run: node scripts/policy.js set  (as controller)");
}
console.log("  policy      ✓ matches on-chain commitment");

// Daily spend so far: sum PurchaseLogged amounts for this agent since the start
// of the current UTC day. The day boundary is a pure function (shared/policy.js)
// so the rollover is unit-tested; the block at that boundary is found by binary
// search on block timestamps rather than guessed from an assumed block time.
const DAY_START_OVERRIDE = flag("--day-start", null); // TEST ONLY: ISO time to treat as "start of today"
if (DAY_START_OVERRIDE) console.log(`  !!! --day-start override active: counting spend since ${DAY_START_OVERRIDE}`);

async function blockAtOrAfter(tsSec, latest) {
  let lo = 0n, hi = latest.number;
  if (latest.timestamp < tsSec) return latest.number + 1n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await chain.getBlock({ blockNumber: mid });
    if (b.timestamp < tsSec) lo = mid + 1n; else hi = mid;
  }
  return lo;
}

const CACHE_DIR = new URL("../.cache/", import.meta.url);
async function dayStartBlock(dayStart, latest) {
  const file = new URL(`daystart-${dayStart}.json`, CACHE_DIR);
  try { return BigInt(JSON.parse(readFileSync(file, "utf8")).block); } catch { /* not cached */ }
  const block = await blockAtOrAfter(dayStart, latest);
  try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(file, JSON.stringify({ dayStart: dayStart.toString(), block: block.toString() })); } catch { /* best effort */ }
  return block;
}

async function spentTodayBaseUnits() {
  const latest = await chain.getBlock();
  const dayStart = DAY_START_OVERRIDE ? BigInt(Math.floor(Date.parse(DAY_START_OVERRIDE) / 1000)) : utcDayStart();
  const fromBlock = await dayStartBlock(dayStart, latest);
  // Arc public RPC caps eth_getLogs at ~20k blocks per call; a full UTC day is ~150k. Chunk it.
  const CHUNK = 10_000n;
  const logs = [];
  for (let start = fromBlock; start <= latest.number; start += CHUNK + 1n) {
    const end = start + CHUNK > latest.number ? latest.number : start + CHUNK;
    logs.push(...await chain.getContractEvents({
      address: SPEND_LOGGER, abi: spendLoggerAbi, eventName: "PurchaseLogged",
      args: { agent: account.address }, fromBlock: start, toBlock: end,
    }));
  }
  return sumSpentSince(logs.map((l) => l.args), dayStart);
}

// ---------------------------------------------------------------------------
// x402 client with the policy gate installed before signing
// ---------------------------------------------------------------------------
let refusals = 0;
// Daily spend is read from chain once per run (a chunked eth_getLogs scan) and
// then tracked locally as calls succeed — one scan per process, not per call.
let spentToday = null;
const client = x402Client.fromConfig({
  schemes: [{ network: ARC_TESTNET_CAIP2, client: new ExactEvmScheme(account) }],
  // Arc USDC is not in x402's default-asset table; allow it. No cap here on
  // purpose: the policy hook below is the single authority (it enforces
  // maxPerCall, dailyCap, payee, asset and network), so refusals always
  // report which policy rule fired.
  spendControls: {
    allowedAssets: [{ network: policy.network, asset: policy.asset }],
  },
})
  .onBeforePaymentCreation(async ({ selectedRequirements: offer }) => {
    // Fail closed: if the chain can't be read (RPC outage / rate limit) we
    // cannot evaluate the daily cap, so we do not sign.
    if (spentToday === null) {
      try { spentToday = await spentTodayBaseUnits(); }
      catch (err) {
        refusals++;
        console.log(`  ✗ REFUSED — policy check unavailable: ${(err.shortMessage ?? err.message).split("\n")[0]}`);
        console.log(`    (fail closed: no signature produced, no transaction sent; retry later or use a keyed RPC)`);
        return { abort: true, reason: "policy check unavailable" };
      }
    }
    const verdict = evaluate(policy, offer, spentToday);
    if (!verdict.ok) {
      refusals++;
      console.log(`  ✗ REFUSED by policy rule "${verdict.rule}": ${verdict.reason}`);
      console.log(`    (no signature produced, no transaction sent)`);
      return { abort: true, reason: `${verdict.rule}: ${verdict.reason}` };
    }
    console.log(`  ✓ policy ok — ${fmtUsdc(offer.amount)} to ${offer.payTo.slice(0, 10)}…, spent today ${fmtUsdc(spentToday)} / ${fmtUsdc(policy.dailyCap)}`);
  });
// Capture the exact paid request (headers + body) so --replay can re-send it.
let lastPaidRequest = null;
const recordingFetch = async (input, init) => {
  // @x402/fetch passes a Request object on the paid retry; handle both shapes.
  if (input instanceof Request && input.headers.has("PAYMENT-SIGNATURE")) {
    const clone = input.clone();
    lastPaidRequest = { url: clone.url, init: { method: clone.method, headers: Object.fromEntries(clone.headers.entries()), body: await clone.text() } };
  } else if (init?.headers && new Headers(init.headers).has("PAYMENT-SIGNATURE")) {
    lastPaidRequest = { url: String(input), init: { ...init, headers: Object.fromEntries(new Headers(init.headers).entries()) } };
  }
  return fetch(input, init);
};
const fetchWithPayment = wrapFetchWithPayment(recordingFetch, client);

// ---------------------------------------------------------------------------
// 1. Discover
// ---------------------------------------------------------------------------
const balanceBefore = await usdcBalance(account.address);
console.log(`  balance     ${fmtUsdc(balanceBefore)} USDC (ERC-20 view)`);

const probe = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: PROCESSES[0] }) });
if (probe.status !== 402) throw new Error(`Expected 402 from unpaid request, got ${probe.status}`);
const required = JSON.parse(Buffer.from(probe.headers.get("PAYMENT-REQUIRED"), "base64").toString("utf8"));
const offer = required.accepts[0];
console.log(`\n402 received — service asks for:`);
console.log(`  ${fmtUsdc(offer.amount)} ${offer.extra?.name ?? "?"} (${offer.amount} base units) on ${offer.network}`);
console.log(`  asset   ${offer.asset}`);
console.log(`  payTo   ${offer.payTo}`);

if (DRY_RUN) {
  const v = evaluate(policy, offer, await spentTodayBaseUnits());
  console.log(`\n--dry-run: policy says ${v.ok ? "ALLOW" : `REFUSE (${v.rule}: ${v.reason})`}. Nothing signed, nothing paid.`);
}

// Simple, honest scoring of what came back. A real agent would compare the
// result to its request; this checks the plan is non-trivial and well-formed.
function scorePlan(plan, description) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return { score: 0, reason: "empty plan" };
  const fields = ["steps", "inputs", "outputs", "decision_points", "suggested_tools", "assessment"].filter((k) => plan[k] != null);
  if (fields.length < 6) return { score: 2, reason: `missing fields: ${6 - fields.length}` };
  const wanted = description.split(/[.;]\s+/).filter((s) => s.length > 3).length;
  if (plan.steps.length < Math.max(1, Math.floor(wanted / 2))) return { score: 3, reason: `${plan.steps.length} steps for ${wanted} sentences` };
  return { score: 5, reason: `${plan.steps.length} steps, ${plan.decision_points.length} decision points, ${plan.suggested_tools.length} tools` };
}

// ---------------------------------------------------------------------------
// 2..N. Pay -> call -> rate -> print
// ---------------------------------------------------------------------------
const results = [];
for (let i = 0; i < (DRY_RUN ? 0 : CALLS); i++) {
  if (i > 0 && DELAY_MIN > 0) {
    const ms = nextDelayMs();
    console.log(`\n  … waiting ${(ms / 1000).toFixed(0)}s before next call (--delay ${DELAY})`);
    await sleep(ms);
  }
  const description = PROCESSES[(PROCESS_OFFSET + i) % PROCESSES.length];
  console.log(`\n── call ${i + 1}/${CALLS} ─────────────────────────────────────────────`);
  console.log(`  process: "${description.slice(0, 70)}…"`);
  const t0 = Date.now();
  let res;
  try {
    const sent = BAD_BODY ? { description: "x" } : { description };
    if (BAD_BODY) console.log(`  --bad-body: sending an invalid body WITH payment; the handler should 400 and no USDC should move`);
    res = await fetchWithPayment(ENDPOINT, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sent),
    });
  } catch (err) {
    if (/Payment creation aborted/.test(err.message)) { console.log(`  → call skipped, nothing paid`); continue; }
    if (/Failed to create payment payload/.test(err.message)) {
      refusals++;
      console.log(`  ✗ REFUSED by x402 spend controls: ${err.message.split(":").slice(1).join(":").trim()}`);
      console.log(`    (no signature produced, no transaction sent)`);
      continue;
    }
    throw err;
  }
  const ms = Date.now() - t0;
  const body = await res.json();
  if (res.status !== 200) {
    // A paid request that the handler rejected. x402 cancels settlement on a
    // 4xx/5xx, so no USDC should have moved — the on-chain check below proves it.
    console.log(`  ✗ HTTP ${res.status} after payment header was sent: ${JSON.stringify(body)}`);
    // The PAYMENT-RESPONSE header is the authoritative answer to "was I charged?":
    // success:false means the facilitator did not settle (no transfer happened).
    let pr = null;
    try { pr = res.headers.has("PAYMENT-RESPONSE") ? decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")) : null; } catch { /* unreadable */ }
    if (pr) console.log(`    PAYMENT-RESPONSE: success=${pr.success} reason=${pr.errorReason ?? "-"} tx=${pr.transaction || "(none)"}${pr.success ? "  !! charged but no result" : "  → not charged"}`);
    else console.log(`    no PAYMENT-RESPONSE header → settlement never happened, not charged`);
    results.push({ settlement: null, logTx: null, logId: null, outcomeTx: null, rejected: res.status, paymentResponse: pr });
    continue;
  }

  const settlement = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE"));
  if (spentToday !== null) spentToday += BigInt(offer.amount);
  const logTx = res.headers.get("X-Spend-Log-Tx");
  const logId = res.headers.get("X-Spend-Log-Id");
  const r = { settlement, logTx, logId, outcomeTx: null };
  results.push(r);

  console.log(`  ✓ 200 in ${(ms / 1000).toFixed(1)}s`);
  console.log(`  plan     ${body.plan.process_name} — ${body.plan.summary}`);
  console.log(`  paid     ${settlement.transaction}  ${txUrl(settlement.transaction)}`);
  if (res.headers.get("X-Spend-Log-Pending")) console.log(`  logged   (deferred — service queued the audit entry for replay)`);
  else console.log(`  logged   ${logTx ?? "(header missing)"}  ${logTx ? txUrl(logTx) : ""}  purchase #${logId ?? "?"}`);

  // Don't trust the service's ledger entry: it must match what we actually paid.
  if (logId != null) {
    const p = await chain.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "getPurchase", args: [BigInt(logId)] });
    const problems = [];
    if (p.amount !== BigInt(offer.amount)) problems.push(`amount logged ${p.amount} ≠ paid ${offer.amount}`);
    if (getAddress(p.agent) !== getAddress(account.address)) problems.push(`agent logged ${p.agent} ≠ me`);
    if (getAddress(p.service) !== getAddress(offer.payTo)) problems.push(`service logged ${p.service} ≠ payTo ${offer.payTo}`);
    if (!p.memo.includes(settlement.transaction)) problems.push(`memo does not reference settlement tx`);
    if (problems.length) { console.log(`  !! LEDGER MISMATCH: ${problems.join("; ")}`); r.mismatch = problems; }
    else console.log(`  ✓ ledger entry matches payment (amount, agent, payee, settlement tx)`);
  }

  if (REPLAY && lastPaidRequest) {
    // Same signed authorization, sent again. EIP-3009 nonces are single-use, so
    // verify must reject it and the agent must not be charged twice.
    console.log(`  --replay: re-sending the identical PAYMENT-SIGNATURE …`);
    const balMid = await usdcBalance(account.address);
    const again = await fetch(lastPaidRequest.url, lastPaidRequest.init);
    const againBody = await again.text();
    const balAfterReplay = await usdcBalance(account.address);
    console.log(`  replay → HTTP ${again.status}  ${againBody.slice(0, 160)}`);
    console.log(`  USDC moved by replay: ${fmtUsdc(balMid - balAfterReplay)}  ${balMid === balAfterReplay ? "✓ not charged twice" : "!! CHARGED AGAIN"}`);
    r.replay = { status: again.status, charged: balMid !== balAfterReplay };
  }

  if (RECORD_OUTCOME && logId != null) {
    const { score, reason } = scorePlan(body.plan, description);
    const reasonHash = keccak256(toHex(reason));
    // Several agent processes may share this key (as in concurrency-trial.js);
    // nonceManager only coordinates within one process, so retry on a collision.
    let hash;
    for (let attempt = 1; ; attempt++) {
      try {
        hash = await chain.writeContract({
          address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "recordOutcome",
          args: [BigInt(logId), score, reasonHash],
          nonce: attempt === 1 ? undefined : await chain.getTransactionCount({ address: account.address, blockTag: "pending" }),
        });
        await chain.waitForTransactionReceipt({ hash, timeout: 60_000 });
        break;
      } catch (err) {
        const transient = /nonce|already known|replacement|underpriced|could not be found|rate limit|exceeds defined limit|timeout/i.test(err.message);
        if (!transient || attempt >= 5) throw err;
        const brief = (err.shortMessage ?? err.message).split("\n")[0].slice(0, 60);
        console.log(`  … outcome tx attempt ${attempt} failed (${brief}), retrying`);
        await sleep(1000 * 2 ** attempt);
      }
    }
    r.outcomeTx = hash;
    console.log(`  rated    ${score}/5 "${reason}"`);
    console.log(`           ${hash}  ${txUrl(hash)}`);
  }
}

// ---------------------------------------------------------------------------
// Verify independently on-chain (don't just trust the service's headers)
// ---------------------------------------------------------------------------
if (results.length) try {
  const balanceAfter = await usdcBalance(account.address);
  console.log(`\n── on-chain check ────────────────────────────────────────────`);
  const paidCalls = results.filter((x) => x.settlement).length;
  const rejectedAfterPay = results.filter((x) => x.rejected).length;
  console.log(`  USDC spent by agent : ${fmtUsdc(balanceBefore - balanceAfter)} (${paidCalls} paid call(s), ${rejectedAfterPay} rejected-after-payment-header, ${refusals} refused; includes outcome gas)`);
  console.log(`  (balance delta is only meaningful if no other process is using this wallet; scripts/reconcile.js is authoritative)`);
  const chargedNoResult = results.filter((x) => x.rejected && x.paymentResponse?.success);
  if (chargedNoResult.length) console.log(`  !! ${chargedNoResult.length} call(s) settled on-chain but the client got an error — investigate`);
  else if (rejectedAfterPay) console.log(`  rejected-after-payment calls: PAYMENT-RESPONSE says not settled → ✓ not charged`);
  const last = results.filter((x) => x.settlement).at(-1) ?? results.at(-1);
  if (last.logId != null) {
    const p = await chain.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "getPurchase", args: [BigInt(last.logId)] });
    console.log(`  purchase #${last.logId}: agent=${p.agent} amount=${fmtUsdc(p.amount)} policyHash=${p.policyHash}`);
    console.log(`    policy matches local file: ${p.policyHash === localPolicyHash}`);
    if (last.outcomeTx) {
      const o = await chain.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "getOutcome", args: [BigInt(last.logId)] });
      console.log(`    outcome: score ${o.score}/5 recordedBy ${o.recordedBy}`);
    }
  }
  const count = await chain.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "purchaseCount" });
  console.log(`  SpendLogger.purchaseCount = ${count}`);
  console.log(`\n  agent wallet  ${addressUrl(account.address)}`);
} catch (err) {
  console.log(`  (on-chain verification skipped: ${(err.shortMessage ?? err.message).split("\n")[0]} — run scripts/reconcile.js)`);
} else if (!DRY_RUN) {
  console.log(`\nNo paid calls made (${refusals} refused by policy).`);
}
