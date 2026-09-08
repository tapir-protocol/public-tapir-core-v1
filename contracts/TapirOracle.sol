// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

// All prices are stored and returned in the asset's native decimals (e.g., 6 decimals for USDT, 18 for WETH)
// Oracle sources may have different decimals (e.g., Chainlink USDT-USD has 8 decimals) and are normalised to asset decimals

// The oracle outputs two price types for consumption by the DepegPool:
// - hwmPrice: the high watermark price, calculated as max(min(p_i, p_{i+1}, p_{i+2})) over consecutive daily triplets
// - closingPrice: the median of daily representative prices within the lookback period
// - these values are consumed by updatePriceData() on the DepegPool (typically ONLY ONCE during COOLDOWN)
// - note: there is no reason to provide prices multiple times but it would be possible to overwrite the previously provided values

// Functions of the oracle
//////////////////////////
// Inputs (recording new data points to the ring buffer - all sources on the same chain):
// - recordApi3Price(): read and record the latest price data from the API3 price source
// - recordChainlinkPrice(): read and record the latest price data from the Chainlink AggregatorV3
// - recordRedStoneClassicPrice(): read and record the latest price data from RedStone Classic (Push) (uses Chainlink-compatible interface)
// - recordTellorPrice(): read and record the latest price data from Tellor (uses Chainlink-compatible interface via GuardedLiquityV2OracleAdaptor)
// - checkpoint(): fetch the latest price data from internal storage and record their median
//   - privileged function callable only by the operator (this is done to introduce some randomness to observation periods)
// Outputs (writing price data to the DepegPool; callable by anyone as their output is repeatably deterministic and sufficiently filtered by input ingestion):
// - writePriceData(): write the hwmPrice and resolutionPrice to the DepegPool. If xChainMode is true, sends via cross-domain messenger; otherwise calls directly
// Supporting functions:
// - setSources(), setConfig(), pause(), unpause(): privileged functions callable only by the admin (DEFAULT_ADMIN_ROLE)
// Rest of the functions are either internal or pure/view and do not interact with the DepegPool

// Usage comments
///////////////////////
//
// Reading from on-chain sources:
// - Call recordApi3Price() to read and record API3 price (if active)
// - Call recordChainlinkPrice() to read and record Chainlink price (if active)
// - Call recordRedStoneClassicPrice() to read and record RedStone Classic (Push) price (if active)
// - Call recordTellorPrice() to read and record Tellor price (if active)
// - Call checkpoint() to compute and store the median of all active sources
// - If price data is too old, checkpoint() will revert
//

// Writing to DepegPool:
// - Same-chain mode (xChainMode = false): writePriceData() calls DepegPool directly
// - Cross-chain mode (xChainMode = true): writePriceData() sends cross-domain message to DepegPool on L2
//
// Price data should be updated approximately every 24 hours, followed by checkpoint()
// Both checkpoint() and recording price data (recordApi3Price, etc.) are permissioned (OPERATOR_ROLE) to reduce adversarial gaming

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ITapirOracle} from "./interfaces/ITapirOracle.sol";
import {IDepegPool} from "./interfaces/IDepegPool.sol";
import {IApi3ReaderProxy} from "@api3/contracts/interfaces/IApi3ReaderProxy.sol";

interface ICrossDomainMessenger {
    function sendMessage(address _target, bytes memory _message, uint32 _minGasLimit) external payable;
}

interface IAggregatorV3 {
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

contract TapirOracle is AccessControl, Pausable, ITapirOracle {
    /// VARIABLES
    ////////////////////

    // ===== Latest price data =====
    ITapirOracle.PriceData public latestApi3Price;
    ITapirOracle.PriceData public latestChainlinkPrice;
    ITapirOracle.PriceData public latestRedStoneClassicPrice;
    ITapirOracle.PriceData public latestTellorPrice;

    // ===== Roles =====
    // DEFAULT_ADMIN_ROLE inherited from OZ/AccessControl, set in constructor to "admin"
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // ===== Asset metadata (all prices use asset's native decimals) =====
    string public assetSymbol; // e.g., "weETH" or "USDT"
    address public asset; // optional target asset address (ERC20), can be address(0) if unneeded
    uint8 public assetDecimals; // e.g., 18 for weETH, 6 for USDT

    ITapirOracle.Sources internal _sources;
    ITapirOracle.Config internal _cfg;

    // ===== Checkpoint storage (ring buffer) =====
    struct PricePoint {
        // Struct in contract because internal data structure only
        uint192 price; // Price in asset's native decimals (e.g., 6 for USDT, 18 for WETH)
        uint64 ts; // Could fit into uint32
    } // compact

    uint256 public constant MAX_POINTS = 400; // ~13 months if ~daily
    uint16 public constant MIN_CHECKPOINTS_FOR_MEDIAN = 5; // Minimum checkpoints used for median calculations
    PricePoint[MAX_POINTS] private _points;
    uint16 private _count; // number of valid points (<= MAX_POINTS)
    uint16 private _head; // next write index (circular)
    uint64 public lastCheckpointTs;

    /// @notice Monotonically increasing high watermark price persisted across the pool's lifetime
    uint256 public persistedHwm;

    constructor(string memory _assetSymbol, address _asset, uint8 _assetDecimals, ITapirOracle.Sources memory sources_, ITapirOracle.Config memory cfg_, address admin) {
        if (admin == address(0)) revert InvalidAddress();
        assetSymbol = _assetSymbol;
        asset = _asset;
        assetDecimals = _assetDecimals;
        
        // Validate sources
        if (sources_.api3ReaderProxyV1IsActive && sources_.api3ReaderProxyV1 == address(0)) revert SourceNotConfigured();
        if (sources_.chainlinkAggregatorV3IsActive && sources_.chainlinkAggregatorV3 == address(0)) revert SourceNotConfigured();
        if (sources_.redStoneClassicIsActive && sources_.redStoneClassicAggregator == address(0)) revert SourceNotConfigured();
        if (sources_.tellorIsActive && sources_.tellorAdapter == address(0)) revert SourceNotConfigured();
        _sources = sources_;

        // Validate config
        if (cfg_.minValidSources == 0 || cfg_.minValidSources > 4) revert InvalidMinValidSources();
        if (cfg_.xChainMode && cfg_.xDomainMessengerL1 == address(0)) revert MessengerNotConfigured();
        _cfg = cfg_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ======== Public view functions ========
    //////////////////////////////////////////

    /// @notice Gets the current sources configuration
    /// @return Sources struct with all configured price sources
    function sources() external view returns (ITapirOracle.Sources memory) {
        return _sources;
    }

    /// @notice Gets the current oracle configuration
    /// @return Config struct with oracle parameters
    function cfg() external view returns (ITapirOracle.Config memory) {
        return _cfg;
    }

    // ======== Admin functions ========
    ////////////////////////////////////

    /// @notice Sets the sources used for recording the ring buffer values
    /// @dev Only admin can set sources.
    /// @param newSources Sources to set. Use correctly decimaled oracles!
    function setSources(ITapirOracle.Sources calldata newSources) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // Basic sanity check: if a source is active, its address must be set
        if (newSources.api3ReaderProxyV1IsActive && newSources.api3ReaderProxyV1 == address(0)) revert SourceNotConfigured();
        if (newSources.chainlinkAggregatorV3IsActive && newSources.chainlinkAggregatorV3 == address(0)) revert SourceNotConfigured();
        if (newSources.redStoneClassicIsActive && newSources.redStoneClassicAggregator == address(0)) revert SourceNotConfigured();
        if (newSources.tellorIsActive && newSources.tellorAdapter == address(0)) revert SourceNotConfigured();

        _sources = newSources;
        emit SourcesUpdated(newSources);
    }

    /// @notice Sets the configuration for the oracle
    /// @dev Instantly updates the configuration to what the admin sets it to
    /// @param newConfig Configuration to set.
    function setConfig(ITapirOracle.Config calldata newConfig) public virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        // Validate minValidSources configuration (1-4)
        if (newConfig.minValidSources == 0 || newConfig.minValidSources > 4) revert InvalidMinValidSources();

        // Ensure depegPool is set
        if (newConfig.depegPool == address(0)) revert InvalidAddress();

        // Ensure consistency for cross-chain mode
        if (newConfig.xChainMode && newConfig.xDomainMessengerL1 == address(0)) {
            revert MessengerNotConfigured();
        }

        // Update the configuration
        _cfg = newConfig;
        emit ConfigUpdated(newConfig);
    }

    /// @notice Pauses new checkpoints from being recorded
    /// @dev Only admin can pause. From OZ/Pausable.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Allows recording of new checkpoints
    /// @dev Only admin can unpause. From OZ/Pausable.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ======== Functions for recording price inputs  ========
    //////////////////////////////////////////////////////////

    /// @notice Reads the API3 price and records it
    /// @dev Reads directly from the API3 ReaderProxy and stores data to latestApi3Price
    /// @dev The timestamp recorded in PriceData is the API3 data feed's timestamp (when the price was reported)
    function recordApi3Price() external whenNotPaused onlyRole(OPERATOR_ROLE) {
        // Cache _sources to reduce storage reads
        ITapirOracle.Sources memory src = _sources;

        // Ensure the price source is active
        if (!src.api3ReaderProxyV1IsActive) revert SourceNotActive();

        // Read the price data
        (int224 value, uint32 timestamp) = IApi3ReaderProxy(src.api3ReaderProxyV1).read();

        // Validate the price data
        if (value <= 0) revert InvalidPrice();
        if (timestamp == 0) revert InvalidTimestamp();
        if (timestamp > block.timestamp) revert FutureTimestamp();
        if (timestamp < latestApi3Price.asOfTs) revert TimestampOlderThanLatest();

        uint256 normalizedPrice = _normalizeDecimals(uint256(int256(value)), src.api3ReaderProxyV1Decimals, assetDecimals);
        if (normalizedPrice > uint256(type(uint192).max)) revert PriceExceedsMax();

        latestApi3Price = ITapirOracle.PriceData(uint192(normalizedPrice), uint64(timestamp));
        emit PriceRecorded(uint64(block.timestamp), uint192(normalizedPrice), "API3");
    }

    /// @notice Reads the Chainlink price and records it
    /// @dev Reads directly from Chainlink AggregatorV3 and stores data to latestChainlinkPrice
    function recordChainlinkPrice() external whenNotPaused onlyRole(OPERATOR_ROLE) {
        // Cache _sources to reduce storage reads
        ITapirOracle.Sources memory src = _sources;

        if (!src.chainlinkAggregatorV3IsActive) revert SourceNotActive();
        uint192 normalizedPrice = _recordAggregatorV3Price(src.chainlinkAggregatorV3, src.chainlinkAggregatorV3Decimals, latestChainlinkPrice);
        emit PriceRecorded(uint64(block.timestamp), normalizedPrice, "Chainlink");
    }

    /// @notice Reads the RedStone Classic (Push) price and records it
    /// @dev Uses RedStone Classic Model (Push) with Chainlink-compatible AggregatorV3Interface
    /// @dev Reference: https://github.com/redstone-finance/redstone-3-models-dex-example
    function recordRedStoneClassicPrice() external whenNotPaused onlyRole(OPERATOR_ROLE) {
        // Cache _sources to reduce storage reads
        ITapirOracle.Sources memory src = _sources;

        if (!src.redStoneClassicIsActive) revert SourceNotActive();
        uint192 normalizedPrice = _recordAggregatorV3Price(src.redStoneClassicAggregator, src.redStoneClassicDecimals, latestRedStoneClassicPrice);
        emit PriceRecorded(uint64(block.timestamp), normalizedPrice, "RedStone");
    }

    /// @notice Reads the Tellor price (via Chainlink adaptor) and records it
    /// @dev Uses Tellor's GuardedLiquityV2OracleAdaptor with Chainlink-compatible AggregatorV3Interface
    /// @dev Reference: https://github.com/tellor-io/GuardedLiquityV2DataFeed
    function recordTellorPrice() external whenNotPaused onlyRole(OPERATOR_ROLE) {
        // Cache _sources to reduce storage reads
        ITapirOracle.Sources memory src = _sources;

        if (!src.tellorIsActive) revert SourceNotActive();
        uint192 normalizedPrice = _recordAggregatorV3Price(src.tellorAdapter, src.tellorDecimals, latestTellorPrice);
        emit PriceRecorded(uint64(block.timestamp), normalizedPrice, "Tellor");
    }

    /// @notice Internal helper to record price from any AggregatorV3-compatible source
    /// @dev Reads latestRoundData(), validates, normalizes, and stores to the given storage slot
    /// @param aggregator The address of the AggregatorV3-compatible contract
    /// @param sourceDecimals The decimals of the price source
    /// @param latestPrice Storage pointer to the PriceData struct to update
    /// @return normalizedPrice The normalized price in asset decimals
    function _recordAggregatorV3Price(address aggregator, uint8 sourceDecimals, ITapirOracle.PriceData storage latestPrice) internal returns (uint192) {
        // Read the price data
        (, int256 answer, , uint256 updatedAt, ) = IAggregatorV3(aggregator).latestRoundData();

        // Validate the price data
        if (answer <= 0) revert InvalidPrice();
        if (updatedAt == 0) revert InvalidTimestamp();
        if (updatedAt > block.timestamp) revert FutureTimestamp();
        if (updatedAt < latestPrice.asOfTs) revert TimestampOlderThanLatest();

        // Normalize to asset decimals
        uint256 normalizedPrice = _normalizeDecimals(uint256(answer), sourceDecimals, assetDecimals);
        if (normalizedPrice > uint256(type(uint192).max)) revert PriceExceedsMax();

        latestPrice.price = uint192(normalizedPrice);
        latestPrice.asOfTs = uint64(updatedAt);

        return uint192(normalizedPrice);
    }

    // ======== Checkpointing functionality ========
    ////////////////////////////////////////////////

    /// @notice Records a new checkpoint to the ring buffer
    /// @dev Only operator can call. Must not be paused.
    /// @dev Requires at least minValidSources (from config) that are sufficiently recent
    /// @dev Each source is validated against its own maxPriceStaleness setting
    /// @dev Price selection: 3+ sources uses median; 2 sources uses price closer to previous checkpoint (or average if no previous); 1 source uses that price directly
    /// @dev Monotonically updates persistedHwm if a new robust daily triplet is finalized (on new day start)
    function checkpoint() public virtual whenNotPaused onlyRole(OPERATOR_ROLE) {
        // Cache block.timestamp to reduce redundant reads
        uint64 currentTs = uint64(block.timestamp);

        // Ensure the checkpoint is not too soon
        if (currentTs < lastCheckpointTs + _cfg.minCheckpointSpacing) revert CheckpointTooSoon();

        // Validate minValidSources configuration
        if (_cfg.minValidSources == 0) revert InvalidMinValidSources();

        // Load sources config for per-source staleness thresholds
        ITapirOracle.Sources memory src = _sources;

        // Load the latest prices into an array for validation
        ITapirOracle.PriceData[4] memory priceSources = [latestApi3Price, latestChainlinkPrice, latestRedStoneClassicPrice, latestTellorPrice];

        // Load per-source staleness thresholds (matching order of priceSources array)
        uint32[4] memory maxStaleness = [src.api3ReaderProxyV1MaxStaleness, src.chainlinkAggregatorV3MaxStaleness, src.redStoneClassicMaxStaleness, src.tellorMaxStaleness];

        // Load per-source active flags (matching order of priceSources array)
        bool[4] memory isActive = [src.api3ReaderProxyV1IsActive, src.chainlinkAggregatorV3IsActive, src.redStoneClassicIsActive, src.tellorIsActive];

        // Filter valid sources (sufficiently recent based on source-specific staleness and non-zero price)
        ITapirOracle.PriceData[4] memory validSources;
        uint8 validCount = 0;
        for (uint8 i = 0; i < 4; i++) {
            if (isActive[i] && currentTs < priceSources[i].asOfTs + maxStaleness[i] && priceSources[i].price > 0) {
                validSources[validCount] = priceSources[i];
                validCount++;
            }
        }

        // Ensure we have at least minValidSources valid sources
        if (validCount < _cfg.minValidSources) revert NotEnoughValidSources();

        uint192 price;

        if (validCount >= 3) {
            // Calculate the median price from the valid sources if validCount >= 3
            price = _checkpointMedian(validSources, validCount);
        } else if (validCount == 2) {
            // Select price closer to previous checkpoint's price
            if (_count > 0) {
                // Get the previous checkpoint's price (most recent checkpoint in ring buffer)
                uint16 lastIndex = _wrapSub(_head, 1);
                uint192 prevPrice = _points[lastIndex].price;

                // Calculate absolute || differences
                uint192 diff0 = validSources[0].price > prevPrice ? validSources[0].price - prevPrice : prevPrice - validSources[0].price;
                uint192 diff1 = validSources[1].price > prevPrice ? validSources[1].price - prevPrice : prevPrice - validSources[1].price;

                // Select the price closer to previous checkpoint
                if (diff0 < diff1) {
                    price = validSources[0].price;
                } else {
                    // diff1 <= diff0
                    price = validSources[1].price;
                }
            } else {
                // No previous checkpoint, use average
                price = (validSources[0].price + validSources[1].price) / 2;
            }
        } else {
            // validCount == 1
            price = validSources[0].price;
        }

        // Update the persisted HWM monotonically when a new day starts
        if (_count > 0) {
            uint16 lastIndex = _wrapSub(_head, 1);
            if (_startOfDayUtc(currentTs) > _startOfDayUtc(_points[lastIndex].ts)) {
                uint256 candidateHwm = _highWatermarkPrice();
                if (candidateHwm > persistedHwm) {
                    persistedHwm = candidateHwm;
                }
            }
        }

        // Write to ring buffer
        _pushPoint(price, currentTs);

        // Update the last checkpoint timestamp to prevent checkpointing too soon next round
        lastCheckpointTs = currentTs;

        // Emit the checkpoint event
        emit Checkpoint(price, currentTs);
    }

    // ======== Function for writing price data to the DepegPool ========
    /////////////////////////////////////////////////////////////////////

    /// @notice Writes the price data (HWM & Closing) to the DepegPool using the updatePriceData() function
    /// @dev Price data is the high watermark price and the closing/resolution price
    /// @dev Can be called by operator only
    /// @dev Uses the maximum of the lifetime persisted HWM and the current ring buffer's candidate HWM
    /// @dev payable because the xDomain messenger requires a value to be passed (only if cfg.xChainMode is true)
    function writePriceData(uint32 _gaslimit) external payable virtual whenNotPaused onlyRole(OPERATOR_ROLE) {
        uint256 hwmPrice = Math.max(persistedHwm, _highWatermarkPrice());
        if (hwmPrice == 0) revert InsufficientCheckpointsForHWM();

        uint16 requestedCount = _getRecentCheckpointCount();
        uint256 closingPrice = _medianOfLastEligibleCheckpoints(requestedCount);

        _sendPriceDataToDepegPool(hwmPrice, closingPrice, _gaslimit);
    }

    // ======== Internal helper functions ========
    //////////////////////////////////////////////

    /// @notice Internal helper to send price data to DepegPool
    /// @dev Handles both xChain and direct call modes
    /// @param hwmPrice The high watermark price to send
    /// @param closingPrice The closing/resolution price to send
    /// @param _gaslimit Gas limit for cross-chain message (only used if xChainMode is true)
    function _sendPriceDataToDepegPool(uint256 hwmPrice, uint256 closingPrice, uint32 _gaslimit) internal {
        if (_cfg.xChainMode) {
            // Cross-chain mode: send message via messenger
            if (_cfg.xDomainMessengerL1 == address(0)) revert MessengerNotConfigured();
            ICrossDomainMessenger(_cfg.xDomainMessengerL1).sendMessage{value: msg.value}(_cfg.depegPool, abi.encodeWithSelector(IDepegPool.updatePriceData.selector, hwmPrice, closingPrice), _gaslimit);
        } else {
            // Same-chain mode: call directly
            IDepegPool(_cfg.depegPool).updatePriceData(hwmPrice, closingPrice);
        }
    }

    /// @notice Calculates the number of checkpoints within the configured lookback period (with a minimum of 5)
    /// @dev Traverses the ring buffer backwards to count checkpoints within the lookback window
    /// @return The count of checkpoints to use for closing price calculation (minimum 5)
    function _getRecentCheckpointCount() internal view returns (uint16) {
        // Cache _count to reduce storage reads in the loop
        uint16 cachedCount = _count;

        // Calculate the amount of data points during the lookback period, with min. 5:
        // Traverse the ringbuffer backwards and count the number of data points that are within the lookback period
        uint16 requestedCount = 0;
        for (uint16 i = 0; i < cachedCount; i++) {
            uint16 index = _wrapSub(_head, uint16(i + 1)); // Start at the most recent checkpoint
            if (_points[index].ts + _cfg.closingPriceLookbackPeriod > block.timestamp) {
                requestedCount++;
            } else {
                break; // Older checkpoints won't be within the lookback period
            }
        }
        // If the number of data points is less than minimum, retrieve further out than the lookback period
        if (requestedCount < MIN_CHECKPOINTS_FOR_MEDIAN) {
            requestedCount = MIN_CHECKPOINTS_FOR_MEDIAN;
        }
        return requestedCount;
    }

    /// @notice Returns the median of daily representative prices from the last requestedCount checkpoints
    /// @dev Retrieves checkpoints, groups them by day (UTC), calculates representative price per day, then returns median
    /// @dev For each day: 1 price → use it; 2 prices → use smaller; 3+ prices → use median
    /// @param requestedCount The number of checkpoints to retrieve (quietly falls back to lower values if not enough checkpoints are available)
    /// @return The median price as uint256 in asset's native decimals
    function _medianOfLastEligibleCheckpoints(uint16 requestedCount) internal view returns (uint256) {
        // Require at least one checkpoint
        if (_count == 0) revert NoCheckpointsAvailable();

        // Determine how many checkpoints to retrieve (up to requestedCount)
        uint16 numToRetrieve = _count < requestedCount ? _count : requestedCount;

        // Create array to hold checkpoints
        PricePoint[] memory checkpoints = new PricePoint[](numToRetrieve);

        // Walk backwards from head to get the last numToRetrieve checkpoints (newest first)
        for (uint256 i = 0; i < numToRetrieve; i++) {
            uint16 idx = _wrapSub(_head, uint16(i + 1));
            checkpoints[i] = _points[idx];
        }

        // Aggregate to daily prices
        uint256[] memory dailyPrices = _aggregateToDailyPrices(checkpoints);

        if (dailyPrices.length == 0) revert NoCheckpointsAvailable();

        // Calculate and return median of daily prices
        return _median(dailyPrices);
    }

    /// @notice Returns the high watermark candidate from the current ring buffer using daily prices
    /// @dev Calculates P_hwm = max_i(min(p_i, p_{i+1}, p_{i+2})) over all consecutive daily triplets
    /// @dev First aggregates checkpoints to daily representative prices, then applies triplet algorithm
    /// @dev This captures the highest robustly held price by finding the triplet with the highest minimum value
    /// @return The buffered HWM candidate, or 0 if fewer than 3 days of data are available
    function _highWatermarkPrice() internal view returns (uint256) {
        // Get all points in chronological order (oldest first)
        PricePoint[] memory points = _materialize();

        // Aggregate to daily prices (will be in chronological order - oldest first)
        uint256[] memory dailyPrices = _aggregateToDailyPrices(points);

        // Require at least 3 days to form a triplet
        if (dailyPrices.length < 3) return 0;

        // Calculate min for each consecutive triplet and track the maximum
        uint256 maxOfMins = 0;

        // Iterate through all consecutive triplets of daily prices
        for (uint256 i = 0; i <= dailyPrices.length - 3; i++) {
            // Calculate minimum of the current triplet
            uint256 tripletMin = Math.min(dailyPrices[i], Math.min(dailyPrices[i + 1], dailyPrices[i + 2]));

            // Update maxOfMins if this triplet's minimum is higher
            if (tripletMin > maxOfMins) {
                maxOfMins = tripletMin;
            }
        }

        return maxOfMins;
    }

    /// @notice Returns the median price and its timestamp for a checkpoint
    /// @dev Handles 3 or more valid sources. Price is returned in asset's native decimals (fewer sources are handled in calling function).
    /// @param validSources The array of valid price sources (already filtered for staleness and non-zero price)
    /// @param validCount The number of valid sources in the array (must be >= 3 (validated in checkpoint()))
    /// @return price The median price in asset decimals
    function _checkpointMedian(ITapirOracle.PriceData[4] memory validSources, uint8 validCount) internal pure returns (uint192 price) {
        assert(validCount >= 3); // Safety: this function assumes validCount >= 3

        // Sort valid sources by price
        // Simple bubble sort for small array
        for (uint8 i = 0; i < validCount - 1; i++) {
            for (uint8 j = 0; j < validCount - i - 1; j++) {
                if (validSources[j].price > validSources[j + 1].price) {
                    ITapirOracle.PriceData memory temp = validSources[j];
                    validSources[j] = validSources[j + 1];
                    validSources[j + 1] = temp;
                }
            }
        }

        // Calculate median/average based on count
        if (validCount == 4) {
            // Return average of two middle values for even count
            price = (validSources[1].price + validSources[2].price) / 2;
        } else if (validCount == 3) {
            // Return median (middle value)
            price = validSources[1].price;
        } // No other cases are possible; _checkpointMedian is called ONLY when validCount >= 3

        return price;
    }

    /// @dev Pushes a new price point to the ring buffer struct
    /// @param price The price of the price point
    /// @param ts The timestamp of the price point
    function _pushPoint(uint192 price, uint64 ts) internal {
        _points[_head] = PricePoint(price, ts);
        _head = uint16((_head + 1) % MAX_POINTS);
        if (_count < MAX_POINTS) {
            _count++;
        }
    }

    /// @notice Returns the number of checkpoints currently recorded
    /// @dev Returns the number of valid price points in the ring buffer
    /// @return count The number of checkpoints
    function checkpointsCount() external view returns (uint256) {
        return _count;
    }

    /// @notice Returns the points in the ring buffer in ascending order of timestamp (oldest first)
    /// @dev Materialize points oldest..newest
    function _materialize() internal view returns (PricePoint[] memory seq) {
        seq = new PricePoint[](_count);
        if (_count == 0) return seq;
        // oldest is at head if buffer full; compute start
        uint16 start = _count < MAX_POINTS ? 0 : _head;
        for (uint256 i = 0; i < _count; i++) {
            uint16 idx = uint16((start + i) % MAX_POINTS);
            seq[i] = _points[idx];
        }
    }

    /// @notice Returns the difference between two uint16 values, wrapping around if the difference is negative
    /// @dev Wraps around if the difference is negative
    /// @param a The first uint16 value
    /// @param b The second uint16 value
    /// @return The difference between the two uint16 values, wrapping around if the difference is negative
    function _wrapSub(uint16 a, uint16 b) internal pure returns (uint16) {
        unchecked {
            // N.B!
            return a >= b ? a - b : uint16(a + uint16(MAX_POINTS) - b);
        }
    }

    /// @notice Normalizes a value from source decimals to target decimals
    /// @param value The value to normalize
    /// @param sourceDecimals The number of decimals of the input value
    /// @param targetDecimals The desired number of decimals for the output
    /// @return The normalized value
    function _normalizeDecimals(uint256 value, uint8 sourceDecimals, uint8 targetDecimals) internal pure returns (uint256) {
        if (sourceDecimals == targetDecimals) return value;
        if (sourceDecimals < targetDecimals) {
            return value * (10 ** (targetDecimals - sourceDecimals));
        }
        return value / (10 ** (sourceDecimals - targetDecimals));
    }

    /// @notice Returns the start of day (UTC, 00:00:00) for a given timestamp
    /// @param ts The timestamp
    /// @return The start of day timestamp (midnight UTC)
    function _startOfDayUtc(uint64 ts) internal pure returns (uint64) {
        return ts - (ts % 86400); // 60*60*24=86400 seconds in a day
    }

    /// @notice Calculates the representative price for a day given an array of prices
    /// @dev If 1 price: return it; if 2 prices: return smaller; if 3+: return median
    /// @param prices Array of prices recorded on that day
    /// @return The representative price for the day
    function _dailyRepresentativePrice(uint256[] memory prices) internal pure returns (uint256) {
        uint256 n = prices.length;
        if (n == 1) return prices[0];
        if (n == 2) return prices[0] < prices[1] ? prices[0] : prices[1];
        return _median(prices);
    }

    /// @notice Groups checkpoints by day and returns representative price for each day
    /// @dev Assumes checkpoints are ordered by time (either chronological or reverse chronological)
    /// @dev Returns daily prices in the same order as input (if input is oldest-first, output is oldest-first)
    /// @param checkpoints Array of PricePoints
    /// @return dailyPrices Array of representative prices per day
    function _aggregateToDailyPrices(PricePoint[] memory checkpoints) internal pure returns (uint256[] memory) {
        uint256 n = checkpoints.length;
        if (n == 0) {
            return new uint256[](0);
        }

        // First pass: count unique days
        uint256 dayCount = 1;
        uint64 prevDayStart = _startOfDayUtc(checkpoints[0].ts);
        for (uint256 i = 1; i < n; i++) {
            uint64 dayStart = _startOfDayUtc(checkpoints[i].ts);
            if (dayStart != prevDayStart) {
                dayCount++;
                prevDayStart = dayStart;
            }
        }

        // Second pass: build daily prices
        uint256[] memory dailyPrices = new uint256[](dayCount);
        uint256 dayIdx = 0;
        uint64 currentDayStart = _startOfDayUtc(checkpoints[0].ts);

        // Track start index of current day
        uint256 dayStartIdx = 0;

        for (uint256 i = 1; i <= n; i++) {
            bool isLastOrNewDay = (i == n) || (_startOfDayUtc(checkpoints[i].ts) != currentDayStart);

            if (isLastOrNewDay) {
                // Calculate count of prices in current day
                uint256 countInDay = i - dayStartIdx;

                // Build array of prices for this day
                uint256[] memory dayPrices = new uint256[](countInDay);
                for (uint256 j = 0; j < countInDay; j++) {
                    dayPrices[j] = checkpoints[dayStartIdx + j].price;
                }

                // Calculate representative price for this day
                dailyPrices[dayIdx] = _dailyRepresentativePrice(dayPrices);

                // Move to next day
                if (i < n) {
                    dayIdx++;
                    currentDayStart = _startOfDayUtc(checkpoints[i].ts);
                    dayStartIdx = i;
                }
            }
        }

        return dailyPrices;
    }

    /// @notice Returns the median of an array of values
    /// @param arr The array of values
    /// @dev O(n^2) complexity!!!
    /// @return The median of the array
    function _median(uint256[] memory arr) internal pure returns (uint256) {
        // small n (<=5). selection median.
        uint256 n = arr.length;
        // simple insertion sort (n is tiny)
        for (uint256 i = 1; i < n; i++) {
            uint256 key = arr[i];
            uint256 j = i;
            while (j > 0 && arr[j - 1] > key) {
                arr[j] = arr[j - 1];
                j--;
            }
            arr[j] = key;
        }
        // Return proper median: average of two middle values for even-length arrays
        if (n % 2 == 0) {
            //      first middle value + second middle value
            return (arr[(n / 2) - 1] + arr[(n / 2)]) / 2;
        } else {
            return arr[n / 2];
        }
    }
}
