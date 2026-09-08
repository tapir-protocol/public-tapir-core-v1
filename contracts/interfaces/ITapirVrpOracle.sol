// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

import "./ITapirOracle.sol";

// Terminology
// VRP = Vault Redeem Preview: this oracle type which uses preview function to determine vault share price
// PRV = Preview Redemption Value: the value the preview function returns for a redemption
// HWM = High-Watermark: robust PRV watermark derived from daily triplets over VRP observations

/// @title ITapirVrpOracle
/// @notice Interface for TapirVrpOracle (Vault Redeem Preview)
/// @dev In the context of Zircuit vaults, the oracle must be deployed on the accounting chain
interface ITapirVrpOracle is ITapirOracle {
    // ===== Structs =====

    /// @notice Configuration struct for Vault-related parameters
    struct VaultConfig {
        address vault; // Address of the ERC-4626 vault
        uint256 witnessShares; // Share amount used for convertToAssets / previewRedeem (must be > 0)
        uint256 errorTolerance; // Error tolerance before HWM/PRV delta is considered (in absolute units)
    }

    // ===== Events =====

    /// @notice Emitted when VRP is resolved
    event VrpResolved(uint256 prv);

    /// @notice Emitted when manual resolution is required due to zero PRV from previewRedeem
    event MustResolveManually();

    // ===== Functions =====

    /// @notice Resolves VRP by sampling current PRV
    function resolveVrp() external;

    /// @notice Manually resolves VRP by setting PRV value (admin backup)
    /// @param _vrpPrv The preview redemption value
    function manualBackupResolveVrp(uint256 _vrpPrv) external;

    // ===== Public State Variable Getters =====

    function vrpResolved() external view returns (bool);
    function vrpPrv() external view returns (uint256);
    function vrpHwm() external view returns (uint256);
    function errorTolerance() external view returns (uint256);
    function vault() external view returns (address);
    function witnessShares() external view returns (uint256);
    function forceManualResolve() external view returns (bool);
}
