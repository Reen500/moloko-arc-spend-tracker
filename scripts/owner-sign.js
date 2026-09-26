// Owner console — the Arc-Owner transactions, signed in MetaMask, never with a key on disk.
//
//   ARC_NETWORK=arcMainnet node scripts/owner-sign.js deploy
//   ARC_NETWORK=arcMainnet node scripts/owner-sign.js set-policy [--policy policies/x.json]
//
// Starts a one-shot page on http://127.0.0.1:8547. Open it in the browser profile
// that holds Arc-Owner, click Sign, confirm in MetaMask. The page posts the tx
// hash back; this script waits for the receipt, prints it and (for deploy)
// records the contract in deployed.json. The page only asks MetaMask to send
// the exact transaction printed below — check `to` and `data` against it.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, encodeFunctionData, getAddress, formatUnits, isHash } from "viem";
import { NETWORK, ARC, arcChain, arcTransport, spendLoggerAbi, txUrl, addressUrl } from "../shared/arc.js";
import { validatePolicy, policyHash } from "../shared/policy.js";

const PORT = 8547;
const argv = process.argv.slice(2);
const cmd = argv[0];
const pi = argv.indexOf("--policy");
const POLICY_PATH = pi === -1 ? ARC.defaultPolicy : argv[pi + 1];
if (!["deploy", "set-policy"].includes(cmd)) throw new Error("usage: owner-sign.js deploy | set-policy [--policy file]");

const policy = validatePolicy(JSON.parse(readFileSync(POLICY_PATH, "utf8")));
const OWNER = policy.controller;
if (policy.network !== `eip155:${ARC.chainId}`) throw new Error(`${POLICY_PATH} is for ${policy.network}, not ${ARC.name}`);

const pub = createPublicClient({ chain: arcChain, transport: arcTransport() });
const readDeployed = () => { try { return JSON.parse(readFileSync("deployed.json", "utf8")); } catch { return {}; } };

let tx, summary;
if (cmd === "deploy") {
  const { bytecode } = JSON.parse(readFileSync("artifacts/contracts/SpendLogger.sol/SpendLogger.json", "utf8"));
  if (readDeployed()[NETWORK]?.address) throw new Error(`deployed.json already has ${NETWORK}; remove it first to redeploy.`);
  tx = { from: OWNER, data: bytecode };
  summary = `Deploy SpendLogger v2 (${(bytecode.length - 2) / 2} bytes of init code) from ${OWNER}`;
} else {
  const SPEND_LOGGER = getAddress(readDeployed()[NETWORK].address);
  const [controller, current] = await Promise.all([
    pub.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "controllerOf", args: [policy.agent] }),
    pub.readContract({ address: SPEND_LOGGER, abi: spendLoggerAbi, functionName: "policyOf", args: [policy.agent] }),
  ]);
  if (controller !== OWNER) throw new Error(`controllerOf(${policy.agent}) is ${controller}, not ${OWNER} — run \`node scripts/policy.js bind\` first.`);
  const hash = policyHash(policy);
  if (current === hash) { console.log(`policy already set to ${hash}; nothing to do.`); process.exit(0); }
  tx = { from: OWNER, to: SPEND_LOGGER, data: encodeFunctionData({ abi: spendLoggerAbi, functionName: "setPolicy", args: [policy.agent, hash] }) };
  summary = `setPolicy(agent ${policy.agent}, ${hash}) on ${SPEND_LOGGER} — policy file ${POLICY_PATH}`;
}

const bal = await pub.getBalance({ address: OWNER });
console.log(`${ARC.name} (chain ${ARC.chainId})`);
console.log(`signer  ${OWNER}  balance ${formatUnits(bal, 18)} USDC`);
console.log(`action  ${summary}`);
if (tx.to) console.log(`to      ${tx.to}\ndata    ${tx.data}`);
if (bal === 0n) throw new Error("Arc-Owner has no USDC for gas.");

const chainHex = `0x${ARC.chainId.toString(16)}`;
const page = `<!doctype html><meta charset="utf-8"><title>Owner sign</title>
<body style="font:15px system-ui;max-width:640px;margin:40px auto;padding:0 16px">
<h2>${ARC.name}: owner transaction</h2>
<p><b>Action</b><br>${summary}</p>
<p><b>Must be signed by</b><br><code>${OWNER}</code> (Arc-Owner)</p>
<button id="go" style="font-size:16px;padding:10px 18px">Sign in MetaMask</button>
<pre id="out" style="white-space:pre-wrap"></pre>
<script>
const tx = ${JSON.stringify(tx)};
const out = (m) => document.getElementById("out").textContent += m + "\\n";
document.getElementById("go").onclick = async () => {
  try {
    if (!window.ethereum) return out("MetaMask not found in this browser profile.");
    const [acct] = await ethereum.request({ method: "eth_requestAccounts" });
    if (acct.toLowerCase() !== tx.from.toLowerCase()) return out("Wrong account selected: " + acct + "\\nSwitch MetaMask to Arc-Owner and click again.");
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "${chainHex}" }] });
    out("Confirm in MetaMask…");
    const hash = await ethereum.request({ method: "eth_sendTransaction", params: [tx] });
    out("Sent: " + hash + "\\nWaiting for confirmation in the terminal. You can close this tab.");
    await fetch("/done", { method: "POST", body: hash });
  } catch (e) { out("Error: " + (e.message || e)); }
};
</script>`;

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page); }
  if (req.method === "POST" && req.url === "/done") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      res.end("ok");
      const hash = body.trim();
      if (!isHash(hash)) return console.error(`bad hash from page: ${hash}`);
      server.close();
      await finish(hash);
    });
    return;
  }
  res.writeHead(404).end();
});
server.listen(PORT, "127.0.0.1", () => console.log(`\nOpen http://127.0.0.1:${PORT} in the Arc Mainnet Chrome profile and click Sign.`));

async function finish(hash) {
  console.log(`\ntx      ${hash}\nwaiting for receipt…`);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const t = await pub.getTransaction({ hash });
  if (getAddress(t.from) !== OWNER) throw new Error(`tx was sent from ${t.from}, not Arc-Owner`);
  console.log(`status  ${rc.status}  block ${rc.blockNumber}  gas ${rc.gasUsed}\n${txUrl(hash)}`);
  if (rc.status !== "success") process.exit(1);
  if (cmd === "deploy") {
    const all = readDeployed();
    all[NETWORK] = {
      network: NETWORK, chainId: ARC.chainId, contract: "SpendLogger", address: rc.contractAddress,
      deployer: OWNER, txHash: hash, blockNumber: Number(rc.blockNumber), gasUsed: rc.gasUsed.toString(),
      deployedAt: new Date().toISOString(), version: "v2",
      explorer: { contract: addressUrl(rc.contractAddress), tx: txUrl(hash) },
    };
    writeFileSync("deployed.json", JSON.stringify(all, null, 2) + "\n");
    console.log(`\n✅ SpendLogger at ${rc.contractAddress} — written to deployed.json under "${NETWORK}".`);
  } else {
    console.log(`\n✅ policy set.`);
  }
}
