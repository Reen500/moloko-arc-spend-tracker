// Reconcile: every USDC payment the agent made to the service must have exactly
// one SpendLogger entry whose memo references the settlement tx, with the same
// amount, payer and payee. Reports anything that does not line up.
//
//   node scripts/reconcile.js               # last ~150k blocks (≈ one UTC day)
//   node scripts/reconcile.js --from 62170000
//
// Arc gotcha: a USDC transfer emits TWO Transfer events — one from the native
// balance system address 0xfff…fffe (18 decimals) and one from the ERC-20
// contract 0x3600… (6 decimals). Only the ERC-20 one is the payment.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, getAddress } from "viem";
import { arcTestnet, arcTransport, ARC_TESTNET_USDC, spendLoggerAbi, usdcAbi, fmtUsdc, txUrl } from "../shared/arc.js";

const argv = process.argv.slice(2);
const fi = argv.indexOf("--from");
const deployed = JSON.parse(readFileSync(new URL("../deployed.json", import.meta.url), "utf8"));
const SPEND_LOGGER = getAddress(deployed.arcTestnet.address);
const AGENT = getAddress(process.env.AGENT_ADDRESS ?? "0xaAf714460A9FbEc7C3f0618cf04E84938b86DC8D");
const SERVICE = getAddress(process.env.DEPLOYER_ADDRESS ?? "0x52DF4736C94BA91cf7d49b84b642089F85A47C77");

const chain = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
const latest = await chain.getBlockNumber();
const fromBlock = fi === -1 ? BigInt(deployed.arcTestnet.blockNumber) : BigInt(argv[fi + 1]);
const CHUNK = 10_000n;

async function scan(fn) {
  const out = [];
  for (let s = fromBlock; s <= latest; s += CHUNK + 1n) out.push(...await fn(s, s + CHUNK > latest ? latest : s + CHUNK));
  return out;
}
console.log(`SpendLogger ${SPEND_LOGGER} · blocks ${fromBlock}..${latest} · agent ${AGENT.slice(0, 10)}… → service ${SERVICE.slice(0, 10)}…`);

const payments = await scan((f, t) => chain.getContractEvents({ address: ARC_TESTNET_USDC, abi: usdcAbi, eventName: "Transfer", args: { from: AGENT, to: SERVICE }, fromBlock: f, toBlock: t }));
const entries = await scan((f, t) => chain.getContractEvents({ address: SPEND_LOGGER, abi: spendLoggerAbi, eventName: "PurchaseLogged", args: { agent: AGENT }, fromBlock: f, toBlock: t }));

const byTx = new Map();
for (const e of entries) { const m = e.args.memo.match(/x402:(0x[0-9a-f]{64})/); if (m) byTx.set(m[1], [...(byTx.get(m[1]) ?? []), e]); }

let ok = 0; const problems = [];
for (const p of payments) {
  const matches = byTx.get(p.transactionHash) ?? [];
  if (matches.length === 0) problems.push({ kind: "PAID_NOT_LOGGED", tx: p.transactionHash, amount: p.args.value });
  else if (matches.length > 1) problems.push({ kind: "LOGGED_TWICE", tx: p.transactionHash, ids: matches.map((m) => m.args.id) });
  else {
    const e = matches[0];
    const diffs = [];
    if (e.args.amount !== p.args.value) diffs.push(`amount ${e.args.amount}≠${p.args.value}`);
    if (getAddress(e.args.service) !== SERVICE) diffs.push(`service ${e.args.service}`);
    if (diffs.length) problems.push({ kind: "MISMATCH", tx: p.transactionHash, id: e.args.id, diffs });
    else ok++;
  }
  byTx.delete(p.transactionHash);
}
for (const [tx, es] of byTx) problems.push({ kind: "LOGGED_NOT_PAID", tx, ids: es.map((e) => e.args.id) });
const noRef = entries.filter((e) => !/x402:0x[0-9a-f]{64}/.test(e.args.memo));
for (const e of noRef) problems.push({ kind: "ENTRY_WITHOUT_SETTLEMENT_REF", id: e.args.id, memo: e.args.memo });

const totalPaid = payments.reduce((s, p) => s + p.args.value, 0n);
const totalLogged = entries.reduce((s, e) => s + e.args.amount, 0n);
console.log(`payments ${payments.length} (${fmtUsdc(totalPaid)}) · ledger entries ${entries.length} (${fmtUsdc(totalLogged)}) · matched ${ok}`);
if (problems.length === 0) console.log("✓ fully reconciled");
else { console.log(`✗ ${problems.length} problem(s):`); for (const p of problems) console.log("  ", JSON.stringify(p, (k, v) => typeof v === "bigint" ? v.toString() : v), p.tx ? txUrl(p.tx) : ""); process.exitCode = 1; }
