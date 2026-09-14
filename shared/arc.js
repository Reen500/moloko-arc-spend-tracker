// Shared Arc Testnet constants for the service and the agent.
// Every value here is TESTNET and comes from https://docs.arc.io — do not
// add mainnet values to this file.
import { defineChain, parseAbi } from "viem";

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

/** Minimal SpendLogger ABI — mirrors contracts/SpendLogger.sol. */
export const spendLoggerAbi = parseAbi([
  "function logPurchase(address agent, address service, uint256 amount, string memo) returns (uint256 id)",
  "function purchaseCount() view returns (uint256)",
  "function getPurchase(uint256 id) view returns ((address agent, address service, uint256 amount, uint256 timestamp, string memo, address reporter))",
  "function totalSpentBy(address) view returns (uint256)",
  "function totalEarnedBy(address) view returns (uint256)",
  "event PurchaseLogged(uint256 indexed id, address indexed agent, address indexed service, uint256 amount, string memo, address reporter, uint256 timestamp)",
]);

export const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const txUrl = (hash) => `${ARC_TESTNET_EXPLORER}/tx/${hash}`;
export const addressUrl = (addr) => `${ARC_TESTNET_EXPLORER}/address/${addr}`;

/** Format USDC base units (6 dec) as a dollar string. */
export const fmtUsdc = (baseUnits) => `$${(Number(baseUnits) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
