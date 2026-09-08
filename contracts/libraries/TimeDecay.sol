// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/utils/math/Math.sol";

/// @title TimeDecay
/// @notice This library provides functionality for calculating time-based decay factors
/// @dev This library assumes a maximum duration of 365 days (31,536,000 seconds)
/// @dev N.B. All functions are internal and pure
library TimeDecay {
    /// CUSTOM ERRORS
    ////////////////////
    error TotalDurationMustBeGreaterThanZero();
    error ElapsedTimeExceedsTotalDuration();

    /// @dev Precision for fixed-point math
    uint256 private constant PRECISION = 1e18;

    /// @dev Minimum decay factor (5% = 0.05 * 1e18)
    uint256 private constant MIN_DECAY = 5e16; // 0.05 in 18 decimals

    /// @notice Calculate the time decay factor: d(t) = sqrt((T - t) / T)
    /// @dev Returns a value between MIN_DECAY and 1e18 (representing 0.05 to 1.0)
    /// @param totalDuration T - The total duration in seconds (e.g., poolActiveDuration)
    /// @param elapsedTime t - The time that has passed in seconds (e.g., block.timestamp - startTime)
    /// @return decayFactor The calculated decay factor scaled by 1e18
    function calculateDecay(uint256 totalDuration, uint256 elapsedTime) internal pure returns (uint256 decayFactor) {
        if (totalDuration == 0) revert TotalDurationMustBeGreaterThanZero();
        if (elapsedTime > totalDuration) revert ElapsedTimeExceedsTotalDuration();

        // Calculate (T - t) / T scaled by PRECISION^2 for proper sqrt scaling
        // Mathematical equivalence:
        //   sqrt(ratio * PRECISION^2) = sqrt(ratio) * sqrt(PRECISION^2)
        //                             = sqrt(ratio) * PRECISION
        // This ensures the result is scaled by PRECISION (1e18) after taking sqrt
        // Note: sqrt(1e36) = 1e18, NOT sqrt(1e18) = 1e9
        uint256 remainingRatio = ((totalDuration - elapsedTime) * PRECISION * PRECISION) / totalDuration;

        // Calculate sqrt(remainingRatio) using OpenZeppelin's Math library
        // Result is properly scaled to 1e18 (PRECISION) due to PRECISION^2 multiplication above
        uint256 sqrtRatio = Math.sqrt(remainingRatio); // N.B.! Non-perfect squares are rounded down

        // Apply minimum threshold
        if (sqrtRatio < MIN_DECAY) {
            return MIN_DECAY;
        }

        return sqrtRatio;
    }

    /// @notice Calculate the change in decay factor between two time points
    /// @dev Useful for computing the difference between last rebalance and current time
    /// @param totalDuration T - The total duration in seconds
    /// @param elapsedTime1 t1 - The first time point in seconds (e.g., time since last rebalance)
    /// @param elapsedTime2 t2 - The second time point in seconds (e.g., current time elapsed)
    /// @return decayDiff The difference in decay factors (d(t1) - d(t2))
    function calculateDecayDiff(uint256 totalDuration, uint256 elapsedTime1, uint256 elapsedTime2) internal pure returns (int256 decayDiff) {
        uint256 decay1 = calculateDecay(totalDuration, elapsedTime1);
        uint256 decay2 = calculateDecay(totalDuration, elapsedTime2);

        return int256(decay1) - int256(decay2);
    }
}
