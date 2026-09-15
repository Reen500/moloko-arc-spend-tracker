// Replay audit entries the service could not write to SpendLogger at the time
// (RPC outage / rate limit). Reads service/pending-audit.jsonl, logs each entry
// with logPurchase (signed by the Deployer / service wallet), and rewrites the
// file with whatever still fails.
//
//   node scripts/replay-audit.js
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createWalletClient, publicActions, getAddress, parseEventLogs, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, arcTransport, spendLoggerAbi, txUrl } from "../shared/arc.js";

const FILE = new URL("../service/pending-audit.jsonl", import.meta.url);
if (!existsSync(FILE)) { console.log("nothing pending"); process.exit(0); }
const entries = readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
if (entries.length === 0) { console.log("nothing pending"); process.exit(0); }

const deployed = JSON.parse(readFileSync(new URL("../deployed.json", import.meta.url), "utf8"));
const SPEND_LOGGER = getAddress(deployed.arcTestnet.address);
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY, { nonceManager });
const chain = createWalletClient({ account, chain: arcTestnet, transport: arcTransport() }).extend(publicActions);

console.log(`${entries.length} pending audit entr${entries.length === 1 ? "y" : "ies"} → SpendLogger ${SPEND_LOGGER}`);
const stillPending = [];
for (const e of entries) {
  try {
    const hash = await chain.writeContract({
      address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "logPurchase",
      args: [getAddress(e.payer), getAddress(e.payee), BigInt(e.amount), e.memo],
    });
    const receipt = await chain.waitForTransactionReceipt({ hash, timeout: 60_000 });
    const ev = parseEventLogs({ abi: spendLoggerAbi, eventName: "PurchaseLogged", logs: receipt.logs })[0];
    console.log(`  ✓ ${e.settlementTx.slice(0, 12)}… → purchase #${ev?.args.id}  ${txUrl(hash)}`);
  } catch (err) {
    console.log(`  ✗ ${e.settlementTx.slice(0, 12)}… still failing: ${(err.shortMessage ?? err.message).split("\n")[0]}`);
    stillPending.push(e);
  }
}
writeFileSync(FILE, stillPending.map((e) => JSON.stringify(e)).join("\n") + (stillPending.length ? "\n" : ""));
console.log(`\n${entries.length - stillPending.length} replayed, ${stillPending.length} still pending`);
