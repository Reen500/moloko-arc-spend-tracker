import { defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import "dotenv/config";

// All networks below are TESTNETS. Never add a mainnet here.
// Values from https://docs.arc.io/arc/references/connect-to-arc
const ARC_TESTNET_RPC = process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.io";
const ARC_TESTNET_CHAIN_ID = 5042002;

// Deployer key is only read when present so `hardhat test` works without a .env.
const deployerAccounts = process.env.DEPLOYER_PRIVATE_KEY
  ? [process.env.DEPLOYER_PRIVATE_KEY]
  : [];

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Avoid PUSH0 so bytecode runs on any post-Merge EVM, whatever Arc's hardfork is.
      evmVersion: "paris",
    },
  },
  networks: {
    // Local in-process EVM used by `hardhat test`.
    hardhatMainnet: { type: "edr-simulated", chainType: "l1" },

    // Circle Arc public testnet. USDC is the native gas token (18 dec native,
    // 6 dec via the ERC-20 interface at 0x3600...0000).
    arcTestnet: {
      type: "http",
      chainType: "generic",
      url: ARC_TESTNET_RPC,
      chainId: ARC_TESTNET_CHAIN_ID,
      accounts: deployerAccounts,
    },

    // Fallback ONLY if Arc is unreachable (spec §9). Public x402 facilitator lives here.
    baseSepolia: {
      type: "http",
      chainType: "op",
      url: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org",
      chainId: 84532,
      accounts: deployerAccounts,
    },
  },
});
