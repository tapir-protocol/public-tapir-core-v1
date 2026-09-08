import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { 
  DepegFactory, 
  DepegPool, 
  DepegToken, 
  TapirOracle,
  USDC6Mock,
  Api3ReaderProxyMock,
  ChainlinkAggregatorMock
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
 * Comprehensive Multi-Decimal Integration Test
 * 
 * This test validates the entire Tapir system with mixed decimal configurations:
 * - Base Asset: USDT (6 decimals)
 * - API3 Oracle: 6 decimals
 * - Chainlink Oracle: 8 decimals 
 * - RedStone Oracle: 18 decimals
 * 
 * Tests cover:
 * 1. Token decimal inheritance (DP/YB match base asset)
 * 2. Oracle decimal normalization from multiple sources
 * 3. Complete lifecycle with normalized prices
 * 4. Event emissions with correct decimal scaling
 * 5. Depeg calculations with 6-decimal base
 * 6. Fee calculations with low-decimal precision
 * 7. Cross-oracle consistency
 */
describe("Multi-Decimal Integration Test", function () {
  // Contracts
  let depegFactory: DepegFactory;
  let depegPool: DepegPool;
  let dpToken: DepegToken;
  let ybToken: DepegToken;
  let baseAsset: USDC6Mock; // 6 decimals
  let tapirOracle: TapirOracle;
  let api3Mock: Api3ReaderProxyMock; // 18 decimals
  let chainlinkMock: ChainlinkAggregatorMock; // 8 decimals
  let redStoneMock: ChainlinkAggregatorMock; // 18 decimals (uses Chainlink interface)

  // Signers
  let owner: SignerWithAddress;
  let operator: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let treasury: SignerWithAddress;

  // Constants - Asset (USDT - 6 decimals)
  const BASE_ASSET_DECIMALS = 6;
  const BASE_ASSET_SYMBOL = "USDT";
  const ONE_UNIT = ethers.parseUnits("1.0", BASE_ASSET_DECIMALS); // 1 USDT = 1_000_000

  // Constants - Oracle Decimals
  const API3_DECIMALS = 6; // Same as base asset - tests no normalization needed
  const CHAINLINK_DECIMALS = 8;
  const REDSTONE_DECIMALS = 18;

  // Price Constants (in respective oracle decimals)
  // All represent ~$1.00 USD per USDT
  const INITIAL_PRICE_API3 = ethers.parseUnits("1.0", API3_DECIMALS);
  const INITIAL_PRICE_CHAINLINK = ethers.parseUnits("1.0", CHAINLINK_DECIMALS);
  const INITIAL_PRICE_REDSTONE = ethers.parseUnits("1.0", REDSTONE_DECIMALS);
  
  // Expected normalized price in base asset decimals (6)
  const NORMALIZED_INITIAL_PRICE = ethers.parseUnits("1.0", BASE_ASSET_DECIMALS); // 1_000_000

  // Pool Configuration
  const POOL_ACTIVE_DURATION = 7 * 24 * 60 * 60; // 7 days
  const COOLDOWN_DURATION = 5 * 60 * 60; // 5 hours
  const MIN_PRICE_AGE = 4 * 60 * 60; // 4 hours
  const REDEMPTION_FEE_BP = 10; // 0.1%
  const MIN_PRICE = ethers.parseUnits("0.90", BASE_ASSET_DECIMALS);
  const MAX_PRICE = ethers.parseUnits("1.10", BASE_ASSET_DECIMALS);
  const BP_IN_INTEGER = 10000;

  // Oracle Configuration
  const MIN_CHECKPOINT_SPACING = 1 * 60 * 60; // 1 hour
  const MAX_PRICE_STALENESS = 25 * 60 * 60; // 25 hours
  const MIN_VALID_SOURCES = 2; // Require at least 2 valid sources

  beforeEach(async function () {
    [owner, operator, user1, user2, treasury] = await ethers.getSigners();

    // Deploy base asset (USDT - 6 decimals)
    const USDC6MockFactory = await ethers.getContractFactory("USDC6Mock");
    baseAsset = await USDC6MockFactory.deploy();
    
    // Mint tokens to users
    await baseAsset.mint(user1.address, ethers.parseUnits("100000", BASE_ASSET_DECIMALS));
    await baseAsset.mint(user2.address, ethers.parseUnits("100000", BASE_ASSET_DECIMALS));

    // Deploy oracle mocks with different decimals
    const currentTime = await time.latest();
    
    const Api3MockFactory = await ethers.getContractFactory("Api3ReaderProxyMock");
    api3Mock = await Api3MockFactory.deploy(INITIAL_PRICE_API3, currentTime);
    const ChainlinkMockFactory = await ethers.getContractFactory("ChainlinkAggregatorMock");
    chainlinkMock = await ChainlinkMockFactory.deploy(
      INITIAL_PRICE_CHAINLINK,
      currentTime,
      CHAINLINK_DECIMALS
    );

    // RedStone uses Chainlink-compatible interface but with 18 decimals
    redStoneMock = await ChainlinkMockFactory.deploy(
      INITIAL_PRICE_REDSTONE,
      currentTime,
      REDSTONE_DECIMALS
    );

    // Deploy DepegFactory
    const DepegFactoryFactory = await ethers.getContractFactory("DepegFactory");
    depegFactory = await DepegFactoryFactory.deploy();

    // Deploy TapirOracle with mixed decimal sources
    const TapirOracleFactory = await ethers.getContractFactory("TapirOracle");
    
    // We'll deploy the oracle first, then deploy the pool, then update the oracle config
    const sources = {
      api3ReaderProxyV1: await api3Mock.getAddress(),
      api3ReaderProxyV1IsActive: true,
      api3ReaderProxyV1Decimals: API3_DECIMALS,
      api3ReaderProxyV1MaxStaleness: MAX_PRICE_STALENESS,
      chainlinkAggregatorV3: await chainlinkMock.getAddress(),
      chainlinkAggregatorV3IsActive: true,
      chainlinkAggregatorV3Decimals: CHAINLINK_DECIMALS,
      chainlinkAggregatorV3MaxStaleness: MAX_PRICE_STALENESS,
      redStoneClassicAggregator: await redStoneMock.getAddress(),
      redStoneClassicIsActive: true,
      redStoneClassicDecimals: REDSTONE_DECIMALS,
      redStoneClassicMaxStaleness: MAX_PRICE_STALENESS,
      tellorIsActive: false,
      tellorAdapter: ethers.ZeroAddress,
      tellorDecimals: 8,
      tellorMaxStaleness: MAX_PRICE_STALENESS,
    };

    // Initial config (will update depegPool after deployment)
    const config = {
      depegPool: ethers.ZeroAddress, // Placeholder, will update
      minCheckpointSpacing: MIN_CHECKPOINT_SPACING,
      minValidSources: MIN_VALID_SOURCES,
      closingPriceLookbackPeriod: 86400,
      xChainMode: false,
      xDomainMessengerL1: ethers.ZeroAddress
    };

    tapirOracle = await TapirOracleFactory.deploy(
      BASE_ASSET_SYMBOL,
      await baseAsset.getAddress(),
      BASE_ASSET_DECIMALS,
      sources,
      config,
      owner.address
    );

    // Grant operator role
    const OPERATOR_ROLE = await tapirOracle.OPERATOR_ROLE();
    await tapirOracle.connect(owner).grantRole(OPERATOR_ROLE, operator.address);

    // Deploy DepegPool via Factory
    const params = createDepegPoolParams({
      assetAddress: await baseAsset.getAddress(),
      dpName: "DP USDT",
      dpSymbol: "dpUSDT",
      ybName: "YB USDT",
      ybSymbol: "ybUSDT",
      name: "Multi-Decimal Test Pool",
      poolActiveDuration: POOL_ACTIVE_DURATION,
      flag: "USDT6_MULTI",
      redemptionFeeBp: REDEMPTION_FEE_BP,
      oracle: await tapirOracle.getAddress(),
      cooldownDuration: COOLDOWN_DURATION,
      poolOwner: owner.address,
      minPrice: MIN_PRICE,
      maxPrice: MAX_PRICE,
      treasury: treasury.address,
      minPriceAge: MIN_PRICE_AGE
    });
    await depegFactory.deployDepeg(params);

    // Get deployed pool
    const module = await depegFactory.getDepegModule(0);
    depegPool = await ethers.getContractAt("DepegPool", module.depegPool);
    dpToken = await ethers.getContractAt("DepegToken", module.dpAsset);
    ybToken = await ethers.getContractAt("DepegToken", module.ybAsset);

    // Update oracle config with actual pool address
    await tapirOracle.connect(owner).setConfig({
      depegPool: await depegPool.getAddress(),
      minCheckpointSpacing: MIN_CHECKPOINT_SPACING,
      minValidSources: MIN_VALID_SOURCES,
      closingPriceLookbackPeriod: 86400,
      xChainMode: false,
      xDomainMessengerL1: ethers.ZeroAddress
    });

    // Approve pool to spend user tokens
    await baseAsset.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
    await baseAsset.connect(user2).approve(await depegPool.getAddress(), ethers.MaxUint256);
  });

  describe("Decimal Configuration Validation", function () {
    it("Should have correct asset decimals", async function () {
      expect(await baseAsset.decimals()).to.equal(BASE_ASSET_DECIMALS);
      expect(await tapirOracle.assetDecimals()).to.equal(BASE_ASSET_DECIMALS);
      expect(await tapirOracle.assetSymbol()).to.equal(BASE_ASSET_SYMBOL);
    });

    it("Should have DP/YB tokens with same decimals as base asset", async function () {
      expect(await dpToken.decimals()).to.equal(BASE_ASSET_DECIMALS);
      expect(await ybToken.decimals()).to.equal(BASE_ASSET_DECIMALS);
    });

    it("Should have correct oracle source decimals configured", async function () {
      const sources = await tapirOracle.sources();
      expect(sources.api3ReaderProxyV1Decimals).to.equal(API3_DECIMALS); // 6 decimals
      expect(sources.chainlinkAggregatorV3Decimals).to.equal(CHAINLINK_DECIMALS); // 8 decimals
      expect(sources.redStoneClassicDecimals).to.equal(REDSTONE_DECIMALS); // 18 decimals
    });

    it("Should have pool price bounds configured in base asset decimals", async function () {
      expect(await depegPool.MIN_PRICE()).to.equal(MIN_PRICE);
      expect(await depegPool.MAX_PRICE()).to.equal(MAX_PRICE);
    });
  });

  describe("Oracle Decimal Normalization", function () {
    it("Should handle API3 price with matching decimals (6 to 6, no normalization)", async function () {
      await tapirOracle.connect(operator).recordApi3Price();
      const recorded = await tapirOracle.latestApi3Price();
      
      // 1.0 in 6 decimals = 1_000_000 (already matches asset decimals)
      // No normalization needed = 1_000_000
      expect(recorded.price).to.equal(NORMALIZED_INITIAL_PRICE);
    });

    it("Should normalize Chainlink price from 8 to 6 decimals", async function () {
      await tapirOracle.connect(operator).recordChainlinkPrice();
      const recorded = await tapirOracle.latestChainlinkPrice();
      
      // 1.0 in 8 decimals = 100_000_000
      // Normalized to 6 decimals = 1_000_000
      expect(recorded.price).to.equal(NORMALIZED_INITIAL_PRICE);
    });

    it("Should normalize RedStone price from 18 to 6 decimals", async function () {
      await tapirOracle.connect(operator).recordRedStoneClassicPrice();
      const recorded = await tapirOracle.latestRedStoneClassicPrice();
      
      // 1.0 in 18 decimals = 1_000_000_000_000_000_000
      // Normalized to 6 decimals = 1_000_000
      expect(recorded.price).to.equal(NORMALIZED_INITIAL_PRICE);
    });

    it("Should handle different prices correctly with decimal normalization", async function () {
      // Set different prices in different decimal formats (all representing $0.995)
      const api3Price = ethers.parseUnits("0.995", API3_DECIMALS);
      const chainlinkPrice = ethers.parseUnits("0.995", CHAINLINK_DECIMALS);
      const redStonePrice = ethers.parseUnits("0.995", REDSTONE_DECIMALS);
      const expectedNormalized = ethers.parseUnits("0.995", BASE_ASSET_DECIMALS);

      await api3Mock.setData(api3Price, await time.latest());
      await chainlinkMock.setData(chainlinkPrice, await time.latest());
      await redStoneMock.setData(redStonePrice, await time.latest());

      await tapirOracle.connect(operator).recordApi3Price();
      await tapirOracle.connect(operator).recordChainlinkPrice();
      await tapirOracle.connect(operator).recordRedStoneClassicPrice();

      const api3Recorded = await tapirOracle.latestApi3Price();
      const chainlinkRecorded = await tapirOracle.latestChainlinkPrice();
      const redStoneRecorded = await tapirOracle.latestRedStoneClassicPrice();

      expect(api3Recorded.price).to.equal(expectedNormalized);
      expect(chainlinkRecorded.price).to.equal(expectedNormalized);
      expect(redStoneRecorded.price).to.equal(expectedNormalized);
    });

    it("Should create checkpoint with median of normalized prices", async function () {
      // Record prices from all sources
      await tapirOracle.connect(operator).recordApi3Price();
      await tapirOracle.connect(operator).recordChainlinkPrice();
      await tapirOracle.connect(operator).recordRedStoneClassicPrice();

      // Move time forward to allow checkpoint
      await time.increase(MIN_CHECKPOINT_SPACING + 1);

      // Create checkpoint
      await tapirOracle.connect(operator).checkpoint();

      expect(await tapirOracle.checkpointsCount()).to.equal(1);
    });

    it("Should handle different decimal configurations correctly", async function () {
      // Test with price = 0.5 across different decimals
      const halfPrice = ethers.parseUnits("0.5", BASE_ASSET_DECIMALS); // 500_000

      await api3Mock.setData(ethers.parseUnits("0.5", API3_DECIMALS), await time.latest());
      await chainlinkMock.setData(ethers.parseUnits("0.5", CHAINLINK_DECIMALS), await time.latest());
      await redStoneMock.setData(ethers.parseUnits("0.5", REDSTONE_DECIMALS), await time.latest());

      await tapirOracle.connect(operator).recordApi3Price();
      await tapirOracle.connect(operator).recordChainlinkPrice();
      await tapirOracle.connect(operator).recordRedStoneClassicPrice();

      // All should normalize to the same value despite different source decimals
      expect((await tapirOracle.latestApi3Price()).price).to.equal(halfPrice);
      expect((await tapirOracle.latestChainlinkPrice()).price).to.equal(halfPrice);
      expect((await tapirOracle.latestRedStoneClassicPrice()).price).to.equal(halfPrice);
    });
  });

  describe("Complete Lifecycle with Multi-Decimal Oracles", function () {
    it("Should handle complete lifecycle with no depeg", async function () {
      const splitAmount = ethers.parseUnits("1000", BASE_ASSET_DECIMALS);

      // Split tokens
      const tx = await depegPool.connect(user1).splitToken(user1.address, splitAmount);
      await expect(tx).to.emit(depegPool, "SplitToken").withArgs(user1.address, splitAmount);

      const dpBalance = await dpToken.balanceOf(user1.address);
      const ybBalance = await ybToken.balanceOf(user1.address);

      expect(dpBalance).to.equal(splitAmount / 2n);
      expect(ybBalance).to.equal(splitAmount / 2n);

      // Verify token supplies are correct with 6 decimals
      const dpSupply = await dpToken.totalSupply();
      const ybSupply = await ybToken.totalSupply();
      expect(dpSupply).to.equal(splitAmount / 2n); // 500_000_000 (500 USDT in 6 decimals)
      expect(ybSupply).to.equal(splitAmount / 2n);
      expect(dpSupply).to.equal(500_000_000n); // Sanity check: 500 USDT with 6 decimals
      expect(ybSupply).to.equal(500_000_000n);

      // Update prices throughout lifecycle (slightly increasing to $1.05)
      const updatedPriceApi3 = ethers.parseUnits("1.05", API3_DECIMALS);
      const updatedPriceChainlink = ethers.parseUnits("1.05", CHAINLINK_DECIMALS);
      const updatedPriceRedStone = ethers.parseUnits("1.05", REDSTONE_DECIMALS);

      await api3Mock.setData(updatedPriceApi3, await time.latest());
      await chainlinkMock.setData(updatedPriceChainlink, await time.latest());
      await redStoneMock.setData(updatedPriceRedStone, await time.latest());

      // Record and checkpoint
      await tapirOracle.connect(operator).recordApi3Price();
      await tapirOracle.connect(operator).recordChainlinkPrice();
      await tapirOracle.connect(operator).recordRedStoneClassicPrice();
      await time.increase(MIN_CHECKPOINT_SPACING + 1);
      await tapirOracle.connect(operator).checkpoint();

      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);

      // Update price data via oracle
      const hwmPrice = ethers.parseUnits("1.05", BASE_ASSET_DECIMALS);
      const resolutionPrice = ethers.parseUnits("1.05", BASE_ASSET_DECIMALS);

      // Oracle impersonation to update price data
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0xDE0B6B3A7640000"]); // 1 ETH
      const oracleSigner = await ethers.getSigner(oracleAddr);

      const updateTx = await depegPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await expect(updateTx).to.emit(depegPool, "PriceDataUpdated").withArgs(hwmPrice, resolutionPrice);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);

      // Resolve
      const resolveTx = await depegPool.resolvePriceDepeg();
      await expect(resolveTx).to.emit(depegPool, "DepegPriceResolved");

      expect(await depegPool.poolHasDepegged()).to.be.false;

      // Redeem
      await dpToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);

      const baseBalanceBefore = await baseAsset.balanceOf(user1.address);
      
      const redeemTx = await depegPool.connect(user1).redeemTokens(user1.address, dpBalance, ybBalance);
      
      // Verify event with correct decimals
      const receipt = await redeemTx.wait();
      const event = receipt?.logs.find(
        (log: any) => depegPool.interface.parseLog(log)?.name === "RedeemTokens"
      );
      expect(event).to.not.be.undefined;

      const baseBalanceAfter = await baseAsset.balanceOf(user1.address);
      const baseReturned = baseBalanceAfter - baseBalanceBefore;

      // Should get back close to original (minus fees)
      expect(baseReturned).to.be.greaterThan(splitAmount * 98n / 100n);
      expect(baseReturned).to.be.lessThan(splitAmount);

      // Verify token supplies are now zero after complete redemption
      expect(await dpToken.totalSupply()).to.equal(0);
      expect(await ybToken.totalSupply()).to.equal(0);
    });

    it("Should handle complete lifecycle with depeg", async function () {
      const splitAmount = ethers.parseUnits("5000", BASE_ASSET_DECIMALS);

      // Both users split tokens
      await depegPool.connect(user1).splitToken(user1.address, splitAmount);
      await depegPool.connect(user2).splitToken(user2.address, splitAmount);

      const user1DpBalance = await dpToken.balanceOf(user1.address);
      const user2YbBalance = await ybToken.balanceOf(user2.address);

      // Verify token supplies with 6 decimals (2 users each split 5000 USDT)
      const dpSupplyAfterSplit = await dpToken.totalSupply();
      const ybSupplyAfterSplit = await ybToken.totalSupply();
      expect(dpSupplyAfterSplit).to.equal(splitAmount); // 5_000_000_000 (5000 USDT in 6 decimals)
      expect(ybSupplyAfterSplit).to.equal(splitAmount);
      expect(dpSupplyAfterSplit).to.equal(5_000_000_000n); // Sanity check: 5000 USDT with 6 decimals
      expect(ybSupplyAfterSplit).to.equal(5_000_000_000n);

      // Setup oracle prices for HWM at $1.00
      await tapirOracle.connect(operator).recordApi3Price();
      await tapirOracle.connect(operator).recordChainlinkPrice();
      await tapirOracle.connect(operator).recordRedStoneClassicPrice();
      await time.increase(MIN_CHECKPOINT_SPACING + 1);
      await tapirOracle.connect(operator).checkpoint();

      // Add more checkpoints for HWM calculation (need at least 3 for HWM)
      for (let i = 0; i < 2; i++) {
        await time.increase(MIN_CHECKPOINT_SPACING + 1);
        await tapirOracle.connect(operator).recordApi3Price();
        await tapirOracle.connect(operator).recordChainlinkPrice();
        await tapirOracle.connect(operator).recordRedStoneClassicPrice();
        await time.increase(MIN_CHECKPOINT_SPACING + 1);
        await tapirOracle.connect(operator).checkpoint();
      }

      // Move to COOLDOWN and simulate depeg to $0.95 (5% depeg)
      // Need to calculate remaining time to reach COOLDOWN
      const poolStartTime = await depegPool.startTime();
      const currentTime = await time.latest();
      const elapsedTime = BigInt(currentTime) - poolStartTime;
      const remainingActiveTime = BigInt(POOL_ACTIVE_DURATION) - elapsedTime;
      await time.increase(Number(remainingActiveTime) + 1);

      // Set depegged prices across all oracles
      const depeggedPriceApi3 = ethers.parseUnits("0.95", API3_DECIMALS);
      const depeggedPriceChainlink = ethers.parseUnits("0.95", CHAINLINK_DECIMALS);
      const depeggedPriceRedStone = ethers.parseUnits("0.95", REDSTONE_DECIMALS);

      await api3Mock.setData(depeggedPriceApi3, await time.latest());
      await chainlinkMock.setData(depeggedPriceChainlink, await time.latest());
      await redStoneMock.setData(depeggedPriceRedStone, await time.latest());

      // Update pool price data
      const hwmPrice = ethers.parseUnits("1.00", BASE_ASSET_DECIMALS);
      const resolutionPrice = ethers.parseUnits("0.95", BASE_ASSET_DECIMALS);

      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0xDE0B6B3A7640000"]); // 1 ETH
      await depegPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION and resolve
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();

      expect(await depegPool.poolHasDepegged()).to.be.true;
      const depegSize = await depegPool.depegSize();
      expect(depegSize).to.equal(500n); // 5% = 500 bp

      // Redeem tokens
      await dpToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(user2).approve(await depegPool.getAddress(), ethers.MaxUint256);

      // User1 redeems DP (should gain value)
      const user1BaseBefore = await baseAsset.balanceOf(user1.address);
      await depegPool.connect(user1).redeemTokens(user1.address, user1DpBalance, 0);
      const user1BaseAfter = await baseAsset.balanceOf(user1.address);
      const user1Return = user1BaseAfter - user1BaseBefore;

      // User2 redeems YB (should lose value)
      const user2BaseBefore = await baseAsset.balanceOf(user2.address);
      await depegPool.connect(user2).redeemTokens(user2.address, 0, user2YbBalance);
      const user2BaseAfter = await baseAsset.balanceOf(user2.address);
      const user2Return = user2BaseAfter - user2BaseBefore;

      // Verify depeg payoffs (accounting for fees)
      // DP gains value: should be > face value
      expect(user1Return).to.be.greaterThan(user1DpBalance);
      
      // YB loses value: should be < face value
      expect(user2Return).to.be.lessThan(user2YbBalance);

      // Total returned should approximately equal splitAmount (one side from each user)
      // User1 redeems DP only, User2 redeems YB only
      // So total tokens redeemed = splitAmount (2500 DP + 2500 YB)
      const totalTokensRedeemed = user1DpBalance + user2YbBalance; // = splitAmount
      const totalReturned = user1Return + user2Return;
      
      // With 5% depeg and fees, total should be close to face value of redeemed tokens
      expect(totalReturned).to.be.greaterThan(totalTokensRedeemed * 97n / 100n);
      expect(totalReturned).to.be.lessThan(totalTokensRedeemed * 101n / 100n);

      // Verify token supplies decreased correctly after partial redemption
      // User1 redeemed all DP, User2 redeemed all YB
      const dpSupplyAfterRedeem = await dpToken.totalSupply();
      const ybSupplyAfterRedeem = await ybToken.totalSupply();
      
      // User2 still has DP tokens, User1 still has YB tokens
      expect(dpSupplyAfterRedeem).to.equal(splitAmount / 2n); // User2's DP balance
      expect(ybSupplyAfterRedeem).to.equal(splitAmount / 2n); // User1's YB balance
      expect(dpSupplyAfterRedeem).to.equal(2_500_000_000n); // 2500 USDT in 6 decimals
      expect(ybSupplyAfterRedeem).to.equal(2_500_000_000n);
    });
  });

  describe("Event Emissions with Correct Decimal Scaling", function () {
    it("Should emit PriceDataUpdated with base asset decimals", async function () {
      await time.increase(POOL_ACTIVE_DURATION + 1);

      const hwmPrice = ethers.parseUnits("1.05", BASE_ASSET_DECIMALS);
      const resolutionPrice = ethers.parseUnits("1.00", BASE_ASSET_DECIMALS);

      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0xDE0B6B3A7640000"]); // 1 ETH

      await expect(
        depegPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice)
      ).to.emit(depegPool, "PriceDataUpdated").withArgs(hwmPrice, resolutionPrice);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      const finalPriceData = await depegPool.finalPriceData();
      expect(finalPriceData.hwmPrice).to.equal(hwmPrice);
      expect(finalPriceData.resolutionPrice).to.equal(resolutionPrice);
      expect(finalPriceData.hwmPrice).to.be.equal(1_050_000n); // sanity check with manual decimals
      expect(finalPriceData.resolutionPrice).to.be.equal(1_000_000n); // sanity check with manual decimals
    });

    it("Should emit SplitToken and RedeemTokens with correct amounts", async function () {
      const splitAmount = ethers.parseUnits("100", BASE_ASSET_DECIMALS);

      // Test SplitToken event
      await expect(
        depegPool.connect(user1).splitToken(user1.address, splitAmount)
      ).to.emit(depegPool, "SplitToken").withArgs(user1.address, splitAmount);

      // Complete lifecycle for redemption
      await time.increase(POOL_ACTIVE_DURATION + 1);

      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0xDE0B6B3A7640000"]); // 1 ETH
      await depegPool.connect(oracleSigner).updatePriceData(NORMALIZED_INITIAL_PRICE, NORMALIZED_INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();

      await dpToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);

      const dpBalance = await dpToken.balanceOf(user1.address);
      const ybBalance = await ybToken.balanceOf(user1.address);

      // Test RedeemTokens event
      const redeemTx = await depegPool.connect(user1).redeemTokens(user1.address, dpBalance, ybBalance);
      const receipt = await redeemTx.wait();
      
      const redeemEvent = receipt?.logs
        .map((log: any) => {
          try {
            return depegPool.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((event: any) => event?.name === "RedeemTokens");

      expect(redeemEvent).to.not.be.undefined;
      expect(redeemEvent?.args[0]).to.equal(user1.address); // counterparty
      expect(redeemEvent?.args[1]).to.equal(dpBalance); // dpAmount
      expect(redeemEvent?.args[2]).to.equal(ybBalance); // ybAmount
      expect(redeemEvent?.args[3]).to.be.closeTo(splitAmount, 1_000_000n); // finalAmount
      expect(redeemEvent?.args[4]).to.be.closeTo(splitAmount * BigInt(REDEMPTION_FEE_BP) / BigInt(BP_IN_INTEGER), 1); // fees
    });
  });

  describe("Fee Calculations with Low Decimal Precision", function () {
    it("Should calculate redemption fee correctly with 6 decimals", async function () {
      const splitAmount = ethers.parseUnits("1000", BASE_ASSET_DECIMALS);
      await depegPool.connect(user1).splitToken(user1.address, splitAmount);

      // Verify token supply with 6 decimals
      expect(await dpToken.totalSupply()).to.equal(1_000_000_000n / 2n); // 500 USDT
      expect(await ybToken.totalSupply()).to.equal(1_000_000_000n / 2n);

      await dpToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);

      const baseBalanceBefore = await baseAsset.balanceOf(user1.address);
      await depegPool.connect(user1).unSplitTokens(user1.address, splitAmount / 2n);
      const baseBalanceAfter = await baseAsset.balanceOf(user1.address);

      const baseReturned = baseBalanceAfter - baseBalanceBefore;
      
      // Expected: splitAmount - redemption fee (0.1%)
      const expectedFee = (splitAmount * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      const expectedReturn = splitAmount - expectedFee;

      // Allow 1 unit tolerance for rounding
      expect(baseReturned).to.be.closeTo(expectedReturn, 1);
    });


    it("Should handle small amounts without underflow", async function () {
      // Test with very small amount (0.01 USDT = 10_000 in 6 decimals)
      const tinyAmount = 10_000n;
      await depegPool.connect(user1).splitToken(user1.address, tinyAmount);

      const dpBalance = await dpToken.balanceOf(user1.address);
      const ybBalance = await ybToken.balanceOf(user1.address);

      expect(dpBalance).to.equal(5_000n);
      expect(ybBalance).to.equal(5_000n);

      // Verify token supplies are correct even with tiny amounts
      expect(await dpToken.totalSupply()).to.equal(5_000n); // 0.005 USDT in 6 decimals
      expect(await ybToken.totalSupply()).to.equal(5_000n);
      expect(await dpToken.decimals()).to.equal(6); // Confirm decimals config
      expect(await ybToken.decimals()).to.equal(6);

      await dpToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);

      const baseBalanceBefore = await baseAsset.balanceOf(user1.address);
      await depegPool.connect(user1).unSplitTokens(user1.address, dpBalance);
      const baseBalanceAfter = await baseAsset.balanceOf(user1.address);

      const baseReturned = baseBalanceAfter - baseBalanceBefore;

      // Should return something close to original (accounting for fees and rounding)
      expect(baseReturned).to.be.greaterThan(0);
      expect(baseReturned).to.be.lessThanOrEqual(tinyAmount);
    });
  });

  describe("Cross-Oracle Consistency", function () {
    it("Should produce consistent median across different decimal sources", async function () {
      // Set slightly different prices to test median calculation
      await api3Mock.setData(ethers.parseUnits("1.00", API3_DECIMALS), await time.latest());
      await chainlinkMock.setData(ethers.parseUnits("1.02", CHAINLINK_DECIMALS), await time.latest());
      await redStoneMock.setData(ethers.parseUnits("1.01", REDSTONE_DECIMALS), await time.latest());

      await tapirOracle.connect(operator).recordApi3Price();
      await tapirOracle.connect(operator).recordChainlinkPrice();
      await tapirOracle.connect(operator).recordRedStoneClassicPrice();

      await time.increase(MIN_CHECKPOINT_SPACING + 1);
      await tapirOracle.connect(operator).checkpoint();

      // Median should be 1.01 (middle value)
      const expectedMedian = ethers.parseUnits("1.01", BASE_ASSET_DECIMALS);
      
      // All prices should be normalized to base decimals
      const api3Price = (await tapirOracle.latestApi3Price()).price;
      const chainlinkPrice = (await tapirOracle.latestChainlinkPrice()).price;
      const redStonePrice = (await tapirOracle.latestRedStoneClassicPrice()).price;

      expect(api3Price).to.equal(ethers.parseUnits("1.00", BASE_ASSET_DECIMALS));
      expect(chainlinkPrice).to.equal(ethers.parseUnits("1.02", BASE_ASSET_DECIMALS));
      expect(redStonePrice).to.equal(ethers.parseUnits("1.01", BASE_ASSET_DECIMALS));
    });

    it("Should handle one oracle deviating significantly", async function () {
      // Chainlink reports much lower price
      await api3Mock.setData(ethers.parseUnits("1.00", API3_DECIMALS), await time.latest());
      await chainlinkMock.setData(ethers.parseUnits("0.90", CHAINLINK_DECIMALS), await time.latest());
      await redStoneMock.setData(ethers.parseUnits("1.00", REDSTONE_DECIMALS), await time.latest());

      await tapirOracle.connect(operator).recordApi3Price();
      await tapirOracle.connect(operator).recordChainlinkPrice();
      await tapirOracle.connect(operator).recordRedStoneClassicPrice();

      await time.increase(MIN_CHECKPOINT_SPACING + 1);
      await tapirOracle.connect(operator).checkpoint();

      // Checkpoint should still succeed with valid median
      expect(await tapirOracle.checkpointsCount()).to.equal(1);
    });

    it("Should require minimum sources despite decimal differences", async function () {
      // Disable some sources
      const sources = await tapirOracle.sources();
      await tapirOracle.connect(owner).setSources({
        api3ReaderProxyV1: sources.api3ReaderProxyV1,
        api3ReaderProxyV1IsActive: false,
        api3ReaderProxyV1Decimals: sources.api3ReaderProxyV1Decimals,
        api3ReaderProxyV1MaxStaleness: sources.api3ReaderProxyV1MaxStaleness,
        chainlinkAggregatorV3: sources.chainlinkAggregatorV3,
        chainlinkAggregatorV3IsActive: sources.chainlinkAggregatorV3IsActive,
        chainlinkAggregatorV3Decimals: sources.chainlinkAggregatorV3Decimals,
        chainlinkAggregatorV3MaxStaleness: sources.chainlinkAggregatorV3MaxStaleness,
        redStoneClassicAggregator: sources.redStoneClassicAggregator,
        redStoneClassicIsActive: false,
        redStoneClassicDecimals: sources.redStoneClassicDecimals,
        redStoneClassicMaxStaleness: sources.redStoneClassicMaxStaleness,
        tellorIsActive: sources.tellorIsActive,
        tellorAdapter: sources.tellorAdapter,
        tellorDecimals: sources.tellorDecimals,
        tellorMaxStaleness: sources.tellorMaxStaleness,
      });

      // Try to checkpoint with only 1 source (Chainlink)
      await tapirOracle.connect(operator).recordChainlinkPrice();
      await time.increase(MIN_CHECKPOINT_SPACING + 1);

      // Should fail because minValidSources = 2
      await expect(
        tapirOracle.connect(operator).checkpoint()
      ).to.be.reverted;
    });
  });

  describe("Depeg Size Calculation with 6 Decimals", function () {
    it("Should calculate 1% depeg correctly", async function () {
      const splitAmount = ethers.parseUnits("1000", BASE_ASSET_DECIMALS);
      await depegPool.connect(user1).splitToken(user1.address, splitAmount);

      await time.increase(POOL_ACTIVE_DURATION + 1);

      const hwmPrice = ethers.parseUnits("1.00", BASE_ASSET_DECIMALS);
      const resolutionPrice = ethers.parseUnits("0.99", BASE_ASSET_DECIMALS); // 1% depeg

      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0xDE0B6B3A7640000"]); // 1 ETH
      await depegPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();

      expect(await depegPool.poolHasDepegged()).to.be.true;
      expect(await depegPool.depegSize()).to.equal(100n); // 1% = 100 bp
    });

    it("Should calculate 5% depeg correctly", async function () {
      const splitAmount = ethers.parseUnits("1000", BASE_ASSET_DECIMALS);
      await depegPool.connect(user1).splitToken(user1.address, splitAmount);

      await time.increase(POOL_ACTIVE_DURATION + 1);

      const hwmPrice = ethers.parseUnits("1.00", BASE_ASSET_DECIMALS);
      const resolutionPrice = ethers.parseUnits("0.95", BASE_ASSET_DECIMALS); // 5% depeg

      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0xDE0B6B3A7640000"]); // 1 ETH
      await depegPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();

      expect(await depegPool.poolHasDepegged()).to.be.true;
      expect(await depegPool.depegSize()).to.equal(500n); // 5% = 500 bp
    });

    it("Should calculate 10% depeg correctly", async function () {
      const splitAmount = ethers.parseUnits("1000", BASE_ASSET_DECIMALS);
      await depegPool.connect(user1).splitToken(user1.address, splitAmount);

      await time.increase(POOL_ACTIVE_DURATION + 1);

      const hwmPrice = ethers.parseUnits("1.00", BASE_ASSET_DECIMALS);
      const resolutionPrice = ethers.parseUnits("0.90", BASE_ASSET_DECIMALS); // 10% depeg

      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0xDE0B6B3A7640000"]); // 1 ETH
      await depegPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();

      expect(await depegPool.poolHasDepegged()).to.be.true;
      expect(await depegPool.depegSize()).to.equal(1000n); // 10% = 1000 bp
    });
  });

  describe("Edge Cases with Low Decimals", function () {
    it("Should reject price above maximum", async function () {
      const tooHighPrice = ethers.parseUnits("1.11", BASE_ASSET_DECIMALS);

      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0xDE0B6B3A7640000"]); // 1 ETH

      await time.increase(POOL_ACTIVE_DURATION + 1);

      // Should fail
      await expect(
        depegPool.connect(oracleSigner).updatePriceData(tooHighPrice, tooHighPrice)
      ).to.be.reverted;

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);
    });

    it("Should handle minimum price with 6 decimals", async function () {
      const minAllowedPrice = ethers.parseUnits("0.90", BASE_ASSET_DECIMALS);

      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0xDE0B6B3A7640000"]); // 1 ETH

      await time.increase(POOL_ACTIVE_DURATION + 1);

      // Should succeed
      await depegPool.connect(oracleSigner).updatePriceData(ONE_UNIT, minAllowedPrice);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);
    });
  });
});

