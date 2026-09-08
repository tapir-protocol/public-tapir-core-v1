import { expect } from "chai";
import { ethers, network } from "hardhat";
import { TapirOracle, TapirPtrwOracle, Api3ReaderProxyMock, ChainlinkAggregatorMock } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { parseUnits, AddressLike } from "ethers";

// ===== REAL WORLD TEST CONFIGURATION =====

// API3 Feed Configuration
const API3_TEST_RPC = "https://zircuit-mainnet.drpc.org";
const API3_TEST_CHAIN_ID = 48900;
const API3_FEED_ADDRESS = "0x4dab7dde07ccbfcfb19bc0537739490faa2adb15";
const API3_FEED_DECIMALS = 18;
const API3_EXPECTED_PRICE = ethers.parseUnits("1.08386", API3_FEED_DECIMALS); // https://market.api3.org/zircuit/weeth-eth-exchange-rate
const API3_TOLERANCE_BPS = 10; // 10 basis points = 0.1%

// Chainlink Feed Configuration
const CHAINLINK_TEST_RPC = "https://arbitrum.drpc.org";
const CHAINLINK_TEST_CHAIN_ID = 42161;
const CHAINLINK_FEED_ADDRESS = "0xE141425bc1594b8039De6390db1cDaf4397EA22b";
const CHAINLINK_FEED_DECIMALS = 18;
const CHAINLINK_EXPECTED_PRICE = ethers.parseUnits("1.08386", CHAINLINK_FEED_DECIMALS); // https://data.chain.link/feeds/arbitrum/mainnet/weeth-eth
const CHAINLINK_TOLERANCE_BPS = 10;

// RedStone Classic Feed Configuration
const REDSTONE_TEST_RPC = "https://eth.drpc.org";
const REDSTONE_TEST_CHAIN_ID = 1;
const REDSTONE_FEED_ADDRESS = "0x8751F736E94F6CD167e8C5B97E245680FbD9CC36";
const REDSTONE_FEED_DECIMALS = 8;
const REDSTONE_EXPECTED_PRICE = ethers.parseUnits("1.08386", REDSTONE_FEED_DECIMALS);
const REDSTONE_TOLERANCE_BPS = 10;

// Contract variants to test
const ORACLE_CONTRACTS = ["TapirOracle", "TapirPtrwOracle"] as const;
type OracleContractName = typeof ORACLE_CONTRACTS[number];

// Helper to deploy oracle contracts with proper configuration
async function deployOracle(
  contractName: OracleContractName,
  assetSymbol: string,
  asset: AddressLike,
  assetDecimals: number,
  sources: any,
  config: any,
  adminAddress: AddressLike
): Promise<TapirOracle | TapirPtrwOracle> {
  const OracleFactory = await ethers.getContractFactory(contractName);
  
  if (contractName === "TapirPtrwOracle") {
    // Deploy mock contracts for TapirPtrwOracle (using Token mock as simple ERC20s)
    const MockToken = await ethers.getContractFactory("Token");
    const mockPendleBase = await MockToken.deploy();
    const mockPendleRouter = await MockToken.deploy();  // Just needs to be a contract address
    const mockPendleYT = await MockToken.deploy();
    const mockPendlePT = await (await ethers.getContractFactory("MockPendlePT")).deploy(true);
    
    const pendleConfig = {
      pendleBase: await mockPendleBase.getAddress(),
      pendleRouter: await mockPendleRouter.getAddress(),
      pendleYT: await mockPendleYT.getAddress(),
      pendlePT: await mockPendlePT.getAddress(),
      errorTolerance: ethers.parseUnits("0.001", 18), // 0.1% error tolerance
    };
    
    const result = await OracleFactory.deploy(
      assetSymbol,
      asset,
      assetDecimals,
      sources,
      config,
      adminAddress,
      pendleConfig
    ) as TapirPtrwOracle;
    const adminSigner = await ethers.getSigner(await ethers.resolveAddress(adminAddress));
    await result.connect(adminSigner).manualBackupResolvePtrw(1, 1);
    return result;
  } else {
    return await OracleFactory.deploy(
      assetSymbol,
      asset,
      assetDecimals,
      sources,
      config,
      adminAddress
    ) as TapirOracle;
  }
}

// Run tests for each oracle contract variant
for (const CONTRACT_NAME of ORACLE_CONTRACTS) {
describe(`${CONTRACT_NAME}`, function () {
  // Contracts
  let oracle: TapirOracle | TapirPtrwOracle;
  let api3Mock: Api3ReaderProxyMock;

  // Signers
  let deployer: SignerWithAddress;
  let admin: SignerWithAddress;
  let operator: SignerWithAddress;
  let user: SignerWithAddress;

  // Constants
  const ASSET_SYMBOL = "USDT";
  const ASSET_DECIMALS = 6;
  const ZERO_ADDRESS = ethers.ZeroAddress;

  beforeEach(async function () {
    [deployer, admin, operator, user] = await ethers.getSigners();

    // Deploy API3 mock with initial test data
    const Api3Mock = await ethers.getContractFactory("Api3ReaderProxyMock");
    const initialValue = ethers.parseUnits("1.0", 18); // 1.0 in 18 decimals (will be normalized to 6 for USDT)
    const currentBlock = await ethers.provider.getBlock("latest");
    const initialTimestamp = currentBlock!.timestamp;
    api3Mock = await Api3Mock.deploy(initialValue, initialTimestamp);

    // Setup sources configuration
    const sources = {
      api3ReaderProxyV1IsActive: true,
      api3ReaderProxyV1: await api3Mock.getAddress(),
      api3ReaderProxyV1Decimals: 18,
      api3ReaderProxyV1MaxStaleness: 3600, // 1 hour
      chainlinkAggregatorV3IsActive: false,
      chainlinkAggregatorV3: ZERO_ADDRESS,
      chainlinkAggregatorV3Decimals: 18,
      chainlinkAggregatorV3MaxStaleness: 3600, // 1 hour
      redStoneClassicIsActive: false,
      redStoneClassicAggregator: ZERO_ADDRESS,
      redStoneClassicDecimals: 8,
      redStoneClassicMaxStaleness: 3600, // 1 hour
      tellorIsActive: false,
      tellorAdapter: ZERO_ADDRESS,
      tellorDecimals: 8,
      tellorMaxStaleness: 3600, // 1 hour
    };

    // Setup config
    const config = {
      minCheckpointSpacing: 86400, // 1 day
      minValidSources: 2, // Minimum 2 valid sources
      closingPriceLookbackPeriod: 86400, // 24 hours lookback for closing price median
      depegPool: user.address, // Use a non-zero address to satisfy validation
      xChainMode: false,
      xDomainMessengerL1: ZERO_ADDRESS,
    };

    // Deploy Oracle (TapirOracle or TapirPtrwOracle based on CONTRACT_NAME)
    oracle = await deployOracle(
      CONTRACT_NAME,
      ASSET_SYMBOL,
      ZERO_ADDRESS, // asset address not needed for this test
      ASSET_DECIMALS,
      sources,
      config,
      admin.address
    );

    // Grant operator role
    const OPERATOR_ROLE = await oracle.OPERATOR_ROLE();
    await oracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
  });

  describe("recordApi3Price", function () {
    describe("Success Cases", function () {
      it("Should record API3 price correctly", async function () {
        // Set test data in the mock (in 18 decimals)
        const testValue = ethers.parseUnits("0.995", 18); // 0.995 in 18 decimals - slight depeg
        const expectedNormalized = 995000n; // Expected value after normalization to 6 decimals
        const currentBlock = await ethers.provider.getBlock("latest");
        const testTimestamp = currentBlock!.timestamp;
        await api3Mock.setData(testValue, testTimestamp);

        // Record the price
        await oracle.connect(operator).recordApi3Price();

        // Verify the stored price data (should be normalized to 6 decimals)
        const latestPrice = await oracle.latestApi3Price();
        expect(latestPrice.price).to.equal(expectedNormalized);
        expect(latestPrice.asOfTs).to.equal(testTimestamp);
      });

      it("Should handle different price values", async function () {
        const testCases = [
          { value: ethers.parseUnits("1.0", 18), expected: 1000000n, desc: "1.0 USDT" },
          { value: ethers.parseUnits("0.99", 18), expected: 990000n, desc: "0.99 USDT" },
          { value: ethers.parseUnits("0.95", 18), expected: 950000n, desc: "0.95 USDT - significant depeg" },
          { value: ethers.parseUnits("1.01", 18), expected: 1010000n, desc: "1.01 USDT - above peg" },
        ];

        for (let i = 0; i < testCases.length; i++) {
          const testCase = testCases[i];
          
          // Advance time between iterations to ensure monotonically increasing timestamps
          if (i > 0) {
            await ethers.provider.send("evm_increaseTime", [60]); // Advance 1 minute
            await ethers.provider.send("evm_mine", []);
          }
          
          const currentBlock = await ethers.provider.getBlock("latest");
          const testTimestamp = currentBlock!.timestamp;
          await api3Mock.setData(testCase.value, testTimestamp);
          await oracle.connect(operator).recordApi3Price();

          const latestPrice = await oracle.latestApi3Price();
          expect(latestPrice.price).to.equal(
            testCase.expected,
            `Failed for ${testCase.desc}`
          );
          expect(latestPrice.asOfTs).to.equal(testTimestamp);
        }
      });

      it("Should update latestApi3Price on multiple calls", async function () {
        // First recording - use current block timestamp
        const firstValue = ethers.parseUnits("1.0", 18);
        const expectedFirst = 1000000n;
        const currentBlock = await ethers.provider.getBlock("latest");
        const firstTimestamp = currentBlock!.timestamp;
        await api3Mock.setData(firstValue, firstTimestamp);
        await oracle.connect(operator).recordApi3Price();

        let latestPrice = await oracle.latestApi3Price();
        expect(latestPrice.price).to.equal(expectedFirst);

        // Second recording with different value - advance time
        const secondValue = ethers.parseUnits("0.99", 18);
        const expectedSecond = 990000n;
        await ethers.provider.send("evm_increaseTime", [3600]); // Advance 1 hour
        await ethers.provider.send("evm_mine", []); // Mine a block
        const newBlock = await ethers.provider.getBlock("latest");
        const secondTimestamp = newBlock!.timestamp;
        await api3Mock.setData(secondValue, secondTimestamp);
        await oracle.connect(operator).recordApi3Price();

        latestPrice = await oracle.latestApi3Price();
        expect(latestPrice.price).to.equal(expectedSecond);
        expect(latestPrice.asOfTs).to.equal(secondTimestamp);
      });

      it("Should only be callable by OPERATOR_ROLE", async function () {
        const testValue = ethers.parseUnits("1.0", 18);
        const currentBlock = await ethers.provider.getBlock("latest");
        const testTimestamp = currentBlock!.timestamp;
        await api3Mock.setData(testValue, testTimestamp);

        // Call from operator should succeed
        await oracle.connect(operator).recordApi3Price();

        const latestPrice = await oracle.latestApi3Price();
        expect(latestPrice.price).to.equal(1000000n);
      });

      it("Should revert when called by non-operator", async function () {
        const testValue = ethers.parseUnits("1.0", 18);
        const currentBlock = await ethers.provider.getBlock("latest");
        const testTimestamp = currentBlock!.timestamp;
        await api3Mock.setData(testValue, testTimestamp);

        // Call from user (non-operator) should fail
        await expect(
          oracle.connect(user).recordApi3Price()
        ).to.be.reverted;

        // Call from deployer (non-operator) should fail
        await expect(
          oracle.connect(deployer).recordApi3Price()
        ).to.be.reverted;
      });

      it("Should handle int224 to uint192 conversion correctly", async function () {
        // Test maximum safe value for uint192
        const maxUint192 = (1n << 192n) - 1n;
        const testValue = maxUint192 / 1000000n; // Scale down to safe range (in 18 decimals)
        const expectedNormalized = testValue / (10n ** 12n); // Normalize from 18 to 6 decimals
        const currentBlock = await ethers.provider.getBlock("latest");
        const testTimestamp = currentBlock!.timestamp;

        await api3Mock.setData(testValue, testTimestamp);
        await oracle.connect(operator).recordApi3Price();

        const latestPrice = await oracle.latestApi3Price();
        expect(latestPrice.price).to.equal(expectedNormalized);
      });

      it("Should correctly store timestamp as uint64", async function () {
        const testValue = ethers.parseUnits("1.0", 18);
        const currentBlock = await ethers.provider.getBlock("latest");
        const testTimestamp = currentBlock!.timestamp;
        await api3Mock.setData(testValue, testTimestamp);

        await oracle.connect(operator).recordApi3Price();

        const latestPrice = await oracle.latestApi3Price();
        expect(latestPrice.asOfTs).to.equal(testTimestamp);
      });
    });

    describe("Failure Cases", function () {
      it("Should revert if source is not active", async function () {
        // Disable the API3 source
        const sources = await oracle.sources();
        const newSources = {
          api3ReaderProxyV1IsActive: false, // Disable this
          api3ReaderProxyV1: sources.api3ReaderProxyV1,
          api3ReaderProxyV1Decimals: sources.api3ReaderProxyV1Decimals,
          api3ReaderProxyV1MaxStaleness: sources.api3ReaderProxyV1MaxStaleness,
          chainlinkAggregatorV3IsActive: sources.chainlinkAggregatorV3IsActive,
          chainlinkAggregatorV3: sources.chainlinkAggregatorV3,
          chainlinkAggregatorV3Decimals: sources.chainlinkAggregatorV3Decimals,
          chainlinkAggregatorV3MaxStaleness: sources.chainlinkAggregatorV3MaxStaleness,
          redStoneClassicIsActive: sources.redStoneClassicIsActive,
          redStoneClassicAggregator: sources.redStoneClassicAggregator,
          redStoneClassicDecimals: sources.redStoneClassicDecimals,
          redStoneClassicMaxStaleness: sources.redStoneClassicMaxStaleness,
          tellorIsActive: sources.tellorIsActive,
          tellorAdapter: sources.tellorAdapter,
          tellorDecimals: sources.tellorDecimals,
          tellorMaxStaleness: sources.tellorMaxStaleness,
        };

        await oracle.connect(admin).setSources(newSources);

        // Try to record price
        await expect(
          oracle.connect(operator).recordApi3Price()
        ).to.be.revertedWithCustomError(oracle, "SourceNotActive");
      });

      it("Should revert if source is not configured", async function () {
        // Set source to zero address
        const sources = await oracle.sources();
        const newSources = {
          api3ReaderProxyV1IsActive: sources.api3ReaderProxyV1IsActive,
          api3ReaderProxyV1: ZERO_ADDRESS, // Set to zero address
          api3ReaderProxyV1Decimals: sources.api3ReaderProxyV1Decimals,
          api3ReaderProxyV1MaxStaleness: sources.api3ReaderProxyV1MaxStaleness,
          chainlinkAggregatorV3IsActive: sources.chainlinkAggregatorV3IsActive,
          chainlinkAggregatorV3: sources.chainlinkAggregatorV3,
          chainlinkAggregatorV3Decimals: sources.chainlinkAggregatorV3Decimals,
          chainlinkAggregatorV3MaxStaleness: sources.chainlinkAggregatorV3MaxStaleness,
          redStoneClassicIsActive: sources.redStoneClassicIsActive,
          redStoneClassicAggregator: sources.redStoneClassicAggregator,
          redStoneClassicDecimals: sources.redStoneClassicDecimals,
          redStoneClassicMaxStaleness: sources.redStoneClassicMaxStaleness,
          tellorIsActive: sources.tellorIsActive,
          tellorAdapter: sources.tellorAdapter,
          tellorDecimals: sources.tellorDecimals,
          tellorMaxStaleness: sources.tellorMaxStaleness,
        };

        await expect(
          oracle.connect(admin).setSources(newSources)
        ).to.be.revertedWithCustomError(oracle, "SourceNotConfigured");
      });

      it("Should revert if both conditions fail", async function () {
        // Disable and unconfigure the source
        const sources = await oracle.sources();
        const newSources = {
          api3ReaderProxyV1IsActive: false, // Disable
          api3ReaderProxyV1: ZERO_ADDRESS, // And set to zero address
          api3ReaderProxyV1Decimals: sources.api3ReaderProxyV1Decimals,
          api3ReaderProxyV1MaxStaleness: sources.api3ReaderProxyV1MaxStaleness,
          chainlinkAggregatorV3IsActive: sources.chainlinkAggregatorV3IsActive,
          chainlinkAggregatorV3: sources.chainlinkAggregatorV3,
          chainlinkAggregatorV3Decimals: sources.chainlinkAggregatorV3Decimals,
          chainlinkAggregatorV3MaxStaleness: sources.chainlinkAggregatorV3MaxStaleness,
          redStoneClassicIsActive: sources.redStoneClassicIsActive,
          redStoneClassicAggregator: sources.redStoneClassicAggregator,
          redStoneClassicDecimals: sources.redStoneClassicDecimals,
          redStoneClassicMaxStaleness: sources.redStoneClassicMaxStaleness,
          tellorIsActive: sources.tellorIsActive,
          tellorAdapter: sources.tellorAdapter,
          tellorDecimals: sources.tellorDecimals,
          tellorMaxStaleness: sources.tellorMaxStaleness,
        };

        await oracle.connect(admin).setSources(newSources);

        // Try to record price - should fail on the first check (isActive)
        await expect(
          oracle.connect(operator).recordApi3Price()
        ).to.be.reverted;
      });
    });

    describe("Edge Cases", function () {
      it("Should reject zero price value", async function () {
        const testValue = 0n;
        const currentBlock = await ethers.provider.getBlock("latest");
        const testTimestamp = currentBlock!.timestamp;
        await api3Mock.setData(testValue, testTimestamp);

        await expect(
          oracle.connect(operator).recordApi3Price()
        ).to.be.reverted;
      });

      it("Should handle very small price values", async function () {
        const testValue = 1000000000000n; // 0.000001 in 18 decimals
        const expectedNormalized = 1n; // Smallest possible positive value in 6 decimals
        const currentBlock = await ethers.provider.getBlock("latest");
        const testTimestamp = currentBlock!.timestamp;
        await api3Mock.setData(testValue, testTimestamp);

        await oracle.connect(operator).recordApi3Price();

        const latestPrice = await oracle.latestApi3Price();
        expect(latestPrice.price).to.equal(expectedNormalized);
      });

      it("Should reject timestamp at 0", async function () {
        const testValue = ethers.parseUnits("1.0", 18);
        const testTimestamp = 0;
        await api3Mock.setData(testValue, testTimestamp);

        await expect(
          oracle.connect(operator).recordApi3Price()
        ).to.be.reverted;
      });

      it("Should reject future timestamps", async function () {
        const testValue = ethers.parseUnits("1.0", 18);
        const currentBlock = await ethers.provider.getBlock("latest");
        const futureTimestamp = currentBlock!.timestamp + 3600; // 1 hour in future
        await api3Mock.setData(testValue, futureTimestamp);

        await expect(
          oracle.connect(operator).recordApi3Price()
        ).to.be.reverted;
      });
    });
  });

  describe("recordChainlinkPrice", function () {
    let chainlinkMock: ChainlinkAggregatorMock;
    let chainlinkOracle: TapirOracle | TapirPtrwOracle;

    beforeEach(async function () {
      // Deploy Chainlink mock with 18 decimals (matching real weETH/ETH feed)
      const ChainlinkMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
      const initialAnswer = ethers.parseUnits("1.0", 18); // 1.0 in 18 decimals
      const currentBlock = await ethers.provider.getBlock("latest");
      const initialUpdatedAt = currentBlock!.timestamp;
      chainlinkMock = await ChainlinkMock.deploy(initialAnswer, initialUpdatedAt, 18);

      // Setup sources with Chainlink
      const sources = {
        api3ReaderProxyV1IsActive: false,
        api3ReaderProxyV1: ZERO_ADDRESS,
        api3ReaderProxyV1Decimals: 18,
        api3ReaderProxyV1MaxStaleness: 3600,
        chainlinkAggregatorV3IsActive: true,
        chainlinkAggregatorV3: await chainlinkMock.getAddress(),
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
        minValidSources: 2,
        closingPriceLookbackPeriod: 86400,
        depegPool: admin.address,
        xChainMode: false,
        xDomainMessengerL1: ZERO_ADDRESS,
      };

      chainlinkOracle = await deployOracle(
        CONTRACT_NAME,
        ASSET_SYMBOL,
        ZERO_ADDRESS,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address
      );

      const OPERATOR_ROLE = await chainlinkOracle.OPERATOR_ROLE();
      await chainlinkOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
    });

    describe("Success Cases", function () {
      it("Should record Chainlink price correctly", async function () {
        const testAnswer = ethers.parseUnits("0.995", 18); // 0.995 in 18 decimals
        const currentBlock = await ethers.provider.getBlock("latest");
        const testUpdatedAt = currentBlock!.timestamp;
        await chainlinkMock.setData(testAnswer, testUpdatedAt);

        await chainlinkOracle.connect(operator).recordChainlinkPrice();

        const latestPrice = await chainlinkOracle.latestChainlinkPrice();
        // Price should be normalized to 6 decimals: 995000 (0.995 USDT)
        const expectedNormalized = 995000n;
        expect(latestPrice.price).to.equal(expectedNormalized);
        expect(latestPrice.asOfTs).to.equal(testUpdatedAt);
      });

      it("Should normalize decimals correctly", async function () {
        // Chainlink: 18 decimals, Asset: 6 decimals
        const testCases = [
          { answer: ethers.parseUnits("1.0", 18), expected: 1000000n, desc: "1.0" },
          { answer: ethers.parseUnits("0.99", 18), expected: 990000n, desc: "0.99" },
          { answer: ethers.parseUnits("0.95", 18), expected: 950000n, desc: "0.95" },
        ];

        for (let i = 0; i < testCases.length; i++) {
          const testCase = testCases[i];

          if (i > 0) {
            await ethers.provider.send("evm_increaseTime", [60]);
            await ethers.provider.send("evm_mine", []);
          }

          const currentBlock = await ethers.provider.getBlock("latest");
          const testUpdatedAt = currentBlock!.timestamp;
          await chainlinkMock.setData(testCase.answer, testUpdatedAt);
          await chainlinkOracle.connect(operator).recordChainlinkPrice();

          const latestPrice = await chainlinkOracle.latestChainlinkPrice();
          expect(latestPrice.price).to.equal(
            testCase.expected,
            `Failed for ${testCase.desc}`
          );
        }
      });

      it("Should update latestChainlinkPrice on multiple calls", async function () {
        const firstAnswer = ethers.parseUnits("1.0", 18);
        const currentBlock = await ethers.provider.getBlock("latest");
        const firstUpdatedAt = currentBlock!.timestamp;
        await chainlinkMock.setData(firstAnswer, firstUpdatedAt);
        await chainlinkOracle.connect(operator).recordChainlinkPrice();

        let latestPrice = await chainlinkOracle.latestChainlinkPrice();
        expect(latestPrice.price).to.equal(1000000n);

        // Advance time and update
        await ethers.provider.send("evm_increaseTime", [3600]);
        await ethers.provider.send("evm_mine", []);
        const secondAnswer = ethers.parseUnits("0.99", 18);
        const newBlock = await ethers.provider.getBlock("latest");
        const secondUpdatedAt = newBlock!.timestamp;
        await chainlinkMock.setData(secondAnswer, secondUpdatedAt);
        await chainlinkOracle.connect(operator).recordChainlinkPrice();

        latestPrice = await chainlinkOracle.latestChainlinkPrice();
        expect(latestPrice.price).to.equal(990000n);
        expect(latestPrice.asOfTs).to.equal(secondUpdatedAt);
      });

      it("Should only be callable by OPERATOR_ROLE", async function () {
        const testAnswer = ethers.parseUnits("1.0", 18);
        const currentBlock = await ethers.provider.getBlock("latest");
        const testUpdatedAt = currentBlock!.timestamp;
        await chainlinkMock.setData(testAnswer, testUpdatedAt);

        // Call from operator should succeed
        await chainlinkOracle.connect(operator).recordChainlinkPrice();

        const latestPrice = await chainlinkOracle.latestChainlinkPrice();
        expect(latestPrice.price).to.equal(1000000n);
      });

      it("Should revert when called by non-operator", async function () {
        const testAnswer = ethers.parseUnits("1.0", 18);
        const currentBlock = await ethers.provider.getBlock("latest");
        const testUpdatedAt = currentBlock!.timestamp;
        await chainlinkMock.setData(testAnswer, testUpdatedAt);

        // Call from user (non-operator) should fail
        await expect(
          chainlinkOracle.connect(user).recordChainlinkPrice()
        ).to.be.reverted;

        // Call from deployer (non-operator) should fail
        await expect(
          chainlinkOracle.connect(deployer).recordChainlinkPrice()
        ).to.be.reverted;
      });
    });

    describe("Failure Cases", function () {
      it("Should revert if source is not active", async function () {
        const sources = await chainlinkOracle.sources();
        const newSources = {
          api3ReaderProxyV1IsActive: sources.api3ReaderProxyV1IsActive,
          api3ReaderProxyV1: sources.api3ReaderProxyV1,
          api3ReaderProxyV1Decimals: sources.api3ReaderProxyV1Decimals,
          api3ReaderProxyV1MaxStaleness: sources.api3ReaderProxyV1MaxStaleness,
          chainlinkAggregatorV3IsActive: false,
          chainlinkAggregatorV3: sources.chainlinkAggregatorV3,
          chainlinkAggregatorV3Decimals: sources.chainlinkAggregatorV3Decimals,
          chainlinkAggregatorV3MaxStaleness: sources.chainlinkAggregatorV3MaxStaleness,
          redStoneClassicIsActive: sources.redStoneClassicIsActive,
          redStoneClassicAggregator: sources.redStoneClassicAggregator,
          redStoneClassicDecimals: sources.redStoneClassicDecimals,
          redStoneClassicMaxStaleness: sources.redStoneClassicMaxStaleness,
          tellorIsActive: sources.tellorIsActive,
          tellorAdapter: sources.tellorAdapter,
          tellorDecimals: sources.tellorDecimals,
          tellorMaxStaleness: sources.tellorMaxStaleness,
        };

        await chainlinkOracle.connect(admin).setSources(newSources);

        await expect(
          chainlinkOracle.connect(operator).recordChainlinkPrice()
        ).to.be.reverted;
      });

      it("Should revert if source is not configured", async function () {
        const sources = await chainlinkOracle.sources();
        const newSources = {
          api3ReaderProxyV1IsActive: sources.api3ReaderProxyV1IsActive,
          api3ReaderProxyV1: sources.api3ReaderProxyV1,
          api3ReaderProxyV1Decimals: sources.api3ReaderProxyV1Decimals,
          api3ReaderProxyV1MaxStaleness: sources.api3ReaderProxyV1MaxStaleness,
          chainlinkAggregatorV3IsActive: sources.chainlinkAggregatorV3IsActive,
          chainlinkAggregatorV3: ZERO_ADDRESS,
          chainlinkAggregatorV3Decimals: sources.chainlinkAggregatorV3Decimals,
          chainlinkAggregatorV3MaxStaleness: sources.chainlinkAggregatorV3MaxStaleness,
          redStoneClassicIsActive: sources.redStoneClassicIsActive,
          redStoneClassicAggregator: sources.redStoneClassicAggregator,
          redStoneClassicDecimals: sources.redStoneClassicDecimals,
          redStoneClassicMaxStaleness: sources.redStoneClassicMaxStaleness,
          tellorIsActive: sources.tellorIsActive,
          tellorAdapter: sources.tellorAdapter,
          tellorDecimals: sources.tellorDecimals,
          tellorMaxStaleness: sources.tellorMaxStaleness,
        };

        await expect(
          chainlinkOracle.connect(admin).setSources(newSources)
        ).to.be.revertedWithCustomError(oracle, "SourceNotConfigured");
      });

      it("Should reject zero or negative answer", async function () {
        const currentBlock = await ethers.provider.getBlock("latest");
        const testUpdatedAt = currentBlock!.timestamp;
        await chainlinkMock.setData(0n, testUpdatedAt);

        await expect(
          chainlinkOracle.connect(operator).recordChainlinkPrice()
        ).to.be.reverted;
      });

      it("Should reject zero updatedAt", async function () {
        await chainlinkMock.setData(ethers.parseUnits("1.0", 18), 0);

        await expect(
          chainlinkOracle.connect(operator).recordChainlinkPrice()
        ).to.be.reverted;
      });

      it("Should reject future timestamps", async function () {
        const currentBlock = await ethers.provider.getBlock("latest");
        const futureTimestamp = currentBlock!.timestamp + 3600;
        await chainlinkMock.setData(ethers.parseUnits("1.0", 18), futureTimestamp);

        await expect(
          chainlinkOracle.connect(operator).recordChainlinkPrice()
        ).to.be.reverted;
      });
    });
  });

  describe("recordRedStoneClassicPrice", function () {
    let redStoneClassicMock: ChainlinkAggregatorMock;
    let redStoneOracle: TapirOracle | TapirPtrwOracle;

    beforeEach(async function () {
      // Deploy RedStone Classic mock (uses same interface as Chainlink)
      const RedStoneMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
      const initialAnswer = ethers.parseUnits("1.0", 8); // 1.0 in 8 decimals (RedStone standard)
      const currentBlock = await ethers.provider.getBlock("latest");
      const initialUpdatedAt = currentBlock!.timestamp;
      redStoneClassicMock = await RedStoneMock.deploy(initialAnswer, initialUpdatedAt, 8);

      // Setup sources with RedStone Classic enabled
      const sources = {
        api3ReaderProxyV1IsActive: false,
        api3ReaderProxyV1: ZERO_ADDRESS,
        api3ReaderProxyV1Decimals: 18,
        api3ReaderProxyV1MaxStaleness: 3600,
        chainlinkAggregatorV3IsActive: false,
        chainlinkAggregatorV3: ZERO_ADDRESS,
        chainlinkAggregatorV3Decimals: 18,
        chainlinkAggregatorV3MaxStaleness: 3600,
        redStoneClassicIsActive: true,
        redStoneClassicAggregator: await redStoneClassicMock.getAddress(),
        redStoneClassicDecimals: 8, // RedStone Classic typically uses 8 decimals
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
        depegPool: admin.address,
        xChainMode: false,
        xDomainMessengerL1: ZERO_ADDRESS,
      };

      redStoneOracle = await deployOracle(
        CONTRACT_NAME,
        ASSET_SYMBOL,
        ZERO_ADDRESS,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address
      );

      // Grant operator role for this oracle
      const OPERATOR_ROLE = await redStoneOracle.OPERATOR_ROLE();
      await redStoneOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
    });

    describe("Success Cases", function () {
      it("Should record RedStone Classic price correctly", async function () {
        // Set RedStone Classic mock data (in 8 decimals)
        const testAnswer = ethers.parseUnits("0.995", 8); // 0.995 USDT
        const expectedNormalized = 995000n; // Expected in 6 decimals
        const currentBlock = await ethers.provider.getBlock("latest");
        const testUpdatedAt = currentBlock!.timestamp;
        await redStoneClassicMock.setData(testAnswer, testUpdatedAt);

        // Record the price
        await redStoneOracle.connect(operator).recordRedStoneClassicPrice();

        // Verify the stored price data
        const latestPrice = await redStoneOracle.latestRedStoneClassicPrice();
        expect(latestPrice.price).to.equal(expectedNormalized);
        expect(latestPrice.asOfTs).to.equal(testUpdatedAt);
      });

      it("Should handle different price values", async function () {
        const testCases = [
          { value: ethers.parseUnits("1.0", 8), expected: 1000000n, desc: "1.0 USDT" },
          { value: ethers.parseUnits("0.99", 8), expected: 990000n, desc: "0.99 USDT" },
          { value: ethers.parseUnits("0.95", 8), expected: 950000n, desc: "0.95 USDT - significant depeg" },
          { value: ethers.parseUnits("1.01", 8), expected: 1010000n, desc: "1.01 USDT - above peg" },
        ];

        for (let i = 0; i < testCases.length; i++) {
          const testCase = testCases[i];
          
          // Advance time between iterations
          if (i > 0) {
            await ethers.provider.send("evm_increaseTime", [60]);
            await ethers.provider.send("evm_mine", []);
          }
          
          const currentBlock = await ethers.provider.getBlock("latest");
          const testUpdatedAt = currentBlock!.timestamp;
          await redStoneClassicMock.setData(testCase.value, testUpdatedAt);
          
          await redStoneOracle.connect(operator).recordRedStoneClassicPrice();

          const latestPrice = await redStoneOracle.latestRedStoneClassicPrice();
          expect(latestPrice.price).to.equal(
            testCase.expected,
            `Failed for ${testCase.desc}`
          );
          expect(latestPrice.asOfTs).to.equal(testUpdatedAt);
        }
      });

      it("Should normalize decimals correctly", async function () {
        // RedStone Classic uses 8 decimals, asset uses 6
        const testAnswer = ethers.parseUnits("0.995", 8);
        const expectedNormalized = 995000n; // 6 decimals
        const currentBlock = await ethers.provider.getBlock("latest");
        const testUpdatedAt = currentBlock!.timestamp;
        await redStoneClassicMock.setData(testAnswer, testUpdatedAt);

        await redStoneOracle.connect(operator).recordRedStoneClassicPrice();

        const latestPrice = await redStoneOracle.latestRedStoneClassicPrice();
        expect(latestPrice.price).to.equal(expectedNormalized);
      });

      it("Should update latestRedStoneClassicPrice on multiple calls", async function () {
        // First recording
        const firstAnswer = ethers.parseUnits("1.0", 8);
        const expectedFirst = 1000000n;
        const currentBlock = await ethers.provider.getBlock("latest");
        const firstUpdatedAt = currentBlock!.timestamp;
        await redStoneClassicMock.setData(firstAnswer, firstUpdatedAt);
        
        await redStoneOracle.connect(operator).recordRedStoneClassicPrice();

        let latestPrice = await redStoneOracle.latestRedStoneClassicPrice();
        expect(latestPrice.price).to.equal(expectedFirst);

        // Second recording with different value
        const secondAnswer = ethers.parseUnits("0.99", 8);
        const expectedSecond = 990000n;
        await ethers.provider.send("evm_increaseTime", [3600]);
        await ethers.provider.send("evm_mine", []);
        const newBlock = await ethers.provider.getBlock("latest");
        const secondUpdatedAt = newBlock!.timestamp;
        await redStoneClassicMock.setData(secondAnswer, secondUpdatedAt);
        
        await redStoneOracle.connect(operator).recordRedStoneClassicPrice();

        latestPrice = await redStoneOracle.latestRedStoneClassicPrice();
        expect(latestPrice.price).to.equal(expectedSecond);
        expect(latestPrice.asOfTs).to.equal(secondUpdatedAt);
      });

      it("Should only be callable by OPERATOR_ROLE", async function () {
        const testAnswer = ethers.parseUnits("1.0", 8);
        const currentBlock = await ethers.provider.getBlock("latest");
        const testUpdatedAt = currentBlock!.timestamp;
        await redStoneClassicMock.setData(testAnswer, testUpdatedAt);

        // Call from operator should succeed
        await redStoneOracle.connect(operator).recordRedStoneClassicPrice();

        const latestPrice = await redStoneOracle.latestRedStoneClassicPrice();
        expect(latestPrice.price).to.equal(1000000n);
      });

      it("Should revert when called by non-operator", async function () {
        const testAnswer = ethers.parseUnits("1.0", 8);
        const currentBlock = await ethers.provider.getBlock("latest");
        const testUpdatedAt = currentBlock!.timestamp;
        await redStoneClassicMock.setData(testAnswer, testUpdatedAt);

        // Call from user (non-operator) should fail
        await expect(
          redStoneOracle.connect(user).recordRedStoneClassicPrice()
        ).to.be.reverted;

        // Call from deployer (non-operator) should fail
        await expect(
          redStoneOracle.connect(deployer).recordRedStoneClassicPrice()
        ).to.be.reverted;
      });

      it("Should handle different decimal conversions", async function () {
        // Test with 18 decimals instead of 8
        const RedStoneMock18 = await ethers.getContractFactory("ChainlinkAggregatorMock");
        const initialAnswer = ethers.parseUnits("1.0", 18);
        const currentBlock = await ethers.provider.getBlock("latest");
        const initialUpdatedAt = currentBlock!.timestamp;
        const redStoneMock18 = await RedStoneMock18.deploy(initialAnswer, initialUpdatedAt, 18);

        const sources = {
          api3ReaderProxyV1IsActive: false,
          api3ReaderProxyV1: ZERO_ADDRESS,
          api3ReaderProxyV1Decimals: 18,
          api3ReaderProxyV1MaxStaleness: 3600,
          chainlinkAggregatorV3IsActive: false,
          chainlinkAggregatorV3: ZERO_ADDRESS,
          chainlinkAggregatorV3Decimals: 18,
          chainlinkAggregatorV3MaxStaleness: 3600,
          redStoneClassicIsActive: true,
          redStoneClassicAggregator: await redStoneMock18.getAddress(),
          redStoneClassicDecimals: 18,
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
          depegPool: admin.address,
          xChainMode: false,
          xDomainMessengerL1: ZERO_ADDRESS,
        };

        const oracle18 = await deployOracle(
          CONTRACT_NAME,
          ASSET_SYMBOL,
          ZERO_ADDRESS,
          ASSET_DECIMALS,
          sources,
          config,
          admin.address
        );

        // Grant operator role to this new oracle
        const OPERATOR_ROLE = await oracle18.OPERATOR_ROLE();
        await oracle18.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

        const testAnswer = ethers.parseUnits("0.995", 18);
        const expectedNormalized = 995000n; // 6 decimals
        await ethers.provider.send("evm_increaseTime", [60]);
        await ethers.provider.send("evm_mine", []);
        const newBlock = await ethers.provider.getBlock("latest");
        const testUpdatedAt = newBlock!.timestamp;
        await redStoneMock18.setData(testAnswer, testUpdatedAt);

        await oracle18.connect(operator).recordRedStoneClassicPrice();

        const latestPrice = await oracle18.latestRedStoneClassicPrice();
        expect(latestPrice.price).to.equal(expectedNormalized);
      });
    });

    describe("Error Cases", function () {
      it("Should revert if source is not active", async function () {
        const sources = await redStoneOracle.sources();
        const newSources = {
          api3ReaderProxyV1IsActive: sources.api3ReaderProxyV1IsActive,
          api3ReaderProxyV1: sources.api3ReaderProxyV1,
          api3ReaderProxyV1Decimals: sources.api3ReaderProxyV1Decimals,
          api3ReaderProxyV1MaxStaleness: sources.api3ReaderProxyV1MaxStaleness,
          chainlinkAggregatorV3IsActive: sources.chainlinkAggregatorV3IsActive,
          chainlinkAggregatorV3: sources.chainlinkAggregatorV3,
          chainlinkAggregatorV3Decimals: sources.chainlinkAggregatorV3Decimals,
          chainlinkAggregatorV3MaxStaleness: sources.chainlinkAggregatorV3MaxStaleness,
          redStoneClassicIsActive: false, // Disable
          redStoneClassicAggregator: sources.redStoneClassicAggregator,
          redStoneClassicDecimals: sources.redStoneClassicDecimals,
          redStoneClassicMaxStaleness: sources.redStoneClassicMaxStaleness,
          tellorIsActive: sources.tellorIsActive,
          tellorAdapter: sources.tellorAdapter,
          tellorDecimals: sources.tellorDecimals,
          tellorMaxStaleness: sources.tellorMaxStaleness,
        };

        await redStoneOracle.connect(admin).setSources(newSources);

        await expect(
          redStoneOracle.connect(operator).recordRedStoneClassicPrice()
        ).to.be.reverted;
      });

      it("Should revert if source is not configured", async function () {
        const sources = await redStoneOracle.sources();
        const newSources = {
          api3ReaderProxyV1IsActive: sources.api3ReaderProxyV1IsActive,
          api3ReaderProxyV1: sources.api3ReaderProxyV1,
          api3ReaderProxyV1Decimals: sources.api3ReaderProxyV1Decimals,
          api3ReaderProxyV1MaxStaleness: sources.api3ReaderProxyV1MaxStaleness,
          chainlinkAggregatorV3IsActive: sources.chainlinkAggregatorV3IsActive,
          chainlinkAggregatorV3: sources.chainlinkAggregatorV3,
          chainlinkAggregatorV3Decimals: sources.chainlinkAggregatorV3Decimals,
          chainlinkAggregatorV3MaxStaleness: sources.chainlinkAggregatorV3MaxStaleness,
          redStoneClassicIsActive: sources.redStoneClassicIsActive,
          redStoneClassicAggregator: ZERO_ADDRESS,
          redStoneClassicDecimals: sources.redStoneClassicDecimals,
          redStoneClassicMaxStaleness: sources.redStoneClassicMaxStaleness,
          tellorIsActive: sources.tellorIsActive,
          tellorAdapter: sources.tellorAdapter,
          tellorDecimals: sources.tellorDecimals,
          tellorMaxStaleness: sources.tellorMaxStaleness,
        };

        await expect(
          redStoneOracle.connect(admin).setSources(newSources)
        ).to.be.revertedWithCustomError(oracle, "SourceNotConfigured");
      });

      it("Should reject zero or negative answer", async function () {
        const currentBlock = await ethers.provider.getBlock("latest");
        const testUpdatedAt = currentBlock!.timestamp;
        await redStoneClassicMock.setData(0n, testUpdatedAt);

        await expect(
          redStoneOracle.connect(operator).recordRedStoneClassicPrice()
        ).to.be.revertedWithCustomError(oracle, "InvalidPrice");
      });

      it("Should reject zero updatedAt", async function () {
        const testAnswer = ethers.parseUnits("1.0", 8);
        await redStoneClassicMock.setData(testAnswer, 0);

        await expect(
          redStoneOracle.connect(operator).recordRedStoneClassicPrice()
        ).to.be.reverted;
      });

      it("Should reject future timestamps", async function () {
        const testAnswer = ethers.parseUnits("1.0", 8);
        const currentBlock = await ethers.provider.getBlock("latest");
        const futureUpdatedAt = BigInt(currentBlock!.timestamp) + 1000n;
        await redStoneClassicMock.setData(testAnswer, futureUpdatedAt);

        await expect(
          redStoneOracle.connect(operator).recordRedStoneClassicPrice()
        ).to.be.revertedWithCustomError(oracle, "FutureTimestamp");
      });
    });
  });

  describe("All Four Sources Recording", function () {
    let api3MockForAllSources: Api3ReaderProxyMock;
    let chainlinkMock: ChainlinkAggregatorMock;
    let redStoneMock: ChainlinkAggregatorMock;
    let tellorMock: ChainlinkAggregatorMock;
    let allSourcesOracle: TapirOracle | TapirPtrwOracle;

    // Different prices for each source (in their native decimals)
    const API3_PRICE = ethers.parseUnits("1.01", 18);      // API3: 18 decimals
    const CHAINLINK_PRICE = ethers.parseUnits("1.02", 8);  // Chainlink: 8 decimals
    const REDSTONE_PRICE = ethers.parseUnits("1.03", 8);   // RedStone: 8 decimals  
    const TELLOR_PRICE = ethers.parseUnits("1.04", 8);     // Tellor: 8 decimals

    // Expected normalized prices (all to 6 decimals for USDT asset)
    const EXPECTED_API3 = 1010000n;      // 1.01 * 10^6
    const EXPECTED_CHAINLINK = 1020000n; // 1.02 * 10^6
    const EXPECTED_REDSTONE = 1030000n;  // 1.03 * 10^6
    const EXPECTED_TELLOR = 1040000n;    // 1.04 * 10^6

    beforeEach(async function () {
      const currentBlock = await ethers.provider.getBlock("latest");
      const timestamp = currentBlock!.timestamp;

      // Deploy all four mocks
      const Api3Mock = await ethers.getContractFactory("Api3ReaderProxyMock");
      api3MockForAllSources = await Api3Mock.deploy(API3_PRICE, timestamp);

      const ChainlinkMockFactory = await ethers.getContractFactory("ChainlinkAggregatorMock");
      chainlinkMock = await ChainlinkMockFactory.deploy(CHAINLINK_PRICE, timestamp, 8);
      redStoneMock = await ChainlinkMockFactory.deploy(REDSTONE_PRICE, timestamp, 8);
      tellorMock = await ChainlinkMockFactory.deploy(TELLOR_PRICE, timestamp, 8);

      // Setup sources with all four enabled
      const sources = {
        api3ReaderProxyV1IsActive: true,
        api3ReaderProxyV1: await api3MockForAllSources.getAddress(),
        api3ReaderProxyV1Decimals: 18,
        api3ReaderProxyV1MaxStaleness: 3600,
        chainlinkAggregatorV3IsActive: true,
        chainlinkAggregatorV3: await chainlinkMock.getAddress(),
        chainlinkAggregatorV3Decimals: 8,
        chainlinkAggregatorV3MaxStaleness: 3600,
        redStoneClassicIsActive: true,
        redStoneClassicAggregator: await redStoneMock.getAddress(),
        redStoneClassicDecimals: 8,
        redStoneClassicMaxStaleness: 3600,
        tellorIsActive: true,
        tellorAdapter: await tellorMock.getAddress(),
        tellorDecimals: 8,
        tellorMaxStaleness: 3600,
      };

      const config = {
        minCheckpointSpacing: 86400,
        minValidSources: 4,
        closingPriceLookbackPeriod: 86400,
        depegPool: user.address, // Use a non-zero address
        xChainMode: false,
        xDomainMessengerL1: ZERO_ADDRESS,
      };

      allSourcesOracle = await deployOracle(
        CONTRACT_NAME,
        ASSET_SYMBOL,
        ZERO_ADDRESS,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address
      );

      // Grant operator role for this oracle
      const OPERATOR_ROLE = await allSourcesOracle.OPERATOR_ROLE();
      await allSourcesOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
    });

    it("Should correctly record different prices from all four oracle sources", async function () {
      // Record prices from all four sources
      await allSourcesOracle.connect(operator).recordApi3Price();
      await allSourcesOracle.connect(operator).recordChainlinkPrice();
      await allSourcesOracle.connect(operator).recordRedStoneClassicPrice();
      await allSourcesOracle.connect(operator).recordTellorPrice();

      // Verify each source recorded the correct normalized price
      const api3Price = await allSourcesOracle.latestApi3Price();
      expect(api3Price.price).to.equal(EXPECTED_API3, "API3 price mismatch");

      const chainlinkPrice = await allSourcesOracle.latestChainlinkPrice();
      expect(chainlinkPrice.price).to.equal(EXPECTED_CHAINLINK, "Chainlink price mismatch");

      const redStonePrice = await allSourcesOracle.latestRedStoneClassicPrice();
      expect(redStonePrice.price).to.equal(EXPECTED_REDSTONE, "RedStone price mismatch");

      const tellorPrice = await allSourcesOracle.latestTellorPrice();
      expect(tellorPrice.price).to.equal(EXPECTED_TELLOR, "Tellor price mismatch");
    });

    it("Should maintain independence between oracle sources", async function () {
      // Record only API3 and Chainlink initially
      await allSourcesOracle.connect(operator).recordApi3Price();
      await allSourcesOracle.connect(operator).recordChainlinkPrice();

      // Verify API3 and Chainlink are recorded
      let api3Price = await allSourcesOracle.latestApi3Price();
      let chainlinkPrice = await allSourcesOracle.latestChainlinkPrice();
      expect(api3Price.price).to.equal(EXPECTED_API3);
      expect(chainlinkPrice.price).to.equal(EXPECTED_CHAINLINK);

      // Verify RedStone and Tellor are still at default (0)
      let redStonePrice = await allSourcesOracle.latestRedStoneClassicPrice();
      let tellorPrice = await allSourcesOracle.latestTellorPrice();
      expect(redStonePrice.price).to.equal(0n, "RedStone should not be recorded yet");
      expect(tellorPrice.price).to.equal(0n, "Tellor should not be recorded yet");

      // Now record RedStone and Tellor
      await allSourcesOracle.connect(operator).recordRedStoneClassicPrice();
      await allSourcesOracle.connect(operator).recordTellorPrice();

      // Verify all four are now correctly recorded
      api3Price = await allSourcesOracle.latestApi3Price();
      chainlinkPrice = await allSourcesOracle.latestChainlinkPrice();
      redStonePrice = await allSourcesOracle.latestRedStoneClassicPrice();
      tellorPrice = await allSourcesOracle.latestTellorPrice();

      expect(api3Price.price).to.equal(EXPECTED_API3);
      expect(chainlinkPrice.price).to.equal(EXPECTED_CHAINLINK);
      expect(redStonePrice.price).to.equal(EXPECTED_REDSTONE);
      expect(tellorPrice.price).to.equal(EXPECTED_TELLOR);
    });

    it("Should correctly normalize different decimal formats to asset decimals", async function () {
      // Update mocks with specific test values to verify decimal normalization
      const currentBlock = await ethers.provider.getBlock("latest");
      const timestamp = currentBlock!.timestamp;

      // API3: 18 decimals -> 6 decimals (divide by 10^12)
      // 1.5 * 10^18 -> 1500000
      await api3MockForAllSources.setData(ethers.parseUnits("1.5", 18), timestamp);
      
      // Chainlink: 8 decimals -> 6 decimals (divide by 10^2)
      // 1.25 * 10^8 -> 1250000
      await chainlinkMock.setData(ethers.parseUnits("1.25", 8), timestamp);
      
      // RedStone: 8 decimals -> 6 decimals (divide by 10^2)
      // 0.95 * 10^8 -> 950000
      await redStoneMock.setData(ethers.parseUnits("0.95", 8), timestamp);
      
      // Tellor: 8 decimals -> 6 decimals (divide by 10^2)
      // 1.00 * 10^8 -> 1000000
      await tellorMock.setData(ethers.parseUnits("1.00", 8), timestamp);

      // Record all prices
      await allSourcesOracle.connect(operator).recordApi3Price();
      await allSourcesOracle.connect(operator).recordChainlinkPrice();
      await allSourcesOracle.connect(operator).recordRedStoneClassicPrice();
      await allSourcesOracle.connect(operator).recordTellorPrice();

      // Verify normalized prices
      const api3Price = await allSourcesOracle.latestApi3Price();
      expect(api3Price.price).to.equal(1500000n, "API3: 1.5 should normalize to 1500000");

      const chainlinkPrice = await allSourcesOracle.latestChainlinkPrice();
      expect(chainlinkPrice.price).to.equal(1250000n, "Chainlink: 1.25 should normalize to 1250000");

      const redStonePrice = await allSourcesOracle.latestRedStoneClassicPrice();
      expect(redStonePrice.price).to.equal(950000n, "RedStone: 0.95 should normalize to 950000");

      const tellorPrice = await allSourcesOracle.latestTellorPrice();
      expect(tellorPrice.price).to.equal(1000000n, "Tellor: 1.00 should normalize to 1000000");
    });

    it("Should store correct timestamps for each source", async function () {
      // Record prices from all four sources
      await allSourcesOracle.connect(operator).recordApi3Price();
      await allSourcesOracle.connect(operator).recordChainlinkPrice();
      await allSourcesOracle.connect(operator).recordRedStoneClassicPrice();
      await allSourcesOracle.connect(operator).recordTellorPrice();

      const currentBlock = await ethers.provider.getBlock("latest");
      const blockTimestamp = currentBlock!.timestamp;

      // All timestamps should be at or before the current block timestamp
      const api3Price = await allSourcesOracle.latestApi3Price();
      const chainlinkPrice = await allSourcesOracle.latestChainlinkPrice();
      const redStonePrice = await allSourcesOracle.latestRedStoneClassicPrice();
      const tellorPrice = await allSourcesOracle.latestTellorPrice();

      expect(api3Price.asOfTs).to.be.lte(blockTimestamp);
      expect(chainlinkPrice.asOfTs).to.be.lte(blockTimestamp);
      expect(redStonePrice.asOfTs).to.be.lte(blockTimestamp);
      expect(tellorPrice.asOfTs).to.be.lte(blockTimestamp);

      // All timestamps should be > 0 (recorded)
      expect(api3Price.asOfTs).to.be.gt(0);
      expect(chainlinkPrice.asOfTs).to.be.gt(0);
      expect(redStonePrice.asOfTs).to.be.gt(0);
      expect(tellorPrice.asOfTs).to.be.gt(0);
    });

    it("Should emit PriceRecorded event with correct data for all sources", async function () {
      // API3: Should emit with "API3" source name and normalized price
      const api3Tx = await allSourcesOracle.connect(operator).recordApi3Price();
      const api3Receipt = await api3Tx.wait();
      const api3Block = await ethers.provider.getBlock(api3Receipt!.blockNumber);
      await expect(api3Tx)
        .to.emit(allSourcesOracle, "PriceRecorded")
        .withArgs(api3Block!.timestamp, EXPECTED_API3, "API3");

      // Chainlink: Should emit with "Chainlink" source name and normalized price
      const chainlinkTx = await allSourcesOracle.connect(operator).recordChainlinkPrice();
      const chainlinkReceipt = await chainlinkTx.wait();
      const chainlinkBlock = await ethers.provider.getBlock(chainlinkReceipt!.blockNumber);
      await expect(chainlinkTx)
        .to.emit(allSourcesOracle, "PriceRecorded")
        .withArgs(chainlinkBlock!.timestamp, EXPECTED_CHAINLINK, "Chainlink");

      // RedStone: Should emit with "RedStone" source name and normalized price
      const redStoneTx = await allSourcesOracle.connect(operator).recordRedStoneClassicPrice();
      const redStoneReceipt = await redStoneTx.wait();
      const redStoneBlock = await ethers.provider.getBlock(redStoneReceipt!.blockNumber);
      await expect(redStoneTx)
        .to.emit(allSourcesOracle, "PriceRecorded")
        .withArgs(redStoneBlock!.timestamp, EXPECTED_REDSTONE, "RedStone");

      // Tellor: Should emit with "Tellor" source name and normalized price
      const tellorTx = await allSourcesOracle.connect(operator).recordTellorPrice();
      const tellorReceipt = await tellorTx.wait();
      const tellorBlock = await ethers.provider.getBlock(tellorReceipt!.blockNumber);
      await expect(tellorTx)
        .to.emit(allSourcesOracle, "PriceRecorded")
        .withArgs(tellorBlock!.timestamp, EXPECTED_TELLOR, "Tellor");
    });
  });
  
  describe("View Functions", function () {
    it("Should return correct sources configuration", async function () {
      const sources = await oracle.sources();
      expect(sources.api3ReaderProxyV1IsActive).to.be.true;
      expect(sources.api3ReaderProxyV1).to.equal(await api3Mock.getAddress());
    });

    it("Should return correct asset metadata", async function () {
      expect(await oracle.assetSymbol()).to.equal(ASSET_SYMBOL);
      expect(await oracle.assetDecimals()).to.equal(ASSET_DECIMALS);
    });
  });

  describe("Checkpoint Functionality", function () {
    describe("Single Source Checkpoint", function () {
      it("Should successfully checkpoint with minValidSources=1 and single active source", async function () {
        // Update config to allow single source
        const currentConfig = await oracle.cfg();
        const newConfig = {
          minCheckpointSpacing: currentConfig.minCheckpointSpacing,
          minValidSources: 1, // Allow single source
          closingPriceLookbackPeriod: currentConfig.closingPriceLookbackPeriod,
          depegPool: currentConfig.depegPool,
          xChainMode: currentConfig.xChainMode,
          xDomainMessengerL1: currentConfig.xDomainMessengerL1,
        };
        await oracle.connect(admin).setConfig(newConfig);

        // Record a price with the single active source (API3)
        const testValue = ethers.parseUnits("0.995", 18);
        const currentBlock = await ethers.provider.getBlock("latest");
        const testTimestamp = currentBlock!.timestamp;
        await api3Mock.setData(testValue, testTimestamp);
        await oracle.connect(operator).recordApi3Price();

        // Perform checkpoint with single source
        await oracle.connect(operator).checkpoint();

        // Verify checkpoint was successful
        const checkpointCount = await oracle.checkpointsCount();
        expect(checkpointCount).to.equal(1);
      });

      it("Should handle median calculation correctly with single source", async function () {
        // Update config to allow single source
        const currentConfig = await oracle.cfg();
        const newConfig = {
          minCheckpointSpacing: 0, // Allow immediate checkpoints for testing
          minValidSources: 1,
          closingPriceLookbackPeriod: currentConfig.closingPriceLookbackPeriod,
          depegPool: currentConfig.depegPool,
          xChainMode: currentConfig.xChainMode,
          xDomainMessengerL1: currentConfig.xDomainMessengerL1,
        };
        await oracle.connect(admin).setConfig(newConfig);

        // Record multiple checkpoints with single source
        const testValues = [
          ethers.parseUnits("0.990", 18),
          ethers.parseUnits("0.985", 18),
          ethers.parseUnits("0.980", 18),
        ];

        for (let i = 0; i < testValues.length; i++) {
          await ethers.provider.send("evm_increaseTime", [100]);
          await ethers.provider.send("evm_mine", []);
          
          const currentBlock = await ethers.provider.getBlock("latest");
          const testTimestamp = currentBlock!.timestamp;
          await api3Mock.setData(testValues[i], testTimestamp);
          await oracle.connect(operator).recordApi3Price();
          await oracle.connect(operator).checkpoint();
        }

        // Verify all checkpoints were recorded
        const checkpointCount = await oracle.checkpointsCount();
        expect(checkpointCount).to.equal(3);
      });

      it("Should revert if minValidSources=2 but only one source is available", async function () {
        // Keep config at minValidSources=2 (default from beforeEach)
        const currentConfig = await oracle.cfg();
        expect(currentConfig.minValidSources).to.equal(2);

        // Record a price with only one source
        const testValue = ethers.parseUnits("0.995", 18);
        const currentBlock = await ethers.provider.getBlock("latest");
        const testTimestamp = currentBlock!.timestamp;
        await api3Mock.setData(testValue, testTimestamp);
        await oracle.connect(operator).recordApi3Price();

        // Attempt checkpoint - should fail
        await expect(
          oracle.connect(operator).checkpoint()
        ).to.be.revertedWithCustomError(oracle, "NotEnoughValidSources");
      });

      it("Should revert if minValidSources is configured incorrectly (0)", async function () {
        const currentConfig = await oracle.cfg();
        
        // Test minValidSources = 0
        let badConfig = {
          minCheckpointSpacing: currentConfig.minCheckpointSpacing,
          minValidSources: 0,
          closingPriceLookbackPeriod: currentConfig.closingPriceLookbackPeriod,
          depegPool: currentConfig.depegPool,
          xChainMode: currentConfig.xChainMode,
          xDomainMessengerL1: currentConfig.xDomainMessengerL1,
        };
        await expect(
          oracle.connect(admin).setConfig(badConfig)
        ).to.be.revertedWithCustomError(oracle, "InvalidMinValidSources");
      });

      it("Should exclude a source when it is deactivated, even if the price is fresh (L-02 Fix)", async function () {
        // Configure minValidSources = 1
        const currentConfig = await oracle.cfg();
        await oracle.connect(admin).setConfig({
          minCheckpointSpacing: 0, // Allow immediate checkpoints
          minValidSources: 1,
          closingPriceLookbackPeriod: currentConfig.closingPriceLookbackPeriod,
          depegPool: currentConfig.depegPool,
          xChainMode: currentConfig.xChainMode,
          xDomainMessengerL1: currentConfig.xDomainMessengerL1,
        });

        // Ensure API3 is active and has a fresh price
        const testValue = ethers.parseUnits("0.995", 18);
        const currentBlock = await ethers.provider.getBlock("latest");
        const testTimestamp = currentBlock!.timestamp;
        await api3Mock.setData(testValue, testTimestamp);
        await oracle.connect(operator).recordApi3Price();

        // Verify it can checkpoint now
        await oracle.connect(operator).checkpoint();
        expect(await oracle.checkpointsCount()).to.equal(1);

        // Deactivate API3
        const sources = await oracle.sources();
        const newSources = {
          api3ReaderProxyV1IsActive: false, // Deactivate
          api3ReaderProxyV1: sources.api3ReaderProxyV1,
          api3ReaderProxyV1Decimals: sources.api3ReaderProxyV1Decimals,
          api3ReaderProxyV1MaxStaleness: sources.api3ReaderProxyV1MaxStaleness,
          chainlinkAggregatorV3IsActive: sources.chainlinkAggregatorV3IsActive,
          chainlinkAggregatorV3: sources.chainlinkAggregatorV3,
          chainlinkAggregatorV3Decimals: sources.chainlinkAggregatorV3Decimals,
          chainlinkAggregatorV3MaxStaleness: sources.chainlinkAggregatorV3MaxStaleness,
          redStoneClassicIsActive: sources.redStoneClassicIsActive,
          redStoneClassicAggregator: sources.redStoneClassicAggregator,
          redStoneClassicDecimals: sources.redStoneClassicDecimals,
          redStoneClassicMaxStaleness: sources.redStoneClassicMaxStaleness,
          tellorIsActive: sources.tellorIsActive,
          tellorAdapter: sources.tellorAdapter,
          tellorDecimals: sources.tellorDecimals,
          tellorMaxStaleness: sources.tellorMaxStaleness,
        };
        await oracle.connect(admin).setSources(newSources);

        // Try to checkpoint - should fail because no active sources remain
        // even though API3's last recorded price is still fresh
        await expect(
          oracle.connect(operator).checkpoint()
        ).to.be.revertedWithCustomError(oracle, "NotEnoughValidSources");
      });
    });

    describe("Per-Source Staleness Checks (TAP-4 Fix)", function () {
      /**
       * TAP-4: Tests for individual maxPriceStaleness per source
       * 
       * This test suite verifies that each oracle source is validated against
       * its own staleness threshold, not a global one.
       * 
       */
      
      let multiSourceOracle: TapirOracle | TapirPtrwOracle;
      let api3MockLocal: Api3ReaderProxyMock;
      let chainlinkMockLocal: ChainlinkAggregatorMock;
      let redStoneMockLocal: ChainlinkAggregatorMock;
      let tellorMockLocal: ChainlinkAggregatorMock;

      // Different staleness thresholds to simulate different oracle heartbeats
      const API3_STALENESS = 3600;        // 1 hour
      const CHAINLINK_STALENESS = 86400;  // 24 hours
      const REDSTONE_STALENESS = 7200;    // 2 hours
      const TELLOR_STALENESS = 43200;     // 12 hours

      beforeEach(async function () {
        // Deploy fresh mocks for this test suite
        const Api3Mock = await ethers.getContractFactory("Api3ReaderProxyMock");
        const ChainlinkMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
        
        const currentBlock = await ethers.provider.getBlock("latest");
        const initialTimestamp = currentBlock!.timestamp;
        const initialPrice = ethers.parseUnits("1.0", 18);

        api3MockLocal = await Api3Mock.deploy(initialPrice, initialTimestamp);
        chainlinkMockLocal = await ChainlinkMock.deploy(initialPrice, initialTimestamp, 18);
        redStoneMockLocal = await ChainlinkMock.deploy(initialPrice, initialTimestamp, 8);
        tellorMockLocal = await ChainlinkMock.deploy(initialPrice, initialTimestamp, 8);

        // Setup sources with different staleness thresholds for each
        const sources = {
          api3ReaderProxyV1IsActive: true,
          api3ReaderProxyV1: await api3MockLocal.getAddress(),
          api3ReaderProxyV1Decimals: 18,
          api3ReaderProxyV1MaxStaleness: API3_STALENESS,
          chainlinkAggregatorV3IsActive: true,
          chainlinkAggregatorV3: await chainlinkMockLocal.getAddress(),
          chainlinkAggregatorV3Decimals: 18,
          chainlinkAggregatorV3MaxStaleness: CHAINLINK_STALENESS,
          redStoneClassicIsActive: true,
          redStoneClassicAggregator: await redStoneMockLocal.getAddress(),
          redStoneClassicDecimals: 8,
          redStoneClassicMaxStaleness: REDSTONE_STALENESS,
          tellorIsActive: true,
          tellorAdapter: await tellorMockLocal.getAddress(),
          tellorDecimals: 8,
          tellorMaxStaleness: TELLOR_STALENESS,
        };

        const config = {
          minCheckpointSpacing: 0, // Allow immediate checkpoints for testing
          minValidSources: 1, // Start with 1 to test individual staleness
          closingPriceLookbackPeriod: 86400,
          depegPool: admin.address,
          xChainMode: false,
          xDomainMessengerL1: ZERO_ADDRESS,
        };

        multiSourceOracle = await deployOracle(
          CONTRACT_NAME,
          ASSET_SYMBOL,
          ZERO_ADDRESS,
          ASSET_DECIMALS,
          sources,
          config,
          admin.address
        );

        const OPERATOR_ROLE = await multiSourceOracle.OPERATOR_ROLE();
        await multiSourceOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
      });

      it("Should accept fresh prices from all sources when within their individual staleness thresholds", async function () {
        const currentBlock = await ethers.provider.getBlock("latest");
        const freshTimestamp = currentBlock!.timestamp;
        const testPrice = ethers.parseUnits("0.995", 18);
        const testPrice8Dec = ethers.parseUnits("0.995", 8);

        // Set fresh prices for all sources
        await api3MockLocal.setData(testPrice, freshTimestamp);
        await chainlinkMockLocal.setData(testPrice, freshTimestamp);
        await redStoneMockLocal.setData(testPrice8Dec, freshTimestamp);
        await tellorMockLocal.setData(testPrice8Dec, freshTimestamp);

        // Record all prices
        await multiSourceOracle.connect(operator).recordApi3Price();
        await multiSourceOracle.connect(operator).recordChainlinkPrice();
        await multiSourceOracle.connect(operator).recordRedStoneClassicPrice();
        await multiSourceOracle.connect(operator).recordTellorPrice();

        // Update config to require all 4 sources
        const currentConfig = await multiSourceOracle.cfg();
        await multiSourceOracle.connect(admin).setConfig({
          minCheckpointSpacing: currentConfig.minCheckpointSpacing,
          minValidSources: 4,
          closingPriceLookbackPeriod: currentConfig.closingPriceLookbackPeriod,
          depegPool: currentConfig.depegPool,
          xChainMode: currentConfig.xChainMode,
          xDomainMessengerL1: currentConfig.xDomainMessengerL1,
        });

        // Checkpoint should succeed with all 4 valid sources
        await multiSourceOracle.connect(operator).checkpoint();
        expect(await multiSourceOracle.checkpointsCount()).to.equal(1);
      });

      it("Should exclude API3 when stale (>1h) but include Chainlink with longer threshold (24h)", async function () {
        const currentBlock = await ethers.provider.getBlock("latest");
        const freshTimestamp = currentBlock!.timestamp;
        const testPrice = ethers.parseUnits("0.995", 18);

        // Set fresh prices initially
        await api3MockLocal.setData(testPrice, freshTimestamp);
        await chainlinkMockLocal.setData(testPrice, freshTimestamp);

        // Record prices
        await multiSourceOracle.connect(operator).recordApi3Price();
        await multiSourceOracle.connect(operator).recordChainlinkPrice();

        // Advance time past API3 staleness (1h) but within Chainlink staleness (24h)
        await ethers.provider.send("evm_increaseTime", [API3_STALENESS + 100]); // 1h + 100s
        await ethers.provider.send("evm_mine", []);

        // Update config to require 2 sources - should fail because API3 is now stale
        const currentConfig = await multiSourceOracle.cfg();
        await multiSourceOracle.connect(admin).setConfig({
          minCheckpointSpacing: currentConfig.minCheckpointSpacing,
          minValidSources: 2,
          closingPriceLookbackPeriod: currentConfig.closingPriceLookbackPeriod,
          depegPool: currentConfig.depegPool,
          xChainMode: currentConfig.xChainMode,
          xDomainMessengerL1: currentConfig.xDomainMessengerL1,
        });

        // Checkpoint should fail - API3 is stale, only Chainlink is valid
        await expect(
          multiSourceOracle.connect(operator).checkpoint()
        ).to.be.revertedWithCustomError(multiSourceOracle, "NotEnoughValidSources");

        // But with minValidSources=1, Chainlink alone should still work
        await multiSourceOracle.connect(admin).setConfig({
          minCheckpointSpacing: currentConfig.minCheckpointSpacing,
          minValidSources: 1,
          closingPriceLookbackPeriod: currentConfig.closingPriceLookbackPeriod,
          depegPool: currentConfig.depegPool,
          xChainMode: currentConfig.xChainMode,
          xDomainMessengerL1: currentConfig.xDomainMessengerL1,
        });

        await multiSourceOracle.connect(operator).checkpoint();
        expect(await multiSourceOracle.checkpointsCount()).to.equal(1);
      });

      it("Should correctly handle mixed staleness states across all sources", async function () {
        const currentBlock = await ethers.provider.getBlock("latest");
        const baseTimestamp = currentBlock!.timestamp;
        const testPrice = ethers.parseUnits("0.995", 18);
        const testPrice8Dec = ethers.parseUnits("0.995", 8);

        // Set prices at different times to create mixed staleness states
        // API3: fresh (within 1h)
        // Chainlink: old but within 24h threshold
        // RedStone: stale (>2h)
        // Tellor: old but within 12h threshold

        // First, advance time to create baseline
        await ethers.provider.send("evm_increaseTime", [10000]); // ~2.8 hours
        await ethers.provider.send("evm_mine", []);

        let block = await ethers.provider.getBlock("latest");
        let now = block!.timestamp;

        // API3: fresh (0s old)
        await api3MockLocal.setData(testPrice, now);
        
        // Chainlink: 3 hours old (within 24h threshold)
        await chainlinkMockLocal.setData(testPrice, now - 10800);
        
        // RedStone: 3 hours old (STALE - exceeds 2h threshold)
        await redStoneMockLocal.setData(testPrice8Dec, now - 10800);
        
        // Tellor: 10 hours old (within 12h threshold)
        await tellorMockLocal.setData(testPrice8Dec, now - 36000);

        // Record all prices
        await multiSourceOracle.connect(operator).recordApi3Price();
        await multiSourceOracle.connect(operator).recordChainlinkPrice();
        await multiSourceOracle.connect(operator).recordRedStoneClassicPrice();
        await multiSourceOracle.connect(operator).recordTellorPrice();

        // With minValidSources=3, should succeed (API3, Chainlink, Tellor are valid; RedStone is stale)
        const currentConfig = await multiSourceOracle.cfg();
        await multiSourceOracle.connect(admin).setConfig({
          minCheckpointSpacing: currentConfig.minCheckpointSpacing,
          minValidSources: 3,
          closingPriceLookbackPeriod: currentConfig.closingPriceLookbackPeriod,
          depegPool: currentConfig.depegPool,
          xChainMode: currentConfig.xChainMode,
          xDomainMessengerL1: currentConfig.xDomainMessengerL1,
        });

        await multiSourceOracle.connect(operator).checkpoint();
        expect(await multiSourceOracle.checkpointsCount()).to.equal(1);

        // With minValidSources=4, should fail (only 3 valid sources)
        await multiSourceOracle.connect(admin).setConfig({
          minCheckpointSpacing: currentConfig.minCheckpointSpacing,
          minValidSources: 4,
          closingPriceLookbackPeriod: currentConfig.closingPriceLookbackPeriod,
          depegPool: currentConfig.depegPool,
          xChainMode: currentConfig.xChainMode,
          xDomainMessengerL1: currentConfig.xDomainMessengerL1,
        });

        await expect(
          multiSourceOracle.connect(operator).checkpoint()
        ).to.be.revertedWithCustomError(multiSourceOracle, "NotEnoughValidSources");
      });

      it("Should handle randomized staleness thresholds correctly", async function () {
        // Generate random staleness values for each source
        const randomApi3Staleness = Math.floor(Math.random() * 3600) + 1800; // 30min to 1.5h
        const randomChainlinkStaleness = Math.floor(Math.random() * 43200) + 43200; // 12h to 24h
        const randomRedStoneStaleness = Math.floor(Math.random() * 7200) + 3600; // 1h to 3h
        const randomTellorStaleness = Math.floor(Math.random() * 21600) + 21600; // 6h to 12h

        // Update sources with random staleness values
        const sources = await multiSourceOracle.sources();
        await multiSourceOracle.connect(admin).setSources({
          api3ReaderProxyV1IsActive: sources.api3ReaderProxyV1IsActive,
          api3ReaderProxyV1: sources.api3ReaderProxyV1,
          api3ReaderProxyV1Decimals: sources.api3ReaderProxyV1Decimals,
          api3ReaderProxyV1MaxStaleness: randomApi3Staleness,
          chainlinkAggregatorV3IsActive: sources.chainlinkAggregatorV3IsActive,
          chainlinkAggregatorV3: sources.chainlinkAggregatorV3,
          chainlinkAggregatorV3Decimals: sources.chainlinkAggregatorV3Decimals,
          chainlinkAggregatorV3MaxStaleness: randomChainlinkStaleness,
          redStoneClassicIsActive: sources.redStoneClassicIsActive,
          redStoneClassicAggregator: sources.redStoneClassicAggregator,
          redStoneClassicDecimals: sources.redStoneClassicDecimals,
          redStoneClassicMaxStaleness: randomRedStoneStaleness,
          tellorIsActive: sources.tellorIsActive,
          tellorAdapter: sources.tellorAdapter,
          tellorDecimals: sources.tellorDecimals,
          tellorMaxStaleness: randomTellorStaleness,
        });

        const testPrice = ethers.parseUnits("0.995", 18);
        const testPrice8Dec = ethers.parseUnits("0.995", 8);

        let block = await ethers.provider.getBlock("latest");
        let now = block!.timestamp;

        // Set prices with timestamps that make them just barely valid
        await api3MockLocal.setData(testPrice, now);
        await chainlinkMockLocal.setData(testPrice, now);
        await redStoneMockLocal.setData(testPrice8Dec, now);
        await tellorMockLocal.setData(testPrice8Dec, now);

        // Record all prices
        await multiSourceOracle.connect(operator).recordApi3Price();
        await multiSourceOracle.connect(operator).recordChainlinkPrice();
        await multiSourceOracle.connect(operator).recordRedStoneClassicPrice();
        await multiSourceOracle.connect(operator).recordTellorPrice();

        // All should be valid initially
        const currentConfig = await multiSourceOracle.cfg();
        await multiSourceOracle.connect(admin).setConfig({
          minCheckpointSpacing: currentConfig.minCheckpointSpacing,
          minValidSources: 4,
          closingPriceLookbackPeriod: currentConfig.closingPriceLookbackPeriod,
          depegPool: currentConfig.depegPool,
          xChainMode: currentConfig.xChainMode,
          xDomainMessengerL1: currentConfig.xDomainMessengerL1,
        });

        await multiSourceOracle.connect(operator).checkpoint();
        expect(await multiSourceOracle.checkpointsCount()).to.equal(1);

        // Advance time past the smallest staleness threshold
        const smallestStaleness = Math.min(
          randomApi3Staleness,
          randomChainlinkStaleness,
          randomRedStoneStaleness,
          randomTellorStaleness
        );

        await ethers.provider.send("evm_increaseTime", [smallestStaleness + 10]);
        await ethers.provider.send("evm_mine", []);

        // At least one source should now be stale, so 4 valid sources should fail
        await expect(
          multiSourceOracle.connect(operator).checkpoint()
        ).to.be.revertedWithCustomError(multiSourceOracle, "NotEnoughValidSources");
      });

      it("Should verify edge case: source becomes stale exactly at threshold boundary", async function () {
        const testPrice = ethers.parseUnits("0.995", 18);
        
        // Get fresh timestamp and set price
        let block = await ethers.provider.getBlock("latest");
        let now = block!.timestamp;
        await api3MockLocal.setData(testPrice, now);
        await multiSourceOracle.connect(operator).recordApi3Price();

        // Advance time to API3_STALENESS - 100 (well within threshold)
        await ethers.provider.send("evm_increaseTime", [API3_STALENESS - 100]);
        await ethers.provider.send("evm_mine", []);

        // Should succeed (price is still valid)
        await multiSourceOracle.connect(operator).checkpoint();
        expect(await multiSourceOracle.checkpointsCount()).to.equal(1);

        // Record new price at current time
        block = await ethers.provider.getBlock("latest");
        now = block!.timestamp;
        await api3MockLocal.setData(testPrice, now);
        await multiSourceOracle.connect(operator).recordApi3Price();

        // Advance time well past threshold
        await ethers.provider.send("evm_increaseTime", [API3_STALENESS + 100]);
        await ethers.provider.send("evm_mine", []);

        // Should fail (price is now stale)
        await expect(
          multiSourceOracle.connect(operator).checkpoint()
        ).to.be.revertedWithCustomError(multiSourceOracle, "NotEnoughValidSources");
      });
    });
  });

  describe("Auxiliary tests", function () {
    describe("Downcasting & uint192 Price Bounds", function () {
      it("Should reject API3 price that exceeds uint192 max after normalization", async function () {
        // uint192 max is 2^192 - 1
        const uint192Max = (BigInt(2) ** BigInt(192)) - BigInt(1);
        
        // API3 uses int224, so we're limited by that. Deploy a new mock with matching decimals
        // to avoid the int224 overflow issue when scaling
        const Api3MockSameDecimals = await ethers.getContractFactory("Api3ReaderProxyMock");
        const currentBlock = await ethers.provider.getBlock("latest");
        const currentTimestamp = currentBlock!.timestamp;
        const api3MockSameDecimals = await Api3MockSameDecimals.deploy(
          BigInt(0), // Initial value
          currentTimestamp
        );
        
        // Create a new oracle with API3 having same decimals as target (no scaling needed)
        const sources = {
          api3ReaderProxyV1IsActive: true,
          api3ReaderProxyV1: await api3MockSameDecimals.getAddress(),
          api3ReaderProxyV1Decimals: ASSET_DECIMALS, // Same as target
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
          depegPool: admin.address,
          xChainMode: false,
          xDomainMessengerL1: ZERO_ADDRESS,
        };
        
        const testOracle = await deployOracle(
          CONTRACT_NAME,
          ASSET_SYMBOL,
          ZERO_ADDRESS,
          ASSET_DECIMALS,
          sources,
          config,
          admin.address
        );

        // Grant operator role
        const OPERATOR_ROLE = await testOracle.OPERATOR_ROLE();
        await testOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
        
        // Set a value that exceeds uint192 max (no scaling, same decimals)
        const exceedingValue = uint192Max + BigInt(1);
        await api3MockSameDecimals.setValue(exceedingValue);
        await api3MockSameDecimals.setTimestamp(currentTimestamp);
        
        // Attempt to record the price should revert
        await expect(testOracle.connect(operator).recordApi3Price())
          .to.be.reverted;
      });

      it("Should reject Chainlink price that exceeds uint192 max after normalization", async function () {
        // uint192 max is 2^192 - 1
        const uint192Max = (BigInt(2) ** BigInt(192)) - BigInt(1);
        const exceedingValue = uint192Max + BigInt(1);
        
        // Deploy a Chainlink mock
        const ChainlinkMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
        const currentBlock = await ethers.provider.getBlock("latest");
        const currentTimestamp = currentBlock!.timestamp;
        const chainlinkMock = await ChainlinkMock.deploy(
          BigInt(0), // initial answer (will be overridden)
          currentTimestamp,
          6 // Same decimals as target to avoid normalization issues
        );
        
        // Create a new oracle with Chainlink enabled
        const sources = {
          api3ReaderProxyV1IsActive: false,
          api3ReaderProxyV1: ZERO_ADDRESS,
          api3ReaderProxyV1Decimals: 18,
          api3ReaderProxyV1MaxStaleness: 3600,
          chainlinkAggregatorV3IsActive: true,
          chainlinkAggregatorV3: await chainlinkMock.getAddress(),
          chainlinkAggregatorV3Decimals: 6, // Same as ASSET_DECIMALS
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
          minValidSources: 1, // Only need 1 source for this test
          closingPriceLookbackPeriod: 86400,
          depegPool: admin.address,
          xChainMode: false,
          xDomainMessengerL1: ZERO_ADDRESS,
        };
        
        const chainlinkTestOracle = await deployOracle(
          CONTRACT_NAME,
          ASSET_SYMBOL,
          ZERO_ADDRESS,
          ASSET_DECIMALS,
          sources,
          config,
          admin.address
        );

        // Grant operator role
        const OPERATOR_ROLE = await chainlinkTestOracle.OPERATOR_ROLE();
        await chainlinkTestOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
        
        // Set a value that exceeds uint192 max
        await chainlinkMock.setAnswer(exceedingValue);
        await chainlinkMock.setUpdatedAt(currentTimestamp);
        
        // Attempt to record the price should revert
        await expect(chainlinkTestOracle.connect(operator).recordChainlinkPrice())
          .to.be.reverted;
      });

      it("Should reject RedStone Classic price that exceeds uint192 max after normalization", async function () {
        // uint192 max is 2^192 - 1
        const uint192Max = (BigInt(2) ** BigInt(192)) - BigInt(1);
        const exceedingValue = uint192Max + BigInt(1);
        
        // Deploy a RedStone mock (uses same contract as Chainlink)
        const RedStoneMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
        const currentBlock = await ethers.provider.getBlock("latest");
        const currentTimestamp = currentBlock!.timestamp;
        const redStoneMock = await RedStoneMock.deploy(
          BigInt(0), // initial answer
          currentTimestamp,
          6 // Same decimals as target
        );
        
        // Create a new oracle with RedStone enabled
        const sources = {
          api3ReaderProxyV1IsActive: false,
          api3ReaderProxyV1: ZERO_ADDRESS,
          api3ReaderProxyV1Decimals: 18,
          api3ReaderProxyV1MaxStaleness: 3600,
          chainlinkAggregatorV3IsActive: false,
          chainlinkAggregatorV3: ZERO_ADDRESS,
          chainlinkAggregatorV3Decimals: 18,
          chainlinkAggregatorV3MaxStaleness: 3600,
          redStoneClassicIsActive: true,
          redStoneClassicAggregator: await redStoneMock.getAddress(),
          redStoneClassicDecimals: 6, // Same as ASSET_DECIMALS
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
          depegPool: admin.address,
          xChainMode: false,
          xDomainMessengerL1: ZERO_ADDRESS,
        };
        
        const redStoneTestOracle = await deployOracle(
          CONTRACT_NAME,
          ASSET_SYMBOL,
          ZERO_ADDRESS,
          ASSET_DECIMALS,
          sources,
          config,
          admin.address
        );

        // Grant operator role
        const OPERATOR_ROLE = await redStoneTestOracle.OPERATOR_ROLE();
        await redStoneTestOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
        
        // Set a value that exceeds uint192 max
        await redStoneMock.setAnswer(exceedingValue);
        await redStoneMock.setUpdatedAt(currentTimestamp);
        
        // Attempt to record the price should revert
        await expect(redStoneTestOracle.connect(operator).recordRedStoneClassicPrice())
          .to.be.reverted;
      });

      it("Should reject values that overflow after decimal conversion scaling up", async function () {
        // Test edge case: when converting from lower decimals to higher decimals,
        // the scaled value might overflow uint192
        
        // Deploy a new mock with lower decimals (e.g., 6) that will scale to 18
        const ChainlinkMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
        const currentBlock = await ethers.provider.getBlock("latest");
        const currentTimestamp = currentBlock!.timestamp;
        
        // A value that's valid as uint256 but would overflow uint192 when scaled up
        // uint192.max / 10^12 + 1 would overflow when scaled back up by 10^12
        // uint192 max is 2^192 - 1
        const uint192Max = (BigInt(2) ** BigInt(192)) - BigInt(1);
        const valueBeforeScaling = uint192Max / BigInt(10 ** 12) + BigInt(1);
        
        const chainlinkMock6Dec = await ChainlinkMock.deploy(
          valueBeforeScaling,
          currentTimestamp,
          6 // Source decimals
        );
        
        // Create oracle that expects 18 decimals (will scale up by 10^12)
        const sources = {
          api3ReaderProxyV1IsActive: false,
          api3ReaderProxyV1: ZERO_ADDRESS,
          api3ReaderProxyV1Decimals: 18,
          api3ReaderProxyV1MaxStaleness: 3600,
          chainlinkAggregatorV3IsActive: true,
          chainlinkAggregatorV3: await chainlinkMock6Dec.getAddress(),
          chainlinkAggregatorV3Decimals: 6,
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
          depegPool: admin.address,
          xChainMode: false,
          xDomainMessengerL1: ZERO_ADDRESS,
        };
        
        const oracleHighDec = await deployOracle(
          CONTRACT_NAME,
          ASSET_SYMBOL,
          ZERO_ADDRESS,
          18, // Asset decimals (higher than source)
          sources,
          config,
          admin.address
        );

        // Grant operator role
        const OPERATOR_ROLE = await oracleHighDec.OPERATOR_ROLE();
        await oracleHighDec.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
        
        // Attempt to record should revert because scaling causes overflow
        await expect(oracleHighDec.connect(operator).recordChainlinkPrice())
          .to.be.reverted;
      });
    });
  });

  describe("Ring Buffer and Lookback Period", function () {
    this.timeout(120000);
    it("Should handle 364 daily checkpoints + 24 hourly checkpoints with 24h lookback period", async function () {
      // Deploy a dedicated oracle with appropriate configuration for this test
      // First, set the blockchain time to a UTC day boundary to ensure all 24 hourly checkpoints
      // fall within the same UTC day
      const currentBlock = await ethers.provider.getBlock("latest");
      const currentTimestamp = currentBlock!.timestamp;
      // Calculate seconds until next UTC midnight
      const secondsUntilMidnight = 86400 - (currentTimestamp % 86400);
      // Advance time to UTC midnight
      await ethers.provider.send("evm_increaseTime", [secondsUntilMidnight]);
      await ethers.provider.send("evm_mine", []);
      
      const startBlock = await ethers.provider.getBlock("latest");
      const api3MockForTest = await (await ethers.getContractFactory("Api3ReaderProxyMock")).deploy(
        ethers.parseUnits("1.0", 18),
        startBlock!.timestamp
      );

      const chainlinkMockForTest = await (await ethers.getContractFactory("ChainlinkAggregatorMock")).deploy(
        ethers.parseUnits("1.0", 18),
        startBlock!.timestamp,
        18
      );

      const sources = {
        api3ReaderProxyV1IsActive: true,
        api3ReaderProxyV1: await api3MockForTest.getAddress(),
        api3ReaderProxyV1Decimals: 18,
        api3ReaderProxyV1MaxStaleness: 86400 + 60 * 60, // ~24h + a small buffer
        chainlinkAggregatorV3IsActive: true,
        chainlinkAggregatorV3: await chainlinkMockForTest.getAddress(),
        chainlinkAggregatorV3Decimals: 18,
        chainlinkAggregatorV3MaxStaleness: 86400 + 60 * 60, // ~24h + a small buffer
        redStoneClassicIsActive: false,
        redStoneClassicAggregator: ZERO_ADDRESS,
        redStoneClassicDecimals: 8,
        redStoneClassicMaxStaleness: 86400 + 60 * 60, // ~24h + a small buffer
        tellorIsActive: false,
        tellorAdapter: ZERO_ADDRESS,
        tellorDecimals: 8,
        tellorMaxStaleness: 86400 + 60 * 60, // ~24h + a small buffer
      };

      const config = {
        minCheckpointSpacing: 45 * 60, // Allow checkpoints every 45min testing
        minValidSources: 2,
        closingPriceLookbackPeriod: 86400, // 24 hours lookback period
        depegPool: admin.address,
        xChainMode: false,
        xDomainMessengerL1: ZERO_ADDRESS,
      };

      const testOracle = await deployOracle(
        CONTRACT_NAME,
        ASSET_SYMBOL,
        ZERO_ADDRESS,
        ASSET_DECIMALS,
        sources,
        config,
        admin.address
      );

      const OPERATOR_ROLE = await testOracle.OPERATOR_ROLE();
      await testOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

      // Deploy mock DepegPool to capture price data
      const MockDepegPool = await ethers.getContractFactory("MockDepegPoolForOracle");
      const mockDepegPool = await MockDepegPool.deploy();

      // Update oracle config to point to mock pool
      await testOracle.connect(admin).setConfig({
        minCheckpointSpacing: 45 * 60,
        minValidSources: 2,
        closingPriceLookbackPeriod: 86400,
        depegPool: await mockDepegPool.getAddress(),
        xChainMode: false,
        xDomainMessengerL1: ZERO_ADDRESS,
      });


      // Record 364 daily checkpoints
      for (let day = 0; day < 364; day++) {
        const currentTime = (await ethers.provider.getBlock("latest"))!.timestamp;
        const price = ethers.parseUnits("1.0", 18); // Stable at 1.0 for daily checkpoints

        // Update both sources
        await api3MockForTest.setData(price, currentTime);
        await chainlinkMockForTest.setAnswer(price);
        await chainlinkMockForTest.setUpdatedAt(currentTime);

        // Record prices
        await testOracle.connect(operator).recordApi3Price();
        await testOracle.connect(operator).recordChainlinkPrice();

        // Checkpoint
        await testOracle.connect(operator).checkpoint();

        // Advance time by 1 day
        await ethers.provider.send("evm_increaseTime", [86400]); // 1 day
        await ethers.provider.send("evm_mine", []);
      }

      // Verify we have 364 checkpoints
      let checkpointCount = await testOracle.checkpointsCount();
      expect(checkpointCount).to.equal(364);

      // Now record 24 hourly checkpoints with varying prices
      const hourlyPrices: bigint[] = [];
      for (let hour = 0; hour < 24; hour++) {
        const currentTime = (await ethers.provider.getBlock("latest"))!.timestamp;
        // Prices gradually decrease from 1.0 to 0.95 over the 24 hours
        const priceValue = 1.0 - (hour * 0.05 / 24);
        const price = ethers.parseUnits(priceValue.toFixed(6), 18);
        hourlyPrices.push(ethers.parseUnits(priceValue.toFixed(6), ASSET_DECIMALS));

        // Update both sources
        await api3MockForTest.setData(price, currentTime);
        await chainlinkMockForTest.setAnswer(price);
        await chainlinkMockForTest.setUpdatedAt(currentTime);

        // Record prices
        await testOracle.connect(operator).recordApi3Price();
        await testOracle.connect(operator).recordChainlinkPrice();

        // Checkpoint
        await testOracle.connect(operator).checkpoint();

        // Advance time by 1 hour (but not after the last checkpoint)
        if (hour < 23) {
          await ethers.provider.send("evm_increaseTime", [3600]); // 1 hour
          await ethers.provider.send("evm_mine", []);
        }
      }

      // Verify we now have 364 + 24 = 388 checkpoints
      checkpointCount = await testOracle.checkpointsCount();
      expect(checkpointCount).to.equal(388);

      // With the daily aggregation logic:
      // - The 24 hourly checkpoints are all on the SAME day (within 24 hours, no day boundary crossed)
      // - They get aggregated into a SINGLE daily representative price (median of 24 values)
      // - The closing price is the median of daily prices within the lookback period
      // - Since all 24 checkpoints are on one day, closing price = that day's representative price
      
      // Sort the hourly prices to find median (which is the daily representative price)
      const sortedHourlyPrices = [...hourlyPrices].sort((a, b) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      });

      // For 24 values (even count), median is average of middle two values
      // This becomes the single daily representative price, which is also the closing price
      const expectedMedian = (sortedHourlyPrices[11] + sortedHourlyPrices[12]) / 2n;

      // Now actually write the price data to verify the median calculation
      await testOracle.connect(operator).writePriceData(0);

      // Verify the closing price matches the daily representative price
      // (median of the 24 hourly checkpoints on that single day)
      const actualClosingPrice = await mockDepegPool.lastClosingPrice();
      expect(actualClosingPrice).to.equal(expectedMedian, 
        `Closing price should be median of the single day's 24 hourly checkpoints. Expected: ${ethers.formatUnits(expectedMedian, ASSET_DECIMALS)}, Got: ${ethers.formatUnits(actualClosingPrice, ASSET_DECIMALS)}`
      );

      // Also verify HWM price was written (should be 1.0 from daily checkpoints)
      const hwmPrice = await mockDepegPool.lastHwmPrice();
      expect(hwmPrice).to.equal(ethers.parseUnits("1.0", ASSET_DECIMALS));

      // Verify updatePriceData was called
      const updateCount = await mockDepegPool.updateCount();
      expect(updateCount).to.equal(1, "updatePriceData should have been called once");
      });

    it("Should correctly count checkpoints inside lookback period AND outside when not enough checkpoints are available inside", async function () {

      // Deploy mock DepegPool to capture price data
      const MockDepegPool = await ethers.getContractFactory("MockDepegPoolForOracle");
      const mockDepegPool = await MockDepegPool.deploy();

      // Update configuration to use 1 valid source and 6-day lookback to ensure
      // checkpoints within lookback are counted properly
      const currentConfig = await oracle.cfg();
      await oracle.connect(admin).setConfig({
        minCheckpointSpacing: 0, // Allow immediate checkpoints
        minValidSources: 1, // Only need 1 source
        closingPriceLookbackPeriod: 6 * 86400, // 6 days lookback
        depegPool: await mockDepegPool.getAddress(),
        xChainMode: currentConfig.xChainMode,
        xDomainMessengerL1: currentConfig.xDomainMessengerL1,
      });

      // Record 5 checkpoints with different prices, each on a DIFFERENT DAY
      // so we can verify which days are used (with daily aggregation, each day = 1 data point)
      const dailyPrices: bigint[] = [];
      const prices = ["0.90", "0.92", "0.94", "0.96", "0.98"]; // Increasing prices
      
      for (let i = 0; i < 5; i++) {
        const currentTime = (await ethers.provider.getBlock("latest"))!.timestamp;
        const price = ethers.parseUnits(prices[i], 18);
        const normalizedPrice = ethers.parseUnits(prices[i], ASSET_DECIMALS);
        dailyPrices.push(normalizedPrice);

        await api3Mock.setData(price, currentTime);
        await oracle.connect(operator).recordApi3Price();
        await oracle.connect(operator).checkpoint();

        // Advance time by 1 day between checkpoints (except after the last one)
        // This ensures each checkpoint is on a different day
        if (i < 4) {
          await ethers.provider.send("evm_increaseTime", [86400]); // 1 day
          await ethers.provider.send("evm_mine", []);
        }
      }

      // Verify we have 5 checkpoints (5 days worth)
      const count = await oracle.checkpointsCount();
      expect(count).to.equal(5);

      // With daily aggregation:
      // - Each checkpoint is on a different day
      // - So we have 5 daily representative prices
      // - The minimum of 5 checkpoints maps to 5 days
      // - Since all 5 are within the 6-day lookback, all are used
      
      // Calculate expected median of all 5 daily prices
      const sortedPrices = [...dailyPrices].sort((a, b) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      });
      // For 5 values (odd count), median is the middle value (index 2)
      const expectedMedian = sortedPrices[2]; // 0.94

      // Write price data to verify the behavior (writePriceData is permissionless)
      // Actually it's NOT permissionless, it requires OPERATOR_ROLE
      await oracle.connect(operator).writePriceData(200000);

      // Verify the closing price uses all 5 daily prices
      const actualClosingPrice = await mockDepegPool.lastClosingPrice();
      expect(actualClosingPrice).to.equal(expectedMedian,
        `With 6-day lookback and 5 daily checkpoints, minimum of 5 days enforced. Expected median: ${ethers.formatUnits(expectedMedian, ASSET_DECIMALS)}, Got: ${ethers.formatUnits(actualClosingPrice, ASSET_DECIMALS)}`
      );

      // Verify HWM price was set (with 5 days of data, we have enough for triplet calculation)
      const hwmPrice = await mockDepegPool.lastHwmPrice();
      expect(hwmPrice).to.be.gt(0, "HWM price should be set");

      // Verify updatePriceData was called
      const updateCount = await mockDepegPool.updateCount();
      expect(updateCount).to.equal(1, "updatePriceData should have been called once");
    });
  });

  describe("Daily Aggregation Logic", function () {
    /**
     * This test verifies the daily aggregation logic for median calculations:
     * - 1 price per day → use that price
     * - 2 prices per day → use the smaller value
     * - 3+ prices per day → use the median
     * 
     * We create 5 days with different numbers of checkpoints per day,
     * then verify both HWM and closing price are calculated correctly.
     */
    it("Should correctly aggregate prices by day with varying checkpoint counts (1, 2, 3, 4, 5 prices per day)", async function () {

      // Deploy mock DepegPool to capture price data
      const MockDepegPool = await ethers.getContractFactory("MockDepegPoolForOracle");
      const mockDepegPool = await MockDepegPool.deploy();

      // Configure oracle with sufficient lookback and checkpoint spacing
      const currentConfig = await oracle.cfg();
      await oracle.connect(admin).setConfig({
        minCheckpointSpacing: 60, // Allow checkpoints 1 minute apart (for multiple per day)
        minValidSources: 1, // Only need 1 source for simplicity
        closingPriceLookbackPeriod: 10 * 86400, // 10 days lookback
        depegPool: await mockDepegPool.getAddress(),
        xChainMode: currentConfig.xChainMode,
        xDomainMessengerL1: currentConfig.xDomainMessengerL1,
      });

      // First, set blockchain time to UTC midnight for predictable day boundaries
      const currentBlock = await ethers.provider.getBlock("latest");
      const currentTimestamp = currentBlock!.timestamp;
      const secondsUntilMidnight = 86400 - (currentTimestamp % 86400);
      await ethers.provider.send("evm_increaseTime", [secondsUntilMidnight]);
      await ethers.provider.send("evm_mine", []);

      // Helper function to create a checkpoint with a specific price
      async function createCheckpoint(priceStr: string) {
        const block = await ethers.provider.getBlock("latest");
        const price = ethers.parseUnits(priceStr, 18);
        await api3Mock.setData(price, block!.timestamp);
        await oracle.connect(operator).recordApi3Price();
        await oracle.connect(operator).checkpoint();
        // Advance 2 minutes (within same day, but enough for minCheckpointSpacing)
        await ethers.provider.send("evm_increaseTime", [120]);
        await ethers.provider.send("evm_mine", []);
      }

      // ==========================================
      // DAY 1: 1 price → daily representative = that price
      // ==========================================
      // Single price: 1.00
      // Expected daily representative: 1.00
      await createCheckpoint("1.00");
      
      // Advance to next day
      await ethers.provider.send("evm_increaseTime", [86400 - 120]); // Complete the day
      await ethers.provider.send("evm_mine", []);

      // ==========================================
      // DAY 2: 2 prices → daily representative = smaller value
      // ==========================================
      // Prices: 0.98, 0.96
      // Expected daily representative: 0.96 (smaller)
      await createCheckpoint("0.98");
      await createCheckpoint("0.96");
      
      // Advance to next day
      await ethers.provider.send("evm_increaseTime", [86400 - 240]); // Complete the day
      await ethers.provider.send("evm_mine", []);

      // ==========================================
      // DAY 3: 3 prices → daily representative = median
      // ==========================================
      // Prices: 0.92, 0.95, 0.90
      // Sorted: 0.90, 0.92, 0.95
      // Expected daily representative: 0.92 (median)
      await createCheckpoint("0.92");
      await createCheckpoint("0.95");
      await createCheckpoint("0.90");
      
      // Advance to next day
      await ethers.provider.send("evm_increaseTime", [86400 - 360]); // Complete the day
      await ethers.provider.send("evm_mine", []);

      // ==========================================
      // DAY 4: 4 prices → daily representative = median (avg of middle two)
      // ==========================================
      // Prices: 0.88, 0.94, 0.91, 0.85
      // Sorted: 0.85, 0.88, 0.91, 0.94
      // Expected daily representative: (0.88 + 0.91) / 2 = 0.895
      await createCheckpoint("0.88");
      await createCheckpoint("0.94");
      await createCheckpoint("0.91");
      await createCheckpoint("0.85");
      
      // Advance to next day
      await ethers.provider.send("evm_increaseTime", [86400 - 480]); // Complete the day
      await ethers.provider.send("evm_mine", []);

      // ==========================================
      // DAY 5: 5 prices → daily representative = median (middle value)
      // ==========================================
      // Prices: 0.80, 0.87, 0.83, 0.89, 0.81
      // Sorted: 0.80, 0.81, 0.83, 0.87, 0.89
      // Expected daily representative: 0.83 (median, index 2)
      await createCheckpoint("0.80");
      await createCheckpoint("0.87");
      await createCheckpoint("0.83");
      await createCheckpoint("0.89");
      await createCheckpoint("0.81");

      // Verify we have 15 checkpoints total (1+2+3+4+5)
      const checkpointCount = await oracle.checkpointsCount();
      expect(checkpointCount).to.equal(15);

      // ==========================================
      // CALCULATE EXPECTED VALUES
      // ==========================================
      
      // Daily representative prices (in asset decimals):
      const day1Rep = ethers.parseUnits("1.00", ASSET_DECIMALS);    // 1 price → use it
      const day2Rep = ethers.parseUnits("0.96", ASSET_DECIMALS);    // 2 prices → smaller
      const day3Rep = ethers.parseUnits("0.92", ASSET_DECIMALS);    // 3 prices → median
      const day4Rep = ethers.parseUnits("0.895", ASSET_DECIMALS);   // 4 prices → avg of middle two
      const day5Rep = ethers.parseUnits("0.83", ASSET_DECIMALS);    // 5 prices → median

      // For closing price: median of daily representatives
      // Daily reps: [1.00, 0.96, 0.92, 0.895, 0.83]
      // Sorted: [0.83, 0.895, 0.92, 0.96, 1.00]
      // Median (5 values, odd): index 2 = 0.92
      const expectedClosingPrice = day3Rep; // 0.92

      // For HWM: max(min of consecutive triplets) of daily representatives
      // Daily reps in chronological order: [day1=1.00, day2=0.96, day3=0.92, day4=0.895, day5=0.83]
      // Triplet 1: min(1.00, 0.96, 0.92) = 0.92
      // Triplet 2: min(0.96, 0.92, 0.895) = 0.895
      // Triplet 3: min(0.92, 0.895, 0.83) = 0.83
      // HWM = max(0.92, 0.895, 0.83) = 0.92
      const expectedHwmPrice = day3Rep; // 0.92

      // Write price data
      await oracle.connect(operator).writePriceData(0);

      // Verify closing price
      const actualClosingPrice = await mockDepegPool.lastClosingPrice();
      expect(actualClosingPrice).to.equal(expectedClosingPrice,
        `Closing price should be median of 5 daily representatives. Expected: ${ethers.formatUnits(expectedClosingPrice, ASSET_DECIMALS)}, Got: ${ethers.formatUnits(actualClosingPrice, ASSET_DECIMALS)}`
      );

      // Verify HWM price
      const actualHwmPrice = await mockDepegPool.lastHwmPrice();
      expect(actualHwmPrice).to.equal(expectedHwmPrice,
        `HWM price should be max(min(triplets)) of daily representatives. Expected: ${ethers.formatUnits(expectedHwmPrice, ASSET_DECIMALS)}, Got: ${ethers.formatUnits(actualHwmPrice, ASSET_DECIMALS)}`
      );
    });

    it("Should handle single checkpoint per day correctly for 5 days", async function () {

      // Deploy mock DepegPool
      const MockDepegPool = await ethers.getContractFactory("MockDepegPoolForOracle");
      const mockDepegPool = await MockDepegPool.deploy();

      // Configure oracle
      const currentConfig = await oracle.cfg();
      await oracle.connect(admin).setConfig({
        minCheckpointSpacing: 0,
        minValidSources: 1,
        closingPriceLookbackPeriod: 10 * 86400,
        depegPool: await mockDepegPool.getAddress(),
        xChainMode: currentConfig.xChainMode,
        xDomainMessengerL1: currentConfig.xDomainMessengerL1,
      });

      // Create 1 checkpoint per day for 5 days
      // Prices: 1.00, 0.98, 0.95, 0.97, 0.94
      const dailyPrices = ["1.00", "0.98", "0.95", "0.97", "0.94"];
      
      for (let i = 0; i < dailyPrices.length; i++) {
        const block = await ethers.provider.getBlock("latest");
        const price = ethers.parseUnits(dailyPrices[i], 18);
        await api3Mock.setData(price, block!.timestamp);
        await oracle.connect(operator).recordApi3Price();
        await oracle.connect(operator).checkpoint();
        
        // Advance 1 day (except after last)
        if (i < dailyPrices.length - 1) {
          await ethers.provider.send("evm_increaseTime", [86400]);
          await ethers.provider.send("evm_mine", []);
        }
      }

      // Daily representatives = same as input (1 price per day)
      // [1.00, 0.98, 0.95, 0.97, 0.94]
      // Sorted for closing: [0.94, 0.95, 0.97, 0.98, 1.00]
      // Closing price (median): 0.97
      const expectedClosingPrice = ethers.parseUnits("0.97", ASSET_DECIMALS);

      // HWM: triplets in chronological order
      // Triplet 1: min(1.00, 0.98, 0.95) = 0.95
      // Triplet 2: min(0.98, 0.95, 0.97) = 0.95
      // Triplet 3: min(0.95, 0.97, 0.94) = 0.94
      // HWM = max(0.95, 0.95, 0.94) = 0.95
      const expectedHwmPrice = ethers.parseUnits("0.95", ASSET_DECIMALS);

      await oracle.connect(operator).writePriceData(0);

      const actualClosingPrice = await mockDepegPool.lastClosingPrice();
      const actualHwmPrice = await mockDepegPool.lastHwmPrice();

      expect(actualClosingPrice).to.equal(expectedClosingPrice,
        `Closing price mismatch. Expected: ${ethers.formatUnits(expectedClosingPrice, ASSET_DECIMALS)}, Got: ${ethers.formatUnits(actualClosingPrice, ASSET_DECIMALS)}`
      );

      expect(actualHwmPrice).to.equal(expectedHwmPrice,
        `HWM price mismatch. Expected: ${ethers.formatUnits(expectedHwmPrice, ASSET_DECIMALS)}, Got: ${ethers.formatUnits(actualHwmPrice, ASSET_DECIMALS)}`
      );
    });

    it("Should use smaller value when exactly 2 prices recorded on a day", async function () {

      // Deploy mock DepegPool
      const MockDepegPool = await ethers.getContractFactory("MockDepegPoolForOracle");
      const mockDepegPool = await MockDepegPool.deploy();

      // Configure oracle
      const currentConfig = await oracle.cfg();
      await oracle.connect(admin).setConfig({
        minCheckpointSpacing: 60, // 1 minute between checkpoints
        minValidSources: 1,
        closingPriceLookbackPeriod: 10 * 86400,
        depegPool: await mockDepegPool.getAddress(),
        xChainMode: currentConfig.xChainMode,
        xDomainMessengerL1: currentConfig.xDomainMessengerL1,
      });

      // Set time to UTC midnight
      const currentBlock = await ethers.provider.getBlock("latest");
      const currentTimestamp = currentBlock!.timestamp;
      const secondsUntilMidnight = 86400 - (currentTimestamp % 86400);
      await ethers.provider.send("evm_increaseTime", [secondsUntilMidnight]);
      await ethers.provider.send("evm_mine", []);

      // Create 5 days, each with exactly 2 checkpoints
      // Day 1: 1.00, 0.99 → smaller = 0.99
      // Day 2: 0.95, 0.98 → smaller = 0.95
      // Day 3: 0.92, 0.90 → smaller = 0.90
      // Day 4: 0.88, 0.91 → smaller = 0.88
      // Day 5: 0.85, 0.87 → smaller = 0.85
      const dayPrices = [
        ["1.00", "0.99"],
        ["0.95", "0.98"],
        ["0.92", "0.90"],
        ["0.88", "0.91"],
        ["0.85", "0.87"],
      ];

      for (let day = 0; day < dayPrices.length; day++) {
        for (let p = 0; p < dayPrices[day].length; p++) {
          const block = await ethers.provider.getBlock("latest");
          const price = ethers.parseUnits(dayPrices[day][p], 18);
          await api3Mock.setData(price, block!.timestamp);
          await oracle.connect(operator).recordApi3Price();
          await oracle.connect(operator).checkpoint();
          
          // Advance 2 minutes within day
          await ethers.provider.send("evm_increaseTime", [120]);
          await ethers.provider.send("evm_mine", []);
        }
        // Advance to next day (except after last)
        if (day < dayPrices.length - 1) {
          await ethers.provider.send("evm_increaseTime", [86400 - 240]);
          await ethers.provider.send("evm_mine", []);
        }
      }

      // Daily representatives (smaller of 2):
      // [0.99, 0.95, 0.90, 0.88, 0.85]
      // Sorted for closing: [0.85, 0.88, 0.90, 0.95, 0.99]
      // Closing price (median, 5 values): 0.90
      const expectedClosingPrice = ethers.parseUnits("0.90", ASSET_DECIMALS);

      // HWM: triplets in chronological order [0.99, 0.95, 0.90, 0.88, 0.85]
      // Triplet 1: min(0.99, 0.95, 0.90) = 0.90
      // Triplet 2: min(0.95, 0.90, 0.88) = 0.88
      // Triplet 3: min(0.90, 0.88, 0.85) = 0.85
      // HWM = max(0.90, 0.88, 0.85) = 0.90
      const expectedHwmPrice = ethers.parseUnits("0.90", ASSET_DECIMALS);

      await oracle.connect(operator).writePriceData(0);

      const actualClosingPrice = await mockDepegPool.lastClosingPrice();
      const actualHwmPrice = await mockDepegPool.lastHwmPrice();

      expect(actualClosingPrice).to.equal(expectedClosingPrice,
        `Closing price should use smaller of 2 prices per day. Expected: ${ethers.formatUnits(expectedClosingPrice, ASSET_DECIMALS)}, Got: ${ethers.formatUnits(actualClosingPrice, ASSET_DECIMALS)}`
      );

      expect(actualHwmPrice).to.equal(expectedHwmPrice,
        `HWM should use smaller of 2 prices per day. Expected: ${ethers.formatUnits(expectedHwmPrice, ASSET_DECIMALS)}, Got: ${ethers.formatUnits(actualHwmPrice, ASSET_DECIMALS)}`
      );
    });

    it("Should correctly compute median for 3+ prices on same day", async function () {

      // Deploy mock DepegPool
      const MockDepegPool = await ethers.getContractFactory("MockDepegPoolForOracle");
      const mockDepegPool = await MockDepegPool.deploy();

      // Configure oracle
      const currentConfig = await oracle.cfg();
      await oracle.connect(admin).setConfig({
        minCheckpointSpacing: 60,
        minValidSources: 1,
        closingPriceLookbackPeriod: 10 * 86400,
        depegPool: await mockDepegPool.getAddress(),
        xChainMode: currentConfig.xChainMode,
        xDomainMessengerL1: currentConfig.xDomainMessengerL1,
      });

      // Set time to UTC midnight
      const currentBlock = await ethers.provider.getBlock("latest");
      const currentTimestamp = currentBlock!.timestamp;
      const secondsUntilMidnight = 86400 - (currentTimestamp % 86400);
      await ethers.provider.send("evm_increaseTime", [secondsUntilMidnight]);
      await ethers.provider.send("evm_mine", []);

      // Create 5 days with 3 prices each
      // Day 1: 1.00, 1.02, 0.98 → sorted: 0.98, 1.00, 1.02 → median: 1.00
      // Day 2: 0.97, 0.99, 0.95 → sorted: 0.95, 0.97, 0.99 → median: 0.97
      // Day 3: 0.94, 0.92, 0.96 → sorted: 0.92, 0.94, 0.96 → median: 0.94
      // Day 4: 0.91, 0.93, 0.89 → sorted: 0.89, 0.91, 0.93 → median: 0.91
      // Day 5: 0.88, 0.86, 0.90 → sorted: 0.86, 0.88, 0.90 → median: 0.88
      const dayPrices = [
        ["1.00", "1.02", "0.98"],
        ["0.97", "0.99", "0.95"],
        ["0.94", "0.92", "0.96"],
        ["0.91", "0.93", "0.89"],
        ["0.88", "0.86", "0.90"],
      ];

      for (let day = 0; day < dayPrices.length; day++) {
        for (let p = 0; p < dayPrices[day].length; p++) {
          const block = await ethers.provider.getBlock("latest");
          const price = ethers.parseUnits(dayPrices[day][p], 18);
          await api3Mock.setData(price, block!.timestamp);
          await oracle.connect(operator).recordApi3Price();
          await oracle.connect(operator).checkpoint();
          
          await ethers.provider.send("evm_increaseTime", [120]);
          await ethers.provider.send("evm_mine", []);
        }
        if (day < dayPrices.length - 1) {
          await ethers.provider.send("evm_increaseTime", [86400 - 360]);
          await ethers.provider.send("evm_mine", []);
        }
      }

      // Daily representatives (medians):
      // [1.00, 0.97, 0.94, 0.91, 0.88]
      // Sorted for closing: [0.88, 0.91, 0.94, 0.97, 1.00]
      // Closing price (median, 5 values): 0.94
      const expectedClosingPrice = ethers.parseUnits("0.94", ASSET_DECIMALS);

      // HWM: triplets in chronological order [1.00, 0.97, 0.94, 0.91, 0.88]
      // Triplet 1: min(1.00, 0.97, 0.94) = 0.94
      // Triplet 2: min(0.97, 0.94, 0.91) = 0.91
      // Triplet 3: min(0.94, 0.91, 0.88) = 0.88
      // HWM = max(0.94, 0.91, 0.88) = 0.94
      const expectedHwmPrice = ethers.parseUnits("0.94", ASSET_DECIMALS);

      await oracle.connect(operator).writePriceData(0);

      const actualClosingPrice = await mockDepegPool.lastClosingPrice();
      const actualHwmPrice = await mockDepegPool.lastHwmPrice();

      expect(actualClosingPrice).to.equal(expectedClosingPrice,
        `Closing price should use median of 3 prices per day. Expected: ${ethers.formatUnits(expectedClosingPrice, ASSET_DECIMALS)}, Got: ${ethers.formatUnits(actualClosingPrice, ASSET_DECIMALS)}`
      );

      expect(actualHwmPrice).to.equal(expectedHwmPrice,
        `HWM should use median of 3 prices per day. Expected: ${ethers.formatUnits(expectedHwmPrice, ASSET_DECIMALS)}, Got: ${ethers.formatUnits(actualHwmPrice, ASSET_DECIMALS)}`
      );
    });
  });
});
} // End of for loop for ORACLE_CONTRACTS
