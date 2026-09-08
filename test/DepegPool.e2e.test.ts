import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { 
  DepegPool, 
  DepegFactory, 
  DepegToken,
  TapirOracle,
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
 * End-to-End Lifecycle Integration Tests
 * 
 * These tests simulate a real-world deployment scenario where:
 * 1. Multiple users split tokens during the ACTIVE phase
 * 2. Some users unsplit their tokens (take back base assets early)
 * 3. The pool transitions through all lifecycle states
 * 4. Remaining users redeem their tokens after resolution
 * 5. Final state verification: pool balance should equal accumulated fees
 * 
 * Lifecycle states:
 * - ACTIVE: Users can split/unsplit tokens
 * - COOLDOWN: Oracle updates price data
 * - RESOLUTION: Pool resolves whether a depeg occurred
 * - REDEMPTIONS: Users redeem DP/YB tokens for base assets
 */
describe("DepegPool - E2E Lifecycle Integration", function () {
  // Contracts
  let depegPool: DepegPool;
  let depegFactory: DepegFactory;
  let dpToken: DepegToken;
  let ybToken: DepegToken;
  let baseAsset: any;
  let tapirOracle: TapirOracle;
  let api3Mock: Api3ReaderProxyMock;
  let chainlinkMock: ChainlinkAggregatorMock;

  // Signers
  let owner: SignerWithAddress;
  let operator: SignerWithAddress;
  let treasury: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charlie: SignerWithAddress;
  let david: SignerWithAddress;
  let eve: SignerWithAddress;
  let oracleKeeper: SignerWithAddress;

  // Constants
  const INITIAL_PRICE = ethers.parseEther("1.0"); // Reference price for tests
  const MIN_PRICE = ethers.parseEther("0.5");
  const MAX_PRICE = ethers.parseEther("2.0");
  const POOL_ACTIVE_DURATION = 7 * 24 * 60 * 60; // 7 days
  const COOLDOWN_DURATION = 12 * 60 * 60; // 12 hours (increased for oracle checkpoints)
  const MIN_PRICE_AGE = 5 * 60 * 60; // 5 hours
  const REDEMPTION_FEE_BP = 10; // 0.1%
  const BP_IN_INTEGER = 10000;
  const ORACLE_MIN_CHECKPOINT_SPACING = 3600; // 1 hour

  // Helper function to create daily checkpoints during the active phase
  // This builds up the historical price data needed for HWM and closing price calculations
  // With daily aggregation, checkpoints must be on different UTC days to count as separate data points
  async function createDailyCheckpoints(prices: bigint[], daysToAdvance: number = 1) {
    for (let i = 0; i < prices.length; i++) {
      const currentBlock = await ethers.provider.getBlock("latest");
      const currentTimestamp = currentBlock!.timestamp;
      
      await api3Mock.setData(prices[i], currentTimestamp);
      await chainlinkMock.setData(prices[i], currentTimestamp);
      
      await tapirOracle.connect(oracleKeeper).recordApi3Price();
      await tapirOracle.connect(oracleKeeper).recordChainlinkPrice();
      await tapirOracle.connect(oracleKeeper).checkpoint();
      
      // Advance 1 day between checkpoints to ensure each checkpoint is on a different day
      if (i < prices.length - 1) {
        await time.increase(86400 * daysToAdvance); // 1 day
      }
    }
  }

  // Helper function to update oracle price feeds and record prices during COOLDOWN
  // This writes the HWM and closing price to the pool based on previously recorded checkpoints
  async function oracleUpdatePriceData(hwmPrice: bigint, resolutionPrice: bigint) {
    // The oracle uses daily aggregation - it takes the median of prices per UTC day
    // HWM requires at least 3 days of data
    // Closing price uses the median of daily prices within the lookback period
    
    // Since checkpoints should already exist from createDailyCheckpoints() during ACTIVE phase,
    // we may just need to add a few more checkpoints during cooldown to capture the resolution price
    
    // Create a few more checkpoints during cooldown (these may be on the same day)
    const numCooldownCheckpoints = 3;
    const checkpointInterval = ORACLE_MIN_CHECKPOINT_SPACING + 1; // Just over 1 hour
    
    for (let i = 0; i < numCooldownCheckpoints; i++) {
      const currentBlock = await ethers.provider.getBlock("latest");
      const currentTimestamp = currentBlock!.timestamp;
      
      await api3Mock.setData(resolutionPrice, currentTimestamp);
      await chainlinkMock.setData(resolutionPrice, currentTimestamp);
      
      await tapirOracle.connect(oracleKeeper).recordApi3Price();
      await tapirOracle.connect(oracleKeeper).recordChainlinkPrice();
      await tapirOracle.connect(oracleKeeper).checkpoint();
      
      // Advance time for next checkpoint (except after the last one)
      if (i < numCooldownCheckpoints - 1) {
        await time.increase(checkpointInterval);
      }
    }
    
    // Call writePriceData to send HWM and closing price to the pool
    // gaslimit parameter is only used for cross-chain mode, we use 0 for same-chain
    await tapirOracle.connect(oracleKeeper).writePriceData(0);
  }

  // Helper function to move pool through all states to REDEMPTIONS
  async function moveToRedemptions(hwmPrice: bigint, resolutionPrice: bigint) {
    // First, create daily checkpoints during the ACTIVE phase
    // We need at least 5 days of data for closing price median and 3 for HWM
    // Create checkpoints at HWM price for first 3 days, then transition to resolution price
    const dailyPrices = [
      hwmPrice,        // Day 1 - HWM
      hwmPrice,        // Day 2 - HWM
      hwmPrice,        // Day 3 - HWM  
      resolutionPrice, // Day 4 - Transition
      resolutionPrice, // Day 5 - Resolution
      resolutionPrice, // Day 6 - Resolution
      resolutionPrice, // Day 7 - Resolution
    ];
    await createDailyCheckpoints(dailyPrices);
    
    // Move to COOLDOWN (time should already have advanced ~6 days from checkpoints)
    // Need to advance remaining time to reach POOL_ACTIVE_DURATION
    const currentBlock = await ethers.provider.getBlock("latest");
    const poolStartTime = await depegPool.startTime();
    const timeElapsed = BigInt(currentBlock!.timestamp) - poolStartTime;
    const timeRemaining = BigInt(POOL_ACTIVE_DURATION) - timeElapsed + 1n;
    if (timeRemaining > 0n) {
      await time.increase(Number(timeRemaining));
    }
    
    // Oracle updates price data during COOLDOWN
    await oracleUpdatePriceData(hwmPrice, resolutionPrice);
    
    // Move to RESOLUTION and resolve
    await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
    await depegPool.resolvePriceDepeg();
  }

  beforeEach(async function () {
    [owner, operator, treasury, alice, bob, charlie, david, eve, oracleKeeper] = await ethers.getSigners();

    // Deploy mock ERC20 token as base asset
    const MockERC20 = await ethers.getContractFactory("WtETHMock");
    baseAsset = await MockERC20.deploy();

    // Deploy mock price feeds
    const Api3Mock = await ethers.getContractFactory("Api3ReaderProxyMock");
    const ChainlinkMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
    
    const currentBlock = await ethers.provider.getBlock("latest");
    const initialTimestamp = currentBlock!.timestamp;
    
    api3Mock = await Api3Mock.deploy(INITIAL_PRICE, initialTimestamp);
    // ChainlinkMock expects: (int256 initialAnswer, uint256 initialUpdatedAt, uint8 decimals)
    chainlinkMock = await ChainlinkMock.deploy(INITIAL_PRICE, initialTimestamp, 18);

    // Setup TapirOracle sources configuration
    const sources = {
      api3ReaderProxyV1IsActive: true,
      api3ReaderProxyV1: await api3Mock.getAddress(),
      api3ReaderProxyV1Decimals: 18,
      api3ReaderProxyV1MaxStaleness: 24 * 60 * 60, // 24 hours
      chainlinkAggregatorV3IsActive: true,
      chainlinkAggregatorV3: await chainlinkMock.getAddress(),
      chainlinkAggregatorV3Decimals: 18,
      chainlinkAggregatorV3MaxStaleness: 24 * 60 * 60, // 24 hours
      redStoneClassicIsActive: false,
      redStoneClassicAggregator: ethers.ZeroAddress,
      redStoneClassicDecimals: 8,
      redStoneClassicMaxStaleness: 24 * 60 * 60, // 24 hours
      tellorIsActive: false,
      tellorAdapter: ethers.ZeroAddress,
      tellorDecimals: 8,
      tellorMaxStaleness: 24 * 60 * 60, // 24 hours
    };

    // Deploy TapirOracle first (with zero pool address initially)
    const oracleConfig = {
      minCheckpointSpacing: ORACLE_MIN_CHECKPOINT_SPACING,
      minValidSources: 2, // Require 2 valid sources
      closingPriceLookbackPeriod: COOLDOWN_DURATION, // Match pool cooldown
      depegPool: ethers.ZeroAddress, // Will be set after pool deployment
      xChainMode: false,
      xDomainMessengerL1: ethers.ZeroAddress,
    };

    const TapirOracle = await ethers.getContractFactory("TapirOracle");
    tapirOracle = await TapirOracle.deploy(
      "E2E", // assetSymbol
      await baseAsset.getAddress(), // asset
      18, // assetDecimals (base asset is 18 decimals)
      sources, // Sources struct
      oracleConfig, // Config struct
      owner.address, // admin
    );

    // Grant operator role to oracleKeeper
    const OPERATOR = await tapirOracle.OPERATOR_ROLE();
    await tapirOracle.connect(owner).grantRole(OPERATOR, oracleKeeper.address);

    // Record initial prices
    await tapirOracle.connect(oracleKeeper).recordApi3Price();
    await tapirOracle.connect(oracleKeeper).recordChainlinkPrice();

    // Deploy factory
    const DepegFactory = await ethers.getContractFactory("DepegFactory");
    depegFactory = await DepegFactory.deploy();

    // Deploy DepegPool via factory with TapirOracle
    const params = createDepegPoolParams({
      assetAddress: await baseAsset.getAddress(),
      name: "E2E Test Pool",
      flag: "E2E",
      oracle: await tapirOracle.getAddress(),
      poolActiveDuration: POOL_ACTIVE_DURATION,
      cooldownDuration: COOLDOWN_DURATION,
      redemptionFeeBp: REDEMPTION_FEE_BP,
      poolOwner: owner.address,
      minPrice: MIN_PRICE,
      maxPrice: MAX_PRICE,
      treasury: treasury.address,
      minPriceAge: MIN_PRICE_AGE
    });
    await depegFactory.deployDepeg(params);

    // Get deployed pool
    const depegModule = await depegFactory.getDepegModule(0);
    depegPool = await ethers.getContractAt("DepegPool", depegModule.depegPool);
    dpToken = await ethers.getContractAt("DepegToken", depegModule.dpAsset);
    ybToken = await ethers.getContractAt("DepegToken", depegModule.ybAsset);

    // Update TapirOracle config to point to the deployed pool
    await tapirOracle.connect(owner).setConfig({
      minCheckpointSpacing: ORACLE_MIN_CHECKPOINT_SPACING,
      minValidSources: 2,
      closingPriceLookbackPeriod: COOLDOWN_DURATION,
      depegPool: await depegPool.getAddress(),
      xChainMode: false,
      xDomainMessengerL1: ethers.ZeroAddress,
    });

    // Grant operator role
    const OPERATOR_ROLE = await depegPool.OPERATOR_ROLE();
    await depegPool.grantRole(OPERATOR_ROLE, operator.address);

    // Fund users with base asset and approve pool
    const users = [alice, bob, charlie, david, eve];
    for (const user of users) {
      await baseAsset.mint(user.address, ethers.parseEther("10000"));
      await baseAsset.connect(user).approve(await depegPool.getAddress(), ethers.MaxUint256);
    }
  });

  describe("Complete Lifecycle - No Depeg Scenario", function () {
    it("Should handle full lifecycle: split, unsplit, redeem, and fee verification", async function () {
      // ========================================
      // PHASE 1: ACTIVE - Users split tokens
      // ========================================
      console.log("\n=== PHASE 1: ACTIVE - Token Splitting ===");
      
      const aliceSplit = ethers.parseEther("1000");
      const bobSplit = ethers.parseEther("500");
      const charlieSplit = ethers.parseEther("750");
      const davidSplit = ethers.parseEther("300");
      const eveSplit = ethers.parseEther("200");

      await depegPool.connect(alice).splitToken(alice.address, aliceSplit);
      await depegPool.connect(bob).splitToken(bob.address, bobSplit);
      await depegPool.connect(charlie).splitToken(charlie.address, charlieSplit);
      await depegPool.connect(david).splitToken(david.address, davidSplit);
      await depegPool.connect(eve).splitToken(eve.address, eveSplit);

      const totalSplit = aliceSplit + bobSplit + charlieSplit + davidSplit + eveSplit;
      console.log(`Total split: ${ethers.formatEther(totalSplit)} ETH`);

      // Verify balances after splitting (split divides by 2, so 1000 base -> 500 DP + 500 YB)
      expect(await dpToken.balanceOf(alice.address)).to.equal(aliceSplit / 2n);
      expect(await ybToken.balanceOf(alice.address)).to.equal(aliceSplit / 2n);
      expect(await baseAsset.balanceOf(await depegPool.getAddress())).to.equal(totalSplit);

      // ========================================
      // PHASE 2: ACTIVE - Some users unsplit
      // ========================================
      console.log("\n=== PHASE 2: ACTIVE - Unsplitting ===");
      
      // Bob unsplits 50% of his tokens (he has bobSplit/2 DP and bobSplit/2 YB)
      const bobTokenBalance = bobSplit / 2n; // Bob has this much DP and this much YB
      const bobUnsplit = bobTokenBalance / 2n; // Bob unsplits half
      await dpToken.connect(bob).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(bob).approve(await depegPool.getAddress(), ethers.MaxUint256);
      
      const bobBaseBefore = await baseAsset.balanceOf(bob.address);
      await depegPool.connect(bob).unSplitTokens(bob.address, bobUnsplit);
      const bobBaseAfter = await baseAsset.balanceOf(bob.address);
      
      // Unsplitting X tokens returns X * 2 base (minus fees)
      const bobReturnAmount = bobUnsplit * 2n;
      const bobRedeemFee = (bobReturnAmount * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      const bobExpectedReturn = bobReturnAmount - bobRedeemFee;
      expect(bobBaseAfter - bobBaseBefore).to.equal(bobExpectedReturn);
      console.log(`Bob unsplit ${ethers.formatEther(bobUnsplit)} DP+YB, received ${ethers.formatEther(bobExpectedReturn)} base`);

      // David unsplits all his tokens (he has davidSplit/2 DP and davidSplit/2 YB)
      const davidTokenBalance = davidSplit / 2n;
      const davidUnsplit = davidTokenBalance; // David unsplits everything
      await dpToken.connect(david).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(david).approve(await depegPool.getAddress(), ethers.MaxUint256);
      
      const davidBaseBefore = await baseAsset.balanceOf(david.address);
      await depegPool.connect(david).unSplitTokens(david.address, davidUnsplit);
      const davidBaseAfter = await baseAsset.balanceOf(david.address);
      
      const davidReturnAmount = davidUnsplit * 2n;
      const davidRedeemFee = (davidReturnAmount * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      const davidExpectedReturn = davidReturnAmount - davidRedeemFee;
      expect(davidBaseAfter - davidBaseBefore).to.equal(davidExpectedReturn);
      console.log(`David unsplit ${ethers.formatEther(davidUnsplit)} DP+YB, received ${ethers.formatEther(davidExpectedReturn)} base`);

      const totalFeesFromUnsplit = bobRedeemFee + davidRedeemFee;
      console.log(`Total fees from unsplitting: ${ethers.formatEther(totalFeesFromUnsplit)} ETH`);

      // Remaining split amount after unsplits (bob unsplit half, david unsplit all)
      const totalUnsplitBase = bobReturnAmount + davidReturnAmount; // Base equivalent returned
      const remainingSplit = totalSplit - totalUnsplitBase + totalFeesFromUnsplit; // Fees stay in pool
      console.log(`Remaining split amount: ${ethers.formatEther(remainingSplit)} ETH`);

      // ========================================
      // PHASE 2.5: ACTIVE - Create daily checkpoints for price history
      // ========================================
      console.log("\n=== PHASE 2.5: Creating Daily Price Checkpoints ===");
      
      // Create daily checkpoints at stable price (no depeg scenario)
      // Need at least 5 days for closing price median and 3 for HWM
      const dailyPrices = [
        INITIAL_PRICE, // Day 1
        INITIAL_PRICE, // Day 2
        INITIAL_PRICE, // Day 3
        INITIAL_PRICE, // Day 4
        INITIAL_PRICE, // Day 5
        INITIAL_PRICE, // Day 6
        INITIAL_PRICE, // Day 7
      ];
      await createDailyCheckpoints(dailyPrices);
      console.log(`Created ${dailyPrices.length} daily checkpoints at stable price`);

      // ========================================
      // PHASE 3: COOLDOWN - Oracle updates prices
      // ========================================
      console.log("\n=== PHASE 3: COOLDOWN - Price Update ===");
      
      // Calculate remaining time needed to reach COOLDOWN
      const currentBlock = await ethers.provider.getBlock("latest");
      const poolStartTime = await depegPool.startTime();
      const timeElapsed = BigInt(currentBlock!.timestamp) - poolStartTime;
      const timeRemaining = BigInt(POOL_ACTIVE_DURATION) - timeElapsed + 1n;
      if (timeRemaining > 0n) {
        await time.increase(Number(timeRemaining));
      }
      expect(await depegPool.getState()).to.equal(2); // COOLDOWN

      // No depeg scenario: hwm = resolution price
      const hwmPrice = INITIAL_PRICE;
      const resolutionPrice = INITIAL_PRICE;
      await oracleUpdatePriceData(hwmPrice, resolutionPrice);
      console.log(`Oracle updated: HWM=${ethers.formatEther(hwmPrice)}, Resolution=${ethers.formatEther(resolutionPrice)}`);

      // ========================================
      // PHASE 4: RESOLUTION
      // ========================================
      console.log("\n=== PHASE 4: RESOLUTION ===");
      
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      expect(await depegPool.getState()).to.equal(3); // RESOLUTION

      await depegPool.resolvePriceDepeg();
      expect(await depegPool.depegResolved()).to.be.true;
      expect(await depegPool.poolHasDepegged()).to.be.false;
      expect(await depegPool.depegSize()).to.equal(0);
      console.log("Pool resolved: No depeg detected");

      // ========================================
      // PHASE 5: REDEMPTIONS - Users redeem tokens
      // ========================================
      console.log("\n=== PHASE 5: REDEMPTIONS ===");
      
      expect(await depegPool.getState()).to.equal(4); // REDEMPTIONS

      // Approve tokens for redemption
      await dpToken.connect(alice).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(alice).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await dpToken.connect(bob).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(bob).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await dpToken.connect(charlie).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(charlie).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await dpToken.connect(eve).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(eve).approve(await depegPool.getAddress(), ethers.MaxUint256);

      // Track fees
      let totalRedemptionFees = 0n;

      // Alice redeems all her tokens
      const aliceDpBalance = await dpToken.balanceOf(alice.address);
      const aliceYbBalance = await ybToken.balanceOf(alice.address);
      const aliceBaseBefore = await baseAsset.balanceOf(alice.address);
      await depegPool.connect(alice).redeemTokens(alice.address, aliceDpBalance, aliceYbBalance);
      const aliceBaseAfter = await baseAsset.balanceOf(alice.address);
      const aliceRedeemed = aliceBaseAfter - aliceBaseBefore;
      
      // No depeg: min(DP, YB) pairs are worth 2 base each. Alice has equal amounts.
      // Her DP+YB should equal aliceSplit/2 + aliceSplit/2 = aliceSplit worth of tokens
      // But redemption: DP + YB = amountToSend, then fees are deducted
      const aliceAmountToSend = aliceDpBalance + aliceYbBalance; // No depeg case
      const aliceFees = (aliceAmountToSend * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      totalRedemptionFees += aliceFees;
      console.log(`Alice redeemed ${ethers.formatEther(aliceDpBalance)} DP + ${ethers.formatEther(aliceYbBalance)} YB → ${ethers.formatEther(aliceRedeemed)} base`);

      // Bob redeems remaining tokens (50% of original)
      const bobDpBalance = await dpToken.balanceOf(bob.address);
      const bobYbBalance = await ybToken.balanceOf(bob.address);
      const bobBaseBefore2 = await baseAsset.balanceOf(bob.address);
      await depegPool.connect(bob).redeemTokens(bob.address, bobDpBalance, bobYbBalance);
      const bobBaseAfter2 = await baseAsset.balanceOf(bob.address);
      const bobRedeemed = bobBaseAfter2 - bobBaseBefore2;
      
      const bobAmountToSend = bobDpBalance + bobYbBalance;
      const bobFees = (bobAmountToSend * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      totalRedemptionFees += bobFees;
      console.log(`Bob redeemed ${ethers.formatEther(bobDpBalance)} DP + ${ethers.formatEther(bobYbBalance)} YB → ${ethers.formatEther(bobRedeemed)} base`);

      // Charlie redeems all tokens
      const charlieDpBalance = await dpToken.balanceOf(charlie.address);
      const charlieYbBalance = await ybToken.balanceOf(charlie.address);
      const charlieBaseBefore = await baseAsset.balanceOf(charlie.address);
      await depegPool.connect(charlie).redeemTokens(charlie.address, charlieDpBalance, charlieYbBalance);
      const charlieBaseAfter = await baseAsset.balanceOf(charlie.address);
      const charlieRedeemed = charlieBaseAfter - charlieBaseBefore;
      
      const charlieAmountToSend = charlieDpBalance + charlieYbBalance;
      const charlieFees = (charlieAmountToSend * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      totalRedemptionFees += charlieFees;
      console.log(`Charlie redeemed ${ethers.formatEther(charlieDpBalance)} DP + ${ethers.formatEther(charlieYbBalance)} YB → ${ethers.formatEther(charlieRedeemed)} base`);

      // Eve redeems all tokens
      const eveDpBalance = await dpToken.balanceOf(eve.address);
      const eveYbBalance = await ybToken.balanceOf(eve.address);
      const eveBaseBefore = await baseAsset.balanceOf(eve.address);
      await depegPool.connect(eve).redeemTokens(eve.address, eveDpBalance, eveYbBalance);
      const eveBaseAfter = await baseAsset.balanceOf(eve.address);
      const eveRedeemed = eveBaseAfter - eveBaseBefore;
      
      const eveAmountToSend = eveDpBalance + eveYbBalance;
      const eveFees = (eveAmountToSend * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      totalRedemptionFees += eveFees;
      console.log(`Eve redeemed ${ethers.formatEther(eveDpBalance)} DP + ${ethers.formatEther(eveYbBalance)} YB → ${ethers.formatEther(eveRedeemed)} base`);

      // ========================================
      // PHASE 6: VERIFICATION - Pool balance equals fees
      // ========================================
      console.log("\n=== PHASE 6: FINAL VERIFICATION ===");
      
      const totalFees = totalFeesFromUnsplit + totalRedemptionFees;
      console.log(`Total fees collected: ${ethers.formatEther(totalFees)} ETH`);
      console.log(`  - From unsplitting: ${ethers.formatEther(totalFeesFromUnsplit)} ETH`);
      console.log(`  - From redemptions: ${ethers.formatEther(totalRedemptionFees)} ETH`);

      const poolBalance = await baseAsset.balanceOf(await depegPool.getAddress());
      console.log(`Pool balance after all redemptions: ${ethers.formatEther(poolBalance)} ETH`);

      // Critical verification: pool balance should equal total fees
      expect(poolBalance).to.equal(totalFees, "Pool balance should equal accumulated fees");

      // Verify all tokens have been burned
      expect(await dpToken.totalSupply()).to.equal(0);
      expect(await ybToken.totalSupply()).to.equal(0);

      // Verify treasury can sweep fees
      const treasuryBalanceBefore = await baseAsset.balanceOf(treasury.address);
      await depegPool.sweepFeesToTreasury();
      const treasuryBalanceAfter = await baseAsset.balanceOf(treasury.address);
      
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(totalFees);
      expect(await baseAsset.balanceOf(await depegPool.getAddress())).to.equal(0);
      console.log(`Treasury swept ${ethers.formatEther(totalFees)} ETH in fees`);

      console.log("\n=== E2E TEST COMPLETE ===");
    });
  });

  describe("Complete Lifecycle - With Depeg Scenario", function () {
    it("Should handle full lifecycle with 15% depeg event", async function () {
      // ========================================
      // PHASE 1: ACTIVE - Users split tokens
      // ========================================
      console.log("\n=== PHASE 1: ACTIVE - Token Splitting (Depeg Scenario) ===");
      
      const aliceSplit = ethers.parseEther("2000");
      const bobSplit = ethers.parseEther("1500");
      const charlieSplit = ethers.parseEther("1000");

      await depegPool.connect(alice).splitToken(alice.address, aliceSplit);
      await depegPool.connect(bob).splitToken(bob.address, bobSplit);
      await depegPool.connect(charlie).splitToken(charlie.address, charlieSplit);

      const totalSplit = aliceSplit + bobSplit + charlieSplit;
      console.log(`Total split: ${ethers.formatEther(totalSplit)} ETH`);

      // ========================================
      // PHASE 2: ACTIVE - Bob unsplits partial amount
      // ========================================
      console.log("\n=== PHASE 2: ACTIVE - Partial Unsplitting ===");
      
      // Bob has bobSplit/2 tokens, unsplits 1/3 of his holdings
      const bobTokenBalance = bobSplit / 2n;
      const bobUnsplit = bobTokenBalance / 3n; // Bob unsplits 1/3
      await dpToken.connect(bob).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(bob).approve(await depegPool.getAddress(), ethers.MaxUint256);
      
      const bobBaseBefore = await baseAsset.balanceOf(bob.address);
      await depegPool.connect(bob).unSplitTokens(bob.address, bobUnsplit);
      const bobBaseAfter = await baseAsset.balanceOf(bob.address);
      
      const bobReturnAmount = bobUnsplit * 2n;
      const bobRedeemFee = (bobReturnAmount * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      const bobExpectedReturn = bobReturnAmount - bobRedeemFee;
      expect(bobBaseAfter - bobBaseBefore).to.equal(bobExpectedReturn);
      console.log(`Bob unsplit ${ethers.formatEther(bobUnsplit)} DP+YB, received ${ethers.formatEther(bobExpectedReturn)} base`);

      // ========================================
      // PHASE 2.5: ACTIVE - Create daily checkpoints for price history
      // ========================================
      console.log("\n=== PHASE 2.5: Creating Daily Price Checkpoints ===");
      
      // 15% depeg scenario - create checkpoints showing price decline
      const hwmPrice = INITIAL_PRICE;
      const resolutionPrice = (INITIAL_PRICE * 85n) / 100n; // 15% depeg
      
      // Create daily checkpoints: first at HWM, then declining to resolution price
      const dailyPrices = [
        hwmPrice,                              // Day 1 - Peak
        hwmPrice,                              // Day 2 - Still at peak
        hwmPrice,                              // Day 3 - Still at peak
        (hwmPrice * 95n) / 100n,               // Day 4 - Start declining
        (hwmPrice * 90n) / 100n,               // Day 5 - Continue declining
        resolutionPrice,                        // Day 6 - Resolution price
        resolutionPrice,                        // Day 7 - Resolution price
      ];
      await createDailyCheckpoints(dailyPrices);
      console.log(`Created ${dailyPrices.length} daily checkpoints showing price decline`);

      // ========================================
      // PHASE 3: COOLDOWN - Oracle reports depeg
      // ========================================
      console.log("\n=== PHASE 3: COOLDOWN - Depeg Detection ===");
      
      // Calculate remaining time needed to reach COOLDOWN
      const currentBlock = await ethers.provider.getBlock("latest");
      const poolStartTime = await depegPool.startTime();
      const timeElapsed = BigInt(currentBlock!.timestamp) - poolStartTime;
      const timeRemaining = BigInt(POOL_ACTIVE_DURATION) - timeElapsed + 1n;
      if (timeRemaining > 0n) {
        await time.increase(Number(timeRemaining));
      }
      expect(await depegPool.getState()).to.equal(2); // COOLDOWN

      // Add final checkpoint during cooldown
      await oracleUpdatePriceData(hwmPrice, resolutionPrice);
      console.log(`Oracle updated: HWM=${ethers.formatEther(hwmPrice)}, Resolution=${ethers.formatEther(resolutionPrice)}`);
      console.log(`Depeg detected: ${((hwmPrice - resolutionPrice) * 100n) / hwmPrice}%`);

      // ========================================
      // PHASE 4: RESOLUTION
      // ========================================
      console.log("\n=== PHASE 4: RESOLUTION ===");
      
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();
      
      expect(await depegPool.depegResolved()).to.be.true;
      expect(await depegPool.poolHasDepegged()).to.be.true;
      
      const depegSize = await depegPool.depegSize();
      console.log(`Pool resolved: Depeg size = ${depegSize} basis points (${depegSize / 100n}%)`);
      expect(depegSize).to.be.closeTo(1500, 10); // ~15% = 1500 bp

      // ========================================
      // PHASE 5: REDEMPTIONS - Asymmetric payoffs
      // ========================================
      console.log("\n=== PHASE 5: REDEMPTIONS - Asymmetric Payoffs ===");
      
      // Approve tokens
      await dpToken.connect(alice).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(alice).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await dpToken.connect(bob).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(bob).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await dpToken.connect(charlie).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(charlie).approve(await depegPool.getAddress(), ethers.MaxUint256);

      let totalRedemptionFees = 0n;

      // Alice holds DP tokens (wins in depeg)
      const aliceDpBalance = await dpToken.balanceOf(alice.address);
      const aliceYbBalance = await ybToken.balanceOf(alice.address);
      const aliceBaseBefore = await baseAsset.balanceOf(alice.address);
      await depegPool.connect(alice).redeemTokens(alice.address, aliceDpBalance, aliceYbBalance);
      const aliceBaseAfter = await baseAsset.balanceOf(alice.address);
      const aliceRedeemed = aliceBaseAfter - aliceBaseBefore;
      
      // With 15% depeg: DP worth more, YB worth less. Equal DP+YB → roughly original amount
      // amountToSend calculation handles the depeg math
      const aliceAmountToSend = aliceDpBalance + aliceYbBalance; // Approximation for equal holdings
      const aliceFees = (aliceAmountToSend * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      totalRedemptionFees += aliceFees;
      console.log(`Alice redeemed ${ethers.formatEther(aliceDpBalance)} DP + ${ethers.formatEther(aliceYbBalance)} YB → ${ethers.formatEther(aliceRedeemed)} base`);
      // Alice should get approximately her original amount back (equal DP and YB cancel out depeg)
      expect(aliceRedeemed).to.be.closeTo(aliceSplit - aliceFees, ethers.parseEther("1"));

      // Bob holds remaining mixed position
      const bobDpBalance = await dpToken.balanceOf(bob.address);
      const bobYbBalance = await ybToken.balanceOf(bob.address);
      const bobBaseBefore2 = await baseAsset.balanceOf(bob.address);
      await depegPool.connect(bob).redeemTokens(bob.address, bobDpBalance, bobYbBalance);
      const bobBaseAfter2 = await baseAsset.balanceOf(bob.address);
      const bobRedeemed = bobBaseAfter2 - bobBaseBefore2;
      
      const bobAmountToSend = bobDpBalance + bobYbBalance; // Simplified for fee calc
      const bobFees = (bobAmountToSend * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      totalRedemptionFees += bobFees;
      console.log(`Bob redeemed ${ethers.formatEther(bobDpBalance)} DP + ${ethers.formatEther(bobYbBalance)} YB → ${ethers.formatEther(bobRedeemed)} base`);

      // Charlie holds full position
      const charlieDpBalance = await dpToken.balanceOf(charlie.address);
      const charlieYbBalance = await ybToken.balanceOf(charlie.address);
      const charlieBaseBefore = await baseAsset.balanceOf(charlie.address);
      await depegPool.connect(charlie).redeemTokens(charlie.address, charlieDpBalance, charlieYbBalance);
      const charlieBaseAfter = await baseAsset.balanceOf(charlie.address);
      const charlieRedeemed = charlieBaseAfter - charlieBaseBefore;
      
      const charlieAmountToSend = charlieDpBalance + charlieYbBalance;
      const charlieFees = (charlieAmountToSend * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      totalRedemptionFees += charlieFees;
      console.log(`Charlie redeemed ${ethers.formatEther(charlieDpBalance)} DP + ${ethers.formatEther(charlieYbBalance)} YB → ${ethers.formatEther(charlieRedeemed)} base`);

      // ========================================
      // PHASE 6: VERIFICATION
      // ========================================
      console.log("\n=== PHASE 6: FINAL VERIFICATION ===");
      
      const totalFees = bobRedeemFee + totalRedemptionFees;
      console.log(`Total fees collected: ${ethers.formatEther(totalFees)} ETH`);

      const poolBalance = await baseAsset.balanceOf(await depegPool.getAddress());
      console.log(`Pool balance after all redemptions: ${ethers.formatEther(poolBalance)} ETH`);

      // Critical verification
      expect(poolBalance).to.equal(totalFees, "Pool balance should equal accumulated fees");
      expect(await dpToken.totalSupply()).to.equal(0);
      expect(await ybToken.totalSupply()).to.equal(0);

      // Treasury sweep
      await depegPool.sweepFeesToTreasury();
      expect(await baseAsset.balanceOf(await depegPool.getAddress())).to.equal(0);
      console.log(`Treasury swept ${ethers.formatEther(totalFees)} ETH in fees`);

      console.log("\n=== E2E DEPEG TEST COMPLETE ===");
    });
  });

  describe("Complete Lifecycle - Edge Cases", function () {
    it("Should handle lifecycle where only unsplits occur (no final redemptions)", async function () {
      console.log("\n=== Edge Case: All Users Unsplit Before Expiry ===");
      
      // Users split tokens
      const aliceSplit = ethers.parseEther("500");
      const bobSplit = ethers.parseEther("300");

      await depegPool.connect(alice).splitToken(alice.address, aliceSplit);
      await depegPool.connect(bob).splitToken(bob.address, bobSplit);

      // Both users unsplit everything (they have aliceSplit/2 and bobSplit/2 tokens)
      await dpToken.connect(alice).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(alice).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await dpToken.connect(bob).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(bob).approve(await depegPool.getAddress(), ethers.MaxUint256);

      const aliceTokens = aliceSplit / 2n;
      const bobTokens = bobSplit / 2n;

      const aliceBaseBefore = await baseAsset.balanceOf(alice.address);
      await depegPool.connect(alice).unSplitTokens(alice.address, aliceTokens);
      const aliceBaseAfter = await baseAsset.balanceOf(alice.address);
      
      const bobBaseBefore = await baseAsset.balanceOf(bob.address);
      await depegPool.connect(bob).unSplitTokens(bob.address, bobTokens);
      const bobBaseAfter = await baseAsset.balanceOf(bob.address);

      const aliceReturnAmount = aliceTokens * 2n;
      const bobReturnAmount = bobTokens * 2n;
      const aliceFees = (aliceReturnAmount * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      const bobFees = (bobReturnAmount * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      const totalFees = aliceFees + bobFees;

      expect(aliceBaseAfter - aliceBaseBefore).to.equal(aliceReturnAmount - aliceFees);
      expect(bobBaseAfter - bobBaseBefore).to.equal(bobReturnAmount - bobFees);

      // Move to redemptions state
      await moveToRedemptions(INITIAL_PRICE, INITIAL_PRICE);

      // Pool should only contain fees
      const poolBalance = await baseAsset.balanceOf(await depegPool.getAddress());
      expect(poolBalance).to.equal(totalFees);
      expect(await dpToken.totalSupply()).to.equal(0);
      expect(await ybToken.totalSupply()).to.equal(0);

      console.log(`All users exited early. Fees remaining: ${ethers.formatEther(totalFees)} ETH`);
    });

    it("Should handle mixed redemptions with unbalanced DP/YB holdings", async function () {
      console.log("\n=== Edge Case: Unbalanced DP/YB Redemptions ===");
      
      // Alice and Bob split equal amounts
      const splitAmount = ethers.parseEther("1000");
      await depegPool.connect(alice).splitToken(alice.address, splitAmount);
      await depegPool.connect(bob).splitToken(bob.address, splitAmount);

      // Alice sells all her YB to Bob (simulated by transfer)
      // She has splitAmount/2 YB tokens
      const aliceYbTokens = splitAmount / 2n;
      await ybToken.connect(alice).transfer(bob.address, aliceYbTokens);

      // Move to redemptions (no depeg)
      await moveToRedemptions(INITIAL_PRICE, INITIAL_PRICE);

      // Alice only has DP tokens
      await dpToken.connect(alice).approve(await depegPool.getAddress(), ethers.MaxUint256);
      const aliceDpBalance = await dpToken.balanceOf(alice.address);
      const aliceBaseBefore = await baseAsset.balanceOf(alice.address);
      await depegPool.connect(alice).redeemTokens(alice.address, aliceDpBalance, 0);
      const aliceBaseAfter = await baseAsset.balanceOf(alice.address);

      // Bob has all YB and his original DP
      await dpToken.connect(bob).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(bob).approve(await depegPool.getAddress(), ethers.MaxUint256);
      const bobDpBalance = await dpToken.balanceOf(bob.address);
      const bobYbBalance = await ybToken.balanceOf(bob.address);
      const bobBaseBefore = await baseAsset.balanceOf(bob.address);
      await depegPool.connect(bob).redeemTokens(bob.address, bobDpBalance, bobYbBalance);
      const bobBaseAfter = await baseAsset.balanceOf(bob.address);

      // Verify redemptions occurred
      expect(aliceBaseAfter).to.be.greaterThan(aliceBaseBefore);
      expect(bobBaseAfter).to.be.greaterThan(bobBaseBefore);

      // No tokens should remain
      expect(await dpToken.totalSupply()).to.equal(0);
      expect(await ybToken.totalSupply()).to.equal(0);

      console.log(`Alice redeemed only DP: ${ethers.formatEther(aliceBaseAfter - aliceBaseBefore)} ETH`);
      console.log(`Bob redeemed DP+2xYB: ${ethers.formatEther(bobBaseAfter - bobBaseBefore)} ETH`);
    });
  });

  describe("Fee Accounting Verification", function () {
    it("Should accurately track and verify all fees through complex lifecycle", async function () {
      console.log("\n=== Complex Fee Tracking Test ===");
      
      // Track all operations and fees
      let expectedTotalFees = 0n;
      const operations: string[] = [];

      // Multiple splits
      const splits = [
        { user: alice, amount: ethers.parseEther("1000") },
        { user: bob, amount: ethers.parseEther("800") },
        { user: charlie, amount: ethers.parseEther("600") },
        { user: david, amount: ethers.parseEther("400") },
      ];

      for (const { user, amount } of splits) {
        await depegPool.connect(user).splitToken(user.address, amount);
        operations.push(`Split: ${ethers.formatEther(amount)} ETH`);
      }

      // Multiple unsplits (users have splits[i].amount / 2 tokens each)
      const unsplits = [
        { user: alice, amount: ethers.parseEther("300") / 2n }, // Alice has 500 tokens, unsplits 150
        { user: charlie, amount: ethers.parseEther("200") / 2n }, // Charlie has 300 tokens, unsplits 100
      ];

      for (const { user, amount } of unsplits) {
        await dpToken.connect(user).approve(await depegPool.getAddress(), ethers.MaxUint256);
        await ybToken.connect(user).approve(await depegPool.getAddress(), ethers.MaxUint256);
        await depegPool.connect(user).unSplitTokens(user.address, amount);
        
        const returnAmount = amount * 2n;
        const fees = (returnAmount * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
        expectedTotalFees += fees;
        operations.push(`Unsplit: ${ethers.formatEther(amount)} DP+YB, fees: ${ethers.formatEther(fees)} ETH`);
      }

      // Move to redemptions
      await moveToRedemptions(INITIAL_PRICE, INITIAL_PRICE);

      // Redeem remaining tokens
      const users = [alice, bob, charlie, david];
      for (const user of users) {
        await dpToken.connect(user).approve(await depegPool.getAddress(), ethers.MaxUint256);
        await ybToken.connect(user).approve(await depegPool.getAddress(), ethers.MaxUint256);
        
        const dpBalance = await dpToken.balanceOf(user.address);
        const ybBalance = await ybToken.balanceOf(user.address);
        
        if (dpBalance > 0n || ybBalance > 0n) {
          // No depeg: amountToSend = dpBalance + ybBalance
          const amountToSend = dpBalance + ybBalance;
          const fees = (amountToSend * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
          expectedTotalFees += fees;
          
          await depegPool.connect(user).redeemTokens(user.address, dpBalance, ybBalance);
          operations.push(`Redeem: ${ethers.formatEther(dpBalance)} DP + ${ethers.formatEther(ybBalance)} YB, fees: ${ethers.formatEther(fees)} ETH`);
        }
      }

      // Verify final state
      const poolBalance = await baseAsset.balanceOf(await depegPool.getAddress());
      
      console.log("\nOperations:");
      operations.forEach(op => console.log(`  ${op}`));
      console.log(`\nExpected total fees: ${ethers.formatEther(expectedTotalFees)} ETH`);
      console.log(`Actual pool balance: ${ethers.formatEther(poolBalance)} ETH`);
      
      expect(poolBalance).to.equal(expectedTotalFees, "Pool balance must exactly equal calculated fees");
      expect(await dpToken.totalSupply()).to.equal(0);
      expect(await ybToken.totalSupply()).to.equal(0);

      console.log("\n✓ Fee accounting verified across all operations");
    });
  });
});

