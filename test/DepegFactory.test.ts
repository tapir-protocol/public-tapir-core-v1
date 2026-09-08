import { expect } from "chai";
import { ethers } from "hardhat";
import { DepegFactory } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("DepegFactory", function () {
  // Contracts
  let depegFactory: DepegFactory;
  let baseAsset: any;
  let mockOracle: any;

  // Signers
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let nonAuthorized: SignerWithAddress;
  let treasury: SignerWithAddress;

  // Constants
  const MIN_PRICE = ethers.parseEther("0.5"); // 0.5 ETH
  const MAX_PRICE = ethers.parseEther("2"); // 2 ETH
  const POOL_ACTIVE_DURATION = 7 * 24 * 60 * 60; // 7 days
  const COOLDOWN_DURATION = 5 * 60 * 60; // 5 hours
  const REDEMPTION_FEE_BP = 10; // 0.1%
  const MIN_PRICE_AGE = 5 * 60 * 60; // 5 hours

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
      poolActiveDuration: overrides.poolActiveDuration ?? POOL_ACTIVE_DURATION,
      name: overrides.name ?? "Test Pool",
      flag: overrides.flag ?? "TEST",
      redemptionFeeBp: overrides.redemptionFeeBp ?? REDEMPTION_FEE_BP,
      cooldownDuration: overrides.cooldownDuration ?? COOLDOWN_DURATION,
      poolOwner: overrides.poolOwner ?? ethers.ZeroAddress,
      minPrice: overrides.minPrice ?? MIN_PRICE,
      maxPrice: overrides.maxPrice ?? MAX_PRICE,
      treasury: overrides.treasury ?? ethers.ZeroAddress,
      authorisedRouter: overrides.authorisedRouter ?? ethers.ZeroAddress,
      minPriceAge: overrides.minPriceAge ?? MIN_PRICE_AGE,
      xDomainMessengerL2: overrides.xDomainMessengerL2 ?? ethers.ZeroAddress
    };
  }

  beforeEach(async function () {
    [owner, user1, user2, nonAuthorized, treasury] = await ethers.getSigners();

    // Deploy mock ERC20 token as base asset
    const MockERC20 = await ethers.getContractFactory("WtETHMock");
    baseAsset = await MockERC20.deploy();

    // Deploy simple mock oracle
    const SimpleMockOracle = await ethers.getContractFactory("SimpleMockOracle");
    mockOracle = await SimpleMockOracle.deploy();

    // Deploy factory (owner will be the deployer by default)
    const DepegFactory = await ethers.getContractFactory("DepegFactory");
    depegFactory = await DepegFactory.deploy();
  });

  describe("Deployment", function () {
    it("Should set the correct owner", async function () {
      expect(await depegFactory.owner()).to.equal(owner.address);
    });
  });

  describe("Owner-only Access Control", function () {
    describe("Owner can deploy pools", function () {
      it("Should allow owner to deploy a DepegPool", async function () {
        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address
        });
        await expect(
          depegFactory.connect(owner).deployDepeg(params)
        ).to.not.be.reverted;
      });

      it("Should emit DeployDepeg event when owner deploys", async function () {
        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address
        });
        await expect(
          depegFactory.connect(owner).deployDepeg(params)
        ).to.emit(depegFactory, "DeployDepeg");
      });

      it("Should allow owner to deploy multiple pools", async function () {
        // Deploy first pool
        const params1 = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          dpName: "DP Token 1",
          dpSymbol: "DP1",
          ybName: "YB Token 1",
          ybSymbol: "YB1",
          name: "Test Pool 1",
          flag: "TEST1",
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address
        });
        await depegFactory.connect(owner).deployDepeg(params1);

        // Deploy second pool
        const params2 = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          dpName: "DP Token 2",
          dpSymbol: "DP2",
          ybName: "YB Token 2",
          ybSymbol: "YB2",
          name: "Test Pool 2",
          flag: "TEST2",
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address
        });
        await expect(
          depegFactory.connect(owner).deployDepeg(params2)
        ).to.not.be.reverted;

        // Verify both pools were created
        const module0 = await depegFactory.getDepegModule(0);
        const module1 = await depegFactory.getDepegModule(1);
        
        expect(module0.depegPool).to.not.equal(ethers.ZeroAddress);
        expect(module1.depegPool).to.not.equal(ethers.ZeroAddress);
        expect(module0.depegPool).to.not.equal(module1.depegPool);
      });
    });

    describe("Non-owners cannot deploy pools", function () {
      it("Should revert when user1 tries to deploy a pool", async function () {
        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          oracle: await mockOracle.getAddress(),
          poolOwner: user1.address,
          treasury: treasury.address,
          authorisedRouter: user1.address
        });
        await expect(
          depegFactory.connect(user1).deployDepeg(params)
        ).to.be.revertedWithCustomError(depegFactory, "OwnableUnauthorizedAccount");
      });

      it("Should revert when user2 tries to deploy a pool", async function () {
        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          oracle: await mockOracle.getAddress(),
          poolOwner: user2.address,
          treasury: treasury.address,
          authorisedRouter: user2.address
        });
        await expect(
          depegFactory.connect(user2).deployDepeg(params)
        ).to.be.revertedWithCustomError(depegFactory, "OwnableUnauthorizedAccount");
      });

      it("Should revert when non-authorized user tries to deploy a pool", async function () {
        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          oracle: await mockOracle.getAddress(),
          poolOwner: nonAuthorized.address,
          treasury: treasury.address,
          authorisedRouter: nonAuthorized.address
        });
        await expect(
          depegFactory.connect(nonAuthorized).deployDepeg(params)
        ).to.be.revertedWithCustomError(depegFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("Ownership Transfer", function () {
      it("Should allow new owner to deploy after ownership transfer", async function () {
        // Transfer ownership to user1
        await depegFactory.connect(owner).transferOwnership(user1.address);
        
        // Verify new owner
        expect(await depegFactory.owner()).to.equal(user1.address);

        // New owner should be able to deploy
        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          oracle: await mockOracle.getAddress(),
          poolOwner: user1.address,
          treasury: treasury.address,
          authorisedRouter: user1.address
        });
        await expect(
          depegFactory.connect(user1).deployDepeg(params)
        ).to.not.be.reverted;
      });

      it("Should prevent old owner from deploying after ownership transfer", async function () {
        // Transfer ownership to user1
        await depegFactory.connect(owner).transferOwnership(user1.address);

        // Old owner should not be able to deploy
        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address
        });
        await expect(
          depegFactory.connect(owner).deployDepeg(params)
        ).to.be.revertedWithCustomError(depegFactory, "OwnableUnauthorizedAccount");
      });

      it("Should prevent non-owner from transferring ownership", async function () {
        await expect(
          depegFactory.connect(user1).transferOwnership(user1.address)
        ).to.be.revertedWithCustomError(depegFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("Edge Cases", function () {
      it("Should prevent deployment after ownership renouncement", async function () {
        // Renounce ownership (transfer to zero address)
        await depegFactory.connect(owner).renounceOwnership();

        // Verify ownership is renounced
        expect(await depegFactory.owner()).to.equal(ethers.ZeroAddress);

        // Should not allow anyone to deploy
        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address
        });
        await expect(
          depegFactory.connect(owner).deployDepeg(params)
        ).to.be.revertedWithCustomError(depegFactory, "OwnableUnauthorizedAccount");
      });

      it("Should maintain access control across multiple users", async function () {
        // Owner deploys first
        const params1 = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address
        });
        await depegFactory.connect(owner).deployDepeg(params1);

        // Non-owners still can't deploy
        const params2 = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          dpName: "DP Token 2",
          dpSymbol: "DP2",
          ybName: "YB Token 2",
          ybSymbol: "YB2",
          name: "Test Pool 2",
          flag: "TEST2",
          oracle: await mockOracle.getAddress(),
          poolOwner: user1.address,
          treasury: treasury.address,
          authorisedRouter: user1.address
        });
        await expect(
          depegFactory.connect(user1).deployDepeg(params2)
        ).to.be.revertedWithCustomError(depegFactory, "OwnableUnauthorizedAccount");

        // Owner can still deploy
        const params3 = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          dpName: "DP Token 3",
          dpSymbol: "DP3",
          ybName: "YB Token 3",
          ybSymbol: "YB3",
          name: "Test Pool 3",
          flag: "TEST3",
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address
        });
        await expect(
          depegFactory.connect(owner).deployDepeg(params3)
        ).to.not.be.reverted;
      });
    });
  });

  describe("View Functions", function () {
    it("Should return correct depeg module after deployment", async function () {
      const params = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        authorisedRouter: owner.address
      });
      await depegFactory.connect(owner).deployDepeg(params);

      const module = await depegFactory.getDepegModule(0);
      
      expect(module.dpAsset).to.not.equal(ethers.ZeroAddress);
      expect(module.ybAsset).to.not.equal(ethers.ZeroAddress);
      expect(module.depegPool).to.not.equal(ethers.ZeroAddress);
    });

    it("Should track multiple deployed pools correctly", async function () {
      // Deploy three pools
      for (let i = 0; i < 3; i++) {
        const params = createDepegPoolParams({
          assetAddress: await baseAsset.getAddress(),
          dpName: `DP Token ${i}`,
          dpSymbol: `DP${i}`,
          ybName: `YB Token ${i}`,
          ybSymbol: `YB${i}`,
          name: `Test Pool ${i}`,
          flag: `TEST${i}`,
          oracle: await mockOracle.getAddress(),
          poolOwner: owner.address,
          treasury: treasury.address,
          authorisedRouter: owner.address
        });
        await depegFactory.connect(owner).deployDepeg(params);
      }

      // Verify all three modules are different
      const module0 = await depegFactory.getDepegModule(0);
      const module1 = await depegFactory.getDepegModule(1);
      const module2 = await depegFactory.getDepegModule(2);

      expect(module0.depegPool).to.not.equal(module1.depegPool);
      expect(module1.depegPool).to.not.equal(module2.depegPool);
      expect(module0.depegPool).to.not.equal(module2.depegPool);
    });
  });

  describe("Cross-Domain Messenger Configuration", function () {
    it("Should allow setting xDomainMessenger to zero address (native-chain mode)", async function () {
      const params = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        dpName: "DP Token L1",
        dpSymbol: "DPL1",
        ybName: "YB Token L1",
        ybSymbol: "YBL1",
        name: "L1 Mode Pool",
        flag: "L1TEST",
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        authorisedRouter: owner.address,
        xDomainMessengerL2: ethers.ZeroAddress
      });
      await depegFactory.connect(owner).deployDepeg(params);

      const module = await depegFactory.getDepegModule(0);
      const depegPool = await ethers.getContractAt("DepegPool", module.depegPool);
      
      // Verify the xDomainMessengerL2 is set to zero address
      expect(await depegPool.xDomainMessengerL2()).to.equal(ethers.ZeroAddress);
    });

    it("Should allow setting xDomainMessenger to non-zero address (cross-chain mode)", async function () {
      // Deploy mock cross-domain messenger
      const MockCrossDomainMessenger = await ethers.getContractFactory("MockCrossDomainMessenger");
      const mockMessenger = await MockCrossDomainMessenger.deploy();
      const messengerAddress = await mockMessenger.getAddress();

      // Deploy pool with messenger address set
      const params = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        dpName: "DP Token L2",
        dpSymbol: "DPL2",
        ybName: "YB Token L2",
        ybSymbol: "YBL2",
        name: "L2 Mode Pool",
        flag: "L2TEST",
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        authorisedRouter: owner.address,
        xDomainMessengerL2: messengerAddress
      });
      await depegFactory.connect(owner).deployDepeg(params);

      const module = await depegFactory.getDepegModule(0);
      const depegPool = await ethers.getContractAt("DepegPool", module.depegPool);
      
      // Verify the xDomainMessengerL2 is set correctly
      expect(await depegPool.xDomainMessengerL2()).to.equal(messengerAddress);
      expect(await depegPool.xDomainMessengerL2()).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe("Validation Checks", function () {
    const MIN_DURATION = 4 * 60 * 60; // 4 hours
    const MAX_DURATION = 30 * 24 * 60 * 60; // 30 days

    it("Should revert if minPrice is zero", async function () {
      const params = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        minPrice: 0n
      });
      await expect(
        depegFactory.connect(owner).deployDepeg(params)
      ).to.be.revertedWithCustomError(depegFactory, "MinPriceMustBeGreaterThanZero");
    });

    it("Should revert if maxPrice is less than or equal to minPrice", async function () {
      const params = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        minPrice: ethers.parseEther("1"),
        maxPrice: ethers.parseEther("1")
      });
      await expect(
        depegFactory.connect(owner).deployDepeg(params)
      ).to.be.revertedWithCustomError(depegFactory, "MaxPriceMustBeGreaterThanMinPrice");
    });

    it("Should revert if poolActiveDuration is zero", async function () {
      const params = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        poolActiveDuration: 0
      });
      await expect(
        depegFactory.connect(owner).deployDepeg(params)
      ).to.be.revertedWithCustomError(depegFactory, "ActiveDurationZero");
    });

    it("Should revert if cooldownDuration is out of bounds", async function () {
      const paramsLow = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        cooldownDuration: MIN_DURATION - 1
      });
      await expect(
        depegFactory.connect(owner).deployDepeg(paramsLow)
      ).to.be.revertedWithCustomError(depegFactory, "CooldownOutOfBounds");

      const paramsHigh = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        cooldownDuration: MAX_DURATION + 1
      });
      await expect(
        depegFactory.connect(owner).deployDepeg(paramsHigh)
      ).to.be.revertedWithCustomError(depegFactory, "CooldownOutOfBounds");
    });

    it("Should revert if minPriceAge is out of bounds", async function () {
      const paramsLow = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        minPriceAge: MIN_DURATION - 1
      });
      await expect(
        depegFactory.connect(owner).deployDepeg(paramsLow)
      ).to.be.revertedWithCustomError(depegFactory, "MinAgeOutOfBounds");

      const paramsHigh = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        minPriceAge: MAX_DURATION + 1
      });
      await expect(
        depegFactory.connect(owner).deployDepeg(paramsHigh)
      ).to.be.revertedWithCustomError(depegFactory, "MinAgeOutOfBounds");
    });
  });
});

