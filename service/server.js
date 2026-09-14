// Arc Spend Tracker — x402-paid service.
//
//   POST /api/process-description   $0.01 USDC via x402 (Arc Testnet)
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
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { createWalletClient, http, publicActions, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet, ARC_TESTNET_CAIP2, ARC_TESTNET_RPC, ARC_TESTNET_USDC, ARC_TESTNET_USDC_EIP712,
  spendLoggerAbi, txUrl, addressUrl, fmtUsdc,
} from "../shared/arc.js";
import { generatePlan } from "./plan.js";

loadEnv({ path: new URL("../.env", import.meta.url) });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.SERVICE_PORT ?? 3001);
const PRICE_BASE_UNITS = String(process.env.SERVICE_PRICE_BASE_UNITS ?? "10000"); // $0.01
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
if (!DEPLOYER_PRIVATE_KEY || DEPLOYER_PRIVATE_KEY === "0x...") {
  throw new Error("DEPLOYER_PRIVATE_KEY missing in .env (Arc-Deployer wallet; see SETUP.md Part B).");
}

function resolveSpendLoggerAddress() {
  if (process.env.SPEND_LOGGER_ADDRESS) return getAddress(process.env.SPEND_LOGGER_ADDRESS);
  const deployed = JSON.parse(readFileSync(new URL("../deployed.json", import.meta.url), "utf8"));
  const rec = deployed.arcTestnet;
  if (!rec?.address || rec.chainId !== arcTestnet.id) {
    throw new Error("No Arc Testnet SpendLogger in deployed.json — run `npm run deploy:arc` first.");
  }
  return getAddress(rec.address);
}
const SPEND_LOGGER = resolveSpendLoggerAddress();

// ---------------------------------------------------------------------------
// Chain clients — one wallet (Arc-Deployer) does everything on the service side:
// receives USDC, settles the EIP-3009 authorization, and reports to SpendLogger.
// ---------------------------------------------------------------------------
const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
const chainClient = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_TESTNET_RPC) })
  .extend(publicActions);
const SERVICE_ADDRESS = account.address;

// ---------------------------------------------------------------------------
// In-process x402 facilitator (verify + settle on Arc Testnet)
// ---------------------------------------------------------------------------
const facilitator = new x402Facilitator();
registerExactEvmScheme(facilitator, {
  signer: toFacilitatorEvmSigner({ ...chainClient, address: SERVICE_ADDRESS }),
  networks: ARC_TESTNET_CAIP2,
});
facilitator
  .onAfterSettle(async ({ result }) => console.log(`  ↳ settled  ${result.transaction}  ${txUrl(result.transaction)}`))
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
  .register(ARC_TESTNET_CAIP2, new ExactEvmServerScheme());

const routes = {
  "POST /api/process-description": {
    accepts: {
      scheme: "exact",
      network: ARC_TESTNET_CAIP2,
      payTo: SERVICE_ADDRESS,
      // Arc is not in x402's default-asset table, so price is an explicit AssetAmount.
      // `extra` is the USDC EIP-712 domain both sides need for TransferWithAuthorization.
      price: { asset: ARC_TESTNET_USDC, amount: PRICE_BASE_UNITS, extra: ARC_TESTNET_USDC_EIP712 },
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

resourceServer.onAfterSettle(async ({ paymentPayload, requirements, result }) => {
  if (!result.success) return;
  const payer = getAddress(result.payer ?? paymentPayload.payload?.authorization?.from);
  const amount = BigInt(requirements.amount);
  const memo = `POST /api/process-description x402:${result.transaction}`;

  const job = chainQueue.then(async () => {
    const hash = await chainClient.writeContract({
      address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "logPurchase",
      args: [payer, SERVICE_ADDRESS, amount, memo],
    });
    const receipt = await chainClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`logPurchase reverted: ${hash}`);
    const count = await chainClient.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "purchaseCount" });
    return { hash, id: count - 1n };
  });
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
    // Payment already settled; do not fail the caller because the audit write hiccupped.
    console.error("  ↳ logPurchase FAILED:", err.message);
  }
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => reqStore.run({ res }, next));
app.use((req, _res, next) => { console.log(`${new Date().toISOString()} ${req.method} ${req.path}`); next(); });

app.get("/health", (_req, res) => res.json({
  ok: true, network: ARC_TESTNET_CAIP2, service: SERVICE_ADDRESS, spendLogger: SPEND_LOGGER,
  price: { asset: ARC_TESTNET_USDC, amount: PRICE_BASE_UNITS, usd: fmtUsdc(PRICE_BASE_UNITS) },
}));

app.get("/api/ledger", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 10), 50);
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
  res.json({ contract: SPEND_LOGGER, explorer: addressUrl(SPEND_LOGGER), purchaseCount: count.toString(), purchases });
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
    billing: { asset: "USDC", network: ARC_TESTNET_CAIP2, amount: PRICE_BASE_UNITS, usd: fmtUsdc(PRICE_BASE_UNITS), audit_contract: SPEND_LOGGER },
  });
});

app.listen(PORT, () => {
  console.log("Arc Spend Tracker service");
  console.log(`  listening   http://localhost:${PORT}`);
  console.log(`  network     ${ARC_TESTNET_CAIP2} (Arc Testnet)`);
  console.log(`  payTo       ${SERVICE_ADDRESS}  ${addressUrl(SERVICE_ADDRESS)}`);
  console.log(`  SpendLogger ${SPEND_LOGGER}  ${addressUrl(SPEND_LOGGER)}`);
  console.log(`  price       ${fmtUsdc(PRICE_BASE_UNITS)} USDC per POST /api/process-description`);
  console.log("  facilitator in-process (verify + settle signed by payTo wallet)");
});
