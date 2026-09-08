// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

import "./TapirOracle.sol";
import "./interfaces/ITapirVrpOracle.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

// Lifecycle (refer to TapirOracle for other functions):
// 1. TapirVrpOracle is deployed with a vault and witnessShares (no token prefunding required)
// 2. checkpoint() performs both price checkpointing and VRP checkpointing in one call
// 3. Operator calls resolveVrp(), which samples PRV from previewRedeem(witnessShares)
// 4. writePriceData() uses the VRP values to adjust the closing price

/// @title TapirVrpOracle
/// @notice Extension of TapirOracle with VRP (Vault Redeem Preview) for ERC-4626 vaults
/// @dev Inherits all TapirOracle functionality and adds VRP-specific features
contract TapirVrpOracle is TapirOracle, ITapirVrpOracle {
    /// CUSTOM ERRORS
    ////////////////////
    error VrpNotResolved();
    error VrpAlreadyResolved();
    error InvalidVrpValues();
    error ManualResolveRequired();
    error ManualResolveNotAllowed();
    error XChainModeNotSupported();

    /// VARIABLES
    ////////////////////

    bool public vrpResolved; // Flag indicating whether VRP has been resolved
    uint256 public vrpPrv; // Preview redemption value from previewRedeem(witnessShares)
    uint256 public immutable initialVrpPreview; // Constructor-time previewRedeem(witnessShares), used as scaling reference
    uint256 public immutable errorTolerance; // Error tolerance before HWM/PRV delta is considered (epsilon) – ABSOLUTE UNITS!
    uint256 public constant VRP_ACCURACY = 10000; // Accuracy of VRP calculations

    address public immutable vault; // Address of the ERC-4626 vault (accounting chain in Zircuit context)
    uint256 public immutable witnessShares; // Share amount used for PRV/HWM quotes

    bool public forceManualResolve; // Flag indicating whether to force manual resolution if PRV is zero

    struct VrpPoint {
        uint192 preview; // previewRedeem(witnessShares) quote
        uint64 ts; // observation timestamp
    }

    uint256 public constant MAX_VRP_POINTS = 400; // ~13 months if ~daily
    VrpPoint[MAX_VRP_POINTS] private _vrpPoints;
    uint16 private _vrpCount;
    uint16 private _vrpHead;

    /// @notice Monotonically increasing VRP high watermark persisted across the pool's lifetime
    uint256 public persistedVrpHwm;

    /// CONSTRUCTOR
    ////////////////////

    /// @dev Note: Associated DepegPool.MAX_PRICE should be set with headroom for the 
    /// expected cumulative vault share appreciation over the pool's lifetime.
    constructor(string memory _assetSymbol, address _asset, uint8 _assetDecimals, ITapirOracle.Sources memory sources_, ITapirOracle.Config memory cfg_, address admin, ITapirVrpOracle.VaultConfig memory vaultConfig_) TapirOracle(_assetSymbol, _asset, _assetDecimals, sources_, cfg_, admin) {
        if (cfg_.xChainMode) revert XChainModeNotSupported();
        if (vaultConfig_.vault == address(0)) revert InvalidAddress();
        if (vaultConfig_.witnessShares < VRP_ACCURACY) revert InvalidVrpValues();

        vault = vaultConfig_.vault;
        witnessShares = vaultConfig_.witnessShares;
        errorTolerance = vaultConfig_.errorTolerance;

        // t=0 snapshot: initialize HWM from previewRedeem quote
        uint256 initialPreview = IERC4626(vault).previewRedeem(witnessShares);
        if (initialPreview == 0) revert InvalidVrpValues(); // used as denominator later
        if (initialPreview > uint256(type(uint192).max)) revert InvalidVrpValues();
        initialVrpPreview = initialPreview;
        persistedVrpHwm = initialPreview;
        _pushVrpPoint(uint192(initialPreview), uint64(block.timestamp));
    }

    /// @notice Returns current VRP HWM derived from the persisted value and current buffer.
    /// @dev Returns the maximum of the lifetime persisted VRP HWM and the current ring buffer's candidate
    function vrpHwm() public view override returns (uint256) {
        return Math.max(persistedVrpHwm, _vrpHighWatermarkPreview());
    }

    /// @notice Sets the configuration for the oracle
    /// @dev Instantly updates the configuration to what the admin sets it to
    /// @dev Overrides TapirOracle.setConfig() to prevent enabling xChainMode
    /// @param newConfig Configuration to set.
    function setConfig(ITapirOracle.Config calldata newConfig) public override(ITapirOracle, TapirOracle) onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newConfig.xChainMode) revert XChainModeNotSupported();
        super.setConfig(newConfig);
    }

    /// @notice Records both price and VRP checkpoints in one call.
    /// @dev Inherits spacing and role checks from TapirOracle.checkpoint().
    function checkpoint() public override(TapirOracle, ITapirOracle) onlyRole(OPERATOR_ROLE) {
        super.checkpoint();
        _checkpointVrp();
    }

    /// @notice Resolves VRP by sampling current PRV from ERC-4626 view quotes (no deposits or redemptions)
    /// @dev Only callable by operator role
    function resolveVrp() external whenNotPaused onlyRole(OPERATOR_ROLE) {
        if (vrpResolved) revert VrpAlreadyResolved();
        if (forceManualResolve) revert ManualResolveRequired();

        (uint256 currentPrv, ) = _checkpointVrp();
        vrpPrv = currentPrv;

        if (vrpPrv == 0) {
            forceManualResolve = true;
            emit MustResolveManually();
            return;
        }
        vrpResolved = true;

        emit VrpResolved(vrpPrv);
    }

    /// @notice Manually resolves VRP by setting PRV value
    /// @dev Can only be called by admin
    /// @dev Backup/override if resolveVrp() cannot complete or recorded inaccurate values
    function manualBackupResolveVrp(uint256 _vrpPrv) external onlyRole(DEFAULT_ADMIN_ROLE) {

        vrpPrv = _vrpPrv;
        vrpResolved = true;

        emit VrpResolved(vrpPrv);
    }

    /// @notice Internal helper to record a VRP checkpoint and update persistence
    /// @dev Monotonically updates persistedVrpHwm if a new robust daily triplet is finalised
    /// @return currentPrv The current preview value from the vault
    /// @return newHwm The current effective VRP HWM (persisted)
    function _checkpointVrp() internal returns (uint256 currentPrv, uint256 newHwm) {
        currentPrv = IERC4626(vault).previewRedeem(witnessShares);
        if (currentPrv > uint256(type(uint192).max)) revert InvalidVrpValues();

        uint64 currentTs = uint64(block.timestamp);
        // Update the persisted VRP HWM monotonically when a new day starts
        if (_vrpCount > 0) {
            uint16 lastIndex = _vrpHead == 0 ? uint16(MAX_VRP_POINTS - 1) : uint16(_vrpHead - 1);
            if (_startOfDayUtc(currentTs) > _startOfDayUtc(_vrpPoints[lastIndex].ts)) {
                uint256 candidateVrpHwm = _vrpHighWatermarkPreview();
                if (candidateVrpHwm > persistedVrpHwm) {
                    persistedVrpHwm = candidateVrpHwm;
                }
            }
        }

        _pushVrpPoint(uint192(currentPrv), currentTs);

        newHwm = persistedVrpHwm;
    }

    /// @notice Writes the price data (HWM & Closing) to the DepegPool
    /// @dev Overrides TapirOracle.writePriceData() to add VRP validation checks and adjusts closing price
    /// @dev Only callable by operator role
    /// @dev Requires VRP to be resolved with valid HWM and PRV
    /// @dev Scales both hwmPrice and closingPrice by VRP change vs initial preview reference
    /// @dev Applies VRP depeg logic with tolerance to the closing component
    /// @dev Uses the maximum of the lifetime persisted HWMs and the current ring buffer candidates
    /// @dev Clamps adjusted prices to DepegPool.MAX_PRICE to prevent permanent pool lock.
    /// @dev NOTE: DepegPool.MAX_PRICE should be set with buffer to account for vault yield.
    function writePriceData(uint32 _gaslimit) public payable override whenNotPaused onlyRole(OPERATOR_ROLE) {
        if (!vrpResolved) revert VrpNotResolved();

        uint16 requestedCount = _getRecentCheckpointCount();
        uint256 closingPrice = _medianOfLastEligibleCheckpoints(requestedCount);
        uint256 hwmPrice = Math.max(persistedHwm, _highWatermarkPrice());
        if (hwmPrice == 0) revert InsufficientCheckpointsForHWM();
        uint256 vrpHwmValue = Math.max(persistedVrpHwm, _vrpHighWatermarkPreview());

        // Scale HWM by preview-growth component (VRP HWM relative to constructor snapshot)
        // adjustedHwmPrice = price HWM * (VRP HWM / initial VRP)
        uint256 adjustedHwmPrice = Math.mulDiv(hwmPrice, vrpHwmValue, initialVrpPreview);

        // Apply depeg/tolerance to closing VRP component, then scale by the same reference.
        uint256 effectiveClosingVrp = vrpPrv + errorTolerance < vrpHwmValue ? vrpPrv + errorTolerance : vrpHwmValue;
        // Scale closing price by preview-growth component
        // adjustedClosingPrice = closing price * ((PRV + errorTolerance) / initial VRP)
        uint256 adjustedClosingPrice = Math.mulDiv(closingPrice, effectiveClosingVrp, initialVrpPreview);

        // Clamp adjusted prices to MAX_PRICE to prevent permanent pool lock in COOLDOWN
        // Vault yield can push the adjusted HWM above the pool's immutable MAX_PRICE ceiling.
        uint256 maxPrice = IDepegPool(_cfg.depegPool).MAX_PRICE();
        if (adjustedHwmPrice > maxPrice) {
            adjustedHwmPrice = maxPrice;
        }
        if (adjustedClosingPrice > maxPrice) {
            adjustedClosingPrice = maxPrice;
        }

        _sendPriceDataToDepegPool(adjustedHwmPrice, adjustedClosingPrice, _gaslimit);
    }

    function _pushVrpPoint(uint192 preview, uint64 ts) internal {
        _vrpPoints[_vrpHead] = VrpPoint(preview, ts);
        _vrpHead = uint16((_vrpHead + 1) % MAX_VRP_POINTS);
        if (_vrpCount < MAX_VRP_POINTS) {
            _vrpCount++;
        }
    }

    function _materializeVrpPoints() internal view returns (VrpPoint[] memory seq) {
        seq = new VrpPoint[](_vrpCount);
        if (_vrpCount == 0) return seq;

        uint16 start = _vrpCount < MAX_VRP_POINTS ? 0 : _vrpHead;
        for (uint16 i = 0; i < _vrpCount; i++) {
            uint16 idx = uint16((start + i) % MAX_VRP_POINTS);
            seq[i] = _vrpPoints[idx];
        }
    }

    /// @dev Calculates VRP HWM from ring-buffered preview observations.
    /// @dev Uses same triplet logic as TapirOracle on daily representative values.
    /// @return The buffered VRP HWM candidate, or 0 if fewer than 3 days of data are available
    function _vrpHighWatermarkPreview() internal view returns (uint256) {
        VrpPoint[] memory vrpPoints = _materializeVrpPoints();
        if (vrpPoints.length == 0) revert InvalidVrpValues();

        // Reuse TapirOracle daily aggregation helpers by adapting VRP observations to PricePoint.
        PricePoint[] memory checkpoints = new PricePoint[](vrpPoints.length);
        uint256 maxObserved = 0;
        for (uint256 i = 0; i < vrpPoints.length; i++) {
            checkpoints[i] = PricePoint(vrpPoints[i].preview, vrpPoints[i].ts);
            if (vrpPoints[i].preview > maxObserved) {
                maxObserved = vrpPoints[i].preview;
            }
        }

        uint256[] memory dailyPreviews = _aggregateToDailyPrices(checkpoints);
        if (dailyPreviews.length < 3) {
            return 0;
        }

        uint256 maxOfMins = 0;
        for (uint256 i = 0; i <= dailyPreviews.length - 3; i++) {
            uint256 tripletMin = Math.min(dailyPreviews[i], Math.min(dailyPreviews[i + 1], dailyPreviews[i + 2]));
            if (tripletMin > maxOfMins) {
                maxOfMins = tripletMin;
            }
        }
        return maxOfMins;
    }
}
