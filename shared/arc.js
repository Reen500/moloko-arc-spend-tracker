// Shared Arc constants for the service, the agent and the scripts.
// ARC_NETWORK in .env picks the network: "arcTestnet" (default) or "arcMainnet".
// Values come from https://docs.arc.io; USDC's EIP-712 domain was read from
// each chain's contract (see below).
import { config as loadEnv } from "dotenv";
import { defineChain, parseAbi, http } from "viem";

// Loaded here (not only by callers) because ESM evaluates this module before a
// caller's own loadEnv() call runs, and ARC_NETWORK must be known at import time.
loadEnv({ path: new URL("../.env", import.meta.url), quiet: true });

const NETWORKS = {
  arcTestnet: {
    name: "Arc Testnet",
    chainId: 5042002,
    rpc: process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.io",
    ws: "wss://rpc.testnet.arc.io",
    explorer: "https://testnet.arcscan.app",
    testnet: true,
    serviceKeyVar: "DEPLOYER_PRIVATE_KEY",
    agentKeyVar: "AGENT_PRIVATE_KEY",
    defaultPolicy: "policies/arc-agent.json",
  },
  arcMainnet: {
    name: "Arc Mainnet",
    chainId: 5042,
    rpc: process.env.ARC_MAINNET_RPC ?? "https://rpc.mainnet.arc.io",
    ws: "wss://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io",
    testnet: false,
    // Fresh wallets, separate seed from testnet. The owner (controller) key is
    // never in .env — it signs in MetaMask. Only these two hot keys are.
    serviceKeyVar: "MAINNET_SERVICE_PRIVATE_KEY",
    agentKeyVar: "MAINNET_AGENT_PRIVATE_KEY",
    defaultPolicy: "policies/arc-agent-mainnet.json",
  },
};

export const NETWORK = process.env.ARC_NETWORK ?? "arcTestnet";
export const ARC = NETWORKS[NETWORK];
if (!ARC) throw new Error(`ARC_NETWORK="${NETWORK}" — use one of: ${Object.keys(NETWORKS).join(", ")}`);

export const ARC_CHAIN_ID = ARC.chainId;
export const ARC_CAIP2 = `eip155:${ARC.chainId}`;
export const ARC_RPC = ARC.rpc;
export const ARC_EXPLORER = ARC.explorer;

/** ERC-20 interface of native USDC on Arc (6 decimals). Same address on testnet and mainnet. */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";

/**
 * EIP-712 domain of Arc USDC: name() = "USDC", version() = "2" on both chains
 * (testnet read 2026-09-14, mainnet 2026-09-26; reconstructed DOMAIN_SEPARATOR
 * matches on-chain on both). x402 needs these for TransferWithAuthorization.
 */
export const ARC_USDC_EIP712 = { name: "USDC", version: "2" };

export const arcChain = defineChain({
  id: ARC.chainId,
  name: ARC.name,
  testnet: ARC.testnet,
  // Gas is paid in USDC. The *native* balance has 18 decimals even though the
  // ERC-20 view of the same balance reports 6.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC.rpc], webSocket: [ARC.ws] } },
  blockExplorers: { default: { name: ARC.testnet ? "ArcScan" : "Arc Explorer", url: ARC.explorer } },
});

/** Private key for this network's service wallet (receives, settles, logs). */
export const serviceKey = () => requireKey(ARC.serviceKeyVar);
/** Private key for this network's paying agent. */
export const agentKey = () => requireKey(ARC.agentKeyVar);
function requireKey(name) {
  const v = process.env[name];
  if (!v || v === "0x...") throw new Error(`${name} missing in .env (needed for ${ARC.name}).`);
  return v.startsWith("0x") ? v : `0x${v}`;
}

/**
 * HTTP transport for Arc with a backoff that survives the public RPC's
 * rate limit (JSON-RPC -32005 "rate limit exceeded", seen at ~16 concurrent
 * eth_getLogs from one IP). viem retries -32005 by default but only 3× at
 * 150 ms; a burst of concurrent agents needs more headroom. Delays are
 * 400 ms · 2^attempt: 0.4, 0.8, 1.6, 3.2, 6.4, 12.8 s.
 * For production use a keyed provider (Alchemy / QuickNode / dRPC — all listed
 * in the Arc docs) via ARC_TESTNET_RPC / ARC_MAINNET_RPC.
 */
export const arcTransport = (url = ARC_RPC) => http(url, { retryCount: 6, retryDelay: 400, timeout: 30_000 });

/**
 * Max toBlock - fromBlock for one eth_getLogs call. Arc Mainnet's public RPC
 * allows 10,000 blocks inclusive (span 9,999; probed 2026-09-26), testnet ~20k.
 * One value that works on both.
 */
export const LOG_SPAN = 9_999n;

/** Minimal SpendLogger v2 ABI — mirrors contracts/SpendLogger.sol. */
export const spendLoggerAbi = parseAbi([
  // ledger
  "function logPurchase(address agent, address service, uint256 amount, string memo) returns (uint256 id)",
  "function purchaseCount() view returns (uint256)",
  "function getPurchase(uint256 id) view returns ((address agent, address service, uint256 amount, uint256 timestamp, string memo, address reporter, bytes32 policyHash))",
  "function totalSpentBy(address) view returns (uint256)",
  "function totalEarnedBy(address) view returns (uint256)",
  "event PurchaseLogged(uint256 indexed id, address indexed agent, address indexed service, uint256 amount, string memo, address reporter, uint256 timestamp, bytes32 policyHash)",
  // policy attestation
  "function controllerOf(address agent) view returns (address)",
  "function policyOf(address agent) view returns (bytes32)",
  "function setController(address agent, address controller)",
  "function setPolicy(address agent, bytes32 policyHash)",
  "event ControllerSet(address indexed agent, address indexed controller, address indexed setBy)",
  "event PolicySet(address indexed agent, bytes32 indexed policyHash, address indexed controller)",
  // outcomes
  "function recordOutcome(uint256 id, uint8 score, bytes32 reasonHash)",
  "function getOutcome(uint256 id) view returns ((uint8 score, bytes32 reasonHash, address recordedBy, uint256 timestamp, bool recorded))",
  "event OutcomeRecorded(uint256 indexed id, address indexed agent, uint8 score, bytes32 reasonHash, address recordedBy)",
]);

export const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const txUrl = (hash) => `${ARC_EXPLORER}/tx/${hash}`;
export const addressUrl = (addr) => `${ARC_EXPLORER}/address/${addr}`;

/** Format USDC base units (6 dec) as a dollar string. */
export const fmtUsdc = (baseUnits) => `$${(Number(baseUnits) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
