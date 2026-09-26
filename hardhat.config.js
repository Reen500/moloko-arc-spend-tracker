import { defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import "dotenv/config";

// arcMainnet is listed for source verification only: it has no accounts, so
// hardhat can never sign a mainnet tx. Mainnet deploys go through
// scripts/owner-sign.js (Arc-Owner signs in MetaMask).
// Values from https://docs.arc.io/arc/references/connect-to-arc
const ARC_TESTNET_RPC = process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.io";
const ARC_TESTNET_CHAIN_ID = 5042002;
const ARC_MAINNET_CHAIN_ID = 5042;

// Deployer key is only read when present so `hardhat test` works without a .env.
const deployerAccounts = process.env.DEPLOYER_PRIVATE_KEY
  ? [process.env.DEPLOYER_PRIVATE_KEY]
  : [];

export default defineConfig({
  plugins: [hardhatToolboxViem],
  // Teaches hardhat-verify where Arc Testnet's Blockscout lives:
  //   npx hardhat verify blockscout --network arcTestnet <address>
  chainDescriptors: {
    [ARC_TESTNET_CHAIN_ID]: {
      name: "Arc Testnet",
      chainType: "generic",
      blockExplorers: {
        blockscout: {
          name: "ArcScan",
          url: "https://testnet.arcscan.app",
          apiUrl: "https://testnet.arcscan.app/api",
        },
      },
    },
    [ARC_MAINNET_CHAIN_ID]: {
      name: "Arc Mainnet",
      chainType: "generic",
      blockExplorers: {
        blockscout: {
          name: "Arc Explorer",
          url: "https://explorer.arc.io",
          apiUrl: "https://explorer.arc.io/api",
        },
      },
    },
  },
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

    // Verification only — no accounts (see top of file).
    arcMainnet: {
      type: "http",
      chainType: "generic",
      url: process.env.ARC_MAINNET_RPC ?? "https://rpc.mainnet.arc.io",
      chainId: ARC_MAINNET_CHAIN_ID,
      accounts: [],
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
