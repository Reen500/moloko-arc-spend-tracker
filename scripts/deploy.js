// Deploys SpendLogger and records address / tx / block in ./deployed.json.
//
//   npx hardhat run scripts/deploy.js --network arcTestnet
//
// Signs with DEPLOYER_PRIVATE_KEY from .env (Arc-Deployer MetaMask account).
// Refuses to run against anything that isn't a known TESTNET chain id.
import { network } from "hardhat";
import { formatUnits } from "viem";
import { readFile, writeFile } from "node:fs/promises";

const TESTNETS = {
  5042002: { name: "Arc Testnet",  explorer: "https://testnet.arcscan.app", gasSymbol: "USDC", gasDecimals: 18 },
  84532:   { name: "Base Sepolia", explorer: "https://sepolia.basescan.org", gasSymbol: "ETH",  gasDecimals: 18 },
  31337:   { name: "Hardhat local (simulated)", explorer: "n/a", gasSymbol: "ETH", gasDecimals: 18 },
};

const connection = await network.create();
const { viem, networkName } = connection;
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();

const net = TESTNETS[chainId];
if (!net) {
  throw new Error(
    `Refusing to deploy: chain id ${chainId} (network "${networkName}") is not a known testnet. ` +
    `This project is testnet-only.`,
  );
}

const [deployer] = await viem.getWalletClients();
if (!deployer) {
  throw new Error("No deployer account. Set DEPLOYER_PRIVATE_KEY in .env (see SETUP.md, Part B).");
}
const from = deployer.account.address;
const balanceBefore = await publicClient.getBalance({ address: from });

console.log(`Network : ${net.name} (chainId ${chainId}, hardhat network "${networkName}")`);
console.log(`Deployer: ${from}`);
console.log(`Balance : ${formatUnits(balanceBefore, net.gasDecimals)} ${net.gasSymbol}`);
if (balanceBefore === 0n) {
  throw new Error(`Deployer has no ${net.gasSymbol} for gas. Fund it at https://faucet.circle.com`);
}

console.log("\nDeploying SpendLogger …");
const { contract, deploymentTransaction } = await viem.sendDeploymentTransaction("SpendLogger");
console.log(`tx sent : ${deploymentTransaction.hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
if (receipt.status !== "success") {
  throw new Error(`Deployment reverted in tx ${deploymentTransaction.hash}`);
}
const balanceAfter = await publicClient.getBalance({ address: from });

const record = {
  network: networkName,
  chainId,
  contract: "SpendLogger",
  address: contract.address,
  deployer: from,
  txHash: deploymentTransaction.hash,
  blockNumber: Number(receipt.blockNumber),
  gasUsed: receipt.gasUsed.toString(),
  deployedAt: new Date().toISOString(),
  explorer: {
    contract: `${net.explorer}/address/${contract.address}`,
    tx: `${net.explorer}/tx/${deploymentTransaction.hash}`,
  },
};

// Keep one entry per network so an Arc deploy never clobbers a fallback deploy.
let all = {};
try { all = JSON.parse(await readFile("deployed.json", "utf8")); } catch { /* first deploy */ }
all[networkName] = record;
await writeFile("deployed.json", JSON.stringify(all, null, 2) + "\n");

console.log(`\n✅ SpendLogger deployed`);
console.log(`address : ${contract.address}`);
console.log(`block   : ${receipt.blockNumber}`);
console.log(`gas used: ${receipt.gasUsed} (cost ${formatUnits(balanceBefore - balanceAfter, net.gasDecimals)} ${net.gasSymbol})`);
console.log(`explorer: ${record.explorer.contract}`);
console.log(`tx      : ${record.explorer.tx}`);
console.log(`\nWritten to deployed.json under "${networkName}".`);
