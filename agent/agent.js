// Demo agent: discover -> pay -> call -> print.
//
//   node agent.js                # one paid call
//   node agent.js --calls 5      # five paid calls (builds on-chain history)
//   node agent.js --dry-run      # only show the 402 requirements, sign nothing
//   node agent.js --calls 5 --delay 60      # 60 s between calls
//   node agent.js --calls 5 --delay 30-120  # random 30..120 s between calls
//
// Signs with AGENT_PRIVATE_KEY (Arc-Agent MetaMask account). The signature is
// an off-chain EIP-3009 authorization; the service submits it on-chain and pays
// gas, so this wallet spends exactly the price and nothing else.
import { config as loadEnv } from "dotenv";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { createPublicClient, http, getAddress, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet, ARC_TESTNET_CAIP2, ARC_TESTNET_RPC, ARC_TESTNET_USDC,
  spendLoggerAbi, usdcAbi, txUrl, addressUrl, fmtUsdc,
} from "../shared/arc.js";

loadEnv({ path: new URL("../.env", import.meta.url) });

// ---------------------------------------------------------------------------
// CLI + config
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i === -1 ? def : (argv[i + 1] ?? true); };
const CALLS = Number(flag("--calls", 1));
const DRY_RUN = argv.includes("--dry-run");
// --delay 30      -> wait 30 s between calls
// --delay 30-120  -> wait a random 30..120 s between calls
const DELAY = String(flag("--delay", "0"));
const [DELAY_MIN, DELAY_MAX] = DELAY.split("-").map(Number).concat([NaN]).slice(0, 2);
const nextDelayMs = () => {
  const max = Number.isFinite(DELAY_MAX) ? DELAY_MAX : DELAY_MIN;
  return Math.round((DELAY_MIN + Math.random() * Math.max(0, max - DELAY_MIN)) * 1000);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVICE_URL = (process.env.SERVICE_URL ?? "http://localhost:3001").replace(/\/$/, "");
const ENDPOINT = `${SERVICE_URL}/api/process-description`;
const MAX_PRICE_BASE_UNITS = "50000"; // refuse anything over $0.05 per call — guard against a misconfigured server

const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
if (!AGENT_PRIVATE_KEY || AGENT_PRIVATE_KEY === "0x...") {
  throw new Error("AGENT_PRIVATE_KEY missing in .env (Arc-Agent wallet; see SETUP.md Part B).");
}
const account = privateKeyToAccount(AGENT_PRIVATE_KEY);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

const PROCESSES = [
  "Receive the supplier invoice by email. Extract the PDF totals and match them to the purchase order. If the amounts differ by more than 2%, a manager must approve. Then post the entry to Xero and send a confirmation to the supplier.",
  "A customer submits a support ticket. Classify it by product. If it mentions a refund, route to finance, otherwise assign to the product team. Update the CRM and notify the customer.",
  "Every Monday export last week's sales from the ERP to a spreadsheet, calculate commission per rep, and email each rep their statement. If a rep's total is negative, flag it for review.",
  "New hire onboarding: HR creates the employee record, IT provisions a laptop and accounts, the manager schedules orientation, and payroll is updated. Send a welcome email when all steps are complete.",
  "Expense claims arrive as scanned receipts. Extract merchant, date and amount, check against policy limits, and if over the limit request director approval. Approved claims are posted to the payroll batch.",
];

const usdcBalance = (addr) => publicClient.readContract({ address: ARC_TESTNET_USDC, abi: usdcAbi, functionName: "balanceOf", args: [addr] });

// ---------------------------------------------------------------------------
// x402 client: exact scheme on Arc Testnet, Arc USDC explicitly allowed
// (it's not in x402's default-asset table), capped per payment.
// ---------------------------------------------------------------------------
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: ARC_TESTNET_CAIP2, client: new ExactEvmScheme(account) }],
  spendControls: {
    allowedAssets: [{ network: ARC_TESTNET_CAIP2, asset: ARC_TESTNET_USDC, maxAmountPerPayment: MAX_PRICE_BASE_UNITS }],
  },
});

// ---------------------------------------------------------------------------
// 1. Discover
// ---------------------------------------------------------------------------
console.log("Arc Spend Tracker agent");
console.log(`  wallet   ${account.address}  ${addressUrl(account.address)}`);
console.log(`  service  ${ENDPOINT}`);

const balanceBefore = await usdcBalance(account.address);
console.log(`  balance  ${fmtUsdc(balanceBefore)} USDC (ERC-20 view)`);

const probe = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: PROCESSES[0] }) });
if (probe.status !== 402) throw new Error(`Expected 402 from unpaid request, got ${probe.status}`);
const required = JSON.parse(Buffer.from(probe.headers.get("PAYMENT-REQUIRED"), "base64").toString("utf8"));
const offer = required.accepts[0];
console.log(`\n402 received — service asks for:`);
console.log(`  ${fmtUsdc(offer.amount)} ${offer.extra?.name ?? "?"} (${offer.amount} base units) on ${offer.network}`);
console.log(`  asset   ${offer.asset}`);
console.log(`  payTo   ${offer.payTo}`);

if (offer.network !== ARC_TESTNET_CAIP2) throw new Error(`Refusing: service wants ${offer.network}, this agent only pays on ${ARC_TESTNET_CAIP2} (testnet).`);
if (getAddress(offer.asset) !== getAddress(ARC_TESTNET_USDC)) throw new Error(`Refusing: unexpected asset ${offer.asset}`);
if (BigInt(offer.amount) > BigInt(MAX_PRICE_BASE_UNITS)) throw new Error(`Refusing: price ${offer.amount} exceeds cap ${MAX_PRICE_BASE_UNITS}`);

if (DRY_RUN) console.log("\n--dry-run: nothing signed, nothing paid.");

// ---------------------------------------------------------------------------
// 2..N. Pay -> call -> print
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
  const res = await fetchWithPayment(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description }),
  });
  const ms = Date.now() - t0;
  const body = await res.json();
  if (res.status !== 200) {
    console.error(`  ✗ HTTP ${res.status}`, JSON.stringify(body));
    break;
  }
  const settlement = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE"));
  const logTx = res.headers.get("X-Spend-Log-Tx");
  const logId = res.headers.get("X-Spend-Log-Id");
  results.push({ settlement, logTx, logId });

  console.log(`  ✓ 200 in ${(ms / 1000).toFixed(1)}s`);
  console.log(`  plan     ${body.plan.process_name} — ${body.plan.summary}`);
  console.log(`           readiness ${body.plan.assessment.automation_readiness}% · tools: ${body.plan.suggested_tools.map((t) => t.tool).join("; ")}`);
  console.log(`  paid     ${settlement.transaction}  ${txUrl(settlement.transaction)}`);
  console.log(`  logged   ${logTx ?? "(header missing)"}  ${logTx ? txUrl(logTx) : ""}  purchase #${logId ?? "?"}`);
  if (i === 0) console.log(`\n  full plan for call 1:\n${JSON.stringify(body.plan, null, 2).split("\n").map((l) => "    " + l).join("\n")}`);
}

// ---------------------------------------------------------------------------
// Verify independently on-chain (don't just trust the service's headers)
// ---------------------------------------------------------------------------
if (results.length) {
  const balanceAfter = await usdcBalance(account.address);
  const spent = balanceBefore - balanceAfter;
  console.log(`\n── on-chain check ────────────────────────────────────────────`);
  console.log(`  USDC spent by agent : ${fmtUsdc(spent)} (${spent} base units, ${results.length} call(s))`);

  const last = results.at(-1);
  if (last.logTx) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: last.logTx });
    const logs = await publicClient.getLogs({
      address: receipt.logs[0]?.address,
      event: parseAbiItem("event PurchaseLogged(uint256 indexed id, address indexed agent, address indexed service, uint256 amount, string memo, address reporter, uint256 timestamp)"),
      args: { agent: account.address },
      fromBlock: receipt.blockNumber - 50n, toBlock: receipt.blockNumber,
    });
    const mine = logs.at(-1);
    if (mine) {
      console.log(`  PurchaseLogged #${mine.args.id}: agent=${mine.args.agent} service=${mine.args.service} amount=${fmtUsdc(mine.args.amount)}`);
      console.log(`    memo "${mine.args.memo}"`);
    }
    const count = await publicClient.readContract({ address: receipt.logs[0]?.address, abi: spendLoggerAbi, functionName: "purchaseCount" });
    console.log(`  SpendLogger.purchaseCount = ${count}`);
  }
  console.log(`\n  agent wallet  ${addressUrl(account.address)}`);
}
