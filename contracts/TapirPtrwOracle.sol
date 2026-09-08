// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

import "./TapirOracle.sol";
import "./interfaces/ITapirPtrwOracle.sol";
import "./interfaces/IPendleRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Minimal interface for Pendle PT token expiry check
interface IPendlePT {
    function isExpired() external view returns (bool);
}

// Lifecycle (refer to TapirOracle for other functions):
// 1. TapirPtrwOracle is deployed
// 2. Some actor purchases PT tokens and sends them to the contract (address(this))
//    This MUST be done before the PT maturity date
//    There is no function that needs to be called in this contract; just a transfer to the contract
//    IMPORTANT: the amount of PT deposited into the contract should be greater than some safe amount to avoid fee distortions/edge cases
// 3. Checkpointing works as normal
// 4. After the PT maturity date, anyone can call the resolvePtrw() function to redeem the PT tokens for base tokens
//    This will set the PTRW values and emit the PtrwResolved event
// 5. Now the writePriceData() can be called, which will use the PTRW values to adjust the closing price

/// @title TapirPtrwOracle
/// @notice Extension of TapirOracle with Pendle PT (Principal Token) Redemption Witness (PTRW) functionality
/// @dev Inherits all TapirOracle functionality and adds PTRW-specific features
contract TapirPtrwOracle is TapirOracle, ITapirPtrwOracle {
    /// CUSTOM ERRORS
    ////////////////////
    error PtrwNotResolved();
    error PtrwAlreadyResolved();
    error InvalidPtrwValues();
    error PtBalanceNotZero();
    error MarketNotExpired();
    error ManualResolveRequired();

    /// VARIABLES
    ////////////////////

    bool public ptrwResolved; // Flag indicating whether PT has been redeemed
    uint256 public ptrwErv; // Expected Redemption Value for PTRW (acquisition value)
    uint256 public ptrwArv; // Actual Redemption Value for PTRW (redemption value)
    uint256 public immutable errorTolerance; // Error tolerance before ERV/ARV delta is considered (epsilon) – ABSOLUTE UNITS!
    uint256 public constant PTRW_ACCURACY = 10000; // Accuracy of PTRW calculations

    address public immutable pendleBase; // Address of the Pendle base token @dev N.B! Must be standard ERC20 (no FoT, return true on transfer...)
    address public immutable pendleRouter; // Address of the Pendle router contract
    address public immutable pendleYT; // Address of the Pendle YT (Yield Token) contract
    address public immutable pendlePT; // Address of the Pendle PT (Principal Token) contract

    bool public forceManualResolve; // Flag indicating whether to force manual resolution if ARV is zero

    /// CONSTRUCTOR
    ////////////////////

    constructor(string memory _assetSymbol, address _asset, uint8 _assetDecimals, ITapirOracle.Sources memory sources_, ITapirOracle.Config memory cfg_, address admin, ITapirPtrwOracle.PendleConfig memory pendleConfig_) TapirOracle(_assetSymbol, _asset, _assetDecimals, sources_, cfg_, admin) {
        if (pendleConfig_.pendleBase == address(0)) revert InvalidAddress();
        if (pendleConfig_.pendleRouter == address(0)) revert InvalidAddress();
        if (pendleConfig_.pendlePT == address(0)) revert InvalidAddress();
        if (pendleConfig_.pendleYT == address(0)) revert InvalidAddress();

        pendleBase = pendleConfig_.pendleBase;
        pendleRouter = pendleConfig_.pendleRouter;
        pendleYT = pendleConfig_.pendleYT;
        pendlePT = pendleConfig_.pendlePT;
        errorTolerance = pendleConfig_.errorTolerance;
    }

    /// @notice Resolves PTRW by setting ERV and ARV values
    /// @dev Can only be called after initialization and once
    /// @dev This function should be called AFTER PT maturity to finalize PTRW values
    /// @dev Safe to call because it requires Pendle redemptions state
    /// @dev Pays out any remaining PT & Base to caller as a tip
    /// @dev Only callable by operator role
    function resolvePtrw() external whenNotPaused onlyRole(OPERATOR_ROLE) {
        if (forceManualResolve) revert ManualResolveRequired();

        // Check that PT has passed maturity date (using PT's isExpired() directly)
        if (!IPendlePT(pendlePT).isExpired()) revert MarketNotExpired();

        // First, let's check the amount of PT tokens in the contract
        // We can also set ptrwErv in the same call as the expected redemption value is 1:1 with the amount of PT tokens
        ptrwErv = IERC20(pendlePT).balanceOf(address(this));
        if (ptrwErv == 0) revert InvalidPtrwValues(); // Getting balance failed or no PT tokens were deposited

        // Redeem PT for base to determine ARV (Actual Redemption Value)
        // Uses Pendle's redeemPyToToken which:
        //   1. Burns PT (post-expiry only PT needed)
        //   2. Redeems SY tokens
        //   3. Converts SY back to base token
        // Reference: https://docs.pendle.finance/pendle-v2/Developers/Contracts/PendleRouter/PendleRouterOverview
        // Note: Post-expiry, YT is worthless and NOT required for redemption

        // Approve router to spend PT tokens
        IERC20(pendlePT).approve(pendleRouter, ptrwErv);

        // Create TokenOutput struct for redemption (no aggregator swap needed)
        // When tokenOut == tokenRedeemSy, no external swap is performed
        IPendleRouter.TokenOutput memory output = IPendleRouter.TokenOutput({
            tokenOut: pendleBase,
            minTokenOut: 0, // No slippage protection
            tokenRedeemSy: pendleBase, // Base token is directly redeemable from SY
            pendleSwap: address(0), // No aggregator swap needed
            swapData: IPendleRouter.SwapData({swapType: IPendleRouter.SwapType.NONE, extRouter: address(0), extCalldata: "", needScale: false})
        });

        // Redeem PT tokens to get base token back
        // Post-expiry: PT alone can be redeemed
        (uint256 netTokenOut, ) = IPendleRouter(pendleRouter).redeemPyToToken(
            address(this), // Receive tokens in this contract
            pendleYT, // YT address identifies the market
            ptrwErv,
            output
        );

        // Actual Redemption Value is the amount of base received
        ptrwArv = netTokenOut;

        // Transfer any received Base to caller as a tip
        uint256 baseBalance = IERC20(pendleBase).balanceOf(address(this));
        if (baseBalance > 0) {
            IERC20(pendleBase).transfer(msg.sender, baseBalance);
        }

        if (ptrwArv == 0) {
            // Dev: use manualBackupResolvePtrw() if ARV is zero
            forceManualResolve = true;
            emit MustResolveManually();
            return; // Return before ptrwResolved is set to true outside this conditional block
        }
        ptrwResolved = true;

        emit PtrwResolved(ptrwArv);
    }

    /// @notice Manually resolves PTRW by setting ERV and ARV values
    /// @dev Can only be called by admin
    /// @dev This is a backup function to resolve PTRW if the resolvePtrw() function fails (e.g. PT was not deposited)
    function manualBackupResolvePtrw(uint256 _ptrwErv, uint256 _ptrwArv) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!forceManualResolve) {
            if (ptrwResolved) revert PtrwAlreadyResolved();
            if (IERC20(pendlePT).balanceOf(address(this)) > 0) revert PtBalanceNotZero();
        } // else forceManualResolve is true, so we don't need to check these conditions

        if (_ptrwErv == 0) revert InvalidPtrwValues(); // Division by zero

        // Check that PT has passed maturity date (using PT's isExpired() directly)
        if (!IPendlePT(pendlePT).isExpired()) revert MarketNotExpired();

        ptrwErv = _ptrwErv;
        ptrwArv = _ptrwArv;
        ptrwResolved = true;

        emit PtrwResolved(ptrwArv);
    }

    /// @notice Resets the forceManualResolve flag
    /// @dev Only callable by admin
    function resetForceManualResolve() external onlyRole(DEFAULT_ADMIN_ROLE) {
        forceManualResolve = false;
    }

    /// @notice Writes the price data (HWM & Closing) to the DepegPool
    /// @dev Overrides TapirOracle.writePriceData() to add PTRW validation checks & adjusts closing price
    /// @dev Only callable by operator role
    /// @dev Requires PTRW to be both initialized and resolved, with valid ERV and ARV
    /// @dev Uses the maximum of the lifetime persisted HWM or the current buffer candidate
    /// @dev Multiplies closingPrice by ptrwDepeg factor before forwarding to DepegPool
    function writePriceData(uint32 _gaslimit) public payable override whenNotPaused onlyRole(OPERATOR_ROLE) {
        if (!ptrwResolved) revert PtrwNotResolved();

        // Calculate PTRW depeg factor (accounting for error tolerance)
        uint256 ptrwDepeg;
        if (ptrwArv + errorTolerance < ptrwErv) {
            ptrwDepeg = ((ptrwArv + errorTolerance) * PTRW_ACCURACY) / ptrwErv;
        } else {
            ptrwDepeg = PTRW_ACCURACY;
        }

        // Get the regular oracle prices using internal functions from parent
        uint256 hwmPrice = Math.max(persistedHwm, _highWatermarkPrice());
        if (hwmPrice == 0) revert InsufficientCheckpointsForHWM();
        uint16 requestedCount = _getRecentCheckpointCount();
        uint256 closingPrice = _medianOfLastEligibleCheckpoints(requestedCount);

        // Apply PTRW adjustment to closing price
        uint256 adjustedClosingPrice = ((closingPrice * ptrwDepeg) / PTRW_ACCURACY);

        // Use parent's helper function to send to DepegPool
        _sendPriceDataToDepegPool(hwmPrice, adjustedClosingPrice, _gaslimit);
    }
}
