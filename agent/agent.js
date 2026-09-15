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
import { readFileSync } from "node:fs";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";
import { createWalletClient, http, publicActions, getAddress, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet, ARC_TESTNET_CAIP2, ARC_TESTNET_RPC, ARC_TESTNET_USDC,
  spendLoggerAbi, usdcAbi, txUrl, addressUrl, fmtUsdc,
} from "../shared/arc.js";
import { validatePolicy, policyHash, evaluate } from "../shared/policy.js";

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
const account = privateKeyToAccount(AGENT_PRIVATE_KEY);
const chain = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_TESTNET_RPC) }).extend(publicActions);

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

// Daily spend so far: sum PurchaseLogged amounts for this agent since 00:00 UTC.
async function spentTodayBaseUnits() {
  const latest = await chain.getBlock();
  const midnight = BigInt(Math.floor(Date.now() / 86_400_000) * 86_400);
  const secondsBack = Number(latest.timestamp - midnight);
  const fromBlock = latest.number - BigInt(Math.ceil(secondsBack / 0.5) + 200); // ~0.5-0.6 s blocks, generous margin
  const logs = await chain.getContractEvents({
    address: SPEND_LOGGER, abi: spendLoggerAbi, eventName: "PurchaseLogged",
    args: { agent: account.address }, fromBlock: fromBlock < 0n ? 0n : fromBlock, toBlock: latest.number,
  });
  return logs.filter((l) => l.args.timestamp >= midnight).reduce((s, l) => s + l.args.amount, 0n);
}

// ---------------------------------------------------------------------------
// x402 client with the policy gate installed before signing
// ---------------------------------------------------------------------------
let refusals = 0;
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
    const spentToday = await spentTodayBaseUnits();
    const verdict = evaluate(policy, offer, spentToday);
    if (!verdict.ok) {
      refusals++;
      console.log(`  ✗ REFUSED by policy rule "${verdict.rule}": ${verdict.reason}`);
      console.log(`    (no signature produced, no transaction sent)`);
      return { abort: true, reason: `${verdict.rule}: ${verdict.reason}` };
    }
    console.log(`  ✓ policy ok — ${fmtUsdc(offer.amount)} to ${offer.payTo.slice(0, 10)}…, spent today ${fmtUsdc(spentToday)} / ${fmtUsdc(policy.dailyCap)}`);
  });
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

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
  const description = PROCESSES[i % PROCESSES.length];
  console.log(`\n── call ${i + 1}/${CALLS} ─────────────────────────────────────────────`);
  console.log(`  process: "${description.slice(0, 70)}…"`);
  const t0 = Date.now();
  let res;
  try {
    res = await fetchWithPayment(ENDPOINT, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description }),
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
  if (res.status !== 200) { console.error(`  ✗ HTTP ${res.status}`, JSON.stringify(body)); break; }

  const settlement = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE"));
  const logTx = res.headers.get("X-Spend-Log-Tx");
  const logId = res.headers.get("X-Spend-Log-Id");
  const r = { settlement, logTx, logId, outcomeTx: null };
  results.push(r);

  console.log(`  ✓ 200 in ${(ms / 1000).toFixed(1)}s`);
  console.log(`  plan     ${body.plan.process_name} — ${body.plan.summary}`);
  console.log(`  paid     ${settlement.transaction}  ${txUrl(settlement.transaction)}`);
  console.log(`  logged   ${logTx ?? "(header missing)"}  ${logTx ? txUrl(logTx) : ""}  purchase #${logId ?? "?"}`);

  if (RECORD_OUTCOME && logId != null) {
    const { score, reason } = scorePlan(body.plan, description);
    const reasonHash = keccak256(toHex(reason));
    const hash = await chain.writeContract({
      address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "recordOutcome",
      args: [BigInt(logId), score, reasonHash],
    });
    await chain.waitForTransactionReceipt({ hash });
    r.outcomeTx = hash;
    console.log(`  rated    ${score}/5 "${reason}"`);
    console.log(`           ${hash}  ${txUrl(hash)}`);
  }
}

// ---------------------------------------------------------------------------
// Verify independently on-chain (don't just trust the service's headers)
// ---------------------------------------------------------------------------
if (results.length) {
  const balanceAfter = await usdcBalance(account.address);
  console.log(`\n── on-chain check ────────────────────────────────────────────`);
  console.log(`  USDC spent by agent : ${fmtUsdc(balanceBefore - balanceAfter)} (${results.length} paid call(s), ${refusals} refused; includes outcome gas)`);
  const last = results.at(-1);
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
} else if (!DRY_RUN) {
  console.log(`\nNo paid calls made (${refusals} refused by policy).`);
}
