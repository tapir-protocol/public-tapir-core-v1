import { expect } from "chai";
import { ethers } from "hardhat";
import { 
  TapirOracle, 
  DepegPool, 
  MockCrossDomainMessenger,
  Api3ReaderProxyMock,
  ChainlinkAggregatorMock,
  DepegToken,
  DepegFactory
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// Helper function to create DepegPoolParams struct
function createDepegPoolParams(overrides: Partial<{
  assetAddress: string;
  dpName: string;
  dpSymbol: string;
  ybName: string;
  ybSymbol: string;
  oracle: string;
  poolActiveDuration: number;
  name: string;
  flag: string;
  redemptionFeeBp: number;
  cooldownDuration: number;
  poolOwner: string;
  minPrice: bigint;
  maxPrice: bigint;
  treasury: string;
  authorisedRouter: string;
  minPriceAge: number;
  xDomainMessengerL2: string;
}> = {}) {
  return {
    assetAddress: overrides.assetAddress ?? ethers.ZeroAddress,
    dpMetadata: {
      name: overrides.dpName ?? "DP Token",
      symbol: overrides.dpSymbol ?? "DP"
    },
    ybMetadata: {
      name: overrides.ybName ?? "YB Token",
      symbol: overrides.ybSymbol ?? "YB"
    },
    oracle: overrides.oracle ?? ethers.ZeroAddress,
    poolActiveDuration: overrides.poolActiveDuration ?? 7 * 24 * 60 * 60,
    name: overrides.name ?? "Test Pool",
    flag: overrides.flag ?? "TEST",
    redemptionFeeBp: overrides.redemptionFeeBp ?? 10,
    cooldownDuration: overrides.cooldownDuration ?? 5 * 60 * 60,
    poolOwner: overrides.poolOwner ?? ethers.ZeroAddress,
    minPrice: overrides.minPrice ?? ethers.parseEther("0.5"),
    maxPrice: overrides.maxPrice ?? ethers.parseEther("2"),
    treasury: overrides.treasury ?? ethers.ZeroAddress,
    authorisedRouter: overrides.authorisedRouter ?? ethers.ZeroAddress,
    minPriceAge: overrides.minPriceAge ?? 5 * 60 * 60,
    xDomainMessengerL2: overrides.xDomainMessengerL2 ?? ethers.ZeroAddress
  };
}

/**
 * Cross-Chain Testing for TapirOracle
 * 
 * This test suite simulates the scenario where:
 * - TapirOracle is deployed on L1 (Ethereum mainnet)
 * - DepegPool and related contracts are deployed on L2 (e.g., Zircuit)
 * - Messages are passed between chains using OP Stack's CrossDomainMessenger
 * 
 * Test Structure:
 * 1. Unit tests with MockCrossDomainMessenger (tests message encoding and basic flow)
 * 2. Integration tests simulating the full cross-chain flow
 * 3. Edge cases and failure scenarios
 */
describe("TapirOracle - Cross-Chain Messaging (L1->L2)", function () {
  // Contracts
  let oracleL1: TapirOracle;
  let depegPoolL2: DepegPool;
  let messengerL1: MockCrossDomainMessenger;
  let messengerL2: MockCrossDomainMessenger;
  let api3Mock: Api3ReaderProxyMock;
  let chainlinkMock: ChainlinkAggregatorMock;
  let dpTokenL2: DepegToken;
  let ybTokenL2: DepegToken;
  let assetMock: any;

  // Signers
  let deployer: SignerWithAddress;
  let admin: SignerWithAddress;
  let operator: SignerWithAddress;
  let treasury: SignerWithAddress;
  let user: SignerWithAddress;

  // Constants
  const ASSET_SYMBOL = "USDT";
  const ASSET_DECIMALS = 6;
  const ZERO_ADDRESS = ethers.ZeroAddress;
  const ONE_USDT = ethers.parseUnits("1.0", ASSET_DECIMALS);
  const MIN_GAS_LIMIT = 200000; // Minimum gas for cross-domain message
  const MIN_PRICE_AGE = 4 * 3600; // 4 hours (minimum allowed by DepegPool)
  const MAX_PRICE_STALENESS = 24 * 60 * 60; // 1 day (per-source staleness)

  // Helper function to simulate cross-chain message relay
  async function relayMessage(messageIndex: number) {
    const message = await messengerL1.getSentMessage(messageIndex);
    
    // Set xDomainMessageSender to the L1 Oracle
    await messengerL2.setXDomainMessageSender(await oracleL1.getAddress());
    
    // Impersonate the L2 Messenger
    await ethers.provider.send("hardhat_impersonateAccount", [await messengerL2.getAddress()]);
    await ethers.provider.send("hardhat_setBalance", [
      await messengerL2.getAddress(),
      "0x" + ethers.parseEther("10.0").toString(16)
    ]);
    
    const messengerSigner = await ethers.getSigner(await messengerL2.getAddress());
    
    // Get the target pool from the message
    const targetPool = await ethers.getContractAt("DepegPool", message.target);
    
    let tx;
    // Decode and call the target function
    if (message.message.startsWith("0x601d5249")) { // updatePriceData(uint256,uint256) selector
      const iface = new ethers.Interface(["function updatePriceData(uint256 _hwmPrice, uint256 _resolutionPrice)"]);
      const decoded = iface.decodeFunctionData("updatePriceData", message.message);
      tx = await targetPool.connect(messengerSigner).updatePriceData(decoded._hwmPrice, decoded._resolutionPrice);
    }
    
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [await messengerL2.getAddress()]);
    
    return tx;
  }

  beforeEach(async function () {
    [deployer, admin, operator, treasury, user] = await ethers.getSigners();

    // ========================================
    // 1. Deploy Mock Asset (can be on either chain, we'll use it on L2)
    // ========================================
    const USDC6MockFactory = await ethers.getContractFactory("USDC6Mock");
    assetMock = await USDC6MockFactory.deploy();
    
    // Mint tokens to users for testing
    await assetMock.mint(user.address, ethers.parseUnits("10000", ASSET_DECIMALS));

    // ========================================
    // 2. Deploy L1 Components (Oracle and Price Sources)
    // ========================================
    
    // Deploy API3 mock
    const Api3Mock = await ethers.getContractFactory("Api3ReaderProxyMock");
    const initialValue = ethers.parseUnits("1.0", 18);
    const currentBlock = await ethers.provider.getBlock("latest");
    api3Mock = await Api3Mock.deploy(initialValue, currentBlock!.timestamp);

    // Deploy Chainlink mock
    const ChainlinkMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
    chainlinkMock = await ChainlinkMock.deploy(
      ethers.parseUnits("1.0", 18),
      currentBlock!.timestamp,
      18
    );

    // Deploy L1 Cross-Domain Messenger
    const MessengerFactory = await ethers.getContractFactory("MockCrossDomainMessenger");
    messengerL1 = await MessengerFactory.deploy();

    // ========================================
    // 3. Deploy L2 Components (DepegPool and tokens)
    // ========================================
    
    // Deploy L2 Cross-Domain Messenger
    messengerL2 = await MessengerFactory.deploy();

    // ========================================
    // 4. Deploy TapirOracle on L1 FIRST with temporary depegPool address
    // ========================================
    
    const sources = {
      api3ReaderProxyV1IsActive: true,
      api3ReaderProxyV1: await api3Mock.getAddress(),
      api3ReaderProxyV1Decimals: 18,
      api3ReaderProxyV1MaxStaleness: MAX_PRICE_STALENESS,
      chainlinkAggregatorV3IsActive: true,
      chainlinkAggregatorV3: await chainlinkMock.getAddress(),
      chainlinkAggregatorV3Decimals: 18,
      chainlinkAggregatorV3MaxStaleness: MAX_PRICE_STALENESS,
      redStoneClassicIsActive: false,
      redStoneClassicAggregator: ZERO_ADDRESS,
      redStoneClassicDecimals: 0,
      redStoneClassicMaxStaleness: MAX_PRICE_STALENESS,
      tellorIsActive: false,
      tellorAdapter: ZERO_ADDRESS,
      tellorDecimals: 8,
      tellorMaxStaleness: MAX_PRICE_STALENESS,
    };

    const oracleConfig = {
      minCheckpointSpacing: 0, // Allow immediate checkpoints for testing
      minValidSources: 2,
      closingPriceLookbackPeriod: 86400, // 24 hours lookback for closing price median
      depegPool: ZERO_ADDRESS, // Temporary - will be updated after DepegPool deployment
      xChainMode: true, // Enable cross-chain mode
      xDomainMessengerL1: await messengerL1.getAddress(),
    };

    const TapirOracle = await ethers.getContractFactory("TapirOracle");
    oracleL1 = await TapirOracle.deploy(
      ASSET_SYMBOL,
      await assetMock.getAddress(),
      ASSET_DECIMALS,
      sources,
      oracleConfig,
      admin.address
    );

    // Grant operator role to operator
    const OPERATOR_ROLE = await oracleL1.OPERATOR_ROLE();
    await oracleL1.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

    // ========================================
    // 5. Deploy DepegPool on L2 with correct oracle address
    // ========================================
    
    // Deploy DepegFactory on L2
    const DepegFactory = await ethers.getContractFactory("DepegFactory");
    const depegFactory = await DepegFactory.deploy();

    // Deploy DepegPool via factory with the correct L1 oracle address and L2 messenger configured
    const params = createDepegPoolParams({
      assetAddress: await assetMock.getAddress(),
      dpName: "Depeg Protected USDT",
      dpSymbol: "dpUSDT",
      ybName: "Yield Bearing USDT",
      ybSymbol: "ybUSDT",
      name: "Cross-Chain Test Pool",
      poolActiveDuration: 86400 * 365, // 1 year
      flag: "XCHAIN",
      redemptionFeeBp: 50, // 0.5%
      oracle: await oracleL1.getAddress(),
      cooldownDuration: 86400 * 7, // 7 days
      poolOwner: admin.address,
      minPrice: ethers.parseUnits("0.90", ASSET_DECIMALS),
      maxPrice: ethers.parseUnits("1.10", ASSET_DECIMALS),
      treasury: treasury.address,
      minPriceAge: MIN_PRICE_AGE,
      xDomainMessengerL2: await messengerL2.getAddress() // IMPORTANT for cross-chain!
    });
    await depegFactory.deployDepeg(params);

    // Get deployed pool
    const depegModule = await depegFactory.getDepegModule(0);
    depegPoolL2 = await ethers.getContractAt("DepegPool", depegModule.depegPool);
    dpTokenL2 = await ethers.getContractAt("DepegToken", depegModule.dpAsset);
    ybTokenL2 = await ethers.getContractAt("DepegToken", depegModule.ybAsset);

    // ========================================
    // 6. Update TapirOracle config to point to the deployed DepegPool
    // ========================================
    
    const updatedOracleConfig = {
      minCheckpointSpacing: 0,
      minValidSources: 2,
      closingPriceLookbackPeriod: 86400,
      depegPool: await depegPoolL2.getAddress(), // Actual L2 DepegPool
      xChainMode: true,
      xDomainMessengerL1: await messengerL1.getAddress(),
    };
    
    await oracleL1.connect(admin).setConfig(updatedOracleConfig);
    
    // ========================================
    // 7. Cross-chain setup complete
    // ========================================
    // Note: xDomainMessageSender will be set in individual tests as needed
    // This simulates the OP Stack setting it during message relay
  });

  describe("Basic Cross-Chain Setup", function () {
    it("Should have correct cross-chain configuration", async function () {
      const cfg = await oracleL1.cfg();
      
      expect(cfg.xChainMode).to.be.true;
      expect(cfg.xDomainMessengerL1).to.equal(await messengerL1.getAddress());
      expect(cfg.depegPool).to.equal(await depegPoolL2.getAddress());
    });

    it("Should have oracle set to L1 oracle address on DepegPool", async function () {
      // Oracle always points to the real oracle address, regardless of whether it is on L1 or L2
      const oracle = await depegPoolL2.oracle();
      expect(oracle).to.equal(await oracleL1.getAddress());
    });

    it("Should have L2 messenger configured on DepegPool", async function () {
      // The xDomainMessengerL2 address should be set for cross-chain verification
      const messenger = await depegPoolL2.xDomainMessengerL2();
      expect(messenger).to.equal(await messengerL2.getAddress());
    });

    it("Should have checkpoints for price writing", async function () {
      // Record prices from sources
      const testValue = ethers.parseUnits("0.995", 18);
      const currentBlock = await ethers.provider.getBlock("latest");
      await api3Mock.setData(testValue, currentBlock!.timestamp);
      await chainlinkMock.setData(testValue, currentBlock!.timestamp);
      
      await oracleL1.connect(operator).recordApi3Price();
      await oracleL1.connect(operator).recordChainlinkPrice();
      
      // Create checkpoint
      await oracleL1.connect(operator).checkpoint();
      
      const count = await oracleL1.checkpointsCount();
      expect(count).to.equal(1);
    });
  });

  describe("writePriceData - Cross-Chain Message Flow", function () {
    beforeEach(async function () {
      // Setup: Create multiple checkpoints for HWM calculation
      // Each checkpoint must be on a DIFFERENT day since daily aggregation is used
      // HWM requires at least 3 days worth of data
      const prices = [
        ethers.parseUnits("1.000", 18), // day 0
        ethers.parseUnits("1.001", 18), // day 1
        ethers.parseUnits("1.002", 18), // day 2
        ethers.parseUnits("1.003", 18), // day 3
        ethers.parseUnits("0.957", 18), // day 4
        ethers.parseUnits("0.955", 18), // day 5
        ethers.parseUnits("0.954", 18), // day 6
      ];

      for (let i = 0; i < prices.length; i++) {
        // Advance time by 1 day to ensure each checkpoint is on a different day
        await ethers.provider.send("evm_increaseTime", [86400]); // 1 day
        await ethers.provider.send("evm_mine", []);
        
        const currentBlock = await ethers.provider.getBlock("latest");
        await api3Mock.setData(prices[i], currentBlock!.timestamp);
        await chainlinkMock.setData(prices[i], currentBlock!.timestamp);
        
        await oracleL1.connect(operator).recordApi3Price();
        await oracleL1.connect(operator).recordChainlinkPrice();
        await oracleL1.connect(operator).checkpoint();
      }

      // Move pool to COOLDOWN state
      // We've advanced 7 days (7 checkpoints × 1 day) above
      // Pool needs to reach: startTime + poolActiveDuration (365 days) to enter COOLDOWN
      // But not reach: startTime + poolActiveDuration + cooldownDuration (372 days) or we enter limbo state 0
      // So advance: 365 days - 7 days = 358 days + 1 day for safety = 359 days
      await ethers.provider.send("evm_increaseTime", [86400 * 359]); // 359 days
      await ethers.provider.send("evm_mine", []);
      
      // Verify we're in COOLDOWN
      const state = await depegPoolL2.getState();
      expect(state).to.equal(2); // STATE_COOLDOWN
    });

    it("Should send cross-chain message when writePriceData is called", async function () {
      const tx = await oracleL1.connect(operator).writePriceData(MIN_GAS_LIMIT);
      await tx.wait();
      
      // Verify message was sent
      const messageCount = await messengerL1.sentMessagesCount();
      expect(messageCount).to.equal(1);
      
      // Verify message details
      const message = await messengerL1.getSentMessage(0);
      expect(message.target).to.equal(await depegPoolL2.getAddress());
      expect(message.sender).to.equal(await oracleL1.getAddress());
      
      // Decode the message
      const iface = new ethers.Interface([
        "function updatePriceData(uint256 _hwmPrice, uint256 _resolutionPrice)"
      ]);
      const decoded = iface.decodeFunctionData("updatePriceData", message.message);
      
      expect(decoded._hwmPrice).to.be.gt(0);
      expect(decoded._resolutionPrice).to.be.gt(0);
      
      // HWM should be higher than resolution price (since prices are increasing and there was a depeg (if no depeg, prices would be equal))
      expect(decoded._hwmPrice).to.be.gt(decoded._resolutionPrice);
    });

    it("Should successfully relay message and update price data on L2", async function () {
      // Send message
      await oracleL1.connect(operator).writePriceData(MIN_GAS_LIMIT);
      
      // Check initial state
      const initialPriceData = await depegPoolL2.finalPriceData();
      expect(initialPriceData.timestamp).to.equal(0); // Not set yet
      
      // Relay message
      await relayMessage(0);
      
      // Verify price data was updated
      const updatedPriceData = await depegPoolL2.finalPriceData();
      expect(updatedPriceData.timestamp).to.be.gt(0);
      expect(updatedPriceData.hwmPrice).to.be.gt(0);
      expect(updatedPriceData.resolutionPrice).to.be.gt(0);
      
      // HWM should be the highest sustained price
      expect(updatedPriceData.hwmPrice).to.be.gte(updatedPriceData.resolutionPrice);
    });

    it("Should emit PriceDataUpdated event on L2 after relay", async function () {
      await oracleL1.connect(operator).writePriceData(MIN_GAS_LIMIT);
      
      // Relay the message and capture the transaction
      const tx = await relayMessage(0);
      
      // Get the expected price values from the transaction
      const updatedPriceData = await depegPoolL2.finalPriceData();
      
      // Verify the PriceDataUpdated event was emitted
      await expect(tx)
        .to.emit(depegPoolL2, "PriceDataUpdated")
        .withArgs(updatedPriceData.hwmPrice, updatedPriceData.resolutionPrice);
      
      // Also verify the price data was actually updated
      expect(updatedPriceData.timestamp).to.be.gt(0);
    });

    it("Should revert if pool is not in COOLDOWN state", async function () {
      // Deploy a new pool
      const DepegFactory = await ethers.getContractFactory("DepegFactory");
      const factory = await DepegFactory.deploy();
      
      // Deploy pool via factory
      const futureParams = createDepegPoolParams({
        assetAddress: await assetMock.getAddress(),
        dpName: "dpUSDT",
        dpSymbol: "dpUSDT",
        ybName: "ybUSDT",
        ybSymbol: "ybUSDT",
        name: "Future Pool",
        poolActiveDuration: 86400 * 365,
        flag: "FUTURE",
        redemptionFeeBp: 50,
        oracle: await oracleL1.getAddress(),
        cooldownDuration: 86400 * 7,
        poolOwner: admin.address,
        minPrice: ethers.parseUnits("0.90", ASSET_DECIMALS),
        maxPrice: ethers.parseUnits("1.10", ASSET_DECIMALS),
        treasury: treasury.address,
        minPriceAge: MIN_PRICE_AGE,
        xDomainMessengerL2: await messengerL2.getAddress()
      });
      await factory.deployDepeg(futureParams);
      
      const newPoolModule = await factory.getDepegModule(0);
      const newPool = await ethers.getContractAt("DepegPool", newPoolModule.depegPool);
      
      // Verify the new pool is NOT in COOLDOWN state
      const poolState = await newPool.getState();
      expect(poolState).to.not.equal(2); // Should not be STATE_COOLDOWN
      
      // Update oracleL1's config to point to the new pool
      const currentConfig = await oracleL1.cfg();
      const newConfig = {
        minCheckpointSpacing: currentConfig.minCheckpointSpacing,
        minValidSources: currentConfig.minValidSources,
        closingPriceLookbackPeriod: currentConfig.closingPriceLookbackPeriod,
        depegPool: await newPool.getAddress(), // Point to the new pool
        xChainMode: currentConfig.xChainMode,
        xDomainMessengerL1: currentConfig.xDomainMessengerL1,
      };
      await oracleL1.connect(admin).setConfig(newConfig);
      
      // Get the current message count so we know which message to relay
      const messageIndex = Number(await messengerL1.sentMessagesCount());
      
      // Try to write price data
      await oracleL1.connect(operator).writePriceData(MIN_GAS_LIMIT);
      
      // Configure messenger for new pool
      await messengerL2.setXDomainMessageSender(await oracleL1.getAddress());
      
      // Try to relay - should fail because pool is not in COOLDOWN
      await expect(
        relayMessage(messageIndex) // Use the message that was just sent
      ).to.be.reverted;
    });
  });

  describe("Security and Edge Cases", function () {
    // Helper to setup checkpoints and move to COOLDOWN
    async function setupForPriceData() {
      // Create multiple checkpoints for HWM calculation (7 days of data)
      const prices = [
        ethers.parseUnits("1.000", 18),
        ethers.parseUnits("1.001", 18),
        ethers.parseUnits("1.002", 18),
        ethers.parseUnits("1.003", 18),
        ethers.parseUnits("0.957", 18),
        ethers.parseUnits("0.955", 18),
        ethers.parseUnits("0.954", 18),
      ];

      for (let i = 0; i < prices.length; i++) {
        await ethers.provider.send("evm_increaseTime", [86400]); // 1 day
        await ethers.provider.send("evm_mine", []);
        
        const currentBlock = await ethers.provider.getBlock("latest");
        await api3Mock.setData(prices[i], currentBlock!.timestamp);
        await chainlinkMock.setData(prices[i], currentBlock!.timestamp);
        
        await oracleL1.connect(operator).recordApi3Price();
        await oracleL1.connect(operator).recordChainlinkPrice();
        await oracleL1.connect(operator).checkpoint();
      }

      // Move pool to COOLDOWN state (365 days - 7 days already passed = 358 days + 1 for safety)
      await ethers.provider.send("evm_increaseTime", [86400 * 359]);
      await ethers.provider.send("evm_mine", []);
    }

    it("Should only accept messages from correct xDomainMessageSender", async function () {
      await setupForPriceData();
      
      // Verify we're in COOLDOWN
      expect(await depegPoolL2.getState()).to.equal(2);
      
      // Send message
      const messageIndex = Number(await messengerL1.sentMessagesCount());
      await oracleL1.connect(operator).writePriceData(MIN_GAS_LIMIT);
      
      // Try to relay with wrong xDomainMessageSender
      await messengerL2.setXDomainMessageSender(user.address); // Wrong sender!
      
      // Manually relay the message (can't use relayMessage helper because it sets the sender)
      const message = await messengerL1.getSentMessage(messageIndex);
      
      // Impersonate the L2 Messenger
      await ethers.provider.send("hardhat_impersonateAccount", [await messengerL2.getAddress()]);
      await ethers.provider.send("hardhat_setBalance", [
        await messengerL2.getAddress(),
        "0x" + ethers.parseEther("10.0").toString(16)
      ]);
      
      const messengerSigner = await ethers.getSigner(await messengerL2.getAddress());
      
      // Try to relay with wrong xDomainMessageSender - should fail
      // Because DepegPool checks: xDomainMessengerL2.xDomainMessageSender() == oracle
      const iface = new ethers.Interface(["function updatePriceData(uint256 _hwmPrice, uint256 _resolutionPrice)"]);
      const decoded = iface.decodeFunctionData("updatePriceData", message.message);
      
      await expect(
        depegPoolL2.connect(messengerSigner).updatePriceData(decoded._hwmPrice, decoded._resolutionPrice)
      ).to.be.reverted;
      
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [await messengerL2.getAddress()]);
    });

    it("Should handle message with zero gas limit", async function () {
      await setupForPriceData();
      
      // Verify we're in COOLDOWN
      expect(await depegPoolL2.getState()).to.equal(2);
      
      // Send with zero gas limit (should still work with mock)
      const tx = await oracleL1.connect(operator).writePriceData(0);
      await tx.wait();
      
      const message = await messengerL1.getSentMessage(0);
      expect(message.minGasLimit).to.equal(0);
    });

    it("Should handle ETH value passed with message", async function () {
      await setupForPriceData();
      
      // Verify we're in COOLDOWN
      expect(await depegPoolL2.getState()).to.equal(2);
      
      // Send with ETH value (for L2 gas)
      const ethValue = ethers.parseEther("0.01");
      const tx = await oracleL1.connect(operator).writePriceData(MIN_GAS_LIMIT, { value: ethValue });
      await tx.wait();
      
      const message = await messengerL1.getSentMessage(0);
      expect(message.value).to.equal(ethValue);
    });
  });

  describe("Comparison: Same-Chain vs Cross-Chain Mode", function () {
    let oracleSameChain: TapirOracle;
    let depegPoolSameChain: DepegPool;

    beforeEach(async function () {
      // Deploy a same-chain setup for comparison
      
      // Deploy oracle FIRST in same-chain mode with temporary depegPool address
      const existingSources = await oracleL1.sources();
      
      // Create a plain object from the Result object to avoid read-only property issues
      const sources = {
        api3ReaderProxyV1IsActive: existingSources.api3ReaderProxyV1IsActive,
        api3ReaderProxyV1: existingSources.api3ReaderProxyV1,
        api3ReaderProxyV1Decimals: existingSources.api3ReaderProxyV1Decimals,
        api3ReaderProxyV1MaxStaleness: existingSources.api3ReaderProxyV1MaxStaleness,
        chainlinkAggregatorV3IsActive: existingSources.chainlinkAggregatorV3IsActive,
        chainlinkAggregatorV3: existingSources.chainlinkAggregatorV3,
        chainlinkAggregatorV3Decimals: existingSources.chainlinkAggregatorV3Decimals,
        chainlinkAggregatorV3MaxStaleness: existingSources.chainlinkAggregatorV3MaxStaleness,
        redStoneClassicIsActive: existingSources.redStoneClassicIsActive,
        redStoneClassicAggregator: existingSources.redStoneClassicAggregator,
        redStoneClassicDecimals: existingSources.redStoneClassicDecimals,
        redStoneClassicMaxStaleness: existingSources.redStoneClassicMaxStaleness,
        tellorIsActive: existingSources.tellorIsActive,
        tellorAdapter: existingSources.tellorAdapter,
        tellorDecimals: existingSources.tellorDecimals,
        tellorMaxStaleness: existingSources.tellorMaxStaleness,
      };
      
      const sameChainConfig = {
        minCheckpointSpacing: 0,
        minValidSources: 2,
        closingPriceLookbackPeriod: 86400,
        depegPool: ZERO_ADDRESS, // Temporary - will be updated after pool deployment
        xChainMode: false, // Same-chain mode
        xDomainMessengerL1: ZERO_ADDRESS,
      };
      
      const TapirOracle = await ethers.getContractFactory("TapirOracle");
      oracleSameChain = await TapirOracle.deploy(
        ASSET_SYMBOL,
        await assetMock.getAddress(),
        ASSET_DECIMALS,
        sources,
        sameChainConfig,
        admin.address
      );
      
      const OPERATOR_ROLE = await oracleSameChain.OPERATOR_ROLE();
      await oracleSameChain.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
      
      // Now deploy pool with correct oracle address
      const DepegFactory = await ethers.getContractFactory("DepegFactory");
      const factory = await DepegFactory.deploy();
      
      // Deploy pool via factory with correct oracle
      const sameChainPoolParams = createDepegPoolParams({
        assetAddress: await assetMock.getAddress(),
        dpName: "dpUSDT",
        dpSymbol: "dpUSDT",
        ybName: "ybUSDT",
        ybSymbol: "ybUSDT",
        name: "Same Chain Pool",
        poolActiveDuration: 86400 * 365,
        flag: "SAME",
        redemptionFeeBp: 50,
        oracle: await oracleSameChain.getAddress(),
        cooldownDuration: 86400 * 7,
        poolOwner: admin.address,
        minPrice: ethers.parseUnits("0.90", ASSET_DECIMALS),
        maxPrice: ethers.parseUnits("1.10", ASSET_DECIMALS),
        treasury: treasury.address,
        minPriceAge: MIN_PRICE_AGE
      });
      await factory.deployDepeg(sameChainPoolParams);
      
      const poolModule = await factory.getDepegModule(0);
      depegPoolSameChain = await ethers.getContractAt("DepegPool", poolModule.depegPool);
      
      // Update oracle config to point to the deployed pool
      const updatedSameChainConfig = {
        minCheckpointSpacing: 0,
        minValidSources: 2,
        closingPriceLookbackPeriod: 86400,
        depegPool: await depegPoolSameChain.getAddress(), // Now point to the real pool
        xChainMode: false,
        xDomainMessengerL1: ZERO_ADDRESS,
      };
      await oracleSameChain.connect(admin).setConfig(updatedSameChainConfig);
      
      // Record prices and checkpoint for both oracles
      const testValue = ethers.parseUnits("0.995", 18);
      const currentBlock = await ethers.provider.getBlock("latest");
      await api3Mock.setData(testValue, currentBlock!.timestamp);
      await chainlinkMock.setData(testValue, currentBlock!.timestamp);
      
      await oracleSameChain.connect(operator).recordApi3Price();
      await oracleSameChain.connect(operator).recordChainlinkPrice();
      await oracleSameChain.connect(operator).checkpoint();
    });

    it("Should update price data immediately in same-chain mode", async function () {
      // Create enough checkpoints for HWM calculation
      const prices = [
        ethers.parseUnits("1.000", 18),
        ethers.parseUnits("1.001", 18),
        ethers.parseUnits("1.002", 18),
        ethers.parseUnits("1.003", 18),
        ethers.parseUnits("0.957", 18),
        ethers.parseUnits("0.955", 18),
        ethers.parseUnits("0.954", 18),
      ];

      for (let i = 0; i < prices.length; i++) {
        await ethers.provider.send("evm_increaseTime", [86400]); // 1 day
        await ethers.provider.send("evm_mine", []);
        
        const currentBlock = await ethers.provider.getBlock("latest");
        await api3Mock.setData(prices[i], currentBlock!.timestamp);
        await chainlinkMock.setData(prices[i], currentBlock!.timestamp);
        
        await oracleSameChain.connect(operator).recordApi3Price();
        await oracleSameChain.connect(operator).recordChainlinkPrice();
        await oracleSameChain.connect(operator).checkpoint();
      }

      // Move pool to COOLDOWN state
      await ethers.provider.send("evm_increaseTime", [86400 * 359]);
      await ethers.provider.send("evm_mine", []);
      
      // Verify we're in COOLDOWN
      expect(await depegPoolSameChain.getState()).to.equal(2);
      
      // Check initial price data
      const initialPriceData = await depegPoolSameChain.finalPriceData();
      expect(initialPriceData.timestamp).to.equal(0);
      
      // Call writePriceData - should update immediately in same-chain mode
      await oracleSameChain.connect(operator).writePriceData(MIN_GAS_LIMIT);
      
      // Verify price data was updated immediately
      const updatedPriceData = await depegPoolSameChain.finalPriceData();
      expect(updatedPriceData.timestamp).to.be.gt(0);
      expect(updatedPriceData.hwmPrice).to.be.gt(0);
      expect(updatedPriceData.resolutionPrice).to.be.gt(0);
    });

    // *handled automatically in prod by OP stack infra
    it("Should require manual relay in cross-chain mode*", async function () {
      // Create checkpoints for cross-chain oracle
      const prices = [
        ethers.parseUnits("1.000", 18),
        ethers.parseUnits("1.001", 18),
        ethers.parseUnits("1.002", 18),
        ethers.parseUnits("1.003", 18),
        ethers.parseUnits("0.957", 18),
        ethers.parseUnits("0.955", 18),
        ethers.parseUnits("0.954", 18),
      ];

      for (let i = 0; i < prices.length; i++) {
        await ethers.provider.send("evm_increaseTime", [86400]); // 1 day
        await ethers.provider.send("evm_mine", []);
        
        const currentBlock = await ethers.provider.getBlock("latest");
        await api3Mock.setData(prices[i], currentBlock!.timestamp);
        await chainlinkMock.setData(prices[i], currentBlock!.timestamp);
        
        await oracleL1.connect(operator).recordApi3Price();
        await oracleL1.connect(operator).recordChainlinkPrice();
        await oracleL1.connect(operator).checkpoint();
      }

      // Move pool to COOLDOWN state
      await ethers.provider.send("evm_increaseTime", [86400 * 359]);
      await ethers.provider.send("evm_mine", []);
      
      // Verify we're in COOLDOWN
      expect(await depegPoolL2.getState()).to.equal(2);
      
      // Check initial price data
      const initialPriceData = await depegPoolL2.finalPriceData();
      expect(initialPriceData.timestamp).to.equal(0);
      
      // Send message
      await oracleL1.connect(operator).writePriceData(MIN_GAS_LIMIT);
      
      // Price data should NOT be updated yet (message not relayed)
      const priceDataAfterSend = await depegPoolL2.finalPriceData();
      expect(priceDataAfterSend.timestamp).to.equal(0);
      
      // Relay message
      await relayMessage(0);
      
      // NOW price data should be updated
      const finalPriceData = await depegPoolL2.finalPriceData();
      expect(finalPriceData.timestamp).to.be.gt(0);
      expect(finalPriceData.hwmPrice).to.be.gt(0);
      expect(finalPriceData.resolutionPrice).to.be.gt(0);
    });
  });
});

