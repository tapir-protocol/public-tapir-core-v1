import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  TapirOracle,
  TapirVrpOracle,
  TapirPtrwOracle,
  Api3ReaderProxyMock,
  MockDepegPoolForOracle,
  Mock4626PreviewVault,
  Token
} from "../typechain-types";

describe("Oracle Pause Scope [Q-09]", function () {
  let admin: SignerWithAddress;
  let operator: SignerWithAddress;
  let user: SignerWithAddress;

  const ASSET_SYMBOL = "USDT";
  const ASSET_DECIMALS = 6;
  const ZERO_ADDRESS = ethers.ZeroAddress;

  // Shared setup components
  let api3Mock: Api3ReaderProxyMock;
  let depegPool: MockDepegPoolForOracle;

  beforeEach(async function () {
    [admin, operator, user] = await ethers.getSigners();

    const currentBlock = await ethers.provider.getBlock("latest");
    const Api3Factory = await ethers.getContractFactory("Api3ReaderProxyMock");
    api3Mock = await Api3Factory.deploy(ethers.parseUnits("1.0", 18), currentBlock!.timestamp);

    const DepegPoolFactory = await ethers.getContractFactory("MockDepegPoolForOracle");
    depegPool = await DepegPoolFactory.deploy();
  });

  async function getBaseOracleSetup() {
    const sources = {
      api3ReaderProxyV1IsActive: true,
      api3ReaderProxyV1: await api3Mock.getAddress(),
      api3ReaderProxyV1Decimals: 18,
      api3ReaderProxyV1MaxStaleness: 86400,
      chainlinkAggregatorV3IsActive: false,
      chainlinkAggregatorV3: ZERO_ADDRESS,
      chainlinkAggregatorV3Decimals: 18,
      chainlinkAggregatorV3MaxStaleness: 86400,
      redStoneClassicIsActive: false,
      redStoneClassicAggregator: ZERO_ADDRESS,
      redStoneClassicDecimals: 8,
      redStoneClassicMaxStaleness: 86400,
      tellorIsActive: false,
      tellorAdapter: ZERO_ADDRESS,
      tellorDecimals: 8,
      tellorMaxStaleness: 86400,
    };

    const config = {
      minCheckpointSpacing: 0,
      minValidSources: 1,
      closingPriceLookbackPeriod: 86400,
      depegPool: await depegPool.getAddress(),
      xChainMode: false,
      xDomainMessengerL1: ZERO_ADDRESS,
    };

    return { sources, config };
  }

  describe("TapirOracle", function () {
    let oracle: TapirOracle;

    beforeEach(async function () {
      const { sources, config } = await getBaseOracleSetup();
      const OracleFactory = await ethers.getContractFactory("TapirOracle");
      oracle = await OracleFactory.deploy(
        ASSET_SYMBOL,
        ZERO_ADDRESS,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address
      );

      const operatorRole = await oracle.OPERATOR_ROLE();
      await oracle.connect(admin).grantRole(operatorRole, operator.address);
      await oracle.connect(admin).pause();
    });

    it("should revert recordApi3Price when paused", async function () {
      await expect(oracle.connect(operator).recordApi3Price()).to.be.revertedWithCustomError(oracle, "EnforcedPause");
    });

    it("should revert recordChainlinkPrice when paused", async function () {
      await expect(oracle.connect(operator).recordChainlinkPrice()).to.be.revertedWithCustomError(oracle, "EnforcedPause");
    });

    it("should revert recordRedStoneClassicPrice when paused", async function () {
      await expect(oracle.connect(operator).recordRedStoneClassicPrice()).to.be.revertedWithCustomError(oracle, "EnforcedPause");
    });

    it("should revert recordTellorPrice when paused", async function () {
      await expect(oracle.connect(operator).recordTellorPrice()).to.be.revertedWithCustomError(oracle, "EnforcedPause");
    });

    it("should revert writePriceData when paused", async function () {
      await expect(oracle.connect(operator).writePriceData(0)).to.be.revertedWithCustomError(oracle, "EnforcedPause");
    });
  });

  describe("TapirVrpOracle", function () {
    let oracle: TapirVrpOracle;
    let vault: Mock4626PreviewVault;

    beforeEach(async function () {
      const { sources, config } = await getBaseOracleSetup();
      
      const VaultFactory = await ethers.getContractFactory("Mock4626PreviewVault");
      vault = await VaultFactory.deploy(ethers.parseUnits("2", 18));

      const vaultConfig = {
        vault: await vault.getAddress(),
        witnessShares: 100_000n,
        errorTolerance: 1_000n,
      };

      const OracleFactory = await ethers.getContractFactory("TapirVrpOracle");
      oracle = await OracleFactory.deploy(
        ASSET_SYMBOL,
        ZERO_ADDRESS,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address,
        vaultConfig
      );

      const operatorRole = await oracle.OPERATOR_ROLE();
      await oracle.connect(admin).grantRole(operatorRole, operator.address);
      await oracle.connect(admin).pause();
    });

    it("should revert resolveVrp when paused", async function () {
      await expect(oracle.connect(operator).resolveVrp()).to.be.revertedWithCustomError(oracle, "EnforcedPause");
    });

    it("should revert writePriceData when paused", async function () {
      await expect(oracle.connect(operator).writePriceData(0)).to.be.revertedWithCustomError(oracle, "EnforcedPause");
    });
  });

  describe("TapirPtrwOracle", function () {
    let oracle: TapirPtrwOracle;

    beforeEach(async function () {
      const { sources, config } = await getBaseOracleSetup();
      
      const MockToken = await ethers.getContractFactory("Token");
      const mockPendleBase = await MockToken.deploy();
      const mockPendleRouter = await MockToken.deploy();
      const mockPendleYT = await MockToken.deploy();
      const mockPendlePT = await MockToken.deploy();
      
      const pendleConfig = {
        pendleBase: await mockPendleBase.getAddress(),
        pendleRouter: await mockPendleRouter.getAddress(),
        pendleYT: await mockPendleYT.getAddress(),
        pendlePT: await mockPendlePT.getAddress(),
        errorTolerance: ethers.parseUnits("0.001", 18),
      };

      const OracleFactory = await ethers.getContractFactory("TapirPtrwOracle");
      oracle = await OracleFactory.deploy(
        ASSET_SYMBOL,
        ZERO_ADDRESS,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address,
        pendleConfig
      );

      const operatorRole = await oracle.OPERATOR_ROLE();
      await oracle.connect(admin).grantRole(operatorRole, operator.address);
      await oracle.connect(admin).pause();
    });

    it("should revert resolvePtrw when paused", async function () {
      await expect(oracle.connect(operator).resolvePtrw()).to.be.revertedWithCustomError(oracle, "EnforcedPause");
    });

    it("should revert writePriceData when paused", async function () {
      await expect(oracle.connect(operator).writePriceData(0)).to.be.revertedWithCustomError(oracle, "EnforcedPause");
    });
  });
});
