// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "../libraries/TimeDecay.sol";

/// @title TimeDecayTest
/// @notice Test wrapper contract to expose TimeDecay library functions
/// @dev This contract is only used for testing purposes
contract TimeDecayTest {
    using TimeDecay for *;

    /// @notice Exposes calculateDecay for testing
    function calculateDecay(uint256 totalDuration, uint256 elapsedTime) external pure returns (uint256) {
        return TimeDecay.calculateDecay(totalDuration, elapsedTime);
    }

    /// @notice Exposes calculateDecayDiff for testing
    function calculateDecayDiff(uint256 totalDuration, uint256 elapsedTime1, uint256 elapsedTime2) external pure returns (int256) {
        return TimeDecay.calculateDecayDiff(totalDuration, elapsedTime1, elapsedTime2);
    }
}
