import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  Api3ReaderProxyMock,
  Mock4626PreviewVault,
  MockDepegPoolForOracle,
  TapirVrpOracle,
} from "../typechain-types";

describe("TapirVrpOracle", function () {
  this.timeout(120000); // Increase timeout for the whole suite to 120s

  let oracle: TapirVrpOracle;
  let vault: Mock4626PreviewVault;
  let api3Mock: Api3ReaderProxyMock;
  let depegPool: MockDepegPoolForOracle;

  let admin: SignerWithAddress;
  let operator: SignerWithAddress;
  let user: SignerWithAddress;

  const ASSET_SYMBOL = "USDT";
  const ASSET_DECIMALS = 6;
  const WITNESS_SHARES = 100_000n;
  const VRP_ACCURACY = 10_000n;
  const ERROR_TOLERANCE = 1_000n;
  const ZERO_ADDRESS = ethers.ZeroAddress;

  async function deployFixture(initialPreviewPerShare = ethers.parseUnits("2", 18)) {
    [admin, operator, user] = await ethers.getSigners();

    const VaultFactory = await ethers.getContractFactory("Mock4626PreviewVault");
    vault = await VaultFactory.deploy(initialPreviewPerShare);

    const DepegPoolFactory = await ethers.getContractFactory("MockDepegPoolForOracle");
    depegPool = await DepegPoolFactory.deploy();

    const currentBlock = await ethers.provider.getBlock("latest");
    const Api3Factory = await ethers.getContractFactory("Api3ReaderProxyMock");
    api3Mock = await Api3Factory.deploy(ethers.parseUnits("1.0", 18), currentBlock!.timestamp);

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

    const vaultConfig = {
      vault: await vault.getAddress(),
      witnessShares: WITNESS_SHARES,
      errorTolerance: ERROR_TOLERANCE,
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
  }

  async function checkpointAtPrice(price: string) {
    const currentBlock = await ethers.provider.getBlock("latest");
    await api3Mock.setData(ethers.parseUnits(price, 18), currentBlock!.timestamp);
    await oracle.connect(operator).recordApi3Price();
    await oracle.connect(operator).checkpoint();
  }

  async function advanceOneDay() {
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine", []);
  }

  async function checkpointDailySeries(prices: string[]) {
    for (let i = 0; i < prices.length; i++) {
      await checkpointAtPrice(prices[i]);
      if (i < prices.length - 1) {
        await advanceOneDay();
      }
    }
  }

  async function checkpointAtPriceWithPreview(price: string, previewPerShare: string) {
    await vault.setPreviewPerShare(ethers.parseUnits(previewPerShare, 18));
    await checkpointAtPrice(price);
  }

  async function checkpointDailySeriesWithPreview(price: string, previewsPerShare: string[]) {
    for (let i = 0; i < previewsPerShare.length; i++) {
      await checkpointAtPriceWithPreview(price, previewsPerShare[i]);
      if (i < previewsPerShare.length - 1) {
        await advanceOneDay();
      }
    }
  }

  it("sets initial VRP HWM from previewRedeem at construction", async function () {
    await deployFixture();

    // L28 deploys mock with previewPerShare = 2e18
    expect(await oracle.vrpHwm()).to.equal(2n * WITNESS_SHARES);
    expect(await oracle.vrpResolved()).to.equal(false);
  });

  it("reverts deployment if witnessShares is below VRP_ACCURACY", async function () {
    [admin] = await ethers.getSigners();

    const VaultFactory = await ethers.getContractFactory("Mock4626PreviewVault");
    const localVault = await VaultFactory.deploy(ethers.parseUnits("1", 18));

    const DepegPoolFactory = await ethers.getContractFactory("MockDepegPoolForOracle");
    const localDepegPool = await DepegPoolFactory.deploy();

    const currentBlock = await ethers.provider.getBlock("latest");
    const Api3Factory = await ethers.getContractFactory("Api3ReaderProxyMock");
    const localApi3 = await Api3Factory.deploy(ethers.parseUnits("1.0", 18), currentBlock!.timestamp);

    const sources = {
      api3ReaderProxyV1IsActive: true,
      api3ReaderProxyV1: await localApi3.getAddress(),
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
      depegPool: await localDepegPool.getAddress(),
      xChainMode: false,
      xDomainMessengerL1: ZERO_ADDRESS,
    };

    const vaultConfig = {
      vault: await localVault.getAddress(),
      witnessShares: VRP_ACCURACY - 1n,
      errorTolerance: ERROR_TOLERANCE,
    };

    const OracleFactory = await ethers.getContractFactory("TapirVrpOracle");
    await expect(
      OracleFactory.deploy(
        ASSET_SYMBOL,
        ZERO_ADDRESS,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address,
        vaultConfig
      )
    ).to.be.revertedWithCustomError(OracleFactory, "InvalidVrpValues");
  });

  it("derives VRP HWM from synchronized checkpoint updates", async function () {
    await deployFixture();
    expect(await oracle.vrpHwm()).to.equal(2n * WITNESS_SHARES);

    await checkpointDailySeriesWithPreview("1.0", ["2.0", "3.0", "2.0", "2.0", "2.0"]);

    // Daily previews: [2,3,2,2,2], triplet mins: [2,2,2] => VRP HWM = 2 (spike-resistant)
    expect(await oracle.vrpHwm()).to.equal(2n * WITNESS_SHARES);
  });

  it("tracks sustained VRP increase via ring-buffer triplets", async function () {
    await deployFixture();

    // Move beyond constructor day so increasing series forms clean daily points.
    await advanceOneDay();
    await checkpointDailySeriesWithPreview("1.0", ["2.5", "3.0", "3.5"]);

    // Daily previews: [2,2.5,3,3.5]
    // Triplet mins: [2,2.5] => VRP HWM = 2.5
    expect(await oracle.vrpHwm()).to.equal(250_000n);
  });

  it("checkpoint() updates both price and VRP buffers in one call", async function () {
    await deployFixture();

    // Move beyond constructor day so a sustained 3x sequence forms distinct daily points.
    await advanceOneDay();

    await vault.setPreviewPerShare(ethers.parseUnits("3", 18));
    await checkpointAtPrice("1.0");
    await advanceOneDay();

    await vault.setPreviewPerShare(ethers.parseUnits("3", 18));
    await checkpointAtPrice("1.0");
    await advanceOneDay();

    await vault.setPreviewPerShare(ethers.parseUnits("3", 18));
    await checkpointAtPrice("1.0");

    // Daily VRP previews: [2,3,3,3] => triplet mins: [2,3] => VRP HWM = 3.
    expect(await oracle.vrpHwm()).to.equal(3n * WITNESS_SHARES);
  });

  it("resolveVrp sets PRV and marks resolved (operator only)", async function () {
    await deployFixture();
    await vault.setPreviewPerShare(ethers.parseUnits("4", 18));

    await expect(oracle.connect(user).resolveVrp()).to.be.reverted;
    await expect(oracle.connect(operator).resolveVrp())
      .to.emit(oracle, "VrpResolved")
      .withArgs(4n * WITNESS_SHARES);

    expect(await oracle.vrpPrv()).to.equal(4n * WITNESS_SHARES);
    expect(await oracle.vrpResolved()).to.equal(true);

    await expect(oracle.connect(operator).resolveVrp()).to.be.revertedWithCustomError(
      oracle,
      "VrpAlreadyResolved"
    );
  });

  it("resolveVrp enables manual mode when PRV is zero", async function () {
    await deployFixture();
    await vault.setPreviewPerShare(0);

    await expect(oracle.connect(operator).resolveVrp())
      .to.emit(oracle, "MustResolveManually");

    expect(await oracle.forceManualResolve()).to.equal(true);
    expect(await oracle.vrpResolved()).to.equal(false);
  });

  it("manual backup can set PRV and resolve after manual mode ", async function () {
    await deployFixture();
    await vault.setPreviewPerShare(0);
    await oracle.connect(operator).resolveVrp();

    // User and operator should not be able to call manualBackupResolveVrp
    await expect(oracle.connect(user).manualBackupResolveVrp(12_345n)).to.be.reverted;
    await expect(oracle.connect(operator).manualBackupResolveVrp(12_345n)).to.be.reverted;

    await expect(oracle.connect(admin).manualBackupResolveVrp(12_345n))
      .to.emit(oracle, "VrpResolved")
      .withArgs(12_345n);

    expect(await oracle.vrpPrv()).to.equal(12_345n);
    expect(await oracle.vrpResolved()).to.equal(true);
  });

  it("manual resolve should be allowed even if VRP is already resolved", async function () {
    await deployFixture();
    await vault.setPreviewPerShare(0);
    await oracle.connect(operator).resolveVrp();

    await oracle.connect(admin).manualBackupResolveVrp(12_345n);

    await expect(oracle.connect(admin).manualBackupResolveVrp(54_321n))
      .to.emit(oracle, "VrpResolved")
      .withArgs(54_321n);
    expect(await oracle.vrpPrv()).to.equal(54_321n);
  });

  it("manual resolve should be allowed even if manual mode is not enabled", async function () {
    await deployFixture();
    await vault.setPreviewPerShare(555);

    await expect(oracle.connect(admin).manualBackupResolveVrp(12_345n))
      .to.emit(oracle, "VrpResolved")
      .withArgs(12_345n);
    expect(await oracle.vrpPrv()).to.equal(12_345n);
  });

  it("manual resolve should allow a value of zero", async function () {
    await deployFixture();
    await expect(oracle.connect(admin).manualBackupResolveVrp(0))
      .to.emit(oracle, "VrpResolved")
      .withArgs(0n);
    expect(await oracle.vrpPrv()).to.equal(0n);
  });

  it("admin manual override changes the calculated resolution price in writePriceData", async function () {
    await deployFixture();

    // Build 5 daily checkpoints: HWM = 1.2
    await checkpointAtPrice("1.0");
    await advanceOneDay();
    await checkpointAtPrice("1.1");
    await advanceOneDay();
    await checkpointAtPrice("1.2");
    await advanceOneDay();
    await checkpointAtPrice("1.3");
    await advanceOneDay();
    await checkpointAtPrice("1.4");

    // Standard operator resolves at 1.0 (50% depeg)
    await vault.setPreviewPerShare(ethers.parseUnits("1", 18));
    await oracle.connect(operator).resolveVrp();

    // Admin overrides to 1.5 (closer to HWM, less depeg)
    await oracle.connect(admin).manualBackupResolveVrp(150_000n);

    await oracle.connect(operator).writePriceData(0);

    // vrpPrv is now 150_000n.
    // effectiveClosingVrp = min(150_000 + 1000, 200_000) = 151_000.
    // adjusted = 1_200_000 * 151_000 / 200_000 = 906_000
    expect(await depegPool.lastHwmPrice()).to.equal(1_200_000n);
    expect(await depegPool.lastClosingPrice()).to.equal(906_000n);
  });

  it("writePriceData uses base oracle HWM and applies VRP depeg to closing price", async function () {
    await deployFixture();

    // Build 5 daily checkpoints so HWM is derived via TapirOracle's triplet algorithm:
    // daily prices = [1.0, 1.1, 1.2, 1.3, 1.4] -> HWM = max(min(triplets)) = 1.2
    await checkpointAtPrice("1.0");
    await advanceOneDay();
    await checkpointAtPrice("1.1");
    await advanceOneDay();
    await checkpointAtPrice("1.2");
    await advanceOneDay();
    await checkpointAtPrice("1.3");
    await advanceOneDay();
    await checkpointAtPrice("1.4");

    // Set current PRV to 1n * WITNESS_SHARES and resolve (-50%)
    await vault.setPreviewPerShare(ethers.parseUnits("1", 18));
    await oracle.connect(operator).resolveVrp();

    await oracle.connect(operator).writePriceData(0);

    // Depeg = (1n * WITNESS_SHARES + ERROR_TOLERANCE) / 2n * WITNESS_SHARES = 0.505
    // adjusted for accuracy (10000): 0.505 * 10000 = 5050
    // closingPrice median from 5 daily checkpoints is 1_200_000 (asset decimals = 6)
    // adjusted = 1_200_000 * 5_050 / 10_000 = 606_000
    // hwmPrice from TapirOracle triplet algorithm is also 1_200_000
    expect(await depegPool.lastHwmPrice()).to.equal(1_200_000n);
    expect(await depegPool.lastClosingPrice()).to.equal(606_000n);
    expect(await depegPool.updateCount()).to.equal(1n);
  });

  it("writePriceData scales both HWM and closing by VRP growth vs initial preview", async function () {
    await deployFixture();

    // Base oracle prices: HWM = closing = 1_200_000 from daily sequence below.
    await checkpointAtPrice("1.0");
    await advanceOneDay();
    await checkpointAtPrice("1.1");
    await advanceOneDay();
    await checkpointAtPrice("1.2");
    await advanceOneDay();
    await checkpointAtPrice("1.3");
    await advanceOneDay();
    await checkpointAtPrice("1.4");

    // Increase preview from initial 2x to 3x and resolve.
    // Build sustained 3x VRP checkpoints so triplet-based VRP HWM also moves to 3x.
    await vault.setPreviewPerShare(ethers.parseUnits("3", 18));
    await advanceOneDay();
    // Use 1.2 for synced checkpoints so base oracle HWM/closing remain at 1.2 while VRP ramps to 3x.
    await checkpointDailySeriesWithPreview("1.2", ["3.0", "3.0", "3.0"]);
    await oracle.connect(operator).resolveVrp();

    await oracle.connect(operator).writePriceData(0);

    // adjustedHwm = 1_200_000 * 3 / 2 = 1_800_000
    // adjustedClosing = 1_200_000 * 3 / 2 = 1_800_000
    expect(await depegPool.lastHwmPrice()).to.equal(1_800_000n);
    expect(await depegPool.lastClosingPrice()).to.equal(1_800_000n);
  });

  it("shows depeg due to oracle price change only", async function () {
    await deployFixture();

    // Older 3-day high regime sets base HWM, last 5 days are low and set closing.
    // Base oracle: HWM = 1_400_000, closing = 1_000_000 (depeg from oracle path alone).
    await checkpointDailySeries(["1.4", "1.4", "1.4", "1.0", "1.0", "1.0", "1.0", "1.0"]);

    // Keep VRP unchanged versus initial snapshot (2x -> 2x), so VRP contributes no depeg.
    await vault.setPreviewPerShare(ethers.parseUnits("2", 18));
    await oracle.connect(operator).resolveVrp();
    await oracle.connect(operator).writePriceData(0);

    expect(await depegPool.lastHwmPrice()).to.equal(1_400_000n);
    expect(await depegPool.lastClosingPrice()).to.equal(1_000_000n);
  });

  it("shows depeg due to VRP change only", async function () {
    await deployFixture();

    // Base oracle path with no oracle depeg: HWM = closing = 1_200_000.
    await checkpointDailySeries(["1.0", "1.1", "1.2", "1.3", "1.4"]);

    // VRP depegs from 2x -> 1x, with tolerance applied.
    await vault.setPreviewPerShare(ethers.parseUnits("1", 18));
    await oracle.connect(operator).resolveVrp();
    await oracle.connect(operator).writePriceData(0);

    // HWM remains at 1_200_000 while closing is reduced by VRP factor 5050/10000.
    expect(await depegPool.lastHwmPrice()).to.equal(1_200_000n);
    expect(await depegPool.lastClosingPrice()).to.equal(606_000n);
  });

  it("shows depeg due to both oracle price change and VRP change", async function () {
    await deployFixture();

    // Oracle-only component: base HWM 1_400_000, base closing 1_000_000.
    await checkpointDailySeries(["1.4", "1.4", "1.4", "1.0", "1.0", "1.0", "1.0", "1.0"]);

    // VRP-only component: apply 2x -> 1x depeg with tolerance.
    await vault.setPreviewPerShare(ethers.parseUnits("1", 18));
    await oracle.connect(operator).resolveVrp();
    await oracle.connect(operator).writePriceData(0);

    // Combined output:
    // adjustedHwm = 1_400_000 * 2 / 2 = 1_400_000
    // adjustedClosing = 1_000_000 * (1 + tol) / 2 = 505_000
    expect(await depegPool.lastHwmPrice()).to.equal(1_400_000n);
    expect(await depegPool.lastClosingPrice()).to.equal(505_000n);
  });

  it("[H-01] writePriceData clamps adjusted prices to MAX_PRICE", async function () {
    await deployFixture();
    
    // Set a low MAX_PRICE in the mock pool
    const maxPriceLimit = ethers.parseUnits("1.5", 6); // 1.5 in asset decimals
    await depegPool.setMaxPrice(maxPriceLimit);

    // VRP growth: initial 2 -> current 4 (2x growth)
    await vault.setPreviewPerShare(ethers.parseUnits("4", 18));
    
    // Need enough checkpoints for HWM (3 triplets) and Median (5 points)
    for (let i = 0; i < 5; i++) {
        await advanceOneDay();
        await checkpointAtPrice("1.0");
    }
    
    await oracle.connect(operator).resolveVrp(); // PRV = 4.0 * WITNESS_SHARES

    // Without clamping:
    // adjustedHwmPrice = 1.0 * (4 / 2) = 2.0
    // adjustedClosingPrice = 1.0 * (4 / 2) = 2.0 (assuming no tolerance depeg)
    
    // Both 2.0 > 1.5, so they should be clamped to 1.5
    await oracle.connect(operator).writePriceData(100_000);

    expect(await depegPool.lastHwmPrice()).to.equal(maxPriceLimit);
    expect(await depegPool.lastClosingPrice()).to.equal(maxPriceLimit);
  });

  it("writePriceData is restricted to operator role", async function () {
    await deployFixture();

    // Need 3 daily checkpoints for HWM
    await checkpointAtPrice("1.0");
    await advanceOneDay();
    await checkpointAtPrice("1.0");
    await advanceOneDay();
    await checkpointAtPrice("1.0");

    await vault.setPreviewPerShare(ethers.parseUnits("1", 18));
    await oracle.connect(operator).resolveVrp();

    // User should not be able to call writePriceData
    await expect(oracle.connect(user).writePriceData(0)).to.be.reverted;

    // Operator should be able to call writePriceData
    await expect(oracle.connect(operator).writePriceData(0)).to.not.be.reverted;
  });

  describe("xChainMode restriction", function () {
    it("should revert if deployed with xChainMode = true", async function () {
      await deployFixture();
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
        xChainMode: true,
        xDomainMessengerL1: user.address,
      };

      const vaultConfig = {
        vault: await vault.getAddress(),
        witnessShares: WITNESS_SHARES,
        errorTolerance: ERROR_TOLERANCE,
      };

      const OracleFactory = await ethers.getContractFactory("TapirVrpOracle");
      await expect(
        OracleFactory.deploy(
          ASSET_SYMBOL,
          ZERO_ADDRESS,
          ASSET_DECIMALS,
          sources,
          config,
          admin.address,
          vaultConfig
        )
      ).to.be.revertedWithCustomError(OracleFactory, "XChainModeNotSupported");
    });

    it("should revert if setConfig is called with xChainMode = true", async function () {
      await deployFixture();
      const config = {
        minCheckpointSpacing: 0,
        minValidSources: 1,
        closingPriceLookbackPeriod: 86400,
        depegPool: await depegPool.getAddress(),
        xChainMode: true,
        xDomainMessengerL1: user.address, // Provide non-zero address to pass TapirOracle validation
      };

      await expect(
        oracle.connect(admin).setConfig(config)
      ).to.be.revertedWithCustomError(oracle, "XChainModeNotSupported");
    });
  });
});
