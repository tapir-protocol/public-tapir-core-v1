// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

// All prices are stored and returned in the asset's native decimals (e.g., 6 decimals for USDT, 18 for ETH)
// Oracle sources may have different decimals and are normalized to asset decimals

interface ITapirOracle {
    // ===== Structs =====

    /// @notice Data sources read by the Tapir Oracle
    /// @dev all sources must be return the price in relation to the base asset
    /// @dev decimals are adjusted on a source-by-source basis
    /// @dev each source has an isActive boolean to enable/disable it
    /// @dev each source has its own maxPriceStaleness to accommodate different oracle heartbeats
    struct Sources {
        // === API3 READER PROXY V1 CONFIGURATION ===
        //////////////////////////////////

        /// @notice Whether API3 Reader Proxy V1 source is active
        bool api3ReaderProxyV1IsActive;
        /// @notice Price data from an API3 ReaderProxyV1 contract, read through the read() function
        /// @dev Docs: https://docs.api3.org/dapps/integration/contract-integration.html
        /// @return api3ReaderProxyV1 The address of the IApi3ReaderProxy
        address api3ReaderProxyV1;
        /// @notice Decimals used by the return value of api3ReaderProxyV1.read()
        uint8 api3ReaderProxyV1Decimals;
        /// @notice Maximum staleness for API3 price data (in seconds)
        /// @dev Should match the API3 feed's heartbeat interval/account for minimum deviation thresholds
        uint32 api3ReaderProxyV1MaxStaleness;
        // === CHAINLINK AGGREGATOR V3 CONFIGURATION ===
        //////////////////////////////////

        /// @notice Whether Chainlink Aggregator V3 source is active
        bool chainlinkAggregatorV3IsActive;
        /// @notice Price data from a Chainlink AggregatorV3 contract, read through the latestRoundData() function
        /// @dev Docs: https://docs.chain.link/docs/reference-contracts
        /// @return chainlinkAggregatorV3 The address of the IAggregatorV3
        address chainlinkAggregatorV3;
        /// @notice Decimals used by the return value of chainlinkAggregatorV3.latestRoundData()
        uint8 chainlinkAggregatorV3Decimals;
        /// @notice Maximum staleness for Chainlink price data (in seconds)
        /// @dev Should match the Chainlink feed's heartbeat interval/account for minimum deviation thresholds
        uint32 chainlinkAggregatorV3MaxStaleness;
        // === REDSTONE CLASSIC MODEL CONFIGURATION ===
        ///////////////////////////////////////////////

        /// @notice Whether RedStone Classic (Push) source is active
        bool redStoneClassicIsActive;
        /// @notice RedStone Classic price feed using Chainlink-compatible AggregatorV3 interface
        /// @dev Docs: https://docs.redstone.finance/
        /// @dev RedStone Classic Model (Push) deploys on-chain price feeds with latestRoundData() interface
        /// @dev Compatible with Chainlink AggregatorV3Interface - drop-in replacement
        /// @dev Reference: https://github.com/redstone-finance/redstone-3-models-dex-example
        /// @return redStoneClassicAggregator The address of the RedStone Push price feed
        address redStoneClassicAggregator;
        /// @notice Decimals used by RedStone Classic price data (typically 8 decimals)
        uint8 redStoneClassicDecimals;
        /// @notice Maximum staleness for RedStone Classic price data (in seconds)
        /// @dev Should match the RedStone feed's heartbeat interval/account for minimum deviation thresholds
        uint32 redStoneClassicMaxStaleness;
        // === TELLOR ORACLE CONFIGURATION ===
        /////////////////////////////////////

        /// @notice Whether Tellor Oracle source is active
        bool tellorIsActive;
        /// @notice Tellor price feed using Chainlink-compatible AggregatorV3 interface
        /// @dev Uses GuardedLiquityV2OracleAdaptor which implements latestRoundData()
        /// @dev Reference: https://github.com/tellor-io/GuardedLiquityV2DataFeed
        /// @return tellorAdapter The address of the Tellor GuardedLiquityV2OracleAdaptor
        address tellorAdapter;
        /// @notice Decimals used by the Tellor adapter price data
        uint8 tellorDecimals;
        /// @notice Maximum staleness for Tellor price data (in seconds)
        /// @dev Should match the Tellor feed's heartbeat interval/account for minimum deviation thresholds
        uint32 tellorMaxStaleness;
    }

    /// @notice Configuration for the current Tapir Oracle instance
    struct Config {
        uint32 minCheckpointSpacing; // How long must pass since the last checkpoint to be able to checkpoint again
        uint8 minValidSources; // Minimum number of valid oracle sources required for a checkpoint (should be more than 1 if 3 or more sources are active (as per specification)))
        uint32 closingPriceLookbackPeriod; // Time period (in seconds) to look back when calculating closing price median (e.g., 24 hours = 86400)
        address depegPool; // The address of the DepegPool contract
        bool xChainMode; // If true, writes to DepegPool via cross-domain messenger; if false, writes directly
        address xDomainMessengerL1; // The L1 messenger address used to send xDomain messages to L2 (only used if xChainMode is true)
    }

    /// @notice Price data for a given source
    struct PriceData {
        uint192 price; // Price normalised to asset's native decimals
        uint64 asOfTs; // Timestamp when the data was retrieved from the source
    }

    // ===== Errors =====
    error SourceNotActive();
    error SourceNotConfigured();
    error InvalidPrice();
    error InvalidTimestamp();
    error FutureTimestamp();
    error TimestampOlderThanLatest();
    error PriceExceedsMax();
    error CheckpointTooSoon();
    error InvalidMinValidSources();
    error NotEnoughValidSources();
    error NoCheckpointsAvailable();
    error InsufficientCheckpointsForHWM();
    error MessengerNotConfigured();
    error InvalidAddress();
    error UnexpectedValue();

    // ===== Events =====
    event Checkpoint(uint192 price, uint64 asOfTs); // Price is in asset decimals
    event ConfigUpdated(Config cfg);
    event SourcesUpdated(Sources src);
    event PriceRecorded(uint64 indexed blockTimestamp, uint192 normalizedPrice, string sourceName);

    // ===== Functions =====

    // INPUTS: recording prices
    function recordApi3Price() external;
    function recordChainlinkPrice() external;
    function recordRedStoneClassicPrice() external;
    function recordTellorPrice() external;

    // ===== Core Implemented Functions =====

    // Status checks
    function checkpointsCount() external view returns (uint256);

    // Checkpoint (operator function)
    function checkpoint() external;

    // ===== Admin Functions =====

    // Configuration - ACTUAL IMPLEMENTATION
    function setSources(Sources calldata s) external;
    function setConfig(Config calldata c) external;

    // Pause control
    function pause() external;
    function unpause() external;

    // ===== Public State Variable Getters =====
    function cfg() external view returns (Config memory); // Needs to be made available in the interface for the DepegPool to validate the oracle configuration
    function sources() external view returns (Sources memory);

    function OPERATOR_ROLE() external view returns (bytes32);
    function assetSymbol() external view returns (string memory);
    function asset() external view returns (address);
    function assetDecimals() external view returns (uint8);
    function MAX_POINTS() external view returns (uint256);
    function MIN_CHECKPOINTS_FOR_MEDIAN() external view returns (uint16);
    function lastCheckpointTs() external view returns (uint64);

    // Latest price data from each source (auto-generated getters return tuple, not memory struct)
    function latestApi3Price() external view returns (uint192 price, uint64 asOfTs);
    function latestChainlinkPrice() external view returns (uint192 price, uint64 asOfTs);
    function latestRedStoneClassicPrice() external view returns (uint192 price, uint64 asOfTs);
    function latestTellorPrice() external view returns (uint192 price, uint64 asOfTs);
}
