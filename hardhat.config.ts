import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import * as process from "node:process";
require("dotenv").config();

const HARDHAT_FORK_RPC_URL = process.env.HARDHAT_FORK_RPC_URL;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1, // Optimized for deployment size to stay under 24KB limit
      },
      evmVersion: "paris",
      viaIR: true, // Enables IR-based optimizer for better optimization
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
  },
  networks: {
    hardhat: {
      forking: HARDHAT_FORK_RPC_URL ? { url: HARDHAT_FORK_RPC_URL } : undefined,
    },
    // Built-in in-process network
    mainnet: {
      chainId: 1,
      url: process.env.ETH_RPC || "",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    // Fork of Ethereum Mainnet
    mainnetFork: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      // This network expects you to run `npx hardhat node` with forking enabled.
      // Keeping here for compatibility, but do not enable forking here directly.
    },
    // When you run `npx hardhat node`
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      // accounts are auto-provided by the node; you can override if you like:
      // accounts: [process.env.LOCAL_PRIVATE_KEY!],
    },
    sepolia: {
      chainId: 11155111,
      url: process.env.SEPOLIA_URL || "https://sepolia.drpc.org",
      accounts: process.env.ACCOUNT_PRIVATE_KEY ? [process.env.ACCOUNT_PRIVATE_KEY] : [],
    },
    garfield: { // https://explorer.garfield-testnet.zircuit.com/
      chainId: 48898,
      url: process.env.GARFIELD_URL || "https://garfield-testnet.zircuit.com",
      accounts: process.env.ACCOUNT_PRIVATE_KEY ? [process.env.ACCOUNT_PRIVATE_KEY] : [],
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    base: {
      url: "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    enabled: true,
  },
  mocha: {
    timeout: 120000,
  },
};

export default config;
