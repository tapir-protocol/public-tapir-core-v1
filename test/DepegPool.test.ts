import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { 
  DepegPool, 
  DepegFactory, 
  DepegToken,
  TapirOracle 
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
    poolActiveDuration: overrides.poolActiveDuration ?? 7 * 24 * 60 * 60, // 7 days
    name: overrides.name ?? "Test Pool",
    flag: overrides.flag ?? "TEST",
    redemptionFeeBp: overrides.redemptionFeeBp ?? 10,
    cooldownDuration: overrides.cooldownDuration ?? 5 * 60 * 60, // 5 hours
    poolOwner: overrides.poolOwner ?? ethers.ZeroAddress,
    minPrice: overrides.minPrice ?? ethers.parseEther("0.5"),
    maxPrice: overrides.maxPrice ?? ethers.parseEther("2"),
    treasury: overrides.treasury ?? ethers.ZeroAddress,
    authorisedRouter: overrides.authorisedRouter ?? ethers.ZeroAddress,
    minPriceAge: overrides.minPriceAge ?? 5 * 60 * 60, // 5 hours
    xDomainMessengerL2: overrides.xDomainMessengerL2 ?? ethers.ZeroAddress
  };
}

describe("DepegPool", function () {
  // Contracts
  let depegPool: DepegPool;
  let depegFactory: DepegFactory;
  let dpToken: DepegToken;
  let ybToken: DepegToken;
  let baseAsset: any;
  let mockOracle: TapirOracle;

  // Signers
  let owner: SignerWithAddress;
  let operator: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let treasury: SignerWithAddress;
  let nonAuthorized: SignerWithAddress;

  // Constants
  const INITIAL_PRICE = ethers.parseEther("1"); // 1 ETH - used as reference price for tests
  const MIN_PRICE = ethers.parseEther("0.5"); // 0.5 ETH
  const MAX_PRICE = ethers.parseEther("2"); // 2 ETH
  const POOL_ACTIVE_DURATION = 7 * 24 * 60 * 60; // 7 days
  const COOLDOWN_DURATION = 5 * 60 * 60; // 5 hours
  const REDEMPTION_FEE_BP = 10; // 0.1%
  const BP_IN_INTEGER = 10000;
  const ORACLE_CHANGE_DELAY = 7 * 24 * 60 * 60; // 7 days
  const MIN_DURATION = 4 * 60 * 60; // 4 hours
  const MAX_DURATION = 30 * 24 * 60 * 60; // 30 days
  const MIN_PRICE_AGE = 5 * 60 * 60; // 5 hours

  // States
  const STATE_ACTIVE = 1;
  const STATE_COOLDOWN = 2;
  const STATE_RESOLUTION = 3;
  const STATE_REDEMPTIONS = 4;

  beforeEach(async function () {
    [owner, operator, user1, user2, treasury, nonAuthorized] = await ethers.getSigners();

    // Deploy mock ERC20 token as base asset
    const MockERC20 = await ethers.getContractFactory("WtETHMock");
    baseAsset = await MockERC20.deploy();

    // Deploy simple mock oracle
    const SimpleMockOracle = await ethers.getContractFactory("SimpleMockOracle");
    const simpleMockOracle = await SimpleMockOracle.deploy();
    
    // Deploy factory
    const DepegFactory = await ethers.getContractFactory("DepegFactory");
    depegFactory = await DepegFactory.deploy();

    // Deploy DepegPool via factory
    const params = createDepegPoolParams({
      assetAddress: await baseAsset.getAddress(),
      oracle: await simpleMockOracle.getAddress(),
      poolOwner: owner.address,
      treasury: treasury.address,
      authorisedRouter: owner.address
    });
    await depegFactory.deployDepeg(params);

    // Get deployed pool
    const depegModule = await depegFactory.getDepegModule(0);
    depegPool = await ethers.getContractAt("DepegPool", depegModule.depegPool);
    dpToken = await ethers.getContractAt("DepegToken", depegModule.dpAsset);
    ybToken = await ethers.getContractAt("DepegToken", depegModule.ybAsset);

    // Store mock oracle reference
    mockOracle = await ethers.getContractAt("SimpleMockOracle", await simpleMockOracle.getAddress()) as any;

    // Grant operator role
    const OPERATOR_ROLE = await depegPool.OPERATOR_ROLE();
    await depegPool.connect(owner).grantRole(OPERATOR_ROLE, operator.address);

    // Mint base assets to users for testing
    await baseAsset.mint(user1.address, ethers.parseEther("10000"));
    await baseAsset.mint(user2.address, ethers.parseEther("10000"));

    // Approve pool to spend base assets
    await baseAsset.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
    await baseAsset.connect(user2).approve(await depegPool.getAddress(), ethers.MaxUint256);
  });

  describe("Deployment & Initialization", function () {
    it("Should deploy with correct initial parameters", async function () {
      expect(await depegPool.name()).to.equal("Test Pool");
      expect(await depegPool.flag()).to.equal("TEST");
      expect(await depegPool.poolActiveDuration()).to.equal(POOL_ACTIVE_DURATION);
      expect(await depegPool.cooldownDuration()).to.equal(COOLDOWN_DURATION);
      expect(await depegPool.redemptionFeeBp()).to.equal(REDEMPTION_FEE_BP);
      expect(await depegPool.MIN_PRICE()).to.equal(MIN_PRICE);
      expect(await depegPool.MAX_PRICE()).to.equal(MAX_PRICE);
      expect(await depegPool.depegResolved()).to.equal(false);
      expect(await depegPool.poolHasDepegged()).to.equal(false);
      expect(await depegPool.depegSize()).to.equal(0);
      expect(await depegPool.ORACLE_CHANGE_DELAY()).to.equal(ORACLE_CHANGE_DELAY);
      expect(await depegPool.MIN_DURATION()).to.equal(MIN_DURATION);
      expect(await depegPool.MAX_DURATION()).to.equal(MAX_DURATION);
      expect(await depegPool.startTime()).to.be.closeTo((await ethers.provider.getBlock("latest"))!.timestamp, 60);
      expect(await depegPool.minPriceAge()).to.equal(MIN_PRICE_AGE);
      expect(await depegPool.pendingOracle()).to.equal(ethers.ZeroAddress);
      expect(await depegPool.oracleChangeTimestamp()).to.equal(0);
      expect(await depegPool.lastPauseTimestamp()).to.equal(ethers.MaxUint256);
      expect(await depegPool.paused()).to.equal(false);
      expect(await depegPool.TREASURY()).to.equal(treasury.address);
      expect(await depegPool.isAuthorisedRouter(owner.address)).to.equal(true);
    });

    it("Should set correct token addresses", async function () {
      expect(await depegPool.DP_ASSET()).to.equal(await dpToken.getAddress());
      expect(await depegPool.YB_ASSET()).to.equal(await ybToken.getAddress());
      expect(await depegPool.ASSET()).to.equal(await baseAsset.getAddress());
    });

    it("Should deploy valid ERC20 tokens as DP & YB", async function () {
      expect(await dpToken.name()).to.equal("DP Token");
      expect(await dpToken.symbol()).to.equal("DP");
      expect(await ybToken.name()).to.equal("YB Token");
      expect(await ybToken.symbol()).to.equal("YB");
      expect(await dpToken.decimals()).to.equal(18);
      expect(await ybToken.decimals()).to.equal(18);
    });

    it("Should grant correct roles", async function () {
      const DEFAULT_ADMIN_ROLE = await depegPool.DEFAULT_ADMIN_ROLE();
      const OPERATOR_ROLE = await depegPool.OPERATOR_ROLE();
      
      expect(await depegPool.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
      expect(await depegPool.hasRole(OPERATOR_ROLE, operator.address)).to.be.true;
    });

    it("Should start in ACTIVE state", async function () {
      expect(await depegPool.getState()).to.equal(STATE_ACTIVE);
    });

    describe("Constructor Validation", function () {
      it("Should revert when minPriceAge is too short", async function () {
        const tooShortMinPriceAge = MIN_DURATION - 1; // Less than 4 hours

        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          dpName: "DP Token Short",
          dpSymbol: "DPS",
          ybName: "YB Token Short",
          ybSymbol: "YBS",
          name: "Short Age Pool",
          flag: "SHORTAGE",
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address,
          minPriceAge: tooShortMinPriceAge
        });
        await expect(
          depegFactory.connect(owner).deployDepeg(params)
        ).to.be.reverted;
      });

      it("Should revert when minPriceAge is too long", async function () {
        const tooLongMinPriceAge = MAX_DURATION + 1; // More than 30 days

        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          dpName: "DP Token Long",
          dpSymbol: "DPL",
          ybName: "YB Token Long",
          ybSymbol: "YBL",
          name: "Long Age Pool",
          flag: "LONGAGE",
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address,
          minPriceAge: tooLongMinPriceAge
        });
        await expect(
          depegFactory.connect(owner).deployDepeg(params)
        ).to.be.reverted;
      });

      it("Should accept minPriceAge at the minimum boundary", async function () {
        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          dpName: "DP Token Min",
          dpSymbol: "DPM",
          ybName: "YB Token Min",
          ybSymbol: "YBM",
          name: "Min Age Pool",
          flag: "MINAGE",
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address,
          minPriceAge: MIN_DURATION // Exactly 4 hours
        });
        await expect(
          depegFactory.connect(owner).deployDepeg(params)
        ).to.not.be.reverted;
      });

      it("Should accept minPriceAge at the maximum boundary", async function () {
        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          dpName: "DP Token Max",
          dpSymbol: "DPMX",
          ybName: "YB Token Max",
          ybSymbol: "YBMX",
          name: "Max Age Pool",
          flag: "MAXAGE",
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address,
          minPriceAge: MAX_DURATION // Exactly 30 days
        });
        await expect(
          depegFactory.connect(owner).deployDepeg(params)
        ).to.not.be.reverted;
      });

    });
  });

  describe("State Management", function () {
    it("Should transition from ACTIVE to COOLDOWN after pool duration", async function () {
      expect(await depegPool.getState()).to.equal(STATE_ACTIVE);
      
      // Fast forward to end of active period
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);
    });

    it("Should remain in ACTIVE state if duration not elapsed", async function () {
      await time.increase(POOL_ACTIVE_DURATION - 1000);
      expect(await depegPool.getState()).to.equal(STATE_ACTIVE);
    });

    it("Should transition from COOLDOWN to RESOLUTION after cooldown duration when price data is updated", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);

      // Oracle updates price data using impersonation
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move past cooldown
      await time.increase(COOLDOWN_DURATION + 1);
      
      expect(await depegPool.getState()).to.equal(STATE_RESOLUTION);
    });

    it("Should transition from RESOLUTION to REDEMPTIONS after min price age & resolution price set", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Oracle updates price data
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION
      await time.increase(COOLDOWN_DURATION + 1);
      expect(await depegPool.getState()).to.equal(STATE_RESOLUTION);

      // Wait for min price age and resolve
      await time.increase(MIN_PRICE_AGE + 1);
      await depegPool.resolvePriceDepeg();

      expect(await depegPool.getState()).to.equal(STATE_REDEMPTIONS);
    });

    it("Should remain in RESOLUTION state if min price age not elapsed", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Wait in cooldown before oracle updates (so we can test price age separately)
      await time.increase(COOLDOWN_DURATION - 1000);
      
      // Oracle updates price data LATE in cooldown
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move just past cooldown to enter RESOLUTION (only 1001 seconds since oracle update)
      await time.increase(1001);
      expect(await depegPool.getState()).to.equal(STATE_RESOLUTION);

      // Trying to resolve should fail since only 1001 seconds have passed since oracle update
      // which is much less than MIN_PRICE_AGE (5 hours = 18000 seconds)
      // priceAge ~= 1001, minRequired = MIN_PRICE_AGE (18000)
      await expect(depegPool.resolvePriceDepeg()).to.be.revertedWithCustomError(depegPool, "PriceDataTooRecent")
      expect(await depegPool.getState()).to.equal(STATE_RESOLUTION);
    });

    it("Should not enter RESOLUTION state if resolution price not set", async function () {
      // Move to COOLDOWN (no oracle price update)
      await time.increase(POOL_ACTIVE_DURATION + 1);
      expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);

      // Move past cooldown without setting price
      await time.increase(COOLDOWN_DURATION + 1);
      
      // Without price data, state cannot be RESOLUTION
      // It will not match any state condition since finalPriceData is not set
      const state = await depegPool.getState();
      expect(state).to.not.equal(STATE_RESOLUTION);
      expect(state).to.not.equal(STATE_REDEMPTIONS);
      
      // Trying to resolve should fail since not in RESOLUTION state
      await expect(depegPool.resolvePriceDepeg())
        .to.be.revertedWithCustomError(depegPool, "MustBeInResolutionState")
        .withArgs(STATE_COOLDOWN);
    });

    it("Should remain in COOLDOWN state if final price data is not set, even after cooldown duration passes", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);

      // Move past cooldown duration WITHOUT oracle setting final price data
      await time.increase(COOLDOWN_DURATION + 100);
      
      // Verify finalPriceData is still not set
      const finalPriceData = await depegPool.finalPriceData();
      expect(finalPriceData.hwmPrice).to.equal(0);
      expect(finalPriceData.resolutionPrice).to.equal(0);
      expect(finalPriceData.timestamp).to.equal(0);
      
      // Pool should still be in COOLDOWN state (not RESOLUTION)
      expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);
      
      // Even if we wait much longer, should remain in COOLDOWN
      await time.increase(COOLDOWN_DURATION * 10);
      expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);
      
      // Trying to resolve should fail
      await expect(depegPool.resolvePriceDepeg())
        .to.be.revertedWithCustomError(depegPool, "MustBeInResolutionState")
        .withArgs(STATE_COOLDOWN);
    });

    it("Should progress to RESOLUTION when final price data is set AFTER cooldown duration has passed", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);

      // Move PAST cooldown duration (without price data)
      await time.increase(COOLDOWN_DURATION + 1000);
      
      // Should still be in COOLDOWN since finalPriceData not set
      expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);
      
      // NOW oracle updates price data (late, after cooldown has already passed)
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);
      
      // Verify finalPriceData is now set
      const finalPriceData = await depegPool.finalPriceData();
      expect(finalPriceData.hwmPrice).to.equal(INITIAL_PRICE);
      expect(finalPriceData.resolutionPrice).to.equal(INITIAL_PRICE);
      expect(finalPriceData.timestamp).to.be.greaterThan(0);
      
      // Pool should NOW be in RESOLUTION state immediately (even though cooldown passed long ago)
      expect(await depegPool.getState()).to.equal(STATE_RESOLUTION);
      
      // Should be able to resolve after minPriceAge passes
      await time.increase(MIN_PRICE_AGE + 1);
      await expect(depegPool.resolvePriceDepeg()).to.not.be.reverted;
      
      // Should now be in REDEMPTIONS state because depeg has been resolved
      expect(await depegPool.getState()).to.equal(STATE_REDEMPTIONS);
    });
  });

  describe("splitToken", function () {
    const SPLIT_AMOUNT = ethers.parseEther("100");

    it("Should split tokens correctly in ACTIVE state", async function () {
      const user1BalanceBefore = await baseAsset.balanceOf(user1.address);
      // approval given in beforeEach
      
      await depegPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT);

      const user1BalanceAfter = await baseAsset.balanceOf(user1.address);
      const dpBalance = await dpToken.balanceOf(user1.address);
      const ybBalance = await ybToken.balanceOf(user1.address);
      const expectedMintAmount = SPLIT_AMOUNT / 2n;

      expect(user1BalanceBefore - user1BalanceAfter).to.equal(SPLIT_AMOUNT);
      expect(dpBalance).to.equal(expectedMintAmount);
      expect(ybBalance).to.equal(expectedMintAmount);
    });

    it("Should emit SplitToken event", async function () {
      await expect(depegPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT))
        .to.emit(depegPool, "SplitToken")
        .withArgs(user1.address, SPLIT_AMOUNT);
    });

    it("Should revert when splitting zero amount", async function () {
      await expect(
        depegPool.connect(user1).splitToken(user1.address, 0)
      ).to.be.reverted;
    });

    it("Should revert when not in ACTIVE state", async function () {
      // Move to COOLDOWN state
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      await expect(
        depegPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT)
      ).to.be.reverted;
    });

    it("Should revert when paused", async function () {
      await depegPool.connect(owner).pause();
      
      await expect(
        depegPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT)
      ).to.be.reverted;
    });

    it("Should not revert after unpausing", async function () {
      await depegPool.connect(owner).pause();
      await depegPool.connect(owner).unpause();
      
      await expect(
        depegPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT)
      ).to.not.be.reverted;
    });

    it("Should handle odd amounts correctly (rounding down)", async function () {
      const oddAmount = 99n;
      await depegPool.connect(user1).splitToken(user1.address, oddAmount);

      const dpBalance = await dpToken.balanceOf(user1.address);
      const ybBalance = await ybToken.balanceOf(user1.address);
      const expectedMintAmount = 49n; // Rounds down

      expect(dpBalance).to.equal(expectedMintAmount);
      expect(ybBalance).to.equal(expectedMintAmount);
    });

    it("Should not allow splitting a different counterparty's tokens", async function () {
      await expect(
        depegPool.connect(user1).splitToken(user2.address, SPLIT_AMOUNT)
      ).to.be.reverted;
    });

    it("Should allow an authorised router to split a different counterparty's tokens", async function () {
      await depegPool.connect(owner).splitToken(user2.address, SPLIT_AMOUNT); // owner was set as the authorised router
      const dpBalance = await dpToken.balanceOf(user2.address);
      const ybBalance = await ybToken.balanceOf(user2.address);
      const expectedMintAmount = SPLIT_AMOUNT / 2n;
      expect(dpBalance).to.equal(expectedMintAmount);
      expect(ybBalance).to.equal(expectedMintAmount);
    });
  });

  describe("unSplitTokens", function () {
    const SPLIT_AMOUNT = ethers.parseEther("100");
    const UNSPLIT_AMOUNT = SPLIT_AMOUNT / 2n;

    beforeEach(async function () {
      // First split tokens
      await depegPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT);
      
      // Approve DP and YB tokens for pool
      await dpToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
    });

    it("Should unsplit tokens correctly", async function () {
      const baseBalanceBefore = await baseAsset.balanceOf(user1.address);
      const dpBalanceBefore = await dpToken.balanceOf(user1.address);
      const ybBalanceBefore = await ybToken.balanceOf(user1.address);

      await depegPool.connect(user1).unSplitTokens(user1.address, UNSPLIT_AMOUNT);

      const baseBalanceAfter = await baseAsset.balanceOf(user1.address);
      const dpBalanceAfter = await dpToken.balanceOf(user1.address);
      const ybBalanceAfter = await ybToken.balanceOf(user1.address);

      expect(dpBalanceBefore - dpBalanceAfter).to.equal(UNSPLIT_AMOUNT);
      expect(ybBalanceBefore - ybBalanceAfter).to.equal(UNSPLIT_AMOUNT);
      expect(baseBalanceAfter).to.be.greaterThan(baseBalanceBefore); // weak test case
      const fees = (UNSPLIT_AMOUNT * 2n) * BigInt(REDEMPTION_FEE_BP) / BigInt(BP_IN_INTEGER);
      expect(baseBalanceAfter-baseBalanceBefore).to.equal(UNSPLIT_AMOUNT * 2n - fees); // strong test case
    });

    it("Should emit UnSplitTokens event", async function () {
      await expect(depegPool.connect(user1).unSplitTokens(user1.address, UNSPLIT_AMOUNT))
        .to.emit(depegPool, "UnSplitTokens");
    });

    it("Should revert when unsplitting zero amount", async function () {
      await expect(
        depegPool.connect(user1).unSplitTokens(user1.address, 0)
      ).to.be.reverted;
    });

    it("Should revert when not in ACTIVE state", async function () {
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      await expect(
        depegPool.connect(user1).unSplitTokens(user1.address, UNSPLIT_AMOUNT)
      ).to.be.reverted;
    });


    it("Should revert when not called by counterparty or authorised router", async function () {
      await expect(
        depegPool.connect(nonAuthorized).unSplitTokens(user1.address, UNSPLIT_AMOUNT)
      ).to.be.reverted;
    });

    it("Should allow an authorised router to unsplit a different counterparty's tokens", async function () {
      const baseBalanceBefore = await baseAsset.balanceOf(user1.address);
      await depegPool.connect(owner).unSplitTokens(user1.address, UNSPLIT_AMOUNT); // owner was set as the authorised router
      const baseBalanceAfter = await baseAsset.balanceOf(user1.address);
      expect(baseBalanceAfter-baseBalanceBefore).to.greaterThan(0n); // weak test case
    });
  });

  describe("Admin & Operator Functions", function () {
    describe("setRedemptionFeeBp", function () {
      it("Should allow admin to set redemption fee", async function () {
        const newFee = 231;
        await depegPool.connect(owner).setRedemptionFeeBp(newFee);
        expect(await depegPool.redemptionFeeBp()).to.equal(newFee);
      });

      it("Should allow operator to set redemption fee", async function () {
        const newFee = 231;
        await depegPool.connect(operator).setRedemptionFeeBp(newFee);
        expect(await depegPool.redemptionFeeBp()).to.equal(newFee);
      });

      it("Should revert when non-authorized user tries to set fee", async function () {
        await expect(
          depegPool.connect(nonAuthorized).setRedemptionFeeBp(20)
        ).to.be.revertedWithCustomError(depegPool, "UnauthorizedCaller")
          .withArgs(nonAuthorized.address);
      });

      it("Should emit RedemptionFeeBpUpdated event", async function () {
        const newFee = 231;
        await expect(depegPool.connect(owner).setRedemptionFeeBp(newFee))
          .to.emit(depegPool, "RedemptionFeeBpUpdated")
          .withArgs(newFee);
      });

      it("Should accept a zero redemption fee", async function () {
        await depegPool.connect(owner).setRedemptionFeeBp(0);
        expect(await depegPool.redemptionFeeBp()).to.equal(0);
      });

      it("Should reject when redemption fee is too high", async function () {
        await expect(
          depegPool.connect(owner).setRedemptionFeeBp(256)
        ).to.be.rejected;
      });

    });

    describe("setCooldownDuration", function () {
      it("Should allow admin to set cooldown duration", async function () {
        const newCooldown = 6 * 60 * 60; // 6 hours
        await depegPool.connect(owner).setCooldownDuration(newCooldown);
        expect(await depegPool.cooldownDuration()).to.equal(newCooldown);
      });

      it("Should revert when cooldown is too short", async function () {
        const MIN_DURATION = await depegPool.MIN_DURATION();
        const MAX_DURATION = await depegPool.MAX_DURATION();
        const tooShort = MIN_DURATION - 1n;
        await expect(
          depegPool.connect(owner).setCooldownDuration(tooShort)
        ).to.be.revertedWithCustomError(depegPool, "CooldownOutOfBounds")
          .withArgs(tooShort, MIN_DURATION, MAX_DURATION);
      });

      it("Should revert when cooldown is too long", async function () {
        const MIN_DURATION = await depegPool.MIN_DURATION();
        const MAX_DURATION = await depegPool.MAX_DURATION();
        const tooLong = MAX_DURATION + 1n;
        await expect(
          depegPool.connect(owner).setCooldownDuration(tooLong)
        ).to.be.revertedWithCustomError(depegPool, "CooldownOutOfBounds")
          .withArgs(tooLong, MIN_DURATION, MAX_DURATION);
      });

      it("Should revert when operator tries to set cooldown", async function () {
        await expect(
          depegPool.connect(operator).setCooldownDuration(6 * 60 * 60)
        ).to.be.reverted;
      });

      it("Should revert when non-authorized user tries to set cooldown", async function () {
        await expect(
          depegPool.connect(nonAuthorized).setCooldownDuration(6 * 60 * 60)
        ).to.be.reverted;
      });

      it("Should emit CooldownDurationUpdated event", async function () {
        const newCooldown = 6 * 60 * 60;
        await expect(depegPool.connect(owner).setCooldownDuration(newCooldown))
          .to.emit(depegPool, "CooldownDurationUpdated")
          .withArgs(newCooldown);
      });

      it("Should revert when setting cooldown duration when not in ACTIVE state", async function () {
        // Move to COOLDOWN state
        await time.increase(POOL_ACTIVE_DURATION + 1);
        expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);

        // Attempt to change cooldownDuration should fail
        await expect(
          depegPool.connect(owner).setCooldownDuration(6 * 60 * 60)
        ).to.be.revertedWithCustomError(depegPool, "MustBeInActiveState")
          .withArgs(STATE_COOLDOWN);

        // Oracle updates price data using impersonation
        const oracleAddr = await depegPool.oracle();
        await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
        await ethers.provider.send("hardhat_setBalance", [oracleAddr, "0xDE0B6B3A7640000"]); // 1 ETH
        const oracleSigner = await ethers.getSigner(oracleAddr);
        await depegPool.connect(oracleSigner).updatePriceData(ethers.parseEther("1.0"), ethers.parseEther("0.9"));
        await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

        // Move past cooldown duration to RESOLUTION
        await time.increase(COOLDOWN_DURATION + 1);
        expect(await depegPool.getState()).to.equal(STATE_RESOLUTION);

        // Attempt to change cooldownDuration should fail
        await expect(
          depegPool.connect(owner).setCooldownDuration(6 * 60 * 60)
        ).to.be.revertedWithCustomError(depegPool, "MustBeInActiveState")
          .withArgs(STATE_RESOLUTION);

        // Move past minPriceAge to RESOLUTION
        await time.increase(MIN_PRICE_AGE);
        expect(await depegPool.getState()).to.equal(STATE_RESOLUTION);

        // Resolve the depeg
        await depegPool.resolvePriceDepeg();
        expect(await depegPool.getState()).to.equal(STATE_REDEMPTIONS);

        // Attempt to change cooldownDuration should fail
        await expect(
          depegPool.connect(owner).setCooldownDuration(6 * 60 * 60)
        ).to.be.revertedWithCustomError(depegPool, "MustBeInActiveState")
          .withArgs(STATE_REDEMPTIONS);
      });
    });

    describe("setMinPriceAge", function () {
      it("Should allow admin to set min price age during ACTIVE state", async function () {
        const newMinAge = 6 * 60 * 60; // 6 hours
        await depegPool.connect(owner).setMinPriceAge(newMinAge);
        expect(await depegPool.minPriceAge()).to.equal(newMinAge);
      });

      it("Should revert when min age is too short", async function () {
        const MIN_DURATION = await depegPool.MIN_DURATION();
        await expect(
          depegPool.connect(owner).setMinPriceAge(MIN_DURATION - 1n)
        ).to.be.reverted;
      });

      it("Should revert when min age is too long", async function () {
        const MAX_DURATION = await depegPool.MAX_DURATION();
        await expect(
          depegPool.connect(owner).setMinPriceAge(MAX_DURATION + 1n)
        ).to.be.reverted;
      });

      it("Should emit MinPriceAgeUpdated event", async function () {
        const newMinAge = 6 * 60 * 60;
        await expect(depegPool.connect(owner).setMinPriceAge(newMinAge))
          .to.emit(depegPool, "MinPriceAgeUpdated")
          .withArgs(newMinAge);
      });

      it("Should revert when non-authorized user tries to set min price age", async function () {
        await expect(
          depegPool.connect(nonAuthorized).setMinPriceAge(6 * 60 * 60)
        ).to.be.reverted;
      });

      it("Should revert when operator tries to set min price age", async function () {
        await expect(
          depegPool.connect(operator).setMinPriceAge(6 * 60 * 60)
        ).to.be.reverted;
      });

      it("Should allow admin to set min price age during COOLDOWN state", async function () {
        // Move to COOLDOWN state
        await time.increase(POOL_ACTIVE_DURATION + 1);
        expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);

        const newMinAge = 6 * 60 * 60; // 6 hours
        await depegPool.connect(owner).setMinPriceAge(newMinAge);
        expect(await depegPool.minPriceAge()).to.equal(newMinAge);
      });

      it("Should revert when setting min price age during RESOLUTION state", async function () {
        // Move to COOLDOWN state
        await time.increase(POOL_ACTIVE_DURATION + 1);
        expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);

        // Oracle updates price data using impersonation
        const oracleAddr = await depegPool.oracle();
        await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
        const oracleSigner = await ethers.getSigner(oracleAddr);
        await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
        await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
        await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

        // Move past cooldown to RESOLUTION
        await time.increase(COOLDOWN_DURATION + 1);
        expect(await depegPool.getState()).to.equal(STATE_RESOLUTION);

        // Attempt to change minPriceAge should fail
        await expect(
          depegPool.connect(owner).setMinPriceAge(6 * 60 * 60)
        ).to.be.revertedWithCustomError(depegPool, "MustBeInActiveOrCooldownState")
          .withArgs(STATE_RESOLUTION);
      });

      it("Should revert when setting min price age during REDEMPTIONS state", async function () {
        // Move to COOLDOWN state
        await time.increase(POOL_ACTIVE_DURATION + 1);
        expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);

        // Oracle updates price data using impersonation
        const oracleAddr = await depegPool.oracle();
        await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
        const oracleSigner = await ethers.getSigner(oracleAddr);
        await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
        await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
        await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

        // Move past cooldown to RESOLUTION
        await time.increase(COOLDOWN_DURATION + 1);
        expect(await depegPool.getState()).to.equal(STATE_RESOLUTION);

        // Wait for min price age and resolve depeg
        await time.increase(MIN_PRICE_AGE + 1);
        await depegPool.resolvePriceDepeg();
        expect(await depegPool.getState()).to.equal(STATE_REDEMPTIONS);

        // Attempt to change minPriceAge should fail
        await expect(
          depegPool.connect(owner).setMinPriceAge(6 * 60 * 60)
        ).to.be.revertedWithCustomError(depegPool, "MustBeInActiveOrCooldownState")
          .withArgs(STATE_REDEMPTIONS);
      });
    });

    describe("pause/unpause", function () {
      it("Should allow admin to pause", async function () {
        await depegPool.connect(owner).pause();
        expect(await depegPool.paused()).to.be.true;
      });

      it("Should allow operator to pause", async function () {
        await depegPool.connect(operator).pause();
        expect(await depegPool.paused()).to.be.true;
      });

      it("Should allow admin to unpause", async function () {
        await depegPool.connect(owner).pause();
        await depegPool.connect(owner).unpause();
        expect(await depegPool.paused()).to.be.false;
      });

      it("Should not allow operator to unpause", async function () {
        await depegPool.connect(owner).pause();
        
        await expect(
          depegPool.connect(operator).unpause()
        ).to.be.reverted;
        
        await depegPool.connect(owner).unpause();
        expect(await depegPool.paused()).to.be.false;
      });

      it("Should prevent operations when paused", async function () {
        await depegPool.connect(owner).pause();
        
        await expect(
          depegPool.connect(user1).splitToken(user1.address, ethers.parseEther("100"))
        ).to.be.reverted;
        await expect(
          depegPool.connect(user1).unSplitTokens(user1.address, ethers.parseEther("100"))
        ).to.be.reverted;
        await expect(
          depegPool.connect(user1).redeemTokens(user1.address, ethers.parseEther("100"), ethers.parseEther("100"))
        ).to.be.reverted;
      });

      it("Should record last pause timestamp", async function () {
        // Check it records first ts correctly
        await depegPool.connect(owner).pause();
        const lastPauseTimestamp = await depegPool.lastPauseTimestamp();
        const currentBlock = await ethers.provider.getBlock("latest");
        expect(lastPauseTimestamp).to.be.closeTo(currentBlock!.timestamp, 5);
        // Check the ts resets to max uint256 on unpause
        await depegPool.connect(owner).unpause();
        const lastPauseTimestampAfter = await depegPool.lastPauseTimestamp();
        expect(lastPauseTimestampAfter).to.equal(ethers.MaxUint256);
        // Fast forward 1h
        await time.increase(3600);
        // Check it records new ts correctly
        await depegPool.connect(owner).pause();
        const lastPauseTimestampAfter2 = await depegPool.lastPauseTimestamp();
        const currentBlock2 = await ethers.provider.getBlock("latest");
        expect(lastPauseTimestampAfter2).to.be.closeTo(currentBlock2!.timestamp, 5);
      });
    });

    describe("rescueErc20", function () {
      it("Should allow rescuing non-core tokens immediately", async function () {
        // Deploy a random ERC20
        const MockERC20 = await ethers.getContractFactory("WtETHMock");
        const randomToken: any = await MockERC20.deploy();
        
        // Send some tokens to pool
        await randomToken.mint(await depegPool.getAddress(), ethers.parseEther("100"));
        
        const treasuryBalanceBefore = await randomToken.balanceOf(treasury.address);
        await depegPool.connect(owner).rescueErc20(await randomToken.getAddress(), ethers.parseEther("100"));
        const treasuryBalanceAfter = await randomToken.balanceOf(treasury.address);
        
        expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(ethers.parseEther("100"));
      });

      it("Should prevent rescuing core tokens too early", async function () {
        // Move to just after RESOLUTION start
        await time.increase(POOL_ACTIVE_DURATION + COOLDOWN_DURATION + 1);
        
        // Mint some base tokens to pool for testing
        await baseAsset.mint(await depegPool.getAddress(), ethers.parseEther("100"));
        
        await expect(
          depegPool.connect(owner).rescueErc20(await baseAsset.getAddress(), ethers.parseEther("1"))
        ).to.be.reverted;
      });

      it("Should allow rescuing core tokens 30 days after resolution", async function () {
        // Move to 30 days after resolution start
        await time.increase(POOL_ACTIVE_DURATION + COOLDOWN_DURATION + 30 * 24 * 60 * 60 + 1);
        
        // Mint some base tokens to pool for testing
        await baseAsset.mint(await depegPool.getAddress(), ethers.parseEther("100"));
        
        await expect(
          depegPool.connect(owner).rescueErc20(await baseAsset.getAddress(), ethers.parseEther("1"))
        ).to.not.be.reverted;
      });

      it("Should not overflow when lastPauseTimestamp is max uint256 (never paused)", async function () {
        // This test verifies that the rescue function doesn't cause arithmetic overflow
        // when lastPauseTimestamp is initialized to type(uint256).max (pool never paused)
        // The condition `block.timestamp < lastPauseTimestamp + 30 days` would overflow
        // if evaluated incorrectly, but Solidity's short-circuit evaluation prevents this
        // when the first condition (resolution time check) passes.

        // Move to 30 days after resolution start - first condition should pass
        await time.increase(POOL_ACTIVE_DURATION + COOLDOWN_DURATION + 30 * 24 * 60 * 60 + 1);

        // Verify pool was never paused (lastPauseTimestamp should be max uint256)
        const lastPauseTimestamp = await depegPool.lastPauseTimestamp();
        expect(lastPauseTimestamp).to.equal(ethers.MaxUint256);

        // Mint some base tokens to pool for testing
        await baseAsset.mint(await depegPool.getAddress(), ethers.parseEther("100"));

        // This should NOT revert with arithmetic overflow - the short-circuit evaluation
        // in the && condition should prevent the overflow from being triggered
        await expect(
          depegPool.connect(owner).rescueErc20(await baseAsset.getAddress(), ethers.parseEther("1"))
        ).to.not.be.reverted;
      });

      it("Should revert when rescuing zero amount", async function () {
        const MockERC20 = await ethers.getContractFactory("WtETHMock");
        const randomToken: any = await MockERC20.deploy();
        
        await expect(
          depegPool.connect(owner).rescueErc20(await randomToken.getAddress(), 0)
        ).to.be.revertedWithCustomError(depegPool, "ZeroAmount");
      });

      it("Should revert when trying to rescue a zero token", async function () {
        await expect(
          depegPool.connect(owner).rescueErc20(ethers.ZeroAddress, ethers.parseEther("1"))
        ).to.be.revertedWithCustomError(depegPool, "ZeroAddress");
      });
    });
  });

  describe("Oracle Management", function () {
    let newMockOracle: any;

    beforeEach(async function () {
      // Deploy a new mock oracle
      const SimpleMockOracle = await ethers.getContractFactory("SimpleMockOracle");
      newMockOracle = await SimpleMockOracle.deploy();
    });

    describe("proposeOracleChange", function () {
      it("Should allow admin to propose oracle change", async function () {
        const newOracleAddr = await newMockOracle.getAddress();
        const depegPoolAddr = await depegPool.getAddress();
        
        // Set the depegPool address on the mock oracle so validation passes
        await newMockOracle.setDepegPool(depegPoolAddr);
        
        await expect(
          depegPool.connect(owner).proposeOracleChange(newOracleAddr)
        ).to.not.be.reverted;

        expect(await depegPool.pendingOracle()).to.equal(newOracleAddr);
      });

      it("Should set the oracleChangeTimestamp correctly into the future", async function () {
        const newOracleAddr = await newMockOracle.getAddress();
        const depegPoolAddr = await depegPool.getAddress();
        
        // Set the depegPool address on the mock oracle so validation passes
        await newMockOracle.setDepegPool(depegPoolAddr);
        
        await depegPool.connect(owner).proposeOracleChange(newOracleAddr);
        const currentBlock = await ethers.provider.getBlock("latest");
        expect(await depegPool.oracleChangeTimestamp()).to.be.closeTo(currentBlock!.timestamp + ORACLE_CHANGE_DELAY, 5);
      });

      it("Should revert when proposing zero address", async function () {
        await expect(
          depegPool.connect(owner).proposeOracleChange(ethers.ZeroAddress)
        ).to.be.reverted;
      });

      it("Should revert when proposing non-contract address", async function () {
        await expect(
          depegPool.connect(owner).proposeOracleChange(user1.address)
        ).to.be.reverted;
      });

      it("Should revert when operator tries to propose", async function () {
        const newOracleAddr = await newMockOracle.getAddress();
        
        await expect(
          depegPool.connect(operator).proposeOracleChange(newOracleAddr)
        ).to.be.reverted;
      });

      it("Should revert when non-authorized user tries to propose", async function () {
        const newOracleAddr = await newMockOracle.getAddress();
        
        await expect(
          depegPool.connect(nonAuthorized).proposeOracleChange(newOracleAddr)
        ).to.be.reverted;
      });
    });

    describe("executeOracleChange", function () {
      it("Should revert when no oracle change pending", async function () {
        await expect(
          depegPool.connect(owner).executeOracleChange()
        ).to.be.reverted;
      });

      it("Should revert when timelock not expired", async function () {
        const newOracleAddr = await newMockOracle.getAddress();
        const depegPoolAddr = await depegPool.getAddress();
        
        // Set the depegPool address on the mock oracle so validation passes
        await newMockOracle.setDepegPool(depegPoolAddr);
        
        await depegPool.connect(owner).proposeOracleChange(newOracleAddr);
        
        // Try to execute immediately
        await expect(
          depegPool.connect(owner).executeOracleChange()
        ).to.be.reverted;

        // Wait some time but not enough
        await time.increase(ORACLE_CHANGE_DELAY - 10);
        
        await expect(
          depegPool.connect(owner).executeOracleChange()
        ).to.be.reverted;
      });

      it("Should not revert when timelock has expired", async function () {
        const newOracleAddr = await newMockOracle.getAddress();
        const depegPoolAddr = await depegPool.getAddress();
        
        // Set the depegPool address on the mock oracle so validation passes
        await newMockOracle.setDepegPool(depegPoolAddr);
        
        await depegPool.connect(owner).proposeOracleChange(newOracleAddr);
        
        // Wait for timelock to expire
        await time.increase(ORACLE_CHANGE_DELAY + 1);
        
        await expect(
          depegPool.connect(owner).executeOracleChange()
        ).to.not.be.reverted;

        expect(await depegPool.oracle()).to.equal(newOracleAddr);
        expect(await depegPool.pendingOracle()).to.equal(ethers.ZeroAddress);
      });

      it("Should allow anyone to execute oracle change", async function () {
        const newOracleAddr = await newMockOracle.getAddress();
        const depegPoolAddr = await depegPool.getAddress();
        
        // Set the depegPool address on the mock oracle so validation passes
        await newMockOracle.setDepegPool(depegPoolAddr);
        
        await depegPool.connect(owner).proposeOracleChange(newOracleAddr);
        
        // Wait for timelock to expire
        await time.increase(ORACLE_CHANGE_DELAY + 1);
        
        // Non-authorized user can execute
        await expect(
          depegPool.connect(nonAuthorized).executeOracleChange()
        ).to.not.be.reverted;

        expect(await depegPool.oracle()).to.equal(newOracleAddr);
      });

      it("Should reject trying to execute oracle change twice", async function () {
        const newOracleAddr = await newMockOracle.getAddress();
        const depegPoolAddr = await depegPool.getAddress();
        
        // Set the depegPool address on the mock oracle so validation passes
        await newMockOracle.setDepegPool(depegPoolAddr);
        
        await depegPool.connect(owner).proposeOracleChange(newOracleAddr);
        
        // Wait for timelock to expire
        await time.increase(ORACLE_CHANGE_DELAY + 1);
        
        // Execute once
        await depegPool.connect(owner).executeOracleChange();
        
        // Try to execute again
        await expect(
          depegPool.connect(owner).executeOracleChange()
        ).to.be.reverted;
      });
    });

    describe("Cross-Domain Oracle Calls (L2)", function () {
      let l2Pool: any;
      let mockMessenger: any;
      let l2MockOracle: any;

      beforeEach(async function () {
        // Deploy mock cross-domain messenger
        const MockCrossDomainMessenger = await ethers.getContractFactory("MockCrossDomainMessenger");
        mockMessenger = await MockCrossDomainMessenger.deploy();

        // Deploy a new mock oracle for L2 testing
        const SimpleMockOracle = await ethers.getContractFactory("SimpleMockOracle");
        l2MockOracle = await SimpleMockOracle.deploy();

        // Deploy a new pool with xDomainMessenger set
        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          dpName: "DP L2",
          dpSymbol: "DPL2",
          ybName: "YB L2",
          ybSymbol: "YBL2",
          name: "L2 Test Pool",
          flag: "L2TEST",
          oracle: await l2MockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address,
          xDomainMessengerL2: await mockMessenger.getAddress()
        });
        await depegFactory.deployDepeg(params);

        // Get the newly deployed L2 pool (it will be at the last index)
        const moduleCount = await depegFactory.getDepegModule(0); // Get first to know structure
        const l2Module = await depegFactory.getDepegModule(1); // Second pool
        l2Pool = await ethers.getContractAt("DepegPool", l2Module.depegPool);

        // Grant roles
        await l2Pool.connect(owner).grantRole(await l2Pool.OPERATOR_ROLE(), operator.address);
      });

      describe("updatePriceData via xDomain", function () {
        beforeEach(async function () {
          // Move pool to COOLDOWN state
          await time.increase(POOL_ACTIVE_DURATION + 1);
        });

        it("Should allow oracle to update price data via cross-domain messenger", async function () {
          const hwmPrice = ethers.parseEther("1.2");
          const resolutionPrice = ethers.parseEther("1.1");
          
          // Set the L1 sender to be the oracle
          await mockMessenger.setXDomainMessageSender(await l2MockOracle.getAddress());

          // Impersonate the messenger to simulate cross-chain call
          await ethers.provider.send("hardhat_impersonateAccount", [await mockMessenger.getAddress()]);
          await ethers.provider.send("hardhat_setBalance", [
            await mockMessenger.getAddress(),
            "0x" + ethers.parseEther("10.0").toString(16)
          ]);
          
          const messengerSigner = await ethers.getSigner(await mockMessenger.getAddress());
          
          // Call updatePriceData from the messenger
          await l2Pool.connect(messengerSigner).updatePriceData(hwmPrice, resolutionPrice);
          
          await ethers.provider.send("hardhat_stopImpersonatingAccount", [await mockMessenger.getAddress()]);

          // Verify the pool is now in RESOLUTION state
          expect(await l2Pool.getState()).to.equal(2); // RESOLUTION state
          const finalPriceData = await l2Pool.finalPriceData();
          expect(finalPriceData.hwmPrice).to.equal(hwmPrice);
          expect(finalPriceData.resolutionPrice).to.equal(resolutionPrice);
        });

        it("Should revert when called directly by oracle (not via messenger)", async function () {
          const hwmPrice = ethers.parseEther("1.2");
          const resolutionPrice = ethers.parseEther("1.1");

          // Try to call directly (should fail)
          await expect(
            l2Pool.connect(owner).updatePriceData(hwmPrice, resolutionPrice)
          ).to.be.revertedWithCustomError(l2Pool, "UnauthorizedCaller")
            .withArgs(owner.address);
        });

        it("Should revert when called via messenger but wrong L1 sender", async function () {
          const hwmPrice = ethers.parseEther("1.2");
          const resolutionPrice = ethers.parseEther("1.1");
          
          // Set the L1 sender to be a non-oracle address
          await mockMessenger.setXDomainMessageSender(user1.address);

          // Impersonate the messenger
          await ethers.provider.send("hardhat_impersonateAccount", [await mockMessenger.getAddress()]);
          await ethers.provider.send("hardhat_setBalance", [
            await mockMessenger.getAddress(),
            "0x" + ethers.parseEther("10.0").toString(16)
          ]);
          
          const messengerSigner = await ethers.getSigner(await mockMessenger.getAddress());

          // Try to call via messenger with wrong L1 sender
          await expect(
            l2Pool.connect(messengerSigner).updatePriceData(hwmPrice, resolutionPrice)
          ).to.be.revertedWithCustomError(l2Pool, "UnauthorizedCaller")
            .withArgs(await mockMessenger.getAddress());
          
          await ethers.provider.send("hardhat_stopImpersonatingAccount", [await mockMessenger.getAddress()]);
        });

        it("Should revert when called from non-messenger contract", async function () {
          const hwmPrice = ethers.parseEther("1.2");
          const resolutionPrice = ethers.parseEther("1.1");

          // Try to call from a different address (not the messenger)
          await expect(
            l2Pool.updatePriceData(hwmPrice, resolutionPrice)
          ).to.be.revertedWithCustomError(l2Pool, "UnauthorizedCaller")
            .withArgs(owner.address);
        });
      });

      describe("L2 vs L1 mode comparison", function () {
        it("Should use L1 mode (direct oracle calls) when xDomainMessenger is zero address", async function () {
          // The original depegPool has zero address for xDomainMessenger
          expect(await depegPool.xDomainMessengerL2()).to.equal(ethers.ZeroAddress);

          // Move to COOLDOWN state
          await time.increase(POOL_ACTIVE_DURATION + 1);
          expect(await depegPool.getState()).to.equal(STATE_COOLDOWN);

          // Should allow direct call from oracle in L1 mode
          const oracleAddr = await depegPool.oracle();
          await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
          const oracleSigner = await ethers.getSigner(oracleAddr);
          await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1.0") });

          const hwmPrice = ethers.parseEther("1.0");
          const resolutionPrice = ethers.parseEther("0.9");

          await expect(
            depegPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice)
          ).to.not.be.reverted;

          const finalPriceData = await depegPool.finalPriceData();
          expect(finalPriceData.hwmPrice).to.equal(hwmPrice);
          expect(finalPriceData.resolutionPrice).to.equal(resolutionPrice);

          await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);
        });

        it("Should use L2 mode (cross-domain calls) when xDomainMessenger is set", async function () {
          // The l2Pool has messenger address set
          expect(await l2Pool.xDomainMessengerL2()).to.equal(await mockMessenger.getAddress());

          // Move to COOLDOWN state
          await time.increase(POOL_ACTIVE_DURATION + 1);
          expect(await l2Pool.getState()).to.equal(STATE_COOLDOWN);

          const hwmPrice = ethers.parseEther("1.0");
          const resolutionPrice = ethers.parseEther("0.9");

          // Should NOT allow direct call from oracle in L2 mode
          await expect(
            l2Pool.updatePriceData(hwmPrice, resolutionPrice)
          ).to.be.revertedWithCustomError(l2Pool, "UnauthorizedCaller")
            .withArgs(owner.address);
        });
      });
    });
  });

  describe("Redemption Flow", function () {
    const SPLIT_AMOUNT = ethers.parseEther("1000");

    beforeEach(async function () {
      // User1 splits tokens
      await depegPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT);
      
      // Approve tokens
      await dpToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
    });

    it("Should revert redemption when not in REDEMPTIONS state", async function () {
      await expect(
        depegPool.connect(user1).redeemTokens(
          user1.address,
          ethers.parseEther("100"),
          ethers.parseEther("100")
        )
      ).to.be.reverted;
    });

    it("Should revert when not called by counterparty or authorised router", async function () {
      await expect(
        depegPool.connect(nonAuthorized).redeemTokens(
          user1.address,
          ethers.parseEther("100"),
          ethers.parseEther("100")
        )
      ).to.be.reverted;
    });

    it("Should allow an authorised router to redeem tokens for a different counterparty", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Oracle updates price data
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to REDEMPTIONS
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();

      const dpBalance = await dpToken.balanceOf(user1.address);
      const ybBalance = await ybToken.balanceOf(user1.address);
      
      // Owner (authorised router) redeems for user1
      await expect(
        depegPool.connect(owner).redeemTokens(user1.address, dpBalance, ybBalance)
      ).to.not.be.reverted;
    });

    it("Should should return 1:1 when no depeg occurred", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Oracle updates price data (no depeg)
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to REDEMPTIONS
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();

      const dpBalance = await dpToken.balanceOf(user1.address);
      const ybBalance = await ybToken.balanceOf(user1.address);
      
      const baseBalanceBefore = await baseAsset.balanceOf(user1.address);
      await depegPool.connect(user1).redeemTokens(user1.address, dpBalance, ybBalance);
      const baseBalanceAfter = await baseAsset.balanceOf(user1.address);
      const baseReturned = baseBalanceAfter - baseBalanceBefore;

      // Should return 1:1 minus redemption fee
      const totalRedeemed = dpBalance + ybBalance;
      // Redemption fee = totalRedeemed * redemptionFeeBp / BP_IN_INTEGER
      const redemptionFee = (totalRedeemed * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      const expectedReturn = totalRedeemed - redemptionFee;
      
      expect(baseReturned).to.equal(expectedReturn);
    });

    it("Should return correctly if a depeg has occurred", async function () {
      // User2 also splits to have YB holder
      await depegPool.connect(user2).splitToken(user2.address, SPLIT_AMOUNT);
      const user1DpBalance = await dpToken.balanceOf(user1.address);
      const user2YbBalance = await ybToken.balanceOf(user2.address);
      
      // Approve tokens
      await dpToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(user2).approve(await depegPool.getAddress(), ethers.MaxUint256);

      // Move to COOLDOWN with 15% depeg
      await time.increase(POOL_ACTIVE_DURATION + 1);
      const hwmPrice = INITIAL_PRICE;
      const resolutionPrice = (INITIAL_PRICE * 85n) / 100n; // 15% depeg
      
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to REDEMPTIONS
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();
      
      expect(await depegPool.poolHasDepegged()).to.be.true;

      // User1 redeems DP (should gain)
      const user1BaseBalanceBefore = await baseAsset.balanceOf(user1.address);
      await depegPool.connect(user1).redeemTokens(user1.address, user1DpBalance, 0);
      const user1BaseBalanceAfter = await baseAsset.balanceOf(user1.address);
      const user1Return = user1BaseBalanceAfter - user1BaseBalanceBefore;
      
      // User2 redeems YB (should lose)
      const user2BaseBalanceBefore = await baseAsset.balanceOf(user2.address);
      await depegPool.connect(user2).redeemTokens(user2.address, 0, user2YbBalance);
      const user2BaseBalanceAfter = await baseAsset.balanceOf(user2.address);
      const user2Return = user2BaseBalanceAfter - user2BaseBalanceBefore;

      // DP should be worth more than face value
      expect(user1Return).to.be.greaterThan(user1DpBalance);
      // YB should be worth less than face value  
      expect(user2Return).to.be.lessThan(user2YbBalance);
    });

    it("Should work even with zero DP or YB tokens", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Oracle updates price data
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to REDEMPTIONS
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();

      const firstBaseBalance = await baseAsset.balanceOf(user1.address);
      const dpBalance = await dpToken.balanceOf(user1.address);
      const ybBalance = await ybToken.balanceOf(user1.address);

      // Redeem only DP tokens
      await expect(
        depegPool.connect(user1).redeemTokens(user1.address, dpBalance, 0)
      ).to.not.be.reverted;

      expect(await dpToken.balanceOf(user1.address)).to.equal(0);
      const secondBaseBalance = await baseAsset.balanceOf(user1.address);

      // Redeem only YB tokens
      await expect(
        depegPool.connect(user1).redeemTokens(user1.address, 0, ybBalance)
      ).to.not.be.reverted;

      expect(await ybToken.balanceOf(user1.address)).to.equal(0);
      const thirdBaseBalance = await baseAsset.balanceOf(user1.address);

      expect(thirdBaseBalance).to.be.greaterThan(secondBaseBalance);
      expect(secondBaseBalance).to.be.greaterThan(firstBaseBalance);
    });
  });

  describe("resolvePriceDepeg", function () {
    it("Should revert when not in RESOLUTION state", async function () {
      await expect(
        depegPool.resolvePriceDepeg()
      ).to.be.reverted;
    });

    it("Should revert if finalPriceData is not set", async function () {
        // increase time
        await time.increase(POOL_ACTIVE_DURATION + COOLDOWN_DURATION + 1);
        const finalPriceData = await depegPool.finalPriceData();
        expect(finalPriceData.hwmPrice).to.equal(0);
        expect(finalPriceData.resolutionPrice).to.equal(0);
        expect(finalPriceData.timestamp).to.equal(0);
        await expect(
          depegPool.resolvePriceDepeg()
        ).to.be.reverted;
    });

    it("Should revert if finalPriceData is too recent", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Wait in cooldown before oracle updates
      await time.increase(COOLDOWN_DURATION - 1000);
      
      // Oracle updates price data LATE in cooldown
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move just past cooldown to enter RESOLUTION (only ~1001 seconds since oracle update)
      await time.increase(1001);
      
      // Try to resolve - should fail since only ~1001 seconds have passed since oracle update
      // which is much less than MIN_PRICE_AGE (5 hours = 18000 seconds)
      await expect(depegPool.resolvePriceDepeg()).to.be.revertedWithCustomError(depegPool, "PriceDataTooRecent")
    });

    it("Should set poolHasDepegged to false if no depeg occurred", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Oracle updates price data (no depeg)
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION and resolve
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();

      expect(await depegPool.poolHasDepegged()).to.be.false;
      expect(await depegPool.depegSize()).to.equal(0);
      expect(await depegPool.depegResolved()).to.be.true;
    });

    it("Should set poolHasDepegged to true if depeg occurred", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Oracle updates price data (10% depeg)
      const hwmPrice = INITIAL_PRICE;
      const resolutionPrice = (INITIAL_PRICE * 90n) / 100n;
      
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION and resolve
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();

      expect(await depegPool.poolHasDepegged()).to.be.true;
      expect(await depegPool.depegSize()).to.be.greaterThan(0);
      expect(await depegPool.depegResolved()).to.be.true;
    });

    it("Should correctly calculate depeg size", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Oracle updates price data (5% depeg)
      const hwmPrice = INITIAL_PRICE;
      const resolutionPrice = (INITIAL_PRICE * 95n) / 100n; // 5% depeg = 500 bp
      
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION and resolve
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();

      const depegSize = await depegPool.depegSize();
      expect(depegSize).to.be.closeTo(500, 10); // 5% = 500 bp
    });

    it("Should emit DepegPriceResolved event", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Oracle updates price data
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION and resolve
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      
      await expect(depegPool.resolvePriceDepeg())
        .to.emit(depegPool, "DepegPriceResolved");
    });

    it("Should be callable by anyone", async function () {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Oracle updates price data
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      
      // Non-authorized user can call resolvePriceDepeg
      await expect(depegPool.connect(nonAuthorized).resolvePriceDepeg())
        .to.not.be.reverted;
    });

  });

  describe("sweepFeesToTreasury", function () {
    const SPLIT_AMOUNT = ethers.parseEther("1000");

    beforeEach(async function () {
      // Setup: split and unsplit to generate fees
      await depegPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT);
      
      await dpToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
      await ybToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
      
      await depegPool.connect(user1).unSplitTokens(user1.address, SPLIT_AMOUNT / 2n);
    });

    it("Should revert when not in REDEMPTIONS state", async function () {
      await expect(depegPool.connect(user1).sweepFeesToTreasury())
        .to.be.revertedWithCustomError(depegPool, "MustBeInRedemptionsState")
        .withArgs(STATE_ACTIVE);
    });

    it("Should sweep fees to treasury", async function () {
      // Move to COOLDOWN and set price data
      await time.increase(POOL_ACTIVE_DURATION + 1);
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION and resolve
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();
      
      const treasuryBalanceBefore = await baseAsset.balanceOf(treasury.address);
      const poolBalanceBefore = await baseAsset.balanceOf(await depegPool.getAddress());
      await depegPool.connect(user1).sweepFeesToTreasury();
      const treasuryBalanceAfter = await baseAsset.balanceOf(treasury.address);
      const poolBalanceAfter = await baseAsset.balanceOf(await depegPool.getAddress());
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(poolBalanceBefore - poolBalanceAfter);
      expect(poolBalanceAfter).to.equal(0n);
      expect(treasuryBalanceAfter).to.be.greaterThan(treasuryBalanceBefore);
    });

    it("Should emit TreasuryFeeCollected event", async function () {
      // Move to COOLDOWN and set price data
      await time.increase(POOL_ACTIVE_DURATION + 1);
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION and resolve
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await depegPool.resolvePriceDepeg();
      
      const poolBalance = await baseAsset.balanceOf(await depegPool.getAddress());
      const dpSupply = await dpToken.totalSupply();
      const ybSupply = await ybToken.totalSupply();
      const maxSupply = dpSupply > ybSupply ? dpSupply : ybSupply;
      const feeAmount = poolBalance - maxSupply;
      await expect(depegPool.connect(user1).sweepFeesToTreasury())
        .to.emit(depegPool, "TreasuryFeeCollected")
        .withArgs(feeAmount);
    });

    it("Should not sweep base tokens backing existing DP/YB tokens when no fees have been generated", async function () {
      // Fresh scenario: only splits, no unsplits - therefore no fees generated
      // Note: This test does NOT use the beforeEach setup (which includes unsplits that generate fees)
      
      // Deploy a fresh pool for this test
      const SimpleMockOracle = await ethers.getContractFactory("SimpleMockOracle");
      const freshMockOracle = await SimpleMockOracle.deploy();
      
      const freshParams = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        dpName: "DP Token Fresh",
        dpSymbol: "DPF",
        ybName: "YB Token Fresh",
        ybSymbol: "YBF",
        name: "Fresh Test Pool",
        flag: "FRESH",
        oracle: await freshMockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        authorisedRouter: owner.address
      });
      await depegFactory.deployDepeg(freshParams);
      
      const freshDepegModule = await depegFactory.getDepegModule(1);
      const freshPool = await ethers.getContractAt("DepegPool", freshDepegModule.depegPool);
      const freshDpToken = await ethers.getContractAt("DepegToken", freshDepegModule.dpAsset);
      const freshYbToken = await ethers.getContractAt("DepegToken", freshDepegModule.ybAsset);
      
      // user1 splits tokens but does NOT unsplit - no fees generated
      const SPLIT_AMOUNT = ethers.parseEther("2000");
      await baseAsset.mint(user1.address, SPLIT_AMOUNT);
      await baseAsset.connect(user1).approve(await freshPool.getAddress(), ethers.MaxUint256);
      await freshPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT);
      
      // user1 now has 1000 DP and 1000 YB tokens outstanding (split divides by 2)
      const dpSupply = await freshDpToken.totalSupply();
      const ybSupply = await freshYbToken.totalSupply();
      
      // Verify tokens were minted correctly
      expect(dpSupply).to.equal(SPLIT_AMOUNT / 2n);
      expect(ybSupply).to.equal(SPLIT_AMOUNT / 2n);
      
      const poolBalanceBefore = await baseAsset.balanceOf(await freshPool.getAddress());
      const treasuryBalanceBefore = await baseAsset.balanceOf(treasury.address);
      
      // Pool balance should equal the split amount (all backing, no fees)
      expect(poolBalanceBefore).to.equal(SPLIT_AMOUNT);
      
      // Move fresh pool to COOLDOWN and set price data
      await time.increase(POOL_ACTIVE_DURATION + 1);
      const freshOracleAddr = await freshPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [freshOracleAddr]);
      const freshOracleSigner = await ethers.getSigner(freshOracleAddr);
      await owner.sendTransaction({ to: freshOracleAddr, value: ethers.parseEther("1") });
      await freshPool.connect(freshOracleSigner).updatePriceData(INITIAL_PRICE, INITIAL_PRICE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [freshOracleAddr]);

      // Move to RESOLUTION and resolve to reach REDEMPTIONS state
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await freshPool.resolvePriceDepeg();
      
      // Sweep fees to treasury - should sweep 0 since no fees were generated
      await freshPool.connect(user1).sweepFeesToTreasury();
      
      const poolBalanceAfter = await baseAsset.balanceOf(await freshPool.getAddress());
      const treasuryBalanceAfter = await baseAsset.balanceOf(treasury.address);
      
      // No funds should have been swept - all base tokens are backing existing DP/YB
      const amountSwept = treasuryBalanceAfter - treasuryBalanceBefore;
      expect(amountSwept).to.equal(0n);
      
      // Pool should retain all base tokens since they back outstanding DP/YB tokens
      expect(poolBalanceAfter).to.equal(SPLIT_AMOUNT);
    });

    it("Should correctly calculate fees after depeg with partial redemptions", async function () {
      // This test verifies TAP-1 fix: sweepFeesToTreasury must account for dpValue/ybValue
      // Scenario: 20% depeg, user redeems all YB (leaving DP outstanding)
      // Uses 1% redemption fee to verify fee calculation is correct
      
      const REDEMPTION_FEE = 100; // 1% = 100 basis points
      
      // Deploy a fresh pool
      const SimpleMockOracle = await ethers.getContractFactory("SimpleMockOracle");
      const freshMockOracle = await SimpleMockOracle.deploy();
      
      const freshParams = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        dpName: "DP Token Depeg",
        dpSymbol: "DPD",
        ybName: "YB Token Depeg",
        ybSymbol: "YBD",
        name: "Depeg Test Pool",
        flag: "DEPEG",
        oracle: await freshMockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        authorisedRouter: owner.address,
        redemptionFeeBp: REDEMPTION_FEE // 1% redemption fee
      });
      await depegFactory.deployDepeg(freshParams);
      
      const freshDepegModule = await depegFactory.getDepegModule(1);
      const freshPool = await ethers.getContractAt("DepegPool", freshDepegModule.depegPool);
      const freshDpToken = await ethers.getContractAt("DepegToken", freshDepegModule.dpAsset);
      const freshYbToken = await ethers.getContractAt("DepegToken", freshDepegModule.ybAsset);
      
      // User1 splits 2000 base tokens → gets 1000 DP + 1000 YB
      // Total fee --> 20
      const SPLIT_AMOUNT = ethers.parseEther("2000");
      await baseAsset.mint(user1.address, SPLIT_AMOUNT);
      await baseAsset.connect(user1).approve(await freshPool.getAddress(), ethers.MaxUint256);
      await freshPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT);
      
      // Pool should have 2000 base tokens
      expect(await baseAsset.balanceOf(await freshPool.getAddress())).to.equal(SPLIT_AMOUNT);
      
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Set up 20% depeg: HWM = 1.0, resolution = 0.8
      const hwmPrice = ethers.parseEther("1.0");
      const resolutionPrice = ethers.parseEther("0.8"); // 20% depeg
      
      const freshOracleAddr = await freshPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [freshOracleAddr]);
      const freshOracleSigner = await ethers.getSigner(freshOracleAddr);
      await owner.sendTransaction({ to: freshOracleAddr, value: ethers.parseEther("1") });
      await freshPool.connect(freshOracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [freshOracleAddr]);
      
      // Move to RESOLUTION and resolve
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await freshPool.resolvePriceDepeg();
      
      // Verify depeg occurred
      expect(await freshPool.poolHasDepegged()).to.be.true;
      
      // Get dpValue and ybValue (should be ~12500 and ~7500 for 20% depeg)
      const dpValue = await freshPool.dpValue();
      const ybValue = await freshPool.ybValue();
      
      // dpValue = 10000 * 10000 / 8000 = 12500 (125%)
      // ybValue = 2 * 10000 - 12500 = 7500 (75%)
      expect(dpValue).to.equal(12500);
      expect(ybValue).to.equal(7500);
      
      // User1 redeems all YB tokens, keeps all DP tokens
      // This creates an unbalanced scenario
      await freshDpToken.connect(user1).approve(await freshPool.getAddress(), ethers.MaxUint256);
      await freshYbToken.connect(user1).approve(await freshPool.getAddress(), ethers.MaxUint256);
      
      const dpBalance = await freshDpToken.balanceOf(user1.address);
      const ybBalance = await freshYbToken.balanceOf(user1.address);
      
      // Redeem only YB tokens (all 1000 of them)
      await freshPool.connect(user1).redeemTokens(user1.address, 0, ybBalance);
      
      // YB redemption calculation:
      // Base amount: 1000 YB * 7500 / 10000 = 750 base
      // Fee: 750 * 100 / 10000 = 7.5 base
      // User receives: 750 - 7.5 = 742.5 base
      const ybBaseValue = (ybBalance * ybValue) / BigInt(BP_IN_INTEGER);
      const ybFee = (ybBaseValue * BigInt(REDEMPTION_FEE)) / BigInt(BP_IN_INTEGER);
      expect(ybBaseValue).to.equal(ethers.parseEther("750"));
      expect(ybFee).to.equal(ethers.parseEther("7.5"));
      
      // Pool balance after YB redemption: 2000 - 742.5 = 1257.5 base tokens
      const poolBalanceAfterYbRedemption = await baseAsset.balanceOf(await freshPool.getAddress());
      expect(poolBalanceAfterYbRedemption).to.equal(ethers.parseEther("1257.5"));
      
      // Remaining DP tokens: 1000
      // Required for DP: 1000 * 12500 / 10000 = 1250 base tokens
      const remainingDpSupply = await freshDpToken.totalSupply();
      expect(remainingDpSupply).to.equal(ethers.parseEther("1000"));
      
      const requiredForDp = (remainingDpSupply * dpValue) / BigInt(BP_IN_INTEGER);
      expect(requiredForDp).to.equal(ethers.parseEther("1250"));
      
      // Fees available to sweep: 1257.5 - 1250 = 7.5 base (the redemption fee from YB)
      const expectedFees = poolBalanceAfterYbRedemption - requiredForDp;
      expect(expectedFees).to.equal(ethers.parseEther("7.5"));
      
      const treasuryBalanceBefore = await baseAsset.balanceOf(treasury.address);
      await freshPool.sweepFeesToTreasury();
      const treasuryBalanceAfter = await baseAsset.balanceOf(treasury.address);
      
      // Should sweep exactly 7.5 base tokens (the redemption fee)
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(ethers.parseEther("7.5"));
      
      // Pool should retain exactly 1250 base tokens for remaining 1000 DP tokens
      expect(await baseAsset.balanceOf(await freshPool.getAddress())).to.equal(ethers.parseEther("1250"));
      
      // Verify user can still redeem their DP tokens
      const userBaseBefore = await baseAsset.balanceOf(user1.address);
      await freshPool.connect(user1).redeemTokens(user1.address, dpBalance, 0);
      const userBaseAfter = await baseAsset.balanceOf(user1.address);
      
      // DP redemption: 1000 DP * 12500 / 10000 = 1250 base before fee
      // Fee: 1250 * 100 / 10000 = 12.5 base
      // User receives: 1250 - 12.5 = 1237.5 base
      expect(userBaseAfter - userBaseBefore).to.equal(ethers.parseEther("1237.5"));
      
      // Pool should have 12.5 base left (the DP redemption fee)
      expect(await baseAsset.balanceOf(await freshPool.getAddress())).to.equal(ethers.parseEther("12.5"));
    });

    it("Should correctly handle full depeg scenario (DP=200%, YB=0%)", async function () {
      // This test verifies the exact scenario from the auditor:
      // - Full depeg (100% - each DP token worth 2 base tokens)
      // - User redeems some DP and all YB (YB worth 0)
      // - Contract should only sweep fees, keeping enough for remaining DP redemptions
      // Uses 1% redemption fee
      
      const REDEMPTION_FEE = 100; // 1% = 100 basis points
      
      // Deploy a fresh pool
      const SimpleMockOracle = await ethers.getContractFactory("SimpleMockOracle");
      const freshMockOracle = await SimpleMockOracle.deploy();
      
      const freshParams = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        dpName: "DP Token Full",
        dpSymbol: "DPF",
        ybName: "YB Token Full",
        ybSymbol: "YBF",
        name: "Full Depeg Test Pool",
        flag: "FULL",
        oracle: await freshMockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        authorisedRouter: owner.address,
        redemptionFeeBp: REDEMPTION_FEE // 1% redemption fee
      });
      await depegFactory.deployDepeg(freshParams);
      
      const freshDepegModule = await depegFactory.getDepegModule(1);
      const freshPool = await ethers.getContractAt("DepegPool", freshDepegModule.depegPool);
      const freshDpToken = await ethers.getContractAt("DepegToken", freshDepegModule.dpAsset);
      const freshYbToken = await ethers.getContractAt("DepegToken", freshDepegModule.ybAsset);
      
      // User1 splits 200 base tokens → gets 100 DP + 100 YB
      const SPLIT_AMOUNT = ethers.parseEther("200");
      await baseAsset.mint(user1.address, SPLIT_AMOUNT);
      await baseAsset.connect(user1).approve(await freshPool.getAddress(), ethers.MaxUint256);
      await freshPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT);
      
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Set up ~50% depeg to trigger max DP value (200%)
      // When principalDepeggedValue <= 5000, dpValue caps at 20000 (200%) and ybValue = 0
      const hwmPrice = ethers.parseEther("1.0");
      const resolutionPrice = ethers.parseEther("0.5"); // 50% depeg
      
      const freshOracleAddr = await freshPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [freshOracleAddr]);
      const freshOracleSigner = await ethers.getSigner(freshOracleAddr);
      await owner.sendTransaction({ to: freshOracleAddr, value: ethers.parseEther("1") });
      await freshPool.connect(freshOracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [freshOracleAddr]);
      
      // Move to RESOLUTION and resolve
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await freshPool.resolvePriceDepeg();
      
      // Verify full depeg
      expect(await freshPool.poolHasDepegged()).to.be.true;
      const dpValue = await freshPool.dpValue();
      const ybValue = await freshPool.ybValue();
      
      // At 50% depeg: dpValue should be capped at 20000 (200%), ybValue should be 0
      expect(dpValue).to.equal(20000);
      expect(ybValue).to.equal(0);
      
      await freshDpToken.connect(user1).approve(await freshPool.getAddress(), ethers.MaxUint256);
      await freshYbToken.connect(user1).approve(await freshPool.getAddress(), ethers.MaxUint256);
      
      const dpBalance = await freshDpToken.balanceOf(user1.address); // 100 DP
      const ybBalance = await freshYbToken.balanceOf(user1.address); // 100 YB
      
      // User redeems 50 DP and all 100 YB
      // DP redemption: 50 DP * 20000 / 10000 = 100 base before fee
      // YB redemption: 100 YB * 0 / 10000 = 0 base (worthless)
      // Total before fee: 100 base
      // Fee: 100 * 100 / 10000 = 1 base
      // User receives: 99 base
      const halfDp = dpBalance / 2n; // 50 DP
      await freshPool.connect(user1).redeemTokens(user1.address, halfDp, ybBalance);
      
      // Pool balance after redemption: 200 - 99 = 101 base tokens
      const poolBalanceAfterRedemption = await baseAsset.balanceOf(await freshPool.getAddress());
      expect(poolBalanceAfterRedemption).to.equal(ethers.parseEther("101"));
      
      const remainingDpSupply = await freshDpToken.totalSupply();
      const remainingYbSupply = await freshYbToken.totalSupply();
      expect(remainingDpSupply).to.equal(ethers.parseEther("50"));
      expect(remainingYbSupply).to.equal(0);
      
      // Required: 50 DP * 20000 / 10000 = 100 base
      const requiredForDp = (remainingDpSupply * dpValue) / BigInt(BP_IN_INTEGER);
      expect(requiredForDp).to.equal(ethers.parseEther("100"));
      
      const treasuryBalanceBefore = await baseAsset.balanceOf(treasury.address);
      await freshPool.sweepFeesToTreasury();
      const treasuryBalanceAfter = await baseAsset.balanceOf(treasury.address);
      
      // Should sweep exactly 1 base token (the fee)
      const amountSwept = treasuryBalanceAfter - treasuryBalanceBefore;
      expect(amountSwept).to.equal(ethers.parseEther("1"), "Should only sweep the 1 base fee");
      
      // Pool should retain 100 base tokens for remaining 50 DP tokens
      expect(await baseAsset.balanceOf(await freshPool.getAddress())).to.equal(ethers.parseEther("100"));
      
      // Verify user can still redeem their remaining 50 DP tokens
      const remainingDpBalance = await freshDpToken.balanceOf(user1.address);
      const userBaseBefore = await baseAsset.balanceOf(user1.address);
      await freshPool.connect(user1).redeemTokens(user1.address, remainingDpBalance, 0);
      const userBaseAfter = await baseAsset.balanceOf(user1.address);
      expect(userBaseAfter - userBaseBefore).to.equal(ethers.parseEther("99"));
      
      // Pool should have 1 base left (the second redemption fee)
      expect(await baseAsset.balanceOf(await freshPool.getAddress())).to.equal(ethers.parseEther("1"));
    });
  });

  describe("setAuthorisedRouter", function () {
    it("Should allow admin to authorise a router", async function () {
      await depegPool.connect(owner).setAuthorisedRouter(user1.address, true);
      expect(await depegPool.isAuthorisedRouter(user1.address)).to.equal(true);
    });

    it("Should allow admin to revoke an authorised router", async function () {
      await depegPool.connect(owner).setAuthorisedRouter(user1.address, true);
      expect(await depegPool.isAuthorisedRouter(user1.address)).to.equal(true);
      await depegPool.connect(owner).setAuthorisedRouter(user1.address, false);
      expect(await depegPool.isAuthorisedRouter(user1.address)).to.equal(false);
    });

    it("Should allow multiple routers to be authorised simultaneously", async function () {
      await depegPool.connect(owner).setAuthorisedRouter(user1.address, true);
      await depegPool.connect(owner).setAuthorisedRouter(user2.address, true);
      expect(await depegPool.isAuthorisedRouter(user1.address)).to.equal(true);
      expect(await depegPool.isAuthorisedRouter(user2.address)).to.equal(true);
      expect(await depegPool.isAuthorisedRouter(nonAuthorized.address)).to.equal(false);
    });

    it("Should not allow anyone else to set authorised router", async function () {
      await expect(depegPool.connect(user1).setAuthorisedRouter(user1.address, true)).to.be.reverted;
      await expect(depegPool.connect(nonAuthorized).setAuthorisedRouter(user1.address, true)).to.be.reverted;
    });
  });

  describe("Access Control", function () {
    it("Should have DEFAULT_ADMIN_ROLE set correctly", async function () {
      const DEFAULT_ADMIN_ROLE = await depegPool.DEFAULT_ADMIN_ROLE();
      expect(await depegPool.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
      expect(await depegPool.hasRole(DEFAULT_ADMIN_ROLE, operator.address)).to.be.false;
      expect(await depegPool.hasRole(DEFAULT_ADMIN_ROLE, user1.address)).to.be.false;
    });

    it("Should have OPERATOR_ROLE set correctly", async function () {
      const OPERATOR_ROLE = await depegPool.OPERATOR_ROLE();
      expect(await depegPool.hasRole(OPERATOR_ROLE, operator.address)).to.be.true;
      expect(await depegPool.hasRole(OPERATOR_ROLE, owner.address)).to.be.false;
      expect(await depegPool.hasRole(OPERATOR_ROLE, user1.address)).to.be.false;
    });

    it("Should allow admin to grant OPERATOR_ROLE", async function () {
      const OPERATOR_ROLE = await depegPool.OPERATOR_ROLE();
      await depegPool.connect(owner).grantRole(OPERATOR_ROLE, user1.address);
      expect(await depegPool.hasRole(OPERATOR_ROLE, user1.address)).to.be.true;
    });

    it("Should allow admin to revoke OPERATOR_ROLE", async function () {
      const OPERATOR_ROLE = await depegPool.OPERATOR_ROLE();
      await depegPool.connect(owner).revokeRole(OPERATOR_ROLE, operator.address);
      expect(await depegPool.hasRole(OPERATOR_ROLE, operator.address)).to.be.false;
    });

    it("Should allow admin to reassign DEFAULT_ADMIN_ROLE", async function () {
      const DEFAULT_ADMIN_ROLE = await depegPool.DEFAULT_ADMIN_ROLE();
      await depegPool.connect(owner).grantRole(DEFAULT_ADMIN_ROLE, user1.address);
      await depegPool.connect(owner).revokeRole(DEFAULT_ADMIN_ROLE, owner.address);
      expect(await depegPool.hasRole(DEFAULT_ADMIN_ROLE, user1.address)).to.be.true;
      expect(await depegPool.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.false;
    });

    it("Should allow admin to revoke DEFAULT_ADMIN_ROLE", async function () {
      const DEFAULT_ADMIN_ROLE = await depegPool.DEFAULT_ADMIN_ROLE();
      await depegPool.connect(owner).revokeRole(DEFAULT_ADMIN_ROLE, owner.address);
      expect(await depegPool.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.false;
    });

  });

  describe("Edge Cases & Security", function () {
    it("Should handle very small amounts", async function () {
      const tinyAmount = 3n; //
      await depegPool.connect(user1).splitToken(user1.address, tinyAmount);
      
      const dpBalance = await dpToken.balanceOf(user1.address);
      const ybBalance = await ybToken.balanceOf(user1.address);
      
      expect(dpBalance).to.equal(1n);
      expect(ybBalance).to.equal(1n);
    });

    it("Should handle very large amounts", async function () {
      const largeAmount = ethers.parseEther("1000000000");
      await baseAsset.mint(user1.address, largeAmount);
      
      await depegPool.connect(user1).splitToken(user1.address, largeAmount);
      
      const dpBalance = await dpToken.balanceOf(user1.address);
      const ybBalance = await ybToken.balanceOf(user1.address);
      
      expect(dpBalance).to.equal(largeAmount / 2n);
      expect(ybBalance).to.equal(largeAmount / 2n);
    });
  });

  describe("Hardcoded constants", function () {
    it("Should have correct BP_IN_INTEGER", async function () {
      expect(await depegPool.BP_IN_INTEGER()).to.equal(10000);
    });

    it("Should have correct MIN_DURATION", async function () {
      expect(await depegPool.MIN_DURATION()).to.equal(4 * 60 * 60);
    });

    it("Should have correct MAX_DURATION", async function () {
      expect(await depegPool.MAX_DURATION()).to.equal(30 * 24 * 60 * 60);
    });

    it("Should have correct ORACLE_CHANGE_DELAY", async function () {
      expect(await depegPool.ORACLE_CHANGE_DELAY()).to.equal(7 * 24 * 60 * 60);
    });

    it("Should have correct minPriceAge (constructor hardcoded)", async function () {
    expect(await depegPool.minPriceAge()).to.equal(5 * 60 * 60);
    });
  });

  describe("View Functions", function () {
    it("Should return correct pool name and flag", async function () {
      expect(await depegPool.name()).to.equal("Test Pool");
      expect(await depegPool.flag()).to.equal("TEST");
    });

    it("Should return correct token addresses", async function () {
      expect(await depegPool.DP_ASSET()).to.equal(await dpToken.getAddress());
      expect(await depegPool.YB_ASSET()).to.equal(await ybToken.getAddress());
      expect(await depegPool.ASSET()).to.equal(await baseAsset.getAddress());
    });

    it("Should return correct price bounds", async function () {
      expect(await depegPool.MIN_PRICE()).to.equal(MIN_PRICE);
      expect(await depegPool.MAX_PRICE()).to.equal(MAX_PRICE);
    });

    describe("Constructor Validation", function () {
      it("Should revert if poolOwner is zero address", async function () {
        const DepegPool = await ethers.getContractFactory("DepegPool");
        const params = createDepegPoolParams({ poolOwner: ethers.ZeroAddress });
        await expect(DepegPool.deploy(params)).to.be.revertedWithCustomError(depegPool, "ZeroAddress");
      });

      it("Should revert if oracle is zero address", async function () {
        const DepegPool = await ethers.getContractFactory("DepegPool");
        const params = createDepegPoolParams({ oracle: ethers.ZeroAddress, poolOwner: owner.address });
        await expect(DepegPool.deploy(params)).to.be.revertedWithCustomError(depegPool, "ZeroAddress");
      });

      it("Should revert if minPrice is zero", async function () {
        const DepegPool = await ethers.getContractFactory("DepegPool");
        const params = createDepegPoolParams({
          minPrice: 0n,
          poolOwner: owner.address,
          oracle: await mockOracle.getAddress(),
          assetAddress: await baseAsset.getAddress(),
          treasury: treasury.address
        });
        await expect(DepegPool.deploy(params)).to.be.revertedWithCustomError(depegPool, "MinPriceMustBeGreaterThanZero");
      });

      it("Should revert if maxPrice is less than or equal to minPrice", async function () {
        const DepegPool = await ethers.getContractFactory("DepegPool");
        const params = createDepegPoolParams({
          minPrice: ethers.parseEther("1"),
          maxPrice: ethers.parseEther("1"),
          poolOwner: owner.address,
          oracle: await mockOracle.getAddress(),
          assetAddress: await baseAsset.getAddress(),
          treasury: treasury.address
        });
        await expect(DepegPool.deploy(params)).to.be.revertedWithCustomError(depegPool, "MaxPriceMustBeGreaterThanMinPrice");
      });

      it("Should revert if poolActiveDuration is zero", async function () {
        const DepegPool = await ethers.getContractFactory("DepegPool");
        const params = createDepegPoolParams({
          poolActiveDuration: 0,
          poolOwner: owner.address,
          oracle: await mockOracle.getAddress(),
          assetAddress: await baseAsset.getAddress(),
          treasury: treasury.address
        });
        await expect(DepegPool.deploy(params)).to.be.revertedWithCustomError(depegPool, "ActiveDurationZero");
      });

      it("Should revert if cooldownDuration is out of bounds", async function () {
        const DepegPool = await ethers.getContractFactory("DepegPool");
        const paramsLow = createDepegPoolParams({
          cooldownDuration: MIN_DURATION - 1,
          poolOwner: owner.address,
          oracle: await mockOracle.getAddress(),
          assetAddress: await baseAsset.getAddress(),
          treasury: treasury.address
        });
        await expect(DepegPool.deploy(paramsLow)).to.be.revertedWithCustomError(depegPool, "CooldownOutOfBounds");

        const paramsHigh = createDepegPoolParams({
          cooldownDuration: MAX_DURATION + 1,
          poolOwner: owner.address,
          oracle: await mockOracle.getAddress(),
          assetAddress: await baseAsset.getAddress(),
          treasury: treasury.address
        });
        await expect(DepegPool.deploy(paramsHigh)).to.be.revertedWithCustomError(depegPool, "CooldownOutOfBounds");
      });

      it("Should revert if minPriceAge is out of bounds", async function () {
        const DepegPool = await ethers.getContractFactory("DepegPool");
        const paramsLow = createDepegPoolParams({
          minPriceAge: MIN_DURATION - 1,
          poolOwner: owner.address,
          oracle: await mockOracle.getAddress(),
          assetAddress: await baseAsset.getAddress(),
          treasury: treasury.address
        });
        await expect(DepegPool.deploy(paramsLow)).to.be.revertedWithCustomError(depegPool, "MinAgeOutOfBounds");

        const paramsHigh = createDepegPoolParams({
          minPriceAge: MAX_DURATION + 1,
          poolOwner: owner.address,
          oracle: await mockOracle.getAddress(),
          assetAddress: await baseAsset.getAddress(),
          treasury: treasury.address
        });
        await expect(DepegPool.deploy(paramsHigh)).to.be.revertedWithCustomError(depegPool, "MinAgeOutOfBounds");
      });
    });

    it("Should return correct durations", async function () {
      expect(await depegPool.poolActiveDuration()).to.equal(POOL_ACTIVE_DURATION);
      expect(await depegPool.cooldownDuration()).to.equal(COOLDOWN_DURATION);
    });

    it("Should return correct fee rates", async function () {
      expect(await depegPool.redemptionFeeBp()).to.equal(REDEMPTION_FEE_BP);
    });
  });

  describe("6-Decimal Base Token Support", function () {
    let pool6Decimal: any;
    let dp6Token: any;
    let yb6Token: any;
    let base6Asset: any;
    const MIN_PRICE_6D = ethers.parseUnits("0.5", 6);
    const MAX_PRICE_6D = ethers.parseUnits("2", 6);
    const INITIAL_PRICE_6D = ethers.parseUnits("1", 6); // Reference price for tests

    beforeEach(async function () {
      // Deploy 6-decimal mock token
      const Mock6Decimal = await ethers.getContractFactory("USDC6Mock");
      base6Asset = await Mock6Decimal.deploy();

      // Deploy pool with 6-decimal base
      const pool6Params = createDepegPoolParams({
        assetAddress: await base6Asset.getAddress(),
        dpName: "DP USDC",
        dpSymbol: "dpUSDC",
        ybName: "YB USDC",
        ybSymbol: "ybUSDC",
        name: "6 Decimal Pool",
        flag: "USDC6",
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        minPrice: MIN_PRICE_6D,
        maxPrice: MAX_PRICE_6D,
        treasury: treasury.address,
        authorisedRouter: owner.address
      });
      await depegFactory.deployDepeg(pool6Params);

      // Get the new pool (index 1, since index 0 is the original pool)
      const module = await depegFactory.getDepegModule(1);
      pool6Decimal = await ethers.getContractAt("DepegPool", module.depegPool);
      dp6Token = await ethers.getContractAt("DepegToken", module.dpAsset);
      yb6Token = await ethers.getContractAt("DepegToken", module.ybAsset);

      // Mint 6-decimal tokens to users
      await base6Asset.mint(user1.address, ethers.parseUnits("100000", 6));
      await base6Asset.mint(user2.address, ethers.parseUnits("100000", 6));

      // Approve
      await base6Asset.connect(user1).approve(await pool6Decimal.getAddress(), ethers.MaxUint256);
      await base6Asset.connect(user2).approve(await pool6Decimal.getAddress(), ethers.MaxUint256);
    });

    it("Should create DP/YB tokens with 6 decimals matching base asset", async function () {
      expect(await dp6Token.decimals()).to.equal(6);
      expect(await yb6Token.decimals()).to.equal(6);
      expect(await pool6Decimal.MIN_PRICE()).to.equal(MIN_PRICE_6D);
      expect(await pool6Decimal.MAX_PRICE()).to.equal(MAX_PRICE_6D);
    });

    it("Should split 6-decimal tokens correctly", async function () {
      const splitAmount = ethers.parseUnits("10", 6); // 10 USDC
      
      await pool6Decimal.connect(user1).splitToken(user1.address, splitAmount);

      const dpBalance = await dp6Token.balanceOf(user1.address);
      const ybBalance = await yb6Token.balanceOf(user1.address);

      expect(dpBalance).to.equal(5_000_000n);
      expect(ybBalance).to.equal(5_000_000n);
    });

    it("Should unsplit 6-decimal tokens correctly", async function () {
      const splitAmount = ethers.parseUnits("10", 6);
      await pool6Decimal.connect(user1).splitToken(user1.address, splitAmount);

      // Approve DP/YB tokens
      await dp6Token.connect(user1).approve(await pool6Decimal.getAddress(), ethers.MaxUint256);
      await yb6Token.connect(user1).approve(await pool6Decimal.getAddress(), ethers.MaxUint256);

      const baseBalanceBefore = await base6Asset.balanceOf(user1.address);
      
      await pool6Decimal.connect(user1).unSplitTokens(user1.address, 5_000_000n);

      const baseBalanceAfter = await base6Asset.balanceOf(user1.address);
      const baseReturned = baseBalanceAfter - baseBalanceBefore;

      // Should get back most of the amount (minus fees)
      expect(baseReturned).to.be.greaterThan(splitAmount * 98n / 100n);
      expect(baseReturned).to.be.lessThan(splitAmount);
    });

    it("Should handle complete lifecycle with 6-decimal tokens and no depeg", async function () {
      const splitAmount = ethers.parseUnits("5000", 6);
      await pool6Decimal.connect(user1).splitToken(user1.address, splitAmount);
      
      const dpBalance = await dp6Token.balanceOf(user1.address);
      const ybBalance = await yb6Token.balanceOf(user1.address);

      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Oracle updates price data (no depeg)
      const oracleAddr = await pool6Decimal.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await pool6Decimal.connect(oracleSigner).updatePriceData(INITIAL_PRICE_6D, INITIAL_PRICE_6D);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION and resolve
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await pool6Decimal.resolvePriceDepeg();

      expect(await pool6Decimal.poolHasDepegged()).to.be.false;

      // Redeem tokens
      await dp6Token.connect(user1).approve(await pool6Decimal.getAddress(), ethers.MaxUint256);
      await yb6Token.connect(user1).approve(await pool6Decimal.getAddress(), ethers.MaxUint256);

      const baseBalanceBefore = await base6Asset.balanceOf(user1.address);
      await pool6Decimal.connect(user1).redeemTokens(user1.address, dpBalance, ybBalance);
      const baseBalanceAfter = await base6Asset.balanceOf(user1.address);
      const baseReturned = baseBalanceAfter - baseBalanceBefore;

      // Should get back close to original amount (minus fees)
      expect(baseReturned).to.be.greaterThan(splitAmount * 98n / 100n);
      expect(baseReturned).to.be.lessThan(splitAmount);
    });

    it("Should handle 6-decimal tokens with depeg scenario", async function () {
      const splitAmount = ethers.parseUnits("10", 6);
      await pool6Decimal.connect(user1).splitToken(user1.address, splitAmount);
      await pool6Decimal.connect(user2).splitToken(user2.address, splitAmount);
      
      const user1DpBalance = await dp6Token.balanceOf(user1.address);
      const user2YbBalance = await yb6Token.balanceOf(user2.address);

      // Move to COOLDOWN with 5% depeg
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      const hwmPrice = 1_000_000n;
      const resolutionPrice = (1_000_000n * 95n) / 100n; // 5% depeg
      
      const oracleAddr = await pool6Decimal.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await pool6Decimal.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION and resolve
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await pool6Decimal.resolvePriceDepeg();

      expect(await pool6Decimal.poolHasDepegged()).to.be.true;
      const depegSize = await pool6Decimal.depegSize();
      expect(depegSize).to.equal(500n); // 5% = 500 bp

      // Approve tokens
      await dp6Token.connect(user1).approve(await pool6Decimal.getAddress(), ethers.MaxUint256);
      await yb6Token.connect(user2).approve(await pool6Decimal.getAddress(), ethers.MaxUint256);

      // User1 redeems DP (gains value)
      const user1BaseBefore = await base6Asset.balanceOf(user1.address);
      await pool6Decimal.connect(user1).redeemTokens(user1.address, user1DpBalance, 0);
      const user1BaseAfter = await base6Asset.balanceOf(user1.address);
      const user1Return = user1BaseAfter - user1BaseBefore;

      // User2 redeems YB (loses value)
      const user2BaseBefore = await base6Asset.balanceOf(user2.address);
      await pool6Decimal.connect(user2).redeemTokens(user2.address, 0, user2YbBalance);
      const user2BaseAfter = await base6Asset.balanceOf(user2.address);
      const user2Return = user2BaseAfter - user2BaseBefore;

      // DP should be worth more than face value
      expect(user1Return).to.be.greaterThan(user1DpBalance);
      // YB should be worth less than face value
      expect(user2Return).to.be.lessThan(user2YbBalance);
    });

    it("Should calculate fees correctly with 6-decimal precision", async function () {
      const splitAmount = ethers.parseUnits("1000", 6);
      await pool6Decimal.connect(user1).splitToken(user1.address, splitAmount);

      await dp6Token.connect(user1).approve(await pool6Decimal.getAddress(), ethers.MaxUint256);
      await yb6Token.connect(user1).approve(await pool6Decimal.getAddress(), ethers.MaxUint256);

      const unsplitAmount = splitAmount / 2n;
      const baseBalanceBefore = await base6Asset.balanceOf(user1.address);
      
      await pool6Decimal.connect(user1).unSplitTokens(user1.address, unsplitAmount);

      const baseBalanceAfter = await base6Asset.balanceOf(user1.address);
      const baseReturned = baseBalanceAfter - baseBalanceBefore;

      // Expected: splitAmount - redemption fee
      const expectedRedemptionFee = (splitAmount * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      const expectedReturn = splitAmount - expectedRedemptionFee;

      expect(baseReturned).to.be.closeTo(expectedReturn, ethers.parseUnits("0.01", 6)); // Within 0.01 USDC
    });
  });

  describe("Complete Lifecycle Tests", function () {
    // Helper function to move pool through states
    async function moveToRedemptions(hwmPrice: bigint, resolutionPrice: bigint) {
      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      
      // Oracle updates price data
      const oracleAddr = await depegPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      await depegPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION
      await time.increase(COOLDOWN_DURATION + 1);
      
      // Wait for min price age and resolve
      await time.increase(5 * 60 * 60 + 1); // MIN_PRICE_AGE + 1
      await depegPool.resolvePriceDepeg();
    }

    describe("No Depeg Scenario", function () {
      const SPLIT_AMOUNT = ethers.parseEther("1000");

      it("Should handle complete lifecycle when no depeg occurs", async function () {
        // ACTIVE: User splits tokens
        expect(await depegPool.getState()).to.equal(STATE_ACTIVE);
        await depegPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT);
        
        const dpBalance = await dpToken.balanceOf(user1.address);
        const ybBalance = await ybToken.balanceOf(user1.address);
        expect(dpBalance).to.equal(SPLIT_AMOUNT / 2n);
        expect(ybBalance).to.equal(SPLIT_AMOUNT / 2n);

        // Move through states (no depeg)
        await moveToRedemptions(INITIAL_PRICE, INITIAL_PRICE);
        
        expect(await depegPool.getState()).to.equal(STATE_REDEMPTIONS);
        expect(await depegPool.poolHasDepegged()).to.be.false;
        expect(await depegPool.depegSize()).to.equal(0);

        // REDEMPTIONS: User redeems tokens
        await dpToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
        await ybToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);

        const baseBalanceBefore = await baseAsset.balanceOf(user1.address);
        await depegPool.connect(user1).redeemTokens(user1.address, dpBalance, ybBalance);
        const baseBalanceAfter = await baseAsset.balanceOf(user1.address);
        const baseReturned = baseBalanceAfter - baseBalanceBefore;
        
        // Should get back original amount minus fees (no depeg = 1:1)
        expect(baseReturned).to.be.lessThan(SPLIT_AMOUNT);
        expect(baseReturned).to.be.greaterThan(SPLIT_AMOUNT * 98n / 100n); // At least 98%
      });
    });

    describe("With Depeg Scenario", function () {
      const SPLIT_AMOUNT = ethers.parseEther("1000");

      it("Should handle complete lifecycle with 10% depeg", async function () {
        // ACTIVE: Users split tokens
        await depegPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT);
        await depegPool.connect(user2).splitToken(user2.address, SPLIT_AMOUNT);
        
        const user1DpBalance = await dpToken.balanceOf(user1.address);
        const user2YbBalance = await ybToken.balanceOf(user2.address);

        // Move through states (10% depeg)
        const hwmPrice = INITIAL_PRICE;
        const resolutionPrice = (INITIAL_PRICE * 90n) / 100n; // 10% depeg
        await moveToRedemptions(hwmPrice, resolutionPrice);

        expect(await depegPool.poolHasDepegged()).to.be.true;
        const depegSize = await depegPool.depegSize();
        expect(depegSize).to.be.closeTo(1000, 10); // 10% = 1000 bp

        // REDEMPTIONS: Approve tokens
        await dpToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
        await ybToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
        await dpToken.connect(user2).approve(await depegPool.getAddress(), ethers.MaxUint256);
        await ybToken.connect(user2).approve(await depegPool.getAddress(), ethers.MaxUint256);

        // User1 redeems DP tokens (should gain value)
        const user1BaseBalanceBefore = await baseAsset.balanceOf(user1.address);
        await depegPool.connect(user1).redeemTokens(user1.address, user1DpBalance, 0);
        const user1BaseBalanceAfter = await baseAsset.balanceOf(user1.address);
        const user1DpReturn = user1BaseBalanceAfter - user1BaseBalanceBefore;
        
        // DP tokens worth MORE than face value after depeg
        expect(user1DpReturn).to.be.greaterThan(user1DpBalance);

        // User2 redeems YB tokens (should lose value)
        const user2BaseBalanceBefore = await baseAsset.balanceOf(user2.address);
        await depegPool.connect(user2).redeemTokens(user2.address, 0, user2YbBalance);
        const user2BaseBalanceAfter = await baseAsset.balanceOf(user2.address);
        const user2YbReturn = user2BaseBalanceAfter - user2BaseBalanceBefore;
        
        // YB tokens worth LESS than face value after depeg
        expect(user2YbReturn).to.be.lessThan(user2YbBalance);
      });

      it("Should handle minimal depeg below 0.1% threshold", async function () {
        await depegPool.connect(user1).splitToken(user1.address, SPLIT_AMOUNT);
        
        // 0.09% depeg (below 0.1% threshold)
        const hwmPrice = INITIAL_PRICE;
        const resolutionPrice = (INITIAL_PRICE * 9991n) / 10000n;
        await moveToRedemptions(hwmPrice, resolutionPrice);

        // Should NOT count as depeg
        expect(await depegPool.poolHasDepegged()).to.be.false;
        expect(await depegPool.depegSize()).to.equal(0);
      });

      it("Should calculate depeg size correctly for various depeg percentages", async function () {
        const testCases = [
          { depegPercent: 5, expectedBp: 500 },   // 5% depeg
          { depegPercent: 10, expectedBp: 1000 }, // 10% depeg
          { depegPercent: 20, expectedBp: 2000 }, // 20% depeg
        ];

        for (const testCase of testCases) {
          // Deploy a new pool for each test
          const testParams = createDepegPoolParams({
            assetAddress: await baseAsset.getAddress(),
            dpName: `DP${testCase.depegPercent}`,
            dpSymbol: `DP${testCase.depegPercent}`,
            ybName: `YB${testCase.depegPercent}`,
            ybSymbol: `YB${testCase.depegPercent}`,
            name: `Pool${testCase.depegPercent}`,
            flag: `TEST${testCase.depegPercent}`,
            oracle: await mockOracle.getAddress(),
            poolOwner: owner.address,
            treasury: treasury.address,
            authorisedRouter: owner.address
          });
          await depegFactory.deployDepeg(testParams);

          const newModule = await depegFactory.getDepegModule(testCases.indexOf(testCase) + 1);
          const newPool = await ethers.getContractAt("DepegPool", newModule.depegPool);

          const hwmPrice = INITIAL_PRICE;
          const resolutionPrice = (INITIAL_PRICE * BigInt(100 - testCase.depegPercent)) / 100n;

          // Move pool through states
          await time.increase(POOL_ACTIVE_DURATION + 1);
          const oracleAddr = await newPool.oracle();
          await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
          const oracleSigner = await ethers.getSigner(oracleAddr);
          await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
          await newPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice);
          await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);
          await time.increase(COOLDOWN_DURATION + 5 * 60 * 60 + 2);
          await newPool.resolvePriceDepeg();

          const depegSize = await newPool.depegSize();
          expect(depegSize).to.be.closeTo(testCase.expectedBp, 10);
        }
      });
    });

    describe("Multiple Users Interaction", function () {
      const USER1_SPLIT = ethers.parseEther("1000");
      const USER2_SPLIT = ethers.parseEther("2000");

      it("Should handle multiple users splitting and redeeming", async function () {
        // Both users split
        await depegPool.connect(user1).splitToken(user1.address, USER1_SPLIT);
        await depegPool.connect(user2).splitToken(user2.address, USER2_SPLIT);

        const user1Dp = await dpToken.balanceOf(user1.address);
        const user2Dp = await dpToken.balanceOf(user2.address);
        
        expect(user1Dp).to.equal(USER1_SPLIT / 2n);
        expect(user2Dp).to.equal(USER2_SPLIT / 2n);

        // Move to REDEMPTIONS
        await moveToRedemptions(INITIAL_PRICE, INITIAL_PRICE);

        // Approve tokens
        await dpToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
        await ybToken.connect(user1).approve(await depegPool.getAddress(), ethers.MaxUint256);
        await dpToken.connect(user2).approve(await depegPool.getAddress(), ethers.MaxUint256);
        await ybToken.connect(user2).approve(await depegPool.getAddress(), ethers.MaxUint256);

        // Both users redeem
        const user1BaseBefore = await baseAsset.balanceOf(user1.address);
        await depegPool.connect(user1).redeemTokens(
          user1.address, 
          user1Dp, 
          await ybToken.balanceOf(user1.address)
        );
        const user1BaseAfter = await baseAsset.balanceOf(user1.address);

        const user2BaseBefore = await baseAsset.balanceOf(user2.address);
        await depegPool.connect(user2).redeemTokens(
          user2.address,
          user2Dp,
          await ybToken.balanceOf(user2.address)
        );
        const user2BaseAfter = await baseAsset.balanceOf(user2.address);

        // Both should get most of their funds back (minus fees)
        expect(user1BaseAfter - user1BaseBefore).to.be.greaterThan(USER1_SPLIT * 98n / 100n);
        expect(user2BaseAfter - user2BaseBefore).to.be.greaterThan(USER2_SPLIT * 98n / 100n);
      });
    });
  });

  describe("Invariant Tests", function () {
    this.timeout(120000);
    // Helper to generate pseudo-random bigint in range [min, max]
    function randomBigInt(seed: number, min: bigint, max: bigint): bigint {
      const range = max - min;
      const randomFactor = BigInt(Math.floor(Math.abs(Math.sin(seed * 12345.6789) * 1000000)));
      return min + (randomFactor % (range + 1n));
    }

    it("Should maintain supply invariant: yb.totalSupply() == dp.totalSupply() == baseAsset.balanceOf(depegPool) / 2", async function () {
      // Run 10 iterations with random operations, each with a fresh pool
      for (let i = 0; i < 10; i++) {
        // Deploy a fresh pool for each iteration
        const supplyParams = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          dpName: `DP-Supply-${i}`,
          dpSymbol: `DPS${i}`,
          ybName: `YB-Supply-${i}`,
          ybSymbol: `YBS${i}`,
          name: `Supply Invariant Pool ${i}`,
          flag: `SUP${i}`,
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address
        });
        await depegFactory.deployDepeg(supplyParams);

        const module = await depegFactory.getDepegModule(i + 1);
        const testPool = await ethers.getContractAt("DepegPool", module.depegPool);
        const testDpToken = await ethers.getContractAt("DepegToken", module.dpAsset);
        const testYbToken = await ethers.getContractAt("DepegToken", module.ybAsset);

        // Approve base asset for both users
        await baseAsset.connect(user1).approve(module.depegPool, ethers.MaxUint256);
        await baseAsset.connect(user2).approve(module.depegPool, ethers.MaxUint256);

        const seed = i + 1;
        
        // Generate random split amounts (between 100 and 10000 worth)
        const minAmount = ethers.parseEther("100");
        const maxAmount = ethers.parseEther("10000");
        
        const splitAmount1 = randomBigInt(seed, minAmount, maxAmount);
        const splitAmount2 = randomBigInt(seed * 2, minAmount, maxAmount);
        const splitAmount3 = randomBigInt(seed * 3, minAmount / 2n, maxAmount / 2n);
        
        // Determine if we should do an unsplit (based on seed)
        const shouldUnsplit = seed % 3 !== 0;
        // Determine if we should move to COOLDOWN (based on seed)  
        const shouldMoveToCooldown = seed % 4 === 0;

        // First split
        await testPool.connect(user1).splitToken(user1.address, splitAmount1);

        // Second split from different user
        await testPool.connect(user2).splitToken(user2.address, splitAmount2);

        // Optionally unsplit some tokens
        if (shouldUnsplit) {
          await testDpToken.connect(user1).approve(module.depegPool, ethers.MaxUint256);
          await testYbToken.connect(user1).approve(module.depegPool, ethers.MaxUint256);
          const user1Balance = await testDpToken.balanceOf(user1.address);
          const unsplitAmount = user1Balance / 4n;
          if (unsplitAmount > 0n) {
            await testPool.connect(user1).unSplitTokens(user1.address, unsplitAmount);
          }
        }

        // Third split
        await testPool.connect(user1).splitToken(user1.address, splitAmount3);

        // Optionally move to COOLDOWN
        if (shouldMoveToCooldown) {
          await time.increase(POOL_ACTIVE_DURATION + 1);
          expect(await testPool.getState()).to.equal(STATE_COOLDOWN);
        }

        // Check invariants
        const dpSupply = await testDpToken.totalSupply();
        const ybSupply = await testYbToken.totalSupply();
        const poolBalance = await baseAsset.balanceOf(module.depegPool);

        // Invariant 1: DP and YB supplies should always be equal
        expect(dpSupply).to.equal(ybSupply, `Iteration ${i + 1}: DP and YB supplies should be equal`);

        if (shouldUnsplit) {
          // When unsplitting occurs, fees accumulate so poolBalance >= 2 * supply
          expect(poolBalance).to.be.gte(dpSupply * 2n, `Iteration ${i + 1}: Pool balance should be >= 2 * supply when fees present`);
        } else {
          // Without unsplit, poolBalance should equal 2 * supply (accounting for remainders)
          const numSplits = 3n;
          expect(poolBalance).to.be.lte(dpSupply * 2n + numSplits, `Iteration ${i + 1}: Pool balance should be close to 2 * supply`);
          expect(poolBalance).to.be.gte(dpSupply * 2n, `Iteration ${i + 1}: Pool balance should be >= 2 * supply`);
        }
      }
    });

    it("Should maintain solvency invariant: yb.totalSupply() * ybValue + dp.totalSupply() * dpValue <= baseAsset.balanceOf(depegPool)", async function () {
      // Test scenarios with varying depeg percentages and operations
      const scenarios = [
        { depegPct: 0, withRedemption: false, withTransfer: false, desc: "no depeg" },
        { depegPct: 5, withRedemption: false, withTransfer: false, desc: "5% depeg" },
        { depegPct: 10, withRedemption: false, withTransfer: false, desc: "10% depeg" },
        { depegPct: 20, withRedemption: true, withTransfer: false, desc: "20% depeg with partial redemption" },
        { depegPct: 15, withRedemption: false, withTransfer: true, desc: "15% depeg with asymmetric holdings" },
        { depegPct: 30, withRedemption: false, withTransfer: false, desc: "30% depeg" },
        { depegPct: 40, withRedemption: false, withTransfer: false, desc: "40% depeg" },
        { depegPct: 49, withRedemption: false, withTransfer: false, desc: "49% depeg (near cap)" },
        { depegPct: 50, withRedemption: false, withTransfer: false, desc: "50% depeg (at cap)" },
        { depegPct: 5, withRedemption: true, withTransfer: false, desc: "5% depeg with full redemption" },
      ];

      for (let i = 0; i < scenarios.length; i++) {
        const scenario = scenarios[i];
        
        // Deploy a fresh pool for each scenario
        const solvParams = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          dpName: `DP-Solv-${i}`,
          dpSymbol: `DPSOLV${i}`,
          ybName: `YB-Solv-${i}`,
          ybSymbol: `YBSOLV${i}`,
          name: `Solvency Invariant Pool ${i}`,
          flag: `SOLV${i}`,
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address
        });
        await depegFactory.deployDepeg(solvParams);

        const module = await depegFactory.getDepegModule(i + 1);
        const testPool = await ethers.getContractAt("DepegPool", module.depegPool);
        const testDpToken = await ethers.getContractAt("DepegToken", module.dpAsset);
        const testYbToken = await ethers.getContractAt("DepegToken", module.ybAsset);

        // Approve and split tokens
        await baseAsset.connect(user1).approve(module.depegPool, ethers.MaxUint256);
        await baseAsset.connect(user2).approve(module.depegPool, ethers.MaxUint256);
        
        await testPool.connect(user1).splitToken(user1.address, ethers.parseEther("1000"));
        await testPool.connect(user2).splitToken(user2.address, ethers.parseEther("1000"));

        // Optionally transfer YB tokens to create asymmetric holdings
        if (scenario.withTransfer) {
          const ybBalance = await testYbToken.balanceOf(user1.address);
          await testYbToken.connect(user1).transfer(user2.address, ybBalance);
        }

        // Move to COOLDOWN
        await time.increase(POOL_ACTIVE_DURATION + 1);

        // Oracle updates price data
        const oracleAddr = await testPool.oracle();
        await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
        const oracleSigner = await ethers.getSigner(oracleAddr);
        await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
        
        const resolutionPrice = scenario.depegPct === 0 
          ? INITIAL_PRICE 
          : (INITIAL_PRICE * BigInt(100 - scenario.depegPct)) / 100n;
        await testPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, resolutionPrice);
        await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

        // Move to RESOLUTION and resolve
        await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
        await testPool.resolvePriceDepeg();

        // Optionally perform redemptions
        if (scenario.withRedemption) {
          await testDpToken.connect(user1).approve(module.depegPool, ethers.MaxUint256);
          await testYbToken.connect(user1).approve(module.depegPool, ethers.MaxUint256);
          await testDpToken.connect(user2).approve(module.depegPool, ethers.MaxUint256);
          await testYbToken.connect(user2).approve(module.depegPool, ethers.MaxUint256);
          
          const dpBalance1 = await testDpToken.balanceOf(user1.address);
          const ybBalance1 = await testYbToken.balanceOf(user1.address);
          const dpBalance2 = await testDpToken.balanceOf(user2.address);
          const ybBalance2 = await testYbToken.balanceOf(user2.address);
          
          if (scenario.desc.includes("full")) {
            // Full redemption - both users redeem all tokens
            await testPool.connect(user1).redeemTokens(user1.address, dpBalance1, ybBalance1);
            await testPool.connect(user2).redeemTokens(user2.address, dpBalance2, ybBalance2);
          } else {
            // Partial redemption (only user1's DP tokens)
            await testPool.connect(user1).redeemTokens(user1.address, dpBalance1, 0);
          }
        }

        // Check invariants
        const dpSupply = await testDpToken.totalSupply();
        const ybSupply = await testYbToken.totalSupply();
        const poolBalance = await baseAsset.balanceOf(module.depegPool);
        const dpVal = await testPool.dpValue();
        const ybVal = await testPool.ybValue();

        // Invariant 1: dpValue + ybValue should always equal 2 * BP_IN_INTEGER (20000)
        expect(BigInt(dpVal) + BigInt(ybVal)).to.equal(
          BigInt(BP_IN_INTEGER) * 2n,
          `Scenario "${scenario.desc}": dpValue + ybValue should equal 20000`
        );

        // Invariant 2: Total obligations should not exceed pool balance (solvency)
        const totalObligations = (dpSupply * BigInt(dpVal) + ybSupply * BigInt(ybVal)) / BigInt(BP_IN_INTEGER);
        expect(totalObligations).to.be.lte(
          poolBalance,
          `Scenario "${scenario.desc}": Pool should remain solvent`
        );

        // Special checks for edge cases
        if (scenario.depegPct >= 50) {
          // DP value should be capped at 200%
          expect(dpVal).to.equal(BP_IN_INTEGER * 2, `Scenario "${scenario.desc}": DP value should be capped at 200%`);
          expect(ybVal).to.equal(0, `Scenario "${scenario.desc}": YB value should be 0 when DP is capped`);
        }

        if (scenario.desc.includes("full redemption")) {
          // After full redemption, supplies should be 0
          expect(dpSupply).to.equal(0, `Scenario "${scenario.desc}": DP supply should be 0 after full redemption`);
          expect(ybSupply).to.equal(0, `Scenario "${scenario.desc}": YB supply should be 0 after full redemption`);
        }
      }
    });
  });

  describe("Severe Depeg Scenarios (Resolution price below MIN_PRICE)", function () {
    // These tests verify the fix for the MIN_PRICE constraint deadlock issue (QS/TAP-2)
    // where a large depeg event could prevent the pool from reaching REDEMPTIONS state

    // Track pool index for each test (starts at 0 for the pool created in the main beforeEach)
    let severeDepegPoolIndex = 0;

    // Reset the pool index before each test (accounts for the pool created in beforeEach at index 0)
    beforeEach(function () {
      severeDepegPoolIndex = 0;
    });

    // Helper function to deploy a fresh pool and move to redemptions with specific prices
    async function deployAndMoveToRedemptions(hwmPrice: bigint, resolutionPrice: bigint) {
      severeDepegPoolIndex++;
      const poolIndex = severeDepegPoolIndex;
      
      const severeParams = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        dpName: `DP-Severe-${poolIndex}`,
        dpSymbol: `DPSEV${poolIndex}`,
        ybName: `YB-Severe-${poolIndex}`,
        ybSymbol: `YBSEV${poolIndex}`,
        name: `Severe Depeg Pool ${poolIndex}`,
        flag: `SEV${poolIndex}`,
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        authorisedRouter: owner.address
      });
      await depegFactory.deployDepeg(severeParams);

      const module = await depegFactory.getDepegModule(poolIndex);
      const testPool = await ethers.getContractAt("DepegPool", module.depegPool);
      const testDpToken = await ethers.getContractAt("DepegToken", module.dpAsset);
      const testYbToken = await ethers.getContractAt("DepegToken", module.ybAsset);

      // Approve and split tokens
      await baseAsset.connect(user1).approve(module.depegPool, ethers.MaxUint256);
      await baseAsset.connect(user2).approve(module.depegPool, ethers.MaxUint256);
      
      // Users split tokens
      await testPool.connect(user1).splitToken(user1.address, ethers.parseEther("1000"));
      await testPool.connect(user2).splitToken(user2.address, ethers.parseEther("1000"));

      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);
      expect(await testPool.getState()).to.equal(STATE_COOLDOWN);

      // Oracle updates price data
      const oracleAddr = await testPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      
      await testPool.connect(oracleSigner).updatePriceData(hwmPrice, resolutionPrice);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);

      // Move to RESOLUTION and resolve
      await time.increase(COOLDOWN_DURATION + MIN_PRICE_AGE + 2);
      await testPool.resolvePriceDepeg();

      return { testPool, testDpToken, testYbToken, module };
    }

    it("Should allow resolution price below MIN_PRICE", async function () {
      // Resolution price is 25% of initial price, which is 0.25 (below MIN_PRICE of 0.5)
      const hwmPrice = INITIAL_PRICE;
      const resolutionPrice = INITIAL_PRICE / 4n; // 75% depeg

      const { testPool } = await deployAndMoveToRedemptions(hwmPrice, resolutionPrice);

      expect(await testPool.getState()).to.equal(STATE_REDEMPTIONS);
      expect(await testPool.poolHasDepegged()).to.be.true;
      expect(await testPool.depegResolved()).to.be.true;
    });

    it("Should handle 100% depeg (resolution price = 0)", async function () {
      const hwmPrice = INITIAL_PRICE;
      const resolutionPrice = 0n;

      const { testPool, testDpToken, testYbToken, module } = await deployAndMoveToRedemptions(hwmPrice, resolutionPrice);

      expect(await testPool.getState()).to.equal(STATE_REDEMPTIONS);
      expect(await testPool.poolHasDepegged()).to.be.true;
      expect(await testPool.depegResolved()).to.be.true;

      // Verify DP and YB values are correctly set
      const dpVal = await testPool.dpValue();
      const ybVal = await testPool.ybValue();
      
      // With 100% depeg, DP should be 2 and YB should be 0
      expect(dpVal).to.equal(BP_IN_INTEGER * 2);
      expect(ybVal).to.equal(0);

      // Verify depeg size is 100%
      const depegSize = await testPool.depegSize();
      expect(depegSize).to.equal(BP_IN_INTEGER); // 10000 = 100%
    });

    it("Should correctly distribute funds in 100% depeg scenario", async function () {
      const hwmPrice = INITIAL_PRICE;
      const resolutionPrice = 0n; // Total collapse

      const { testPool, testDpToken, testYbToken, module } = await deployAndMoveToRedemptions(hwmPrice, resolutionPrice);

      // Approve tokens for redemption
      await testDpToken.connect(user1).approve(module.depegPool, ethers.MaxUint256);
      await testYbToken.connect(user1).approve(module.depegPool, ethers.MaxUint256);
      await testDpToken.connect(user2).approve(module.depegPool, ethers.MaxUint256);
      await testYbToken.connect(user2).approve(module.depegPool, ethers.MaxUint256);

      const user1DpBalance = await testDpToken.balanceOf(user1.address);
      const user1YbBalance = await testYbToken.balanceOf(user1.address);
      const user2DpBalance = await testDpToken.balanceOf(user2.address);
      const user2YbBalance = await testYbToken.balanceOf(user2.address);

      // User 1 redeems only DP tokens (should get 200% of DP value)
      const user1BaseBefore = await baseAsset.balanceOf(user1.address);
      await testPool.connect(user1).redeemTokens(user1.address, user1DpBalance, 0);
      const user1BaseAfter = await baseAsset.balanceOf(user1.address);
      const user1Received = user1BaseAfter - user1BaseBefore;

      // DP tokens worth 200% of face value (minus fees)
      // calculatedDpValue = user1DpBalance * 20000 / 10000 = user1DpBalance * 2
      const expectedDpReturn = user1DpBalance * 2n;
      const expectedFees = (expectedDpReturn * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      const expectedNet = expectedDpReturn - expectedFees;
      expect(user1Received).to.equal(expectedNet);

      // User 2 redeems only YB tokens (should get 0)
      const user2BaseBefore = await baseAsset.balanceOf(user2.address);
      await testPool.connect(user2).redeemTokens(user2.address, 0, user2YbBalance);
      const user2BaseAfter = await baseAsset.balanceOf(user2.address);
      const user2Received = user2BaseAfter - user2BaseBefore;

      // YB tokens worth 0% in 100% depeg scenario
      expect(user2Received).to.equal(0);
    });

    it("Should handle 75% depeg scenario correctly", async function () {
      const hwmPrice = INITIAL_PRICE;
      const resolutionPrice = INITIAL_PRICE / 4n;

      const { testPool, testDpToken, testYbToken, module } = await deployAndMoveToRedemptions(hwmPrice, resolutionPrice);

      const dpVal = await testPool.dpValue();
      const ybVal = await testPool.ybValue();
      
      // With 75% depeg (principalDepeggedValue = 2500):
      // rawDpValue = 10000 * 10000 / 2500 = 40000 (400%)
      // This exceeds 200% cap, so DP = 200%, YB = 0%
      expect(dpVal).to.equal(BP_IN_INTEGER * 2); // 20000 = 200%
      expect(ybVal).to.equal(0); // 0%

      // Verify depeg size is 75%
      const depegSize = await testPool.depegSize();
      expect(depegSize).to.equal(7500n);
    });

    it("Should handle 40% depeg scenario correctly", async function () {
      const hwmPrice = INITIAL_PRICE;
      const resolutionPrice = (INITIAL_PRICE * 60n) / 100n; // 40% depeg 

      const { testPool, testDpToken, testYbToken, module } = await deployAndMoveToRedemptions(hwmPrice, resolutionPrice);

      const dpVal = await testPool.dpValue();
      const ybVal = await testPool.ybValue();
      
      // With 40% depeg (principalDepeggedValue = 6000):
      // rawDpValue = 10000 * 10000 / 6000 = 16666 (166.66...%)
      // This does NOT exceed 200% cap, so DP = 16666..., YB = 3333... (rounds up!)
      expect(dpVal).to.equal(16666n);
      expect(ybVal).to.equal(3334n);

      // Verify depeg size is 40%
      const depegSize = await testPool.depegSize();
      expect(depegSize).to.equal(4000n);

      // Verify redemption works with 40% depeg
      await testDpToken.connect(user1).approve(module.depegPool, ethers.MaxUint256);
      await testYbToken.connect(user1).approve(module.depegPool, ethers.MaxUint256);

      const user1DpBalance = await testDpToken.balanceOf(user1.address);
      const user1YbBalance = await testYbToken.balanceOf(user1.address);

      const user1BaseBefore = await baseAsset.balanceOf(user1.address);
      await testPool.connect(user1).redeemTokens(user1.address, user1DpBalance, user1YbBalance);
      const user1BaseAfter = await baseAsset.balanceOf(user1.address);
      const user1Received = user1BaseAfter - user1BaseBefore;

      // Verify user received expected amount (DP * dpVal + YB * ybVal) / BP - fees
      const expectedDpReturn = user1DpBalance * BigInt(dpVal) / BigInt(BP_IN_INTEGER);
      const expectedYbReturn = user1YbBalance * BigInt(ybVal) / BigInt(BP_IN_INTEGER);
      const amountToSend = expectedDpReturn + expectedYbReturn;
      const expectedFees = (amountToSend * BigInt(REDEMPTION_FEE_BP)) / BigInt(BP_IN_INTEGER);
      const expectedNet = amountToSend - expectedFees;
      expect(user1Received).to.equal(expectedNet);

      // User received positive amount
      expect(user1Received).to.be.greaterThan(0);
    });

    it("Should reject resolution price above MAX_PRICE", async function () {
      severeDepegPoolIndex++;
      // Deploy a fresh pool
      const maxPriceParams = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        dpName: "DP-MaxPrice",
        dpSymbol: "DPMAX",
        ybName: "YB-MaxPrice",
        ybSymbol: "YBMAX",
        name: "Max Price Pool",
        flag: "MAX",
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        authorisedRouter: owner.address
      });
      await depegFactory.deployDepeg(maxPriceParams);

      const module = await depegFactory.getDepegModule(severeDepegPoolIndex);
      const testPool = await ethers.getContractAt("DepegPool", module.depegPool);

      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);

      // Oracle tries to update with resolution price above MAX_PRICE
      const oracleAddr = await testPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      
      const aboveMaxPrice = MAX_PRICE + 1n;
      await expect(
        testPool.connect(oracleSigner).updatePriceData(INITIAL_PRICE, aboveMaxPrice)
      ).to.be.revertedWithCustomError(testPool, "PriceOutOfBounds")
        .withArgs(aboveMaxPrice, 0, MAX_PRICE);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);
    });

    it("Should reject HWM price below MIN_PRICE", async function () {
      severeDepegPoolIndex++;
      // Deploy a fresh pool
      const minHwmParams = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        dpName: "DP-MinHWM",
        dpSymbol: "DPMINHWM",
        ybName: "YB-MinHWM",
        ybSymbol: "YBMINHWM",
        name: "Min HWM Pool",
        flag: "MINHWM",
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        authorisedRouter: owner.address
      });
      await depegFactory.deployDepeg(minHwmParams);

      const module = await depegFactory.getDepegModule(severeDepegPoolIndex);
      const testPool = await ethers.getContractAt("DepegPool", module.depegPool);

      // Move to COOLDOWN
      await time.increase(POOL_ACTIVE_DURATION + 1);

      // Oracle tries to update with HWM price below MIN_PRICE (this should still fail)
      const oracleAddr = await testPool.oracle();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddr]);
      const oracleSigner = await ethers.getSigner(oracleAddr);
      await owner.sendTransaction({ to: oracleAddr, value: ethers.parseEther("1") });
      
      const belowMinPrice = MIN_PRICE - 1n;
      await expect(
        testPool.connect(oracleSigner).updatePriceData(belowMinPrice, INITIAL_PRICE)
      ).to.be.revertedWithCustomError(testPool, "PriceOutOfBounds")
        .withArgs(belowMinPrice, MIN_PRICE, MAX_PRICE);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [oracleAddr]);
    });
  });
});

