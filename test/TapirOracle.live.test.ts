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

const ZERO_ADDRESS = ethers.ZeroAddress;
const ASSET_DECIMALS = 6;

describe("Live oracle feeds (optional)", function () {
  // Forks the live network and tests the TapirOracle against live data
  describe("🌐 Real World Integration Test", function () {
    // Increase timeout for network calls
    this.timeout(60000);

    let testOracle: TapirOracle;
    let snapshotId: string;

    before(async function () {
      console.log("\n" + "=".repeat(80));
      console.log("🌐 REAL WORLD TEST: Connecting to Live API3 Feed");
      console.log("=".repeat(80));
      console.log(`📡 RPC: ${API3_TEST_RPC}`);
      console.log(`🔗 Chain ID: ${API3_TEST_CHAIN_ID}`);
      console.log(`📍 API3 Feed Address: ${API3_FEED_ADDRESS}`);
      console.log("=".repeat(80) + "\n");

      try {
        // Fork network to test with live API3 feed
        await network.provider.request({
          method: "hardhat_reset",
          params: [
            {
              forking: {
                jsonRpcUrl: API3_TEST_RPC,
              },
            },
          ],
        });

        // Verify we're on the right network
        const chainId = await ethers.provider.getNetwork().then((n) => n.chainId);
        console.log(`✅ Connected to network with Chain ID: ${chainId}`);

        // Get fresh signers after fork
        const [deployer, admin, operator] = await ethers.getSigners();

        // Setup sources with the REAL API3 feed address
        const sources = {
          api3ReaderProxyV1IsActive: true,
          api3ReaderProxyV1: API3_FEED_ADDRESS, // Real API3 feed!
          api3ReaderProxyV1Decimals: API3_FEED_DECIMALS,
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
          minValidSources: 2,
          closingPriceLookbackPeriod: 86400,
          depegPool: admin.address,
          xChainMode: false,
          xDomainMessengerL1: ZERO_ADDRESS,
        };

        // Deploy TapirOracle on forked network
        const TapirOracle = await ethers.getContractFactory("TapirOracle");
        testOracle = await TapirOracle.deploy(
          "USDT",
          ZERO_ADDRESS,
          ASSET_DECIMALS,
          sources,
          config,
          admin.address
        );

        // Grant OPERATOR_ROLE to the operator
        const OPERATOR_ROLE = await testOracle.OPERATOR_ROLE();
        await testOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

        console.log(`✅ Granted OPERATOR_ROLE to: ${operator.address}`);
      } catch (error) {
        console.error("❌ Failed to setup network fork:", error);
        throw error;
      }
    });

    beforeEach(async function () {
      // Take a snapshot before each test
      snapshotId = await network.provider.send("evm_snapshot");
    });

    afterEach(async function () {
      // Revert to snapshot after each test
      await network.provider.send("evm_revert", [snapshotId]);
    });

    after(async function () {
      // Reset to local network after all tests
      await network.provider.request({
        method: "hardhat_reset",
        params: [],
      });
    });

    it("Should read real API3 price data from live network", async function () {
      console.log("\n" + "-".repeat(80));
      console.log("📊 Reading from Live API3 Data Feed");
      console.log("-".repeat(80));

      // Get the operator signer (third signer, who has OPERATOR_ROLE)
      const [, , operator] = await ethers.getSigners();

      // First, let's read directly from the API3 contract to see what's there
      const api3Contract = await ethers.getContractAt(
        "IApi3ReaderProxy",
        API3_FEED_ADDRESS
      );

      let rawValue: bigint;
      let rawTimestamp: bigint;

      try {
        const result = await api3Contract.read();
        rawValue = BigInt(result[0]);
        rawTimestamp = BigInt(result[1]);

        console.log("\n🔍 Raw API3 Data:");
        console.log(`   Value (int224): ${rawValue}`);
        console.log(`   Timestamp (uint32): ${rawTimestamp}`);
        console.log(`   Timestamp (Date): ${new Date(Number(rawTimestamp) * 1000).toISOString()}`);
        
        // Calculate age of data
        const currentTime = Math.floor(Date.now() / 1000);
        const dataAge = currentTime - Number(rawTimestamp);
        console.log(`   Data Age: ${dataAge} seconds (${(dataAge / 60).toFixed(2)} minutes)`);
      } catch (error) {
        console.error("❌ Failed to read from API3 contract:", error);
        throw error;
      }

      // Now use recordApi3Price() to record it
      console.log("\n📝 Recording price using recordApi3Price()...");
      await testOracle.connect(operator).recordApi3Price();

      // Retrieve the recorded price
      const latestPrice = await testOracle.latestApi3Price();

      // Normalize the raw value from 18 decimals to 6 decimals for comparison
      const normalizedRawValue = rawValue / (10n ** 12n);

      console.log("\n✅ Recorded Price Data:");
      console.log(`   Price (uint192): ${latestPrice.price}`);
      console.log(`   Price (decimal - 6 decimals): ${ethers.formatUnits(latestPrice.price, ASSET_DECIMALS)}`);
      console.log(`   Timestamp: ${latestPrice.asOfTs}`);
      console.log(`   Timestamp (Date): ${new Date(Number(latestPrice.asOfTs) * 1000).toISOString()}`);

      // Verify the values match (price should be normalized from 18 to 6 decimals)
      expect(latestPrice.price).to.equal(normalizedRawValue, "Recorded price should match normalized API3 value");
      expect(latestPrice.asOfTs).to.equal(rawTimestamp, "Recorded timestamp should match API3 timestamp");

      // Calculate tolerance bounds based on expected price (using basis points)
      // Convert expected price from 18 decimals to 6 decimals for comparison
      const expectedPriceNormalized = API3_EXPECTED_PRICE / (10n ** 12n);
      const toleranceBps = BigInt(API3_TOLERANCE_BPS);
      const lowerBound = expectedPriceNormalized - (expectedPriceNormalized * toleranceBps / 10000n);
      const upperBound = expectedPriceNormalized + (expectedPriceNormalized * toleranceBps / 10000n);

      console.log(`\n🎯 API3 Price Validation (±${API3_TOLERANCE_BPS} bps = ±${API3_TOLERANCE_BPS / 100}%):`);
      console.log(`   Expected Price: ${ethers.formatUnits(API3_EXPECTED_PRICE, API3_FEED_DECIMALS)}`);
      console.log(`   Lower Bound: ${ethers.formatUnits(lowerBound, ASSET_DECIMALS)}`);
      console.log(`   Upper Bound: ${ethers.formatUnits(upperBound, ASSET_DECIMALS)}`);
      console.log(`   Actual Price: ${ethers.formatUnits(latestPrice.price, ASSET_DECIMALS)}`);

      if (latestPrice.price >= lowerBound && latestPrice.price <= upperBound) {
        console.log("   ✅ Price is within tolerance!");
      } else {
        console.log("   ⚠️  WARNING: Price is outside tolerance range!");
        console.log("   This may be normal if market conditions have changed.");
        console.log("   Update API3_EXPECTED_PRICE and API3_TOLERANCE_BPS at the top of the test file.");
      }

      console.log("\n" + "-".repeat(80));

      // Assertions
      expect(latestPrice.price).to.be.gt(0, "Price should be greater than zero");
      expect(latestPrice.asOfTs).to.be.gt(0, "Timestamp should be greater than zero");
      
      // Warn if data is stale (older than 1 hour)
      const currentTime = Math.floor(Date.now() / 1000);
      const staleness = currentTime - Number(latestPrice.asOfTs);
      if (staleness > 3600) {
        console.log(`\n⚠️  WARNING: Data is ${(staleness / 3600).toFixed(2)} hours old`);
      }
    });

    it("Should successfully call recordApi3Price multiple times", async function () {
      const [, , operator] = await ethers.getSigners();

      console.log("\n📊 Testing multiple calls to recordApi3Price()...");

      // Call it multiple times
      for (let i = 1; i <= 3; i++) {
        console.log(`\n   Call #${i}:`);
        await testOracle.connect(operator).recordApi3Price();
        const price = await testOracle.latestApi3Price();
        console.log(`   ✓ Price: ${ethers.formatUnits(price.price, ASSET_DECIMALS)}`);
        console.log(`   ✓ Timestamp: ${new Date(Number(price.asOfTs) * 1000).toISOString()}`);
      }

      console.log("\n✅ All calls succeeded!");
    });
  });

  describe("🌐 Real World Integration Test - Chainlink", function () {
    // Increase timeout for network calls
    this.timeout(60000);

    let chainlinkTestOracle: TapirOracle;
    let snapshotId: string;

    before(async function () {
      console.log("\n" + "=".repeat(80));
      console.log("🌐 REAL WORLD TEST: Connecting to Live Chainlink Feed");
      console.log("=".repeat(80));
      console.log(`📡 RPC: ${CHAINLINK_TEST_RPC}`);
      console.log(`🔗 Chain ID: ${CHAINLINK_TEST_CHAIN_ID}`);
      console.log(`📍 Chainlink Feed Address: ${CHAINLINK_FEED_ADDRESS}`);
      console.log("=".repeat(80) + "\n");

      try {
        // Fork network to test with live Chainlink feed
        await network.provider.request({
          method: "hardhat_reset",
          params: [
            {
              forking: {
                jsonRpcUrl: CHAINLINK_TEST_RPC,
              },
            },
          ],
        });

        // Verify we're on the right network
        const chainId = await ethers.provider.getNetwork().then((n) => n.chainId);
        console.log(`✅ Connected to network with Chain ID: ${chainId}`);

        // Get fresh signers after fork
        const [deployer, admin, operator] = await ethers.getSigners();

        // Setup sources with the REAL Chainlink feed address
        const sources = {
          api3ReaderProxyV1IsActive: false,
          api3ReaderProxyV1: ZERO_ADDRESS,
          api3ReaderProxyV1Decimals: 18,
          api3ReaderProxyV1MaxStaleness: 3600,
          chainlinkAggregatorV3IsActive: true,
          chainlinkAggregatorV3: CHAINLINK_FEED_ADDRESS, // Real Chainlink feed!
          chainlinkAggregatorV3Decimals: CHAINLINK_FEED_DECIMALS,
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

        // Deploy TapirOracle on forked network
        const TapirOracle = await ethers.getContractFactory("TapirOracle");
        chainlinkTestOracle = await TapirOracle.deploy(
          "USDT",
          ZERO_ADDRESS,
          ASSET_DECIMALS,
          sources,
          config,
          admin.address
        );

        // Grant OPERATOR_ROLE to the operator
        const OPERATOR_ROLE = await chainlinkTestOracle.OPERATOR_ROLE();
        await chainlinkTestOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

        console.log(`✅ Granted OPERATOR_ROLE to: ${operator.address}`);
      } catch (error) {
        console.error("❌ Failed to setup network fork:", error);
        throw error;
      }
    });

    beforeEach(async function () {
      // Take a snapshot before each test
      snapshotId = await network.provider.send("evm_snapshot");
    });

    afterEach(async function () {
      // Revert to snapshot after each test
      await network.provider.send("evm_revert", [snapshotId]);
    });

    after(async function () {
      // Reset to local network after all tests
      await network.provider.request({
        method: "hardhat_reset",
        params: [],
      });
    });

    it("Should read real Chainlink price data from live network", async function () {
      console.log("\n" + "-".repeat(80));
      console.log("📊 Reading from Live Chainlink Data Feed");
      console.log("-".repeat(80));

      // Get the operator signer (third signer, who has OPERATOR_ROLE)
      const [, , operator] = await ethers.getSigners();

      // First, let's read directly from the Chainlink contract
      const chainlinkContract = await ethers.getContractAt(
        "contracts/TapirOracle.sol:IAggregatorV3",
        CHAINLINK_FEED_ADDRESS
      );

      let rawAnswer: bigint;
      let rawUpdatedAt: bigint;
      let chainlinkDecimals: number;

      try {
        const result = await chainlinkContract.latestRoundData();
        rawAnswer = BigInt(result[1]);
        rawUpdatedAt = BigInt(result[3]);
        chainlinkDecimals = Number(await chainlinkContract.decimals());

        console.log("\n🔍 Raw Chainlink Data:");
        console.log(`   Answer (int256): ${rawAnswer}`);
        console.log(`   Decimals: ${chainlinkDecimals}`);
        console.log(`   Price (decimal): ${ethers.formatUnits(rawAnswer, chainlinkDecimals)}`);
        console.log(`   UpdatedAt (uint256): ${rawUpdatedAt}`);
        console.log(`   UpdatedAt (Date): ${new Date(Number(rawUpdatedAt) * 1000).toISOString()}`);
        
        // Calculate age of data
        const currentTime = Math.floor(Date.now() / 1000);
        const dataAge = currentTime - Number(rawUpdatedAt);
        console.log(`   Data Age: ${dataAge} seconds (${(dataAge / 60).toFixed(2)} minutes)`);
      } catch (error) {
        console.error("❌ Failed to read from Chainlink contract:", error);
        throw error;
      }

      // Now use recordChainlinkPrice() to record it
      console.log("\n📝 Recording price using recordChainlinkPrice()...");
      await chainlinkTestOracle.connect(operator).recordChainlinkPrice();

      // Retrieve the recorded price
      const latestPrice = await chainlinkTestOracle.latestChainlinkPrice();

      // Calculate normalized price (Chainlink decimals to asset decimals)
      // When chainlink decimals > asset decimals, we divide; otherwise we multiply
      const decimalDiff = chainlinkDecimals - ASSET_DECIMALS;
      const decimalScale = BigInt(10) ** BigInt(Math.abs(decimalDiff));
      const normalizedRawPrice = decimalDiff > 0 
        ? rawAnswer / decimalScale
        : rawAnswer * decimalScale;

      console.log("\n✅ Recorded Price Data:");
      console.log(`   Price (uint192): ${latestPrice.price}`);
      console.log(`   Price (normalized to ${ASSET_DECIMALS} decimals): ${ethers.formatUnits(latestPrice.price, ASSET_DECIMALS)}`);
      console.log(`   Timestamp: ${latestPrice.asOfTs}`);
      console.log(`   Timestamp (Date): ${new Date(Number(latestPrice.asOfTs) * 1000).toISOString()}`);

      // Verify the values match (accounting for decimal normalization)
      expect(latestPrice.price).to.equal(normalizedRawPrice, "Recorded price should match normalized Chainlink value");
      expect(latestPrice.asOfTs).to.equal(rawUpdatedAt, "Recorded timestamp should match Chainlink timestamp");

      // Calculate tolerance bounds based on expected price
      const toleranceBps = BigInt(CHAINLINK_TOLERANCE_BPS);
      const lowerBound = CHAINLINK_EXPECTED_PRICE - (CHAINLINK_EXPECTED_PRICE * toleranceBps / 10000n);
      const upperBound = CHAINLINK_EXPECTED_PRICE + (CHAINLINK_EXPECTED_PRICE * toleranceBps / 10000n);

      console.log(`\n🎯 Chainlink Price Validation (±${CHAINLINK_TOLERANCE_BPS} bps = ±${Number(toleranceBps) / 100}%):`);
      console.log(`   Expected Price: ${ethers.formatUnits(CHAINLINK_EXPECTED_PRICE, CHAINLINK_FEED_DECIMALS)}`);
      console.log(`   Lower Bound: ${ethers.formatUnits(lowerBound, CHAINLINK_FEED_DECIMALS)}`);
      console.log(`   Upper Bound: ${ethers.formatUnits(upperBound, CHAINLINK_FEED_DECIMALS)}`);
      console.log(`   Actual Price (Chainlink decimals): ${ethers.formatUnits(rawAnswer, chainlinkDecimals)}`);

      // For comparison, convert stored price back to Chainlink decimals
      const storedInChainlinkDecimals = decimalDiff > 0
        ? latestPrice.price * decimalScale
        : latestPrice.price / decimalScale;
      
      if (storedInChainlinkDecimals >= lowerBound && storedInChainlinkDecimals <= upperBound) {
        console.log("   ✅ Price is within tolerance!");
      } else {
        console.log("   ⚠️  WARNING: Price is outside tolerance range!");
        console.log("   This may be normal if market conditions have changed.");
        console.log("   Update CHAINLINK_EXPECTED_PRICE and CHAINLINK_TOLERANCE_BPS at the top of the test file.");
      }

      console.log("\n" + "-".repeat(80));

      // Assertions
      expect(latestPrice.price).to.be.gt(0, "Price should be greater than zero");
      expect(latestPrice.asOfTs).to.be.gt(0, "Timestamp should be greater than zero");
      
      // Warn if data is stale (older than 1 hour)
      const currentTime = Math.floor(Date.now() / 1000);
      const staleness = currentTime - Number(latestPrice.asOfTs);
      if (staleness > 3600) {
        console.log(`\n⚠️  WARNING: Data is ${(staleness / 3600).toFixed(2)} hours old`);
      }
    });

    it("Should successfully call recordChainlinkPrice multiple times", async function () {
      const [, , operator] = await ethers.getSigners();

      console.log("\n📊 Testing multiple calls to recordChainlinkPrice()...");

      // Call it multiple times
      for (let i = 1; i <= 3; i++) {
        console.log(`\n   Call #${i}:`);
        await chainlinkTestOracle.connect(operator).recordChainlinkPrice();
        const price = await chainlinkTestOracle.latestChainlinkPrice();
        console.log(`   ✓ Price: ${ethers.formatUnits(price.price, ASSET_DECIMALS)}`);
        console.log(`   ✓ Timestamp: ${new Date(Number(price.asOfTs) * 1000).toISOString()}`);
      }

      console.log("\n✅ All calls succeeded!");
    });
  });

  describe("🌐 Real World Integration Test - RedStone Classic", function () {
    let redStoneTestOracle: TapirOracle;

    before(async function () {
      this.timeout(60000); // Increase timeout for network fork

      try {
        console.log("\n" + "=".repeat(80));
        console.log("🌐 REAL WORLD TEST: Connecting to Live RedStone Classic Feed");
        console.log("=".repeat(80));
        console.log(`📡 RPC: ${REDSTONE_TEST_RPC}`);
        console.log(`🔗 Chain ID: ${REDSTONE_TEST_CHAIN_ID}`);
        console.log(`📍 RedStone Feed Address: ${REDSTONE_FEED_ADDRESS}`);
        console.log("=".repeat(80) + "\n");

        // Fork the network
        await network.provider.request({
          method: "hardhat_reset",
          params: [
            {
              forking: {
                jsonRpcUrl: REDSTONE_TEST_RPC,
                blockNumber: undefined,
              },
            },
          ],
        });

        // Verify we're on the right network
        const chainId = await ethers.provider.getNetwork().then(n => n.chainId);
        console.log(`✅ Connected to network with Chain ID: ${chainId}\n`);

        // Get fresh signers after fork
        const [, admin, operator] = await ethers.getSigners();

        // Setup sources with the REAL RedStone Classic feed address
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
          redStoneClassicAggregator: REDSTONE_FEED_ADDRESS, // Real RedStone Classic feed!
          redStoneClassicDecimals: REDSTONE_FEED_DECIMALS,
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

        // Deploy TapirOracle on forked network
        const TapirOracle = await ethers.getContractFactory("TapirOracle");
        redStoneTestOracle = await TapirOracle.deploy(
          "USDT",
          ZERO_ADDRESS,
          ASSET_DECIMALS,
          sources,
          config,
          admin.address
        );

        // Grant OPERATOR_ROLE to the operator
        const OPERATOR_ROLE = await redStoneTestOracle.OPERATOR_ROLE();
        await redStoneTestOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

        console.log(`✅ Deployed TapirOracle at: ${await redStoneTestOracle.getAddress()}`);
        console.log(`✅ Granted OPERATOR_ROLE to: ${operator.address}`);
      } catch (error) {
        console.error("❌ Failed to setup network fork:", error);
        throw error;
      }
    });

    it("Should read real RedStone Classic price data from live network", async function () {
      this.timeout(30000); // 30 second timeout

      const [, , operator] = await ethers.getSigners();

      console.log("\n" + "-".repeat(80));
      console.log("📊 Reading from Live RedStone Classic Data Feed");
      console.log("-".repeat(80) + "\n");

      // Create interface to read directly from RedStone Classic contract
      const redStoneContract = await ethers.getContractAt(
        "ChainlinkAggregatorMock", // Uses same interface!
        REDSTONE_FEED_ADDRESS
      );

      let rawAnswer: bigint;
      let rawUpdatedAt: bigint;
      let redStoneDecimals: number;

      try {
        const result = await redStoneContract.latestRoundData();
        rawAnswer = BigInt(result[1]);
        rawUpdatedAt = BigInt(result[3]);
        redStoneDecimals = Number(await redStoneContract.decimals());

        console.log("🔍 Raw RedStone Classic Data:");
        console.log(`   Answer (int256): ${rawAnswer}`);
        console.log(`   Decimals: ${redStoneDecimals}`);
        console.log(`   Price (decimal): ${ethers.formatUnits(rawAnswer, redStoneDecimals)}`);
        console.log(`   UpdatedAt (uint256): ${rawUpdatedAt}`);
        console.log(`   UpdatedAt (Date): ${new Date(Number(rawUpdatedAt) * 1000).toISOString()}`);
        
        // Calculate age of data
        const currentTime = Math.floor(Date.now() / 1000);
        const dataAge = currentTime - Number(rawUpdatedAt);
        console.log(`   Data Age: ${dataAge} seconds (${(dataAge / 60).toFixed(2)} minutes)`);
      } catch (error) {
        console.error("❌ Failed to read from RedStone Classic contract:", error);
        throw error;
      }

      // Now use recordRedStoneClassicPrice() to record it
      console.log("\n📝 Recording price using recordRedStoneClassicPrice()...");
      await redStoneTestOracle.connect(operator).recordRedStoneClassicPrice();

      // Retrieve the recorded price
      const latestPrice = await redStoneTestOracle.latestRedStoneClassicPrice();

      // Calculate normalized price (RedStone decimals to asset decimals)
      const decimalDiff = redStoneDecimals - ASSET_DECIMALS;
      const decimalScale = BigInt(10) ** BigInt(Math.abs(decimalDiff));
      const normalizedRawPrice = decimalDiff > 0 
        ? rawAnswer / decimalScale
        : rawAnswer * decimalScale;

      console.log("\n✅ Recorded Price Data:");
      console.log(`   Price (uint192): ${latestPrice.price}`);
      console.log(`   Price (normalized to ${ASSET_DECIMALS} decimals): ${ethers.formatUnits(latestPrice.price, ASSET_DECIMALS)}`);
      console.log(`   Timestamp: ${latestPrice.asOfTs}`);
      console.log(`   Timestamp (Date): ${new Date(Number(latestPrice.asOfTs) * 1000).toISOString()}`);

      // Verify the values match (accounting for decimal normalization)
      expect(latestPrice.price).to.equal(normalizedRawPrice, "Recorded price should match normalized RedStone value");
      expect(latestPrice.asOfTs).to.equal(rawUpdatedAt, "Recorded timestamp should match RedStone timestamp");

      // Calculate tolerance bounds based on expected price
      const toleranceBps = BigInt(REDSTONE_TOLERANCE_BPS);
      const lowerBound = REDSTONE_EXPECTED_PRICE - (REDSTONE_EXPECTED_PRICE * toleranceBps / 10000n);
      const upperBound = REDSTONE_EXPECTED_PRICE + (REDSTONE_EXPECTED_PRICE * toleranceBps / 10000n);

      console.log(`\n🎯 RedStone Classic Price Validation (±${REDSTONE_TOLERANCE_BPS} bps = ±${Number(toleranceBps) / 100}%):`);
      console.log(`   Expected Price: ${ethers.formatUnits(REDSTONE_EXPECTED_PRICE, REDSTONE_FEED_DECIMALS)}`);
      console.log(`   Lower Bound: ${ethers.formatUnits(lowerBound, REDSTONE_FEED_DECIMALS)}`);
      console.log(`   Upper Bound: ${ethers.formatUnits(upperBound, REDSTONE_FEED_DECIMALS)}`);
      console.log(`   Actual Price (RedStone decimals): ${ethers.formatUnits(rawAnswer, redStoneDecimals)}`);

      // For comparison, convert stored price back to RedStone decimals
      const storedInRedStoneDecimals = decimalDiff > 0
        ? latestPrice.price * decimalScale
        : latestPrice.price / decimalScale;
      
      if (storedInRedStoneDecimals >= lowerBound && storedInRedStoneDecimals <= upperBound) {
        console.log("   ✅ Price is within tolerance!");
      } else {
        console.log("   ⚠️  WARNING: Price is outside tolerance range!");
        console.log("   This may be normal if market conditions have changed.");
        console.log("   Update REDSTONE_EXPECTED_PRICE and REDSTONE_TOLERANCE_BPS at the top of the test file.");
      }

      console.log("\n" + "-".repeat(80));

      // Assertions
      expect(latestPrice.price).to.be.gt(0, "Price should be greater than zero");
      expect(latestPrice.asOfTs).to.be.gt(0, "Timestamp should be greater than zero");
      
      // Warn if data is stale (older than 1 hour)
      const currentTime = Math.floor(Date.now() / 1000);
      const staleness = currentTime - Number(latestPrice.asOfTs);
      if (staleness > 3600) {
        console.log(`\n⚠️  WARNING: Data is ${(staleness / 3600).toFixed(2)} hours old`);
      }
    });

    it("Should successfully call recordRedStoneClassicPrice multiple times", async function () {
      const [, , operator] = await ethers.getSigners();

      console.log("\n📊 Testing multiple calls to recordRedStoneClassicPrice()...");

      // Call it multiple times
      for (let i = 1; i <= 3; i++) {
        console.log(`\n   Call #${i}:`);
        await redStoneTestOracle.connect(operator).recordRedStoneClassicPrice();
        const price = await redStoneTestOracle.latestRedStoneClassicPrice();
        console.log(`   ✓ Price: ${ethers.formatUnits(price.price, ASSET_DECIMALS)}`);
        console.log(`   ✓ Timestamp: ${new Date(Number(price.asOfTs) * 1000).toISOString()}`);
      }

      console.log("\n✅ All calls succeeded!");
    });
  });


});
