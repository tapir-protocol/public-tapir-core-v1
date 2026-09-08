import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ITapirOracle } from "../typechain-types";

describe("TapirOracle Constructor and Config Validations", function () {
  let deployer: SignerWithAddress;
  let admin: SignerWithAddress;
  let depegPool: SignerWithAddress;
  
  const ASSET_SYMBOL = "USDT";
  const ASSET_ADDRESS = ethers.ZeroAddress;
  const ASSET_DECIMALS = 6;

  let sources: ITapirOracle.SourcesStruct;
  let config: ITapirOracle.ConfigStruct;

  beforeEach(async function () {
    [deployer, admin, depegPool] = await ethers.getSigners();

    sources = {
      api3ReaderProxyV1IsActive: false,
      api3ReaderProxyV1: ethers.ZeroAddress,
      api3ReaderProxyV1Decimals: 0,
      api3ReaderProxyV1MaxStaleness: 0,
      chainlinkAggregatorV3IsActive: false,
      chainlinkAggregatorV3: ethers.ZeroAddress,
      chainlinkAggregatorV3Decimals: 0,
      chainlinkAggregatorV3MaxStaleness: 0,
      redStoneClassicIsActive: false,
      redStoneClassicAggregator: ethers.ZeroAddress,
      redStoneClassicDecimals: 0,
      redStoneClassicMaxStaleness: 0,
      tellorIsActive: false,
      tellorAdapter: ethers.ZeroAddress,
      tellorDecimals: 0,
      tellorMaxStaleness: 0,
    };

    config = {
      minCheckpointSpacing: 3600,
      minValidSources: 1,
      closingPriceLookbackPeriod: 86400,
      depegPool: depegPool.address,
      xChainMode: false,
      xDomainMessengerL1: ethers.ZeroAddress,
    };
  });

  describe("Constructor", function () {
    it("Should revert if admin is address(0)", async function () {
      const OracleFactory = await ethers.getContractFactory("TapirOracle");
      await expect(
        OracleFactory.deploy(
          ASSET_SYMBOL,
          ASSET_ADDRESS,
          ASSET_DECIMALS,
          sources,
          config,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(OracleFactory, "InvalidAddress");
    });

    it("Should succeed with valid admin", async function () {
      const OracleFactory = await ethers.getContractFactory("TapirOracle");
      const oracle = await OracleFactory.deploy(
        ASSET_SYMBOL,
        ASSET_ADDRESS,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address
      );
      expect(await oracle.hasRole(await oracle.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
    });
  });

  describe("setConfig", function () {
    it("Should revert if depegPool is address(0)", async function () {
      const OracleFactory = await ethers.getContractFactory("TapirOracle");
      const oracle = await OracleFactory.deploy(
        ASSET_SYMBOL,
        ASSET_ADDRESS,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address
      );

      const invalidConfig = { ...config, depegPool: ethers.ZeroAddress };
      await expect(
        oracle.connect(admin).setConfig(invalidConfig)
      ).to.be.revertedWithCustomError(oracle, "InvalidAddress");
    });
  });

  describe("TapirPtrwOracle", function () {
    it("Should revert if admin is address(0)", async function () {
      const OracleFactory = await ethers.getContractFactory("TapirPtrwOracle");
      const pendleConfig = {
        pendleBase: deployer.address,
        pendleRouter: deployer.address,
        pendleYT: deployer.address,
        pendlePT: deployer.address,
        errorTolerance: 0,
      };

      await expect(
        OracleFactory.deploy(
          ASSET_SYMBOL,
          ASSET_ADDRESS,
          ASSET_DECIMALS,
          sources,
          config,
          ethers.ZeroAddress,
          pendleConfig
        )
      ).to.be.revertedWithCustomError(OracleFactory, "InvalidAddress");
    });
  });

  describe("TapirVrpOracle", function () {
    it("Should revert if admin is address(0)", async function () {
      const OracleFactory = await ethers.getContractFactory("TapirVrpOracle");
      const vaultConfig = {
        vault: deployer.address,
        witnessShares: 100,
        errorTolerance: 0,
      };

      await expect(
        OracleFactory.deploy(
          ASSET_SYMBOL,
          ASSET_ADDRESS,
          ASSET_DECIMALS,
          sources,
          config,
          ethers.ZeroAddress,
          vaultConfig
        )
      ).to.be.revertedWithCustomError(OracleFactory, "InvalidAddress");
    });
  });
});
