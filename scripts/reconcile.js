// Reconcile agent spend against the chain and export it for finance.
//
// Every USDC payment the agent made to a service must have exactly one
// SpendLogger entry whose memo references the settlement tx, with the same
// amount and payee. Matched rows are joined with the policy hash in force and
// the buyer's outcome score, then exported.
//
//   node scripts/reconcile.js                       # report only
//   node scripts/reconcile.js --export              # + exports/<date>/ledger.csv, xero.csv, quickbooks.csv, reconcile.json, scorecard.csv
//   node scripts/reconcile.js --from 62170000       # start block (default: v2 deploy block)
//   node scripts/reconcile.js --out C:\path         # export directory (default: exports/<yyyy-mm-dd>)
//
// Exit code 1 if anything does not reconcile — usable in CI / a nightly job.
//
// Arc gotcha: a USDC transfer emits TWO Transfer events — one from the native
// balance system address 0xfff…fffe (18 decimals) and one from the ERC-20
// contract 0x3600… (6 decimals). Only the ERC-20 one is the payment.
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, getAddress } from "viem";
import { arcTestnet, arcTransport, ARC_TESTNET_USDC, ARC_TESTNET_EXPLORER, spendLoggerAbi, usdcAbi, fmtUsdc, txUrl } from "../shared/arc.js";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i === -1 ? def : argv[i + 1]; };
const EXPORT = argv.includes("--export");
const today = new Date().toISOString().slice(0, 10);
const OUT_DIR = opt("--out", join(process.cwd(), "exports", today));

const deployed = JSON.parse(readFileSync(new URL("../deployed.json", import.meta.url), "utf8"));
const SPEND_LOGGER = getAddress(deployed.arcTestnet.address);
const AGENT = getAddress(process.env.AGENT_ADDRESS ?? "0xaAf714460A9FbEc7C3f0618cf04E84938b86DC8D");
const chain = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
const latest = await chain.getBlockNumber();
const fromBlock = BigInt(opt("--from", deployed.arcTestnet.blockNumber));
const CHUNK = 10_000n;

async function scan(fn) {
  const out = [];
  for (let s = fromBlock; s <= latest; s += CHUNK + 1n) out.push(...await fn(s, s + CHUNK > latest ? latest : s + CHUNK));
  return out;
}

// ---------------------------------------------------------------------------
// gather: payments (USDC Transfer from agent), ledger entries, outcomes, policies
// ---------------------------------------------------------------------------
console.log(`SpendLogger ${SPEND_LOGGER} · blocks ${fromBlock}..${latest} · agent ${AGENT}`);
const [payments, entries, outcomes, policySets] = await Promise.all([
  scan((f, t) => chain.getContractEvents({ address: ARC_TESTNET_USDC, abi: usdcAbi, eventName: "Transfer", args: { from: AGENT }, fromBlock: f, toBlock: t })),
  scan((f, t) => chain.getContractEvents({ address: SPEND_LOGGER, abi: spendLoggerAbi, eventName: "PurchaseLogged", args: { agent: AGENT }, fromBlock: f, toBlock: t })),
  scan((f, t) => chain.getContractEvents({ address: SPEND_LOGGER, abi: spendLoggerAbi, eventName: "OutcomeRecorded", args: { agent: AGENT }, fromBlock: f, toBlock: t })),
  scan((f, t) => chain.getContractEvents({ address: SPEND_LOGGER, abi: spendLoggerAbi, eventName: "PolicySet", args: { agent: AGENT }, fromBlock: f, toBlock: t })),
]);

// Only payments to addresses the ledger names as a service count as agent purchases;
// anything else (e.g. a manual transfer) is reported separately.
const services = new Set(entries.map((e) => getAddress(e.args.service)));
const purchasePayments = payments.filter((p) => services.has(getAddress(p.args.to)));
const otherTransfers = payments.filter((p) => !services.has(getAddress(p.args.to)));

const outcomeById = new Map(outcomes.map((o) => [o.args.id, o]));
const entriesByTx = new Map();
for (const e of entries) { const m = e.args.memo.match(/x402:(0x[0-9a-f]{64})/); if (m) entriesByTx.set(m[1], [...(entriesByTx.get(m[1]) ?? []), e]); }

// ---------------------------------------------------------------------------
// match
// ---------------------------------------------------------------------------
const rows = []; const problems = [];
for (const p of purchasePayments) {
  const matches = entriesByTx.get(p.transactionHash) ?? [];
  if (matches.length === 0) { problems.push({ kind: "PAID_NOT_LOGGED", tx: p.transactionHash, amount: p.args.value.toString(), to: p.args.to }); continue; }
  if (matches.length > 1) { problems.push({ kind: "LOGGED_TWICE", tx: p.transactionHash, ids: matches.map((m) => m.args.id.toString()) }); continue; }
  const e = matches[0];
  const diffs = [];
  if (e.args.amount !== p.args.value) diffs.push(`amount logged ${e.args.amount} vs paid ${p.args.value}`);
  if (getAddress(e.args.service) !== getAddress(p.args.to)) diffs.push(`payee logged ${e.args.service} vs paid ${p.args.to}`);
  if (diffs.length) { problems.push({ kind: "MISMATCH", tx: p.transactionHash, id: e.args.id.toString(), diffs }); continue; }
  const o = outcomeById.get(e.args.id);
  rows.push({
    purchaseId: Number(e.args.id),
    timestamp: new Date(Number(e.args.timestamp) * 1000).toISOString(),
    agent: e.args.agent,
    vendor: e.args.service,
    amountBaseUnits: e.args.amount.toString(),
    amountUsdc: Number(e.args.amount) / 1e6,
    settlementTx: p.transactionHash,
    settlementBlock: Number(p.blockNumber),
    ledgerTx: e.transactionHash,
    policyHash: e.args.policyHash,
    reporter: e.args.reporter,
    memo: e.args.memo,
    outcomeScore: o ? Number(o.args.score) : null,
    outcomeTx: o?.transactionHash ?? null,
    outcomeBy: o?.args.recordedBy ?? null,
  });
  entriesByTx.delete(p.transactionHash);
}
for (const [tx, es] of entriesByTx) problems.push({ kind: "LOGGED_NOT_PAID", tx, ids: es.map((e) => e.args.id.toString()) });
for (const e of entries.filter((e) => !/x402:0x[0-9a-f]{64}/.test(e.args.memo))) problems.push({ kind: "ENTRY_WITHOUT_SETTLEMENT_REF", id: e.args.id.toString(), memo: e.args.memo });
rows.sort((a, b) => a.purchaseId - b.purchaseId);

// ---------------------------------------------------------------------------
// vendor scorecard: what did each payee cost, and was it worth it?
// ---------------------------------------------------------------------------
const byVendor = new Map();
for (const r of rows) {
  const v = byVendor.get(r.vendor) ?? { vendor: r.vendor, calls: 0, spentUsdc: 0, rated: 0, scoreSum: 0, good: 0, bad: 0 };
  v.calls++; v.spentUsdc += r.amountUsdc;
  if (r.outcomeScore != null) { v.rated++; v.scoreSum += r.outcomeScore; if (r.outcomeScore >= 4) v.good++; if (r.outcomeScore <= 1) v.bad++; }
  byVendor.set(r.vendor, v);
}
const scorecard = [...byVendor.values()].map((v) => ({
  vendor: v.vendor, calls: v.calls, spentUsdc: +v.spentUsdc.toFixed(6),
  avgPriceUsdc: +(v.spentUsdc / v.calls).toFixed(6),
  rated: v.rated, unrated: v.calls - v.rated,
  avgScore: v.rated ? +(v.scoreSum / v.rated).toFixed(2) : null,
  goodOutcomes: v.good, badOutcomes: v.bad,
  costPerGoodOutcomeUsdc: v.good ? +(v.spentUsdc / v.good).toFixed(6) : null,
})).sort((a, b) => b.spentUsdc - a.spentUsdc);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const totalPaid = purchasePayments.reduce((s, p) => s + p.args.value, 0n);
const totalLogged = entries.reduce((s, e) => s + e.args.amount, 0n);
const policyHistory = policySets.map((p) => ({ block: Number(p.blockNumber), policyHash: p.args.policyHash, tx: p.transactionHash }));
console.log(`payments ${purchasePayments.length} (${fmtUsdc(totalPaid)}) · ledger entries ${entries.length} (${fmtUsdc(totalLogged)}) · matched ${rows.length} · outcomes ${outcomes.length} · policy changes ${policySets.length}`);
if (otherTransfers.length) console.log(`(${otherTransfers.length} USDC transfer(s) from the agent to non-service addresses ignored)`);
console.log("\nvendor scorecard");
console.log("vendor                                     calls  spent      avg price  rated  avg score  good  cost/good");
for (const v of scorecard) console.log(`${v.vendor}  ${String(v.calls).padStart(5)}  ${("$" + v.spentUsdc).padEnd(9)}  ${("$" + v.avgPriceUsdc).padEnd(9)}  ${String(v.rated).padStart(5)}  ${String(v.avgScore ?? "-").padStart(9)}  ${String(v.goodOutcomes).padStart(4)}  ${v.costPerGoodOutcomeUsdc != null ? "$" + v.costPerGoodOutcomeUsdc : "-"}`);
if (problems.length === 0) console.log("\n✓ fully reconciled");
else { console.log(`\n✗ ${problems.length} problem(s):`); for (const p of problems) console.log("  ", JSON.stringify(p), p.tx ? txUrl(p.tx) : ""); process.exitCode = 1; }

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------
if (EXPORT) {
  mkdirSync(OUT_DIR, { recursive: true });
  const csv = (header, lines) => [header, ...lines].map((r) => r.map((c) => { const s = c == null ? "" : String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s; }).join(",")).join("\n") + "\n";
  const ddmmyyyy = (iso) => { const d = new Date(iso); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`; };
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  // 1. Full ledger — one row per reconciled purchase, everything an auditor needs.
  writeFileSync(join(OUT_DIR, "ledger.csv"), csv(
    ["purchase_id", "timestamp_utc", "agent", "vendor", "amount_usdc", "amount_base_units", "settlement_tx", "settlement_block", "ledger_tx", "policy_hash", "reporter", "outcome_score", "outcome_tx", "outcome_by", "memo", "explorer"],
    rows.map((r) => [r.purchaseId, r.timestamp, r.agent, r.vendor, r.amountUsdc.toFixed(6), r.amountBaseUnits, r.settlementTx, r.settlementBlock, r.ledgerTx, r.policyHash, r.reporter, r.outcomeScore, r.outcomeTx, r.outcomeBy, r.memo, `${ARC_TESTNET_EXPLORER}/tx/${r.settlementTx}`]),
  ));

  // Accounting systems round to cents and nobody wants 49 one-cent lines, so the
  // Xero / QuickBooks files carry ONE line per vendor per UTC day: exact USDC sum
  // (6 dp) rounded once at the aggregate. Per-purchase detail lives in ledger.csv;
  // the reference column names the purchase id range so a line can be traced back.
  const daily = new Map();
  for (const r of rows) {
    const key = `${r.timestamp.slice(0, 10)}|${r.vendor}`;
    const d = daily.get(key) ?? { date: r.timestamp.slice(0, 10), vendor: r.vendor, baseUnits: 0n, calls: 0, ids: [], scores: [] };
    d.baseUnits += BigInt(r.amountBaseUnits); d.calls++; d.ids.push(r.purchaseId); if (r.outcomeScore != null) d.scores.push(r.outcomeScore);
    daily.set(key, d);
  }
  const dailyRows = [...daily.values()].map((d) => ({
    ...d, amountUsdc: Number(d.baseUnits) / 1e6,
    idRange: d.ids.length > 1 ? `#${Math.min(...d.ids)}–#${Math.max(...d.ids)}` : `#${d.ids[0]}`,
    avgScore: d.scores.length ? (d.scores.reduce((a, b) => a + b, 0) / d.scores.length).toFixed(1) : null,
  }));

  // 2. Xero — precoded bank statement import (Date, Amount, Payee, Description, Reference). Spend is negative.
  writeFileSync(join(OUT_DIR, "xero.csv"), csv(
    ["*Date", "*Amount", "Payee", "Description", "Reference", "Cheque No."],
    dailyRows.map((d) => [ddmmyyyy(d.date), (-d.amountUsdc).toFixed(2), `Agent vendor ${short(d.vendor)}`, `${d.calls} agent purchase(s) ${d.idRange} via x402, USDC on Arc${d.avgScore ? ` — avg outcome ${d.avgScore}/5` : ""} — exact ${d.amountUsdc.toFixed(6)} USDC`, `SpendLogger ${d.idRange}`, ""]),
  ));

  // 3. QuickBooks — 3-column bank CSV (Date, Description, Amount).
  writeFileSync(join(OUT_DIR, "quickbooks.csv"), csv(
    ["Date", "Description", "Amount"],
    dailyRows.map((d) => [ddmmyyyy(d.date), `${d.calls} agent purchase(s) ${d.idRange} to ${short(d.vendor)} via x402, USDC on Arc (exact ${d.amountUsdc.toFixed(6)})`, (-d.amountUsdc).toFixed(2)]),
  ));

  // 4. Vendor scorecard.
  writeFileSync(join(OUT_DIR, "scorecard.csv"), csv(
    ["vendor", "calls", "spent_usdc", "avg_price_usdc", "rated", "unrated", "avg_score", "good_outcomes", "bad_outcomes", "cost_per_good_outcome_usdc"],
    scorecard.map((v) => [v.vendor, v.calls, v.spentUsdc, v.avgPriceUsdc, v.rated, v.unrated, v.avgScore, v.goodOutcomes, v.badOutcomes, v.costPerGoodOutcomeUsdc]),
  ));

  // 5. Machine-readable everything, including exceptions and the policy history.
  writeFileSync(join(OUT_DIR, "reconcile.json"), JSON.stringify({
    generatedAt: new Date().toISOString(), network: "eip155:5042002", spendLogger: SPEND_LOGGER, agent: AGENT,
    blocks: { from: Number(fromBlock), to: Number(latest) },
    totals: { payments: purchasePayments.length, paidUsdc: Number(totalPaid) / 1e6, ledgerEntries: entries.length, loggedUsdc: Number(totalLogged) / 1e6, matched: rows.length, outcomes: outcomes.length },
    reconciled: problems.length === 0, problems, policyHistory, scorecard, purchases: rows,
    ignoredTransfers: otherTransfers.map((p) => ({ tx: p.transactionHash, to: p.args.to, amountBaseUnits: p.args.value.toString() })),
  }, null, 2) + "\n");

  console.log(`\nexported to ${OUT_DIR}\n  ledger.csv (${rows.length} rows) · xero.csv · quickbooks.csv · scorecard.csv (${scorecard.length} vendor(s)) · reconcile.json`);
}
