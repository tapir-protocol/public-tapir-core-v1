import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { 
  DepegPool, 
  DepegFactory, 
  SimpleMockOracle
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("DepegPool Oracle Change Flows", function () {
  let depegPool: DepegPool;
  let depegFactory: DepegFactory;
  let mockOracle: SimpleMockOracle;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let baseAsset: any;

  const ORACLE_CHANGE_DELAY = 7 * 24 * 60 * 60; // 7 days

  function createDepegPoolParams(overrides: any = {}) {
    return {
      assetAddress: overrides.assetAddress ?? ethers.ZeroAddress,
      dpMetadata: {
        name: "DP Token",
        symbol: "DP"
      },
      ybMetadata: {
        name: "YB Token",
        symbol: "YB"
      },
      oracle: overrides.oracle ?? ethers.ZeroAddress,
      poolActiveDuration: 7 * 24 * 60 * 60,
      name: "Test Pool",
      flag: "TEST",
      redemptionFeeBp: 10,
      cooldownDuration: 5 * 60 * 60,
      poolOwner: overrides.poolOwner ?? ethers.ZeroAddress,
      minPrice: ethers.parseEther("0.5"),
      maxPrice: ethers.parseEther("2"),
      treasury: overrides.treasury ?? ethers.ZeroAddress,
      authorisedRouter: ethers.ZeroAddress,
      minPriceAge: 5 * 60 * 60,
      xDomainMessengerL2: overrides.xDomainMessengerL2 ?? ethers.ZeroAddress
    };
  }

  beforeEach(async function () {
    [owner, treasury] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("WtETHMock");
    baseAsset = await MockERC20.deploy();

    const DepegFactory = await ethers.getContractFactory("DepegFactory");
    depegFactory = await DepegFactory.deploy();

    const SimpleMockOracle = await ethers.getContractFactory("SimpleMockOracle");
    mockOracle = await SimpleMockOracle.deploy();
  });

  describe("Same-chain Mode (xDomainMessengerL2 == 0)", function () {
    beforeEach(async function () {
      const params = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        oracle: await mockOracle.getAddress(),
        poolOwner: owner.address,
        treasury: treasury.address,
        xDomainMessengerL2: ethers.ZeroAddress
      });
      await depegFactory.deployDepeg(params);
      const depegModule = await depegFactory.getDepegModule(0);
      depegPool = await ethers.getContractAt("DepegPool", depegModule.depegPool);
      await mockOracle.setDepegPool(await depegPool.getAddress());
    });

    it("Should allow proposing a valid oracle contract", async function () {
      const SimpleMockOracle = await ethers.getContractFactory("SimpleMockOracle");
      const newOracle = await SimpleMockOracle.deploy();
      await newOracle.setDepegPool(await depegPool.getAddress());

      await expect(depegPool.connect(owner).proposeOracleChange(await newOracle.getAddress()))
        .to.emit(depegPool, "OracleChangeProposed");
      
      expect(await depegPool.pendingOracle()).to.equal(await newOracle.getAddress());
    });

    it("Should revert when proposing a non-contract address", async function () {
      const nonContract = ethers.Wallet.createRandom().address;
      await expect(depegPool.connect(owner).proposeOracleChange(nonContract))
        .to.be.revertedWithCustomError(depegPool, "NotAContract");
    });

    it("Should revert when proposing a contract with wrong depegPool in cfg()", async function () {
      const SimpleMockOracle = await ethers.getContractFactory("SimpleMockOracle");
      const newOracle = await SimpleMockOracle.deploy();
      // Don't set depegPool, or set it to something else
      await newOracle.setDepegPool(ethers.Wallet.createRandom().address);

      await expect(depegPool.connect(owner).proposeOracleChange(await newOracle.getAddress()))
        .to.be.revertedWithCustomError(depegPool, "OracleDepegPoolMismatch");
    });

    it("Should revert when proposing a contract that doesn't implement cfg()", async function () {
      // Use the base asset (ERC20) as it doesn't have cfg()
      await expect(depegPool.connect(owner).proposeOracleChange(await baseAsset.getAddress()))
        .to.be.revertedWithCustomError(depegPool, "InvalidOracleInterface");
    });

    it("Should allow executing the oracle change after delay", async function () {
      const SimpleMockOracle = await ethers.getContractFactory("SimpleMockOracle");
      const newOracle = await SimpleMockOracle.deploy();
      await newOracle.setDepegPool(await depegPool.getAddress());

      await depegPool.connect(owner).proposeOracleChange(await newOracle.getAddress());
      
      await time.increase(ORACLE_CHANGE_DELAY);

      await expect(depegPool.executeOracleChange())
        .to.emit(depegPool, "OracleUpdated")
        .withArgs(await newOracle.getAddress());
      
      expect(await depegPool.oracle()).to.equal(await newOracle.getAddress());
    });
  });

  describe("Cross-chain Mode (xDomainMessengerL2 != 0)", function () {
    const mockMessenger = "0x4200000000000000000000000000000000000007";

    beforeEach(async function () {
      const params = createDepegPoolParams({
        assetAddress: await baseAsset.getAddress(),
        oracle: ethers.Wallet.createRandom().address, // Initial oracle can be EOA/L1 address
        poolOwner: owner.address,
        treasury: treasury.address,
        xDomainMessengerL2: mockMessenger
      });
      await depegFactory.deployDepeg(params);
      const depegModule = await depegFactory.getDepegModule(0);
      depegPool = await ethers.getContractAt("DepegPool", depegModule.depegPool);
    });

    it("Should allow proposing a non-contract (EOA/L1) address", async function () {
      const newL1Oracle = ethers.Wallet.createRandom().address;

      await expect(depegPool.connect(owner).proposeOracleChange(newL1Oracle))
        .to.emit(depegPool, "OracleChangeProposed");
      
      expect(await depegPool.pendingOracle()).to.equal(newL1Oracle);
    });

    it("Should allow proposing a contract address (even if it's not an oracle on L2)", async function () {
      // In cross-chain mode, it skips all checks, even if it happens to be a contract on L2
      const randomContract = await baseAsset.getAddress();

      await expect(depegPool.connect(owner).proposeOracleChange(randomContract))
        .to.emit(depegPool, "OracleChangeProposed");
      
      expect(await depegPool.pendingOracle()).to.equal(randomContract);
    });

    it("Should allow executing the oracle change after delay", async function () {
      const newL1Oracle = ethers.Wallet.createRandom().address;

      await depegPool.connect(owner).proposeOracleChange(newL1Oracle);
      
      await time.increase(ORACLE_CHANGE_DELAY);

      // This is the line the user asked about: oracle = ITapirOracle(cachedPendingOracle);
      // It should NOT revert.
      await expect(depegPool.executeOracleChange())
        .to.emit(depegPool, "OracleUpdated")
        .withArgs(newL1Oracle);
      
      expect(await depegPool.oracle()).to.equal(newL1Oracle);
    });

    it("Should revert when proposing zero address even in cross-chain mode", async function () {
      await expect(depegPool.connect(owner).proposeOracleChange(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(depegPool, "ZeroAddress");
    });
  });
});
