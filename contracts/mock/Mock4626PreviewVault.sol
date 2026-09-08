// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title Mock4626PreviewVault
/// @notice Minimal mock used by TapirVrpOracle tests
/// @dev Exposes only previewRedeem(uint256) required by the oracle
contract Mock4626PreviewVault {
    uint256 public previewPerShare; // 1e18 fixed-point

    constructor(uint256 initialPreviewPerShare) {
        previewPerShare = initialPreviewPerShare;
    }

    function setPreviewPerShare(uint256 newPreviewPerShare) external {
        previewPerShare = newPreviewPerShare;
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        return (shares * previewPerShare) / 1e18;
    }
}
