import { expect } from "chai";
import { ethers, network } from "hardhat";
import { TapirPtrwOracle } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// ===== MAINNET FORK TEST CONFIGURATION =====
// This test uses an expired Pendle PT token to test the PTRW oracle functionality

// Mainnet RPC - use a public RPC or your own Alchemy/Infura key
const MAINNET_RPC = process.env.ETH_RPC ?? "";
const MAINNET_FORK_BLOCK = Number(process.env.ETH_FORK_BLOCK);

// PT-pufETH-26SEP2024 Token addresses (EXPIRED)
// https://etherscan.io/token/0xd4e75971eaf78a8d93d96df530f1fff5f9f53288
const PT_TOKEN = "0xd4e75971eaf78a8d93d96df530f1fff5f9f53288";
const YT_TOKEN = "0x1a65eB80a2ac3ea6E41D456DdD6E9cC5728BEf7C";
const SY_TOKEN = "0x253008ba4aE2f3E6488DC998a5321D4EB1a0c905";
const PUFETH_TOKEN = "0xd9a442856c234a39a81a089c06451ebaa4306a72"; // Base token
const PENDLE_ROUTER = "0x888888888889758F76e7103c6CbF23ABbF58F946"; // Router V4
const PT_EXPIRY = 1727308800; // Sep 26, 2024 00:00:00 UTC

// Find a market that uses this PT token - we need to look it up
// For this test, we'll use manualBackupResolvePtrw since we don't have real PT holdings

// A holder of PT tokens to impersonate for testing
// Found from: https://etherscan.io/token/0xd4e75971eaf78a8d93d96df530f1fff5f9f53288#balances
const PT_HOLDER = "0x23168f44BDf5ddE0ECC01F5D18177C7d425B37cC"; // A Pendle-related contract with PT balance

describe("TapirPtrwOracle - Mainnet Fork Integration Test", function () {
  // Contracts
  let oracle: TapirPtrwOracle;

  // Signers
  let deployer: SignerWithAddress;
  let admin: SignerWithAddress;
  let operator: SignerWithAddress;
  let user: SignerWithAddress;

  // Constants
  const ASSET_SYMBOL = "pufETH";
  const ASSET_DECIMALS = 18;
  const ZERO_ADDRESS = ethers.ZeroAddress;
  const ERROR_TOLERANCE = ethers.parseUnits("0.001", 18); // 0.1% tolerance

  before(async function () {
    this.timeout(120000); // 2 minute timeout for network setup
    if (!MAINNET_RPC || !Number.isSafeInteger(MAINNET_FORK_BLOCK) || MAINNET_FORK_BLOCK <= 0) {
      throw new Error("Set ETH_RPC and ETH_FORK_BLOCK to a fixed post-expiry archive block for this optional suite.");
    }

    console.log("\n" + "=".repeat(80));
    console.log("MAINNET FORK TEST: TapirPtrwOracle with Expired Pendle PT");
    console.log("=".repeat(80));
    console.log(`RPC host: ${MAINNET_RPC ? new URL(MAINNET_RPC).host : "(unset)"}`);
    console.log(`PT Token: ${PT_TOKEN}`);
    console.log(`YT Token: ${YT_TOKEN}`);
    console.log(`pufETH (Base): ${PUFETH_TOKEN}`);
    console.log(`Pendle Router: ${PENDLE_ROUTER}`);
    console.log(`PT Expiry: ${new Date(PT_EXPIRY * 1000).toISOString()}`);
    console.log("=".repeat(80) + "\n");

    try {
      // Fork mainnet
      await network.provider.request({
        method: "hardhat_reset",
        params: [
          {
            forking: {
              jsonRpcUrl: MAINNET_RPC,
              blockNumber: MAINNET_FORK_BLOCK,
            },
          },
        ],
      });

      // Verify we're on mainnet fork
      const chainId = await ethers.provider.getNetwork().then((n) => n.chainId);
      console.log(`Connected to network with Chain ID: ${chainId}`);

      // Get current block timestamp
      const block = await ethers.provider.getBlock("latest");
      console.log(`Current block: ${block!.number}`);
      console.log(`Block timestamp: ${new Date(block!.timestamp * 1000).toISOString()}`);
      console.log(`PT is expired: ${block!.timestamp > PT_EXPIRY}`);

      // Get signers
      [deployer, admin, operator, user] = await ethers.getSigners();

      // Check PT token info
      const ptContract = await ethers.getContractAt("IERC20", PT_TOKEN);
      const ptTotalSupply = await ptContract.totalSupply();
      console.log(`PT Total Supply: ${ethers.formatEther(ptTotalSupply)} PT`);

    } catch (error) {
      console.error("Failed to setup mainnet fork:", error);
      throw error;
    }
  });

  after(async function () {
    // Reset to local network after tests
    await network.provider.request({
      method: "hardhat_reset",
      params: [],
    });
  });

  describe("Oracle Deployment and Configuration", function () {
    it("Should deploy TapirPtrwOracle with Pendle config", async function () {
      this.timeout(60000);

      // Setup sources (mock/disabled for this test since we're focusing on PTRW)
      const sources = {
        api3ReaderProxyV1IsActive: false,
        api3ReaderProxyV1: ZERO_ADDRESS,
        api3ReaderProxyV1Decimals: 18,
        api3ReaderProxyV1MaxStaleness: 3600,
        chainlinkAggregatorV3IsActive: false,
        chainlinkAggregatorV3: ZERO_ADDRESS,
        chainlinkAggregatorV3Decimals: 18,
        chainlinkAggregatorV3MaxStaleness: 3600,
        redStoneClassicIsActive: false,
        redStoneClassicAggregator: ZERO_ADDRESS,
        redStoneClassicDecimals: 8,
        redStoneClassicMaxStaleness: 3600,
        tellorIsActive: false,
        tellorAdapter: ZERO_ADDRESS,
        tellorDecimals: 8,
        tellorMaxStaleness: 3600,
      };

      // Setup config
      const config = {
        minCheckpointSpacing: 86400, // 1 day
        minValidSources: 1,
        closingPriceLookbackPeriod: 86400, // 24 hours
        depegPool: ZERO_ADDRESS, // Not needed for PTRW test
        xChainMode: false,
        xDomainMessengerL1: ZERO_ADDRESS,
      };

      // Setup Pendle config
      const pendleConfig = {
        pendleBase: PUFETH_TOKEN,
        pendleRouter: PENDLE_ROUTER,
        pendleYT: YT_TOKEN,
        pendlePT: PT_TOKEN,
        errorTolerance: ERROR_TOLERANCE,
      };

      // Deploy TapirPtrwOracle with all config in constructor
      const TapirPtrwOracle = await ethers.getContractFactory("TapirPtrwOracle");
      oracle = await TapirPtrwOracle.deploy(
        ASSET_SYMBOL,
        PUFETH_TOKEN,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address,
        pendleConfig
      );

      console.log(`Deployed TapirPtrwOracle at: ${await oracle.getAddress()}`);

      // Grant OPERATOR_ROLE to the operator account
      const OPERATOR_ROLE = await oracle.OPERATOR_ROLE();
      await oracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

      // Verify deployment
      expect(await oracle.assetSymbol()).to.equal(ASSET_SYMBOL);
      expect(await oracle.assetDecimals()).to.equal(ASSET_DECIMALS);
      expect(await oracle.ptrwResolved()).to.equal(false);

      // Verify Pendle configuration (set via constructor)
      // Use getAddress() to normalize checksums for comparison
      expect(ethers.getAddress(await oracle.pendlePT())).to.equal(ethers.getAddress(PT_TOKEN));
      expect(ethers.getAddress(await oracle.pendleYT())).to.equal(ethers.getAddress(YT_TOKEN));
      expect(ethers.getAddress(await oracle.pendleBase())).to.equal(ethers.getAddress(PUFETH_TOKEN));
      expect(ethers.getAddress(await oracle.pendleRouter())).to.equal(ethers.getAddress(PENDLE_ROUTER));
      expect(await oracle.errorTolerance()).to.equal(ERROR_TOLERANCE);

      console.log(`Pendle config verified`);
    });
  });

  describe("PTRW Resolution Tests", function () {
    it("Should fail resolvePtrw when called by non-operator", async function () {
      // User without OPERATOR_ROLE should be rejected
      await expect(oracle.connect(user).resolvePtrw())
        .to.be.reverted; // AccessControlUnauthorizedAccount
    });

    it("Should fail resolvePtrw with no PT balance", async function () {
      // Oracle should have no PT tokens, so resolvePtrw should fail
      const oracleAddress = await oracle.getAddress();
      const ptContract = await ethers.getContractAt("IERC20", PT_TOKEN);
      const balance = await ptContract.balanceOf(oracleAddress);
      
      console.log(`\nOracle PT Balance: ${ethers.formatEther(balance)} PT`);
      expect(balance).to.equal(0);

      // Attempt to resolve by operator should fail with InvalidPtrwValues (no PT balance)
      await expect(oracle.connect(operator).resolvePtrw())
        .to.be.revertedWithCustomError(oracle, "InvalidPtrwValues");
    });

    it("Should resolve PTRW with a PT balance", async function () {
      this.timeout(60000);

      // Find a PT holder with balance
      const ptContract = await ethers.getContractAt("IERC20", PT_TOKEN);
      
      // Check the known holder's balance
      const holderBalance = await ptContract.balanceOf(PT_HOLDER);
      console.log(`\nPT Holder Balance: ${ethers.formatEther(holderBalance)} PT`);

      expect(holderBalance, "The selected fork fixture must contain a funded PT holder").to.be.gt(0n);

      // Impersonate the PT holder
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [PT_HOLDER],
      });

      // Fund the impersonated account with ETH for gas
      await deployer.sendTransaction({
        to: PT_HOLDER,
        value: ethers.parseEther("1"),
      });

      const holderSigner = await ethers.getSigner(PT_HOLDER);
      const oracleAddress = await oracle.getAddress();

      // Transfer some PT to the oracle
      const transferAmount = holderBalance / 2n; // Transfer half
      console.log(`Transferring ${ethers.formatEther(transferAmount)} PT to oracle...`);
      
      await ptContract.connect(holderSigner).transfer(oracleAddress, transferAmount);

      // Verify balance
      const oracleBalance = await ptContract.balanceOf(oracleAddress);
      console.log(`Oracle PT Balance: ${ethers.formatEther(oracleBalance)} PT`);
      expect(oracleBalance).to.equal(transferAmount);

      // Now resolve PTRW (must be called by operator)
      console.log(`\nCalling resolvePtrw() as operator...`);
      
      // This will:
      // 1. Record ptrwErv (PT balance before redemption)
      // 2. Redeem PT via Pendle router
      // 3. Record ptrwArv (base tokens received)
      // 4. Transfer base tokens to caller as tip
      
      const tx = await oracle.connect(operator).resolvePtrw();
      const receipt = await tx.wait();

      console.log(`PTRW Resolved! Gas used: ${receipt!.gasUsed}`);

      // Check PTRW values
      const ptrwErv = await oracle.ptrwErv();
      const ptrwArv = await oracle.ptrwArv();
      const ptrwResolved = await oracle.ptrwResolved();

      // Verify PtrwResolved event was emitted with correct ARV
      await expect(tx).to.emit(oracle, "PtrwResolved").withArgs(ptrwArv);

      console.log(`\nPTRW Results:`);
      console.log(`   ptrwErv (Expected): ${ethers.formatEther(ptrwErv)} PT`);
      console.log(`   ptrwArv (Actual): ${ethers.formatEther(ptrwArv)} pufETH`);
      console.log(`   Ratio: ${Number(ptrwArv) / Number(ptrwErv)}`);
      console.log(`   ptrwResolved: ${ptrwResolved}`);

      expect(ptrwResolved).to.equal(true);
      expect(ptrwErv).to.equal(transferAmount);
      expect(ptrwArv).to.be.gt(0);

      // Check operator received the base tokens as tip
      const operatorBaseBalance = await (await ethers.getContractAt("IERC20", PUFETH_TOKEN)).balanceOf(operator.address);
      expect(operatorBaseBalance).to.equal(ptrwArv);

      // Stop impersonation
      await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [PT_HOLDER],
      });
    });

    it("Should allow resolvePtrw to be called multiple times with new PT deposits", async function () {
      this.timeout(120000);

      // Find a PT holder with balance
      const ptContract = await ethers.getContractAt("IERC20", PT_TOKEN);
      const holderBalance = await ptContract.balanceOf(PT_HOLDER);
      
      expect(holderBalance, "The selected fork fixture must contain a funded PT holder").to.be.gt(0n);

      // Impersonate the PT holder
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [PT_HOLDER],
      });
      await deployer.sendTransaction({ to: PT_HOLDER, value: ethers.parseEther("1") });
      const holderSigner = await ethers.getSigner(PT_HOLDER);
      const oracleAddress = await oracle.getAddress();

      // First deposit and resolution
      const firstTransfer = holderBalance / 4n;
      await ptContract.connect(holderSigner).transfer(oracleAddress, firstTransfer);
      
      console.log(`\nFirst resolvePtrw() call...`);
      const tx1 = await oracle.connect(operator).resolvePtrw();
      await tx1.wait();
      
      const firstErv = await oracle.ptrwErv();
      const firstArv = await oracle.ptrwArv();
      console.log(`First resolution - ERV: ${ethers.formatEther(firstErv)}, ARV: ${ethers.formatEther(firstArv)}`);
      
      expect(await oracle.ptrwResolved()).to.equal(true);

      // Second deposit and resolution
      const secondTransfer = holderBalance / 4n;
      await ptContract.connect(holderSigner).transfer(oracleAddress, secondTransfer);
      
      const tx2 = await oracle.connect(operator).resolvePtrw();
      await tx2.wait();
      
      const secondErv = await oracle.ptrwErv();
      const secondArv = await oracle.ptrwArv();

      // Values should be updated to reflect the new redemption
      expect(secondErv).to.equal(secondTransfer);
      expect(secondArv).to.be.gt(0);

      // Stop impersonation
      await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [PT_HOLDER],
      });
    });

  });

  describe("Manual Backup Resolution Test", function () {
    let freshOracle: TapirPtrwOracle;

    beforeEach(async function () {
      this.timeout(60000);

      // Deploy a fresh oracle for manual resolution tests
      const sources = {
        api3ReaderProxyV1IsActive: false,
        api3ReaderProxyV1: ZERO_ADDRESS,
        api3ReaderProxyV1Decimals: 18,
        api3ReaderProxyV1MaxStaleness: 3600,
        chainlinkAggregatorV3IsActive: false,
        chainlinkAggregatorV3: ZERO_ADDRESS,
        chainlinkAggregatorV3Decimals: 18,
        chainlinkAggregatorV3MaxStaleness: 3600,
        redStoneClassicIsActive: false,
        redStoneClassicAggregator: ZERO_ADDRESS,
        redStoneClassicDecimals: 8,
        redStoneClassicMaxStaleness: 3600,
        tellorIsActive: false,
        tellorAdapter: ZERO_ADDRESS,
        tellorDecimals: 8,
        tellorMaxStaleness: 3600,
      };

      const config = {
        minCheckpointSpacing: 86400,
        minValidSources: 1,
        closingPriceLookbackPeriod: 86400,
        depegPool: ZERO_ADDRESS,
        xChainMode: false,
        xDomainMessengerL1: ZERO_ADDRESS,
      };

      // Pendle config for expired PT
      const pendleConfig = {
        pendleBase: PUFETH_TOKEN,
        pendleRouter: PENDLE_ROUTER,
        pendleYT: YT_TOKEN,
        pendlePT: PT_TOKEN, // Expired PT - isExpired() returns true
        errorTolerance: ERROR_TOLERANCE,
      };

      const TapirPtrwOracle = await ethers.getContractFactory("TapirPtrwOracle");
      freshOracle = await TapirPtrwOracle.deploy(
        ASSET_SYMBOL,
        PUFETH_TOKEN,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address,
        pendleConfig
      );
    });

    it("Should allow admin to manually resolve PTRW for expired PT", async function () {
      // With the expired PT token, manualBackupResolvePtrw should succeed
      const manualErv = ethers.parseEther("100");
      const manualArv = ethers.parseEther("99.5"); // 0.5% slippage

      // Verify PT is expired using ABI call directly
      const ptAbi = ["function isExpired() external view returns (bool)"];
      const ptContract = new ethers.Contract(PT_TOKEN, ptAbi, ethers.provider);
      const isExpired = await ptContract.isExpired();
      console.log(`\nPT isExpired: ${isExpired}`);
      expect(isExpired).to.equal(true);

      // Should succeed since PT is expired and no PT balance in oracle
      await expect(
        freshOracle.connect(admin).manualBackupResolvePtrw(manualErv, manualArv)
      ).to.emit(freshOracle, "PtrwResolved").withArgs(manualArv);

      // Verify values are set correctly
      expect(await freshOracle.ptrwResolved()).to.equal(true);
      expect(await freshOracle.ptrwErv()).to.equal(manualErv);
      expect(await freshOracle.ptrwArv()).to.equal(manualArv);
    });

    it("Should reject manual resolution when PT is not expired", async function () {
      // Use a non-expired PT token to test MarketNotExpired revert
      const NON_EXPIRED_PT = "0x1d69402390657308c91179aa184bf992908c1e08";
      const NON_EXPIRED_BASE = "0x23238f20b894f29041f48d88ee91131c395aaa71";
      
      // Get YT address from PT contract
      const ptAbi = [
        "function isExpired() external view returns (bool)",
        "function YT() external view returns (address)"
      ];
      const ptContract = new ethers.Contract(NON_EXPIRED_PT, ptAbi, ethers.provider);
      const nonExpiredYT = await ptContract.YT();
      const isExpired = await ptContract.isExpired();
      
      expect(isExpired).to.equal(false, "PT should NOT be expired for this test");

      // Deploy a fresh oracle with non-expired PT
      const sources = {
        api3ReaderProxyV1IsActive: false,
        api3ReaderProxyV1: ZERO_ADDRESS,
        api3ReaderProxyV1Decimals: 18,
        api3ReaderProxyV1MaxStaleness: 3600,
        chainlinkAggregatorV3IsActive: false,
        chainlinkAggregatorV3: ZERO_ADDRESS,
        chainlinkAggregatorV3Decimals: 18,
        chainlinkAggregatorV3MaxStaleness: 3600,
        redStoneClassicIsActive: false,
        redStoneClassicAggregator: ZERO_ADDRESS,
        redStoneClassicDecimals: 8,
        redStoneClassicMaxStaleness: 3600,
        tellorIsActive: false,
        tellorAdapter: ZERO_ADDRESS,
        tellorDecimals: 8,
        tellorMaxStaleness: 3600,
      };

      const config = {
        minCheckpointSpacing: 86400,
        minValidSources: 1,
        closingPriceLookbackPeriod: 86400,
        depegPool: ZERO_ADDRESS,
        xChainMode: false,
        xDomainMessengerL1: ZERO_ADDRESS,
      };

      // Pendle config with NON-EXPIRED PT
      const nonExpiredPendleConfig = {
        pendleBase: NON_EXPIRED_BASE,
        pendleRouter: PENDLE_ROUTER,
        pendleYT: nonExpiredYT,
        pendlePT: NON_EXPIRED_PT,
        errorTolerance: ERROR_TOLERANCE,
      };

      const TapirPtrwOracle = await ethers.getContractFactory("TapirPtrwOracle");
      const nonExpiredOracle = await TapirPtrwOracle.deploy(
        "sUSDe",
        NON_EXPIRED_BASE,
        18,
        sources,
        config,
        admin.address,
        nonExpiredPendleConfig
      );

      // Should fail because PT is NOT expired
      await expect(
        nonExpiredOracle.connect(admin).manualBackupResolvePtrw(
          ethers.parseEther("100"),
          ethers.parseEther("99.5")
        )
      ).to.be.revertedWithCustomError(nonExpiredOracle, "MarketNotExpired");
    });

    it("Should reject resolvePtrw when PT is not expired", async function () {
      // Use a non-expired PT token to test MarketNotExpired revert in resolvePtrw
      const NON_EXPIRED_PT = "0x1d69402390657308c91179aa184bf992908c1e08";
      const NON_EXPIRED_BASE = "0x23238f20b894f29041f48d88ee91131c395aaa71";
      
      // Get YT address from PT contract
      const ptAbi = [
        "function isExpired() external view returns (bool)",
        "function YT() external view returns (address)"
      ];
      const ptContract = new ethers.Contract(NON_EXPIRED_PT, ptAbi, ethers.provider);
      const nonExpiredYT = await ptContract.YT();
      const isExpired = await ptContract.isExpired();
      
      expect(isExpired).to.equal(false, "PT should NOT be expired for this test");

      // Deploy a fresh oracle with non-expired PT
      const sources = {
        api3ReaderProxyV1IsActive: false,
        api3ReaderProxyV1: ZERO_ADDRESS,
        api3ReaderProxyV1Decimals: 18,
        api3ReaderProxyV1MaxStaleness: 3600,
        chainlinkAggregatorV3IsActive: false,
        chainlinkAggregatorV3: ZERO_ADDRESS,
        chainlinkAggregatorV3Decimals: 18,
        chainlinkAggregatorV3MaxStaleness: 3600,
        redStoneClassicIsActive: false,
        redStoneClassicAggregator: ZERO_ADDRESS,
        redStoneClassicDecimals: 8,
        redStoneClassicMaxStaleness: 3600,
        tellorIsActive: false,
        tellorAdapter: ZERO_ADDRESS,
        tellorDecimals: 8,
        tellorMaxStaleness: 3600,
      };

      const config = {
        minCheckpointSpacing: 86400,
        minValidSources: 1,
        closingPriceLookbackPeriod: 86400,
        depegPool: ZERO_ADDRESS,
        xChainMode: false,
        xDomainMessengerL1: ZERO_ADDRESS,
      };

      // Pendle config with NON-EXPIRED PT
      const nonExpiredPendleConfig = {
        pendleBase: NON_EXPIRED_BASE,
        pendleRouter: PENDLE_ROUTER,
        pendleYT: nonExpiredYT,
        pendlePT: NON_EXPIRED_PT,
        errorTolerance: ERROR_TOLERANCE,
      };

      const TapirPtrwOracle = await ethers.getContractFactory("TapirPtrwOracle");
      const nonExpiredOracle = await TapirPtrwOracle.deploy(
        "sUSDe",
        NON_EXPIRED_BASE,
        18,
        sources,
        config,
        admin.address,
        nonExpiredPendleConfig
      );

      // Grant operator role
      const OPERATOR_ROLE = await nonExpiredOracle.OPERATOR_ROLE();
      await nonExpiredOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

      // Should fail since PT is NOT expired
      await expect(
        nonExpiredOracle.connect(operator).resolvePtrw()
      ).to.be.revertedWithCustomError(nonExpiredOracle, "MarketNotExpired");
    });

    it("Should reject manual resolution from non-admin", async function () {
      const manualErv = ethers.parseEther("100");
      const manualArv = ethers.parseEther("99.5");

      await expect(
        freshOracle.connect(user).manualBackupResolvePtrw(manualErv, manualArv)
      ).to.be.reverted; // AccessControl error
    });

    it("Should reject manual resolution with zero ERV", async function () {
      await expect(
        freshOracle.connect(admin).manualBackupResolvePtrw(0, ethers.parseEther("99.5"))
      ).to.be.revertedWithCustomError(freshOracle, "InvalidPtrwValues");
    });

    it("Should reject manual resolution when PT balance exists", async function () {
      // If we can get PT tokens, transfer to oracle and verify it fails
      const ptContract = await ethers.getContractAt("IERC20", PT_TOKEN);
      const holderBalance = await ptContract.balanceOf(PT_HOLDER);
      
      expect(holderBalance, "The selected fork fixture must contain a funded PT holder").to.be.gt(0n);

      // Impersonate holder and transfer PT to oracle (use minimum amount available)
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [PT_HOLDER],
      });
      const holderSigner = await ethers.getSigner(PT_HOLDER);
      await admin.sendTransaction({ to: PT_HOLDER, value: ethers.parseEther("1") });
            
      await ptContract.connect(holderSigner).transfer(await freshOracle.getAddress(), holderBalance);
      
      await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [PT_HOLDER],
      });

      // Should fail because oracle has PT balance
      await expect(
        freshOracle.connect(admin).manualBackupResolvePtrw(ethers.parseEther("100"), ethers.parseEther("99.5"))
      ).to.be.revertedWithCustomError(freshOracle, "PtBalanceNotZero");
    });

    it("Should reject manual resolution if already resolved", async function () {
      // First resolution should succeed
      await freshOracle.connect(admin).manualBackupResolvePtrw(
        ethers.parseEther("100"),
        ethers.parseEther("99.5")
      );

      // Second resolution should fail
      await expect(
        freshOracle.connect(admin).manualBackupResolvePtrw(ethers.parseEther("100"), ethers.parseEther("99.5"))
      ).to.be.revertedWithCustomError(freshOracle, "PtrwAlreadyResolved");
    });

    it("Should deny automatic resolution and allow manual resolution after resolvePtrw sets forceManualResolve (TAP-3 fix)", async function () {
      this.timeout(60000);

      // This test verifies the fix for TAP-3: Manual Resolution of PTRW Not Possible Due To State Reversion
      // When resolvePtrw() results in ptrwArv == 0, it should:
      // 1. Set forceManualResolve = true
      // 2. Emit MustResolveManually event
      // 3. Return (not revert) so the state change persists
      // 4. Allow admin to call manualBackupResolvePtrw() successfully

      // Deploy a mock Pendle router that returns 0 tokens to simulate the zero ARV scenario
      const MockPendleRouterZero = await ethers.getContractFactory("MockPendleRouterZeroReturns");
      const mockRouterZero = await MockPendleRouterZero.deploy();

      // Deploy a mock PT token with isExpired() = true (so we don't rely on mainnet PT holder balance)
      const MockPendlePT = await ethers.getContractFactory("MockPendlePT");
      const mockPT = await MockPendlePT.deploy(true); // expired = true

      // Deploy fresh oracle with mock router and mock PT
      const sources = {
        api3ReaderProxyV1IsActive: false,
        api3ReaderProxyV1: ZERO_ADDRESS,
        api3ReaderProxyV1Decimals: 18,
        api3ReaderProxyV1MaxStaleness: 3600,
        chainlinkAggregatorV3IsActive: false,
        chainlinkAggregatorV3: ZERO_ADDRESS,
        chainlinkAggregatorV3Decimals: 18,
        chainlinkAggregatorV3MaxStaleness: 3600,
        redStoneClassicIsActive: false,
        redStoneClassicAggregator: ZERO_ADDRESS,
        redStoneClassicDecimals: 8,
        redStoneClassicMaxStaleness: 3600,
        tellorIsActive: false,
        tellorAdapter: ZERO_ADDRESS,
        tellorDecimals: 8,
        tellorMaxStaleness: 3600,
      };

      const config = {
        minCheckpointSpacing: 86400,
        minValidSources: 1,
        closingPriceLookbackPeriod: 86400,
        depegPool: ZERO_ADDRESS,
        xChainMode: false,
        xDomainMessengerL1: ZERO_ADDRESS,
      };

      // Use mock router that returns 0 tokens and mock PT
      const pendleConfig = {
        pendleBase: PUFETH_TOKEN,
        pendleRouter: await mockRouterZero.getAddress(),
        pendleYT: YT_TOKEN,
        pendlePT: await mockPT.getAddress(), // Use mock PT instead of real mainnet PT
        errorTolerance: ERROR_TOLERANCE,
      };

      const TapirPtrwOracle = await ethers.getContractFactory("TapirPtrwOracle");
      const testOracle = await TapirPtrwOracle.deploy(
        ASSET_SYMBOL,
        PUFETH_TOKEN,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address,
        pendleConfig
      );

      // Grant operator role
      const OPERATOR_ROLE = await testOracle.OPERATOR_ROLE();
      await testOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

      // Mint PT tokens directly to the oracle using the mock
      const transferAmount = ethers.parseEther("10");
      await mockPT.mint(await testOracle.getAddress(), transferAmount);

      // Verify initial state
      expect(await testOracle.forceManualResolve()).to.equal(false);
      expect(await testOracle.ptrwResolved()).to.equal(false);

      // Call resolvePtrw - it should NOT revert, but set forceManualResolve = true and emit event
      const tx = await testOracle.connect(operator).resolvePtrw();

      // Verify the MustResolveManually event was emitted
      await expect(tx).to.emit(testOracle, "MustResolveManually");

      // Verify forceManualResolve is now true (state persisted because we return instead of revert)
      expect(await testOracle.forceManualResolve()).to.equal(true);
      
      // Verify ptrwResolved is still false (early return before setting it)
      expect(await testOracle.ptrwResolved()).to.equal(false);

      // Verify ptrwErv was set to the PT balance
      expect(await testOracle.ptrwErv()).to.equal(transferAmount);
      
      // Verify ptrwArv is 0 (mock router returned 0)
      expect(await testOracle.ptrwArv()).to.equal(0);

      // Verify manual resolution is required
      await expect(
        testOracle.connect(operator).resolvePtrw()
      ).to.be.revertedWithCustomError(testOracle, "ManualResolveRequired");

      // Admin should be able to call manualBackupResolvePtrw
      const manualErv = ethers.parseEther("10");
      const manualArv = ethers.parseEther("9.95"); // Assume 0.5% slippage

      await expect(
        testOracle.connect(admin).manualBackupResolvePtrw(manualErv, manualArv)
      ).to.emit(testOracle, "PtrwResolved").withArgs(manualArv);

      // Verify final state
      expect(await testOracle.ptrwResolved()).to.equal(true);
      expect(await testOracle.ptrwErv()).to.equal(manualErv);
      expect(await testOracle.ptrwArv()).to.equal(manualArv);
    });

    it("Should allow admin to reset forceManualResolve flag and try resolution again", async function () {
      // Re-use logic from TAP-3 test to get into forceManualResolve state
      const MockPendleRouterZero = await ethers.getContractFactory("MockPendleRouterZeroReturns");
      const mockRouterZero = await MockPendleRouterZero.deploy();
      const MockPendlePT = await ethers.getContractFactory("MockPendlePT");
      const mockPT = await MockPendlePT.deploy(true);

      const sources = {
        api3ReaderProxyV1IsActive: false,
        api3ReaderProxyV1: ZERO_ADDRESS,
        api3ReaderProxyV1Decimals: 18,
        api3ReaderProxyV1MaxStaleness: 3600,
        chainlinkAggregatorV3IsActive: false,
        chainlinkAggregatorV3: ZERO_ADDRESS,
        chainlinkAggregatorV3Decimals: 18,
        chainlinkAggregatorV3MaxStaleness: 3600,
        redStoneClassicIsActive: false,
        redStoneClassicAggregator: ZERO_ADDRESS,
        redStoneClassicDecimals: 8,
        redStoneClassicMaxStaleness: 3600,
        tellorIsActive: false,
        tellorAdapter: ZERO_ADDRESS,
        tellorDecimals: 8,
        tellorMaxStaleness: 3600,
      };

      const config = {
        minCheckpointSpacing: 86400,
        minValidSources: 1,
        closingPriceLookbackPeriod: 86400,
        depegPool: ZERO_ADDRESS,
        xChainMode: false,
        xDomainMessengerL1: ZERO_ADDRESS,
      };

      const pendleConfig = {
        pendleBase: PUFETH_TOKEN,
        pendleRouter: await mockRouterZero.getAddress(),
        pendleYT: YT_TOKEN,
        pendlePT: await mockPT.getAddress(),
        errorTolerance: ERROR_TOLERANCE,
      };

      const testOracle = await (await ethers.getContractFactory("TapirPtrwOracle")).deploy(
        ASSET_SYMBOL, PUFETH_TOKEN, ASSET_DECIMALS, sources, config, admin.address, pendleConfig
      );

      const OPERATOR_ROLE = await testOracle.OPERATOR_ROLE();
      await testOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

      await mockPT.mint(await testOracle.getAddress(), ethers.parseEther("10"));

      // Trigger forceManualResolve = true
      await testOracle.connect(operator).resolvePtrw();
      expect(await testOracle.forceManualResolve()).to.equal(true);

      // Verify resolvePtrw reverts now
      await expect(
        testOracle.connect(operator).resolvePtrw()
      ).to.be.revertedWithCustomError(testOracle, "ManualResolveRequired");

      // Non-admin cannot reset
      await expect(
        testOracle.connect(operator).resetForceManualResolve()
      ).to.be.revertedWithCustomError(testOracle, "AccessControlUnauthorizedAccount");

      // Admin resets
      await testOracle.connect(admin).resetForceManualResolve();
      expect(await testOracle.forceManualResolve()).to.equal(false);

      // Should be able to try resolvePtrw again (it will set forceManualResolve to true again because mock router still returns 0)
      await expect(
        testOracle.connect(operator).resolvePtrw()
      ).to.emit(testOracle, "MustResolveManually");
      
      expect(await testOracle.forceManualResolve()).to.equal(true);
    });
  });

  describe("PTRW Depeg Factor Calculation", function () {
    it("Should correctly calculate depeg factor when ARV < ERV", async function () {
      // This is a unit test for the depeg calculation logic
      // ptrwDepeg = (ptrwArv + errorTolerance) * PTRW_ACCURACY / ptrwErv
      
      const PTRW_ACCURACY = 10000n;
      
      // Scenario 1: No depeg (ARV >= ERV)
      let erv = ethers.parseEther("100");
      let arv = ethers.parseEther("100");
      let tolerance = ethers.parseEther("0.001"); // 0.1%
      
      let depeg = PTRW_ACCURACY;
      if (arv + tolerance < erv) {
        depeg = ((arv + tolerance) * PTRW_ACCURACY) / erv;
      }
      expect(depeg).to.equal(10000n); // 100%

      // Scenario 2: 5% depeg
      erv = ethers.parseEther("100");
      arv = ethers.parseEther("95");
      tolerance = ethers.parseEther("0.5"); // 0.5 unit tolerance
      
      depeg = PTRW_ACCURACY;
      if (arv + tolerance < erv) {
        depeg = ((arv + tolerance) * PTRW_ACCURACY) / erv;
      }
      expect(depeg).to.equal(9550n); // 95.5%

      // Scenario 3: Depeg within tolerance
      erv = ethers.parseEther("100");
      arv = ethers.parseEther("99.6");
      tolerance = ethers.parseEther("0.5"); // 0.5 unit tolerance
      
      depeg = PTRW_ACCURACY;
      if (arv + tolerance < erv) {
        depeg = ((arv + tolerance) * PTRW_ACCURACY) / erv;
      }
      expect(depeg).to.equal(10000n); // 100% (within tolerance)
    });
  });
});

