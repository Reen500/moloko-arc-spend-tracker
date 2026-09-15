// Shared Arc Testnet constants for the service and the agent.
// Every value here is TESTNET and comes from https://docs.arc.io — do not
// add mainnet values to this file.
import { defineChain, parseAbi, http } from "viem";

export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_TESTNET_CAIP2 = `eip155:${ARC_TESTNET_CHAIN_ID}`;
export const ARC_TESTNET_RPC = process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.io";
export const ARC_TESTNET_EXPLORER = "https://testnet.arcscan.app";

/** ERC-20 interface of native USDC on Arc Testnet (6 decimals via ERC-20). */
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";

/**
 * EIP-712 domain of Arc Testnet USDC, read from the contract on 2026-09-14
 * (name() = "USDC", version() = "2"; reconstructed DOMAIN_SEPARATOR matches
 * on-chain). x402 needs these to build the TransferWithAuthorization typed data.
 */
export const ARC_TESTNET_USDC_EIP712 = { name: "USDC", version: "2" };

export const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  testnet: true,
  // Gas is paid in USDC. The *native* balance has 18 decimals even though the
  // ERC-20 view of the same balance reports 6.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_TESTNET_RPC], webSocket: ["wss://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "ArcScan", url: ARC_TESTNET_EXPLORER } },
});

/**
 * HTTP transport for Arc Testnet with a backoff that survives the public RPC's
 * rate limit (JSON-RPC -32005 "rate limit exceeded", seen at ~16 concurrent
 * eth_getLogs from one IP). viem retries -32005 by default but only 3× at
 * 150 ms; a burst of concurrent agents needs more headroom. Delays are
 * 400 ms · 2^attempt: 0.4, 0.8, 1.6, 3.2, 6.4, 12.8 s.
 * For production use a keyed provider (Alchemy / QuickNode / dRPC — all listed
 * in the Arc docs) via ARC_TESTNET_RPC.
 */
export const arcTransport = (url = ARC_TESTNET_RPC) => http(url, { retryCount: 6, retryDelay: 400, timeout: 30_000 });

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

export const txUrl = (hash) => `${ARC_TESTNET_EXPLORER}/tx/${hash}`;
export const addressUrl = (addr) => `${ARC_TESTNET_EXPLORER}/address/${addr}`;

/** Format USDC base units (6 dec) as a dollar string. */
export const fmtUsdc = (baseUnits) => `$${(Number(baseUnits) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
