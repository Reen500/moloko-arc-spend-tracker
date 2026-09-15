// Policy attestation admin — the two on-chain setup steps plus a read-back.
//
//   node scripts/policy.js show                 # read controller + policy hash from chain
//   node scripts/policy.js bind                 # AGENT signs: setController(agent, controller)   (once)
//   node scripts/policy.js set                  # CONTROLLER signs: setPolicy(agent, hash(policy file))
//   node scripts/policy.js --policy policies/x.json set
//
// `bind` uses AGENT_PRIVATE_KEY; `set` uses DEPLOYER_PRIVATE_KEY (the controller).
// Both are real transactions on Arc Testnet, gas paid in USDC by the signer.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createWalletClient, publicActions, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, arcTransport, spendLoggerAbi, txUrl } from "../shared/arc.js";
import { validatePolicy, policyHash, canonicalize } from "../shared/policy.js";

const argv = process.argv.slice(2);
const pi = argv.indexOf("--policy");
const POLICY_PATH = pi === -1 ? "policies/arc-agent.json" : argv[pi + 1];
const positional = argv.filter((a, i) => !a.startsWith("--") && (pi === -1 || i !== pi + 1));
const cmd = positional[0] ?? "show";
if (!["show", "bind", "set"].includes(cmd)) throw new Error(`unknown command "${cmd}" — use show | bind | set`);

const deployed = JSON.parse(readFileSync("deployed.json", "utf8"));
const SPEND_LOGGER = getAddress(deployed.arcTestnet.address);
const policy = validatePolicy(JSON.parse(readFileSync(POLICY_PATH, "utf8")));
const hash = policyHash(policy);

const pub = createWalletClient({ chain: arcTestnet, transport: arcTransport() }).extend(publicActions);
const signer = (key, label) => {
  if (!key || key === "0x...") throw new Error(`${label} missing in .env`);
  const account = privateKeyToAccount(key);
  return createWalletClient({ account, chain: arcTestnet, transport: arcTransport() }).extend(publicActions);
};

const [controllerOnChain, policyOnChain] = await Promise.all([
  pub.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "controllerOf", args: [policy.agent] }),
  pub.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "policyOf", args: [policy.agent] }),
]);

console.log(`SpendLogger  ${SPEND_LOGGER}`);
console.log(`policy file  ${POLICY_PATH}`);
console.log(`  agent      ${policy.agent}`);
console.log(`  controller ${policy.controller}`);
console.log(`  canonical  ${canonicalize(policy).slice(0, 96)}…`);
console.log(`  hash       ${hash}`);
console.log(`on-chain     controller ${controllerOnChain}`);
console.log(`             policy     ${policyOnChain}  ${policyOnChain === hash ? "✓ matches file" : "✗ differs from file"}`);

if (cmd === "show") process.exitCode = 0;

if (cmd === "bind") {
  const agent = signer(process.env.AGENT_PRIVATE_KEY, "AGENT_PRIVATE_KEY");
  if (getAddress(agent.account.address) !== policy.agent) throw new Error("AGENT_PRIVATE_KEY does not match policy.agent");
  if (controllerOnChain !== "0x0000000000000000000000000000000000000000") {
    console.log(`\nalready bound to ${controllerOnChain}; nothing to do.`);
  } else {
    console.log(`\nbinding: agent ${policy.agent} -> controller ${policy.controller} (signed by agent) …`);
    const tx = await agent.writeContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "setController", args: [policy.agent, policy.controller] });
    const rc = await agent.waitForTransactionReceipt({ hash: tx });
    console.log(`  ${rc.status}  ${tx}  ${txUrl(tx)}  gas ${rc.gasUsed}`);
  }
}

if (cmd === "set") {
  const controller = signer(process.env.DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY");
  if (getAddress(controller.account.address) !== policy.controller) throw new Error("DEPLOYER_PRIVATE_KEY does not match policy.controller");
  if (policyOnChain === hash) {
    console.log(`\npolicy already set to ${hash}; nothing to do.`);
  } else {
    console.log(`\nsetting policy for ${policy.agent} to ${hash} (signed by controller) …`);
    const tx = await controller.writeContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "setPolicy", args: [policy.agent, hash] });
    const rc = await controller.waitForTransactionReceipt({ hash: tx });
    console.log(`  ${rc.status}  ${tx}  ${txUrl(tx)}  gas ${rc.gasUsed}`);
  }
}
