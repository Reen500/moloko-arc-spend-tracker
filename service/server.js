// Arc Spend Tracker — x402-paid service.
//
//   POST /api/process-description   $0.01 USDC via x402 (Arc; ARC_NETWORK picks testnet/mainnet)
//   GET  /api/ledger                 free: recent PurchaseLogged entries
//   GET  /health                     free
//
// Payment flow (spec §7):
//   1. No PAYMENT-SIGNATURE header  -> 402 + requirements (payTo = Arc-Deployer).
//   2. Agent signs an EIP-3009 TransferWithAuthorization for Arc USDC, retries.
//   3. The IN-PROCESS facilitator verifies the signature, then settles by
//      submitting transferWithAuthorization from the Arc-Deployer wallet
//      (no public x402 facilitator supports Arc yet — see README).
//   4. After settlement, the service calls SpendLogger.logPurchase().
//   5. 200 + plan JSON. Headers carry both tx hashes.
import { config as loadEnv } from "dotenv";
import { readFileSync, appendFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { createWalletClient, publicActions, getAddress, parseEventLogs, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  NETWORK, ARC, arcChain, ARC_CAIP2, ARC_USDC, ARC_USDC_EIP712, arcTransport, serviceKey,
  spendLoggerAbi, txUrl, addressUrl, fmtUsdc,
} from "../shared/arc.js";
import { generatePlan } from "./plan.js";

loadEnv({ path: new URL("../.env", import.meta.url) });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? process.env.SERVICE_PORT ?? 3001); // PORT: set by Railway
const PRICE_BASE_UNITS = String(process.env.SERVICE_PRICE_BASE_UNITS ?? "10000"); // $0.01
// Testnet: DEPLOYER_PRIVATE_KEY (Arc-Deployer). Mainnet: MAINNET_SERVICE_PRIVATE_KEY (Arc-Service).
const SERVICE_PRIVATE_KEY = serviceKey();

function resolveSpendLoggerAddress() {
  if (process.env.SPEND_LOGGER_ADDRESS) return getAddress(process.env.SPEND_LOGGER_ADDRESS);
  const deployed = JSON.parse(readFileSync(new URL("../deployed.json", import.meta.url), "utf8"));
  const rec = deployed[NETWORK];
  if (!rec?.address || rec.chainId !== arcChain.id) {
    throw new Error(`No ${ARC.name} SpendLogger in deployed.json (key "${NETWORK}") — deploy it first.`);
  }
  return getAddress(rec.address);
}
const SPEND_LOGGER = resolveSpendLoggerAddress();

// ---------------------------------------------------------------------------
// Chain clients — one wallet (Arc-Deployer) does everything on the service side:
// receives USDC, settles the EIP-3009 authorization, and reports to SpendLogger.
// ---------------------------------------------------------------------------
// nonceManager: settlement and logPurchase writes can be in flight at the same
// time under concurrent requests; without local nonce tracking they collide and
// one of them is silently replaced (seen in testing: 2/4 concurrent calls failed).
const account = privateKeyToAccount(SERVICE_PRIVATE_KEY, { nonceManager });
const chainClient = createWalletClient({ account, chain: arcChain, transport: arcTransport() })
  .extend(publicActions);
const SERVICE_ADDRESS = account.address;

// ---------------------------------------------------------------------------
// TEST-ONLY overrides — used by agent/policy-trial.js to make the service
// advertise a payTo / asset the agent's policy must refuse. Never set these in
// production: a paying client would send funds to TEST_ONLY_PAYTO.
// ---------------------------------------------------------------------------
const TEST_ONLY_PAYTO = process.env.TEST_ONLY_PAYTO ? getAddress(process.env.TEST_ONLY_PAYTO) : null;
const TEST_ONLY_ASSET = process.env.TEST_ONLY_ASSET ? getAddress(process.env.TEST_ONLY_ASSET) : null;
if ((TEST_ONLY_PAYTO || TEST_ONLY_ASSET) && (process.env.NODE_ENV === "production" || !ARC.testnet)) {
  throw new Error("TEST_ONLY_* overrides are only allowed on testnet, never with NODE_ENV=production");
}
const PAY_TO = TEST_ONLY_PAYTO ?? SERVICE_ADDRESS;
const PRICE_ASSET = TEST_ONLY_ASSET ?? ARC_USDC;
// EIP-712 domain of the priced asset. USDC and EURC on Arc Testnet are both
// Circle FiatTokenV2_2 with version "2"; the name differs.
const PRICE_ASSET_EIP712 = TEST_ONLY_ASSET
  ? { name: process.env.TEST_ONLY_ASSET_NAME ?? "EURC", version: "2" }
  : ARC_USDC_EIP712;

// ---------------------------------------------------------------------------
// In-process x402 facilitator (verify + settle on Arc)
// ---------------------------------------------------------------------------
const facilitator = new x402Facilitator();
registerExactEvmScheme(facilitator, {
  // 60 s receipt wait: Arc blocks are ~0.6 s, so a settlement not mined in a
  // minute is dead; failing fast beats holding the client connection open.
  signer: toFacilitatorEvmSigner({ ...chainClient, address: SERVICE_ADDRESS }, { confirmationTimeoutMs: 60_000 }),
  networks: ARC_CAIP2,
});
facilitator
  .onAfterSettle(async ({ result }) => result.success
    ? console.log(`  ↳ settled  ${result.transaction}  ${txUrl(result.transaction)}`)
    : console.warn(`  ↳ settle REJECTED (${result.errorReason ?? "unknown"}): ${result.errorMessage ?? ""} — client gets 402, nothing charged`))
  .onSettleFailure(async ({ error }) => console.error("  ↳ settle FAILED:", error.message));

// x402ResourceServer expects a FacilitatorClient (verify / settle / getSupported).
// The local facilitator has the same surface; getSupported is sync there.
const localFacilitatorClient = {
  verify: (p, r) => facilitator.verify(p, r),
  settle: (p, r) => facilitator.settle(p, r),
  getSupported: async () => facilitator.getSupported(),
};

// ---------------------------------------------------------------------------
// Resource server + route pricing
// ---------------------------------------------------------------------------
const resourceServer = new x402ResourceServer(localFacilitatorClient)
  .register(ARC_CAIP2, new ExactEvmServerScheme());

const routes = {
  "POST /api/process-description": {
    accepts: {
      scheme: "exact",
      network: ARC_CAIP2,
      payTo: PAY_TO,
      // Arc is not in x402's default-asset table, so price is an explicit AssetAmount.
      // `extra` is the token's EIP-712 domain both sides need for TransferWithAuthorization.
      price: { asset: PRICE_ASSET, amount: PRICE_BASE_UNITS, extra: PRICE_ASSET_EIP712 },
      maxTimeoutSeconds: 120,
    },
    description: "Turn a plain-text business-process description into a structured automation plan.",
    mimeType: "application/json",
  },
};

// ---------------------------------------------------------------------------
// After settlement: write the audit entry to SpendLogger.
// Runs before the buffered 200 response is flushed, so we can attach headers.
// ---------------------------------------------------------------------------
const reqStore = new AsyncLocalStorage();
let chainQueue = Promise.resolve(); // serialise Deployer-wallet writes (nonce safety)

// Audit writes must not be lost. Retry through RPC throttling; if the chain is
// still unreachable, persist the entry to pending-audit.jsonl for replay
// (scripts/replay-audit.js) and surface the backlog on /health.
const PENDING_AUDIT = new URL("./pending-audit.jsonl", import.meta.url);
let pendingAuditCount = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTransientRpc = (e) => /rate limit|exceeds defined limit|LimitExceeded|timeout|ECONNRESET|fetch failed|nonce|already known|replacement/i.test(e?.message ?? "");

async function writeAuditEntry(entry) {
  const { payer, payee, amount, memo } = entry;
  for (let attempt = 1; ; attempt++) {
    try {
      const hash = await chainClient.writeContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "logPurchase", args: [payer, payee, amount, memo] });
      const receipt = await chainClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error(`logPurchase reverted: ${hash}`);
      const ev = parseEventLogs({ abi: spendLoggerAbi, eventName: "PurchaseLogged", logs: receipt.logs })[0];
      if (!ev) throw new Error(`no PurchaseLogged event in ${hash}`);
      return { hash, id: ev.args.id };
    } catch (err) {
      if (!isTransientRpc(err) || attempt >= 5) throw err;
      const wait = 1000 * 2 ** attempt; // 2, 4, 8, 16 s
      const brief = (err.shortMessage ?? err.message).split("\n")[0];
      console.warn(`  ↳ logPurchase attempt ${attempt} failed (${brief}); retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

resourceServer.onAfterSettle(async ({ paymentPayload, requirements, result }) => {
  if (!result.success) return;
  if (!result.transaction) { console.error("  ↳ settle reported success with no tx hash — not logging"); return; }
  const payer = getAddress(result.payer ?? paymentPayload.payload?.authorization?.from);
  const payee = getAddress(requirements.payTo);          // what was actually paid, not what we assume
  const amount = BigInt(requirements.amount);
  const memo = `POST /api/process-description x402:${result.transaction}`;

  const entry = { payer, payee, amount: amount.toString(), memo, settlementTx: result.transaction, at: new Date().toISOString() };
  const job = chainQueue.then(() => writeAuditEntry({ ...entry, amount }));
  chainQueue = job.catch(() => {});
  try {
    const { hash, id } = await job;
    console.log(`  ↳ logged   ${hash}  (purchase #${id})  ${txUrl(hash)}`);
    const res = reqStore.getStore()?.res;
    if (res && !res.headersSent) {
      res.setHeader("X-Spend-Log-Tx", hash);
      res.setHeader("X-Spend-Log-Id", id.toString());
      res.setHeader("X-Spend-Log-Contract", SPEND_LOGGER);
    }
  } catch (err) {
    // Payment already settled; the caller still gets its result. The audit
    // entry is persisted and replayed later so the ledger never silently gaps.
    console.error("  ↳ logPurchase FAILED after retries:", (err.shortMessage ?? err.message).split("\n")[0]);
    try {
      appendFileSync(PENDING_AUDIT, JSON.stringify(entry) + "\n");
      pendingAuditCount++;
      console.error(`  ↳ queued to pending-audit.jsonl (${pendingAuditCount} pending) — run scripts/replay-audit.js`);
    } catch (e) {
      console.error("  ↳ COULD NOT PERSIST PENDING AUDIT:", e.message, JSON.stringify(entry));
    }
    const res = reqStore.getStore()?.res;
    if (res && !res.headersSent) res.setHeader("X-Spend-Log-Pending", "1");
  }
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1); // behind Railway's proxy: req.ip is the client, not the proxy
app.use(express.json({ limit: "64kb" }));

// Per-IP rate limit. The free routes fan out to RPC reads, and the public RPC's
// rate limit is shared with settlement — a flood of free reads must not be able
// to starve paid calls. 60 requests / minute / IP, fixed window, in memory.
const RATE = { windowMs: 60_000, max: 60 };
const hits = new Map();
setInterval(() => hits.clear(), RATE.windowMs).unref();
app.use((req, res, next) => {
  const n = (hits.get(req.ip) ?? 0) + 1;
  hits.set(req.ip, n);
  if (n > RATE.max) return res.status(429).json({ error: "rate limited — try again in a minute" });
  next();
});
app.use((req, res, next) => reqStore.run({ res }, next));
app.use((req, _res, next) => { console.log(`${new Date().toISOString()} ${req.method} ${req.path}`); next(); });

app.get("/health", (_req, res) => res.json({
  ok: true, network: ARC_CAIP2, service: SERVICE_ADDRESS, spendLogger: SPEND_LOGGER,
  price: { asset: PRICE_ASSET, amount: PRICE_BASE_UNITS, usd: fmtUsdc(PRICE_BASE_UNITS) }, payTo: PAY_TO,
  testOverrides: Boolean(TEST_ONLY_PAYTO || TEST_ONLY_ASSET),
  pendingAudit: pendingAuditCount,
}));

// Ledger reads are cached briefly: up to 1 + 2·limit RPC calls per miss.
const LEDGER_TTL_MS = 15_000;
const ledgerCache = new Map(); // limit -> { at, body }
app.get("/api/ledger", async (req, res) => {
  const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit ?? "10", 10) || 10, 50));
  const hit = ledgerCache.get(limit);
  if (hit && Date.now() - hit.at < LEDGER_TTL_MS) return res.json(hit.body);
  const count = await chainClient.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "purchaseCount" });
  const ids = [];
  for (let i = count - 1n; i >= 0n && ids.length < limit; i--) ids.push(i);
  const purchases = await Promise.all(ids.map(async (id) => {
    const [p, o] = await Promise.all([
      chainClient.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "getPurchase", args: [id] }),
      chainClient.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "getOutcome", args: [id] }),
    ]);
    return {
      id: id.toString(), agent: p.agent, service: p.service, amount: p.amount.toString(), usd: fmtUsdc(p.amount),
      timestamp: Number(p.timestamp), memo: p.memo, reporter: p.reporter, policyHash: p.policyHash,
      outcome: o.recorded ? { score: o.score, reasonHash: o.reasonHash, recordedBy: o.recordedBy, timestamp: Number(o.timestamp) } : null,
    };
  }));
  const body = { contract: SPEND_LOGGER, explorer: addressUrl(SPEND_LOGGER), purchaseCount: count.toString(), purchases };
  ledgerCache.set(limit, { at: Date.now(), body });
  res.json(body);
});

app.use(paymentMiddleware(routes, resourceServer));

app.post("/api/process-description", async (req, res) => {
  const description = req.body?.description;
  if (typeof description !== "string" || description.trim().length < 10) {
    return res.status(400).json({ error: "Body must be JSON: { \"description\": \"<at least 10 chars>\" }" });
  }
  const plan = await generatePlan(description);
  res.json({
    plan,
    billing: { asset: "USDC", network: ARC_CAIP2, amount: PRICE_BASE_UNITS, usd: fmtUsdc(PRICE_BASE_UNITS), audit_contract: SPEND_LOGGER },
  });
});

app.listen(PORT, () => {
  console.log("Arc Spend Tracker service");
  console.log(`  listening   http://localhost:${PORT}`);
  console.log(`  network     ${ARC_CAIP2} (${ARC.name})`);
  console.log(`  payTo       ${SERVICE_ADDRESS}  ${addressUrl(SERVICE_ADDRESS)}`);
  console.log(`  SpendLogger ${SPEND_LOGGER}  ${addressUrl(SPEND_LOGGER)}`);
  console.log(`  price       ${fmtUsdc(PRICE_BASE_UNITS)} USDC per POST /api/process-description`);
  console.log("  facilitator in-process (verify + settle signed by payTo wallet)");
  if (TEST_ONLY_PAYTO || TEST_ONLY_ASSET) {
    console.log("  !!! TEST-ONLY OVERRIDES ACTIVE — payTo " + PAY_TO + ", asset " + PRICE_ASSET + " (" + PRICE_ASSET_EIP712.name + ")");
  }
});
