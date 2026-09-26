// Policy attestation admin — the two on-chain setup steps plus a read-back.
//
//   node scripts/policy.js show                 # read controller + policy hash from chain
//   node scripts/policy.js bind                 # AGENT signs: setController(agent, controller)   (once)
//   node scripts/policy.js set                  # CONTROLLER signs: setPolicy(agent, hash(policy file))
//   node scripts/policy.js --policy policies/x.json set
//
// `bind` uses the network's agent key. `set` uses DEPLOYER_PRIVATE_KEY on testnet;
// on mainnet the controller (Arc-Owner) has no key in .env, so `set` prints the
// calldata to sign in MetaMask instead (see scripts/owner-sign.js).
// All are real transactions on the network ARC_NETWORK selects, gas paid in USDC.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createWalletClient, publicActions, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORK, ARC, arcChain, arcTransport, spendLoggerAbi, txUrl, agentKey } from "../shared/arc.js";
import { validatePolicy, policyHash, canonicalize } from "../shared/policy.js";

const argv = process.argv.slice(2);
const pi = argv.indexOf("--policy");
const POLICY_PATH = pi === -1 ? ARC.defaultPolicy : argv[pi + 1];
const positional = argv.filter((a, i) => !a.startsWith("--") && (pi === -1 || i !== pi + 1));
const cmd = positional[0] ?? "show";
if (!["show", "bind", "set"].includes(cmd)) throw new Error(`unknown command "${cmd}" — use show | bind | set`);

const deployed = JSON.parse(readFileSync("deployed.json", "utf8"));
const SPEND_LOGGER = getAddress(deployed[NETWORK].address);
const policy = validatePolicy(JSON.parse(readFileSync(POLICY_PATH, "utf8")));
const hash = policyHash(policy);

const pub = createWalletClient({ chain: arcChain, transport: arcTransport() }).extend(publicActions);
const signer = (key, label) => {
  if (!key || key === "0x...") throw new Error(`${label} missing in .env`);
  const account = privateKeyToAccount(key);
  return createWalletClient({ account, chain: arcChain, transport: arcTransport() }).extend(publicActions);
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
  const agent = signer(agentKey(), ARC.agentKeyVar);
  if (getAddress(agent.account.address) !== policy.agent) throw new Error(`${ARC.agentKeyVar} does not match policy.agent`);
  if (controllerOnChain !== "0x0000000000000000000000000000000000000000") {
    console.log(`\nalready bound to ${controllerOnChain}; nothing to do.`);
  } else {
    console.log(`\nbinding: agent ${policy.agent} -> controller ${policy.controller} (signed by agent) …`);
    const tx = await agent.writeContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "setController", args: [policy.agent, policy.controller] });
    const rc = await agent.waitForTransactionReceipt({ hash: tx });
    console.log(`  ${rc.status}  ${tx}  ${txUrl(tx)}  gas ${rc.gasUsed}`);
  }
}

if (cmd === "set" && !ARC.testnet) {
  // Mainnet controller is Arc-Owner, whose key never touches disk: hand off to MetaMask.
  if (policyOnChain === hash) console.log(`
policy already set to ${hash}; nothing to do.`);
  else console.log(`
setPolicy must be signed by the controller ${policy.controller} in MetaMask:
  node scripts/owner-sign.js set-policy${pi === -1 ? "" : ` --policy ${POLICY_PATH}`}`);
} else if (cmd === "set") {
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
