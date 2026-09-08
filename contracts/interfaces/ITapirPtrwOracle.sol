// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

import "./ITapirOracle.sol";

/// @title ITapirPtrwOracle
/// @notice Interface for TapirPtrwOracle
interface ITapirPtrwOracle is ITapirOracle {
    // ===== Structs =====

    /// @notice Configuration struct for Pendle-related addresses
    struct PendleConfig {
        address pendleBase; // Address of the base token (e.g., pufETH)
        address pendleRouter; // Address of the Pendle router contract
        address pendleYT; // Address of the Pendle YT (Yield Token) contract
        address pendlePT; // Address of the Pendle PT (Principal Token) contract
        uint256 errorTolerance; // Error tolerance before ERV/ARV delta is considered (in absolute units)
    }

    // ===== Events =====

    /// @notice Emitted when PTRW is resolved
    event PtrwResolved(uint256 arv);

    /// @notice Emitted when manual resolution is required due to zero ARV from Pendle redemption
    event MustResolveManually();

    // ===== Functions =====

    /// @notice Resolves PTRW by setting ERV and ARV values
    function resolvePtrw() external;

    /// @notice Manually resolves PTRW by setting ERV and ARV values (admin backup)
    /// @param _ptrwErv The expected redemption value
    /// @param _ptrwArv The actual redemption value
    function manualBackupResolvePtrw(uint256 _ptrwErv, uint256 _ptrwArv) external;

    // ===== Public State Variable Getters =====

    function ptrwResolved() external view returns (bool);
    function ptrwErv() external view returns (uint256);
    function ptrwArv() external view returns (uint256);
    function errorTolerance() external view returns (uint256);
    function pendleBase() external view returns (address);
    function pendleRouter() external view returns (address);
    function pendleYT() external view returns (address);
    function pendlePT() external view returns (address);
    function forceManualResolve() external view returns (bool);
    function PTRW_ACCURACY() external view returns (uint256);
}
