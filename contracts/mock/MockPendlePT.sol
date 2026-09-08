// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockPendlePT
/// @notice Mock Pendle PT token for testing
/// @dev Implements ERC20 with isExpired() check for TAP-3 test
contract MockPendlePT is ERC20 {
    bool private _isExpired;

    constructor(bool expired_) ERC20("Mock PT", "MPT") {
        _isExpired = expired_;
    }

    /// @notice Returns whether the PT is expired
    function isExpired() external view returns (bool) {
        return _isExpired;
    }

    /// @notice Mint tokens (for testing)
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Set expired state (for testing)
    function setExpired(bool expired_) external {
        _isExpired = expired_;
    }
}
