// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title MockDepegPoolForOracle
 * @dev Minimal mock DepegPool for testing TapirOracle price writing
 */
contract MockDepegPoolForOracle {
    uint256 public lastHwmPrice;
    uint256 public lastClosingPrice;
    uint256 public updateCount;
    uint128 public maxPrice = type(uint128).max;

    function setMaxPrice(uint128 _maxPrice) external {
        maxPrice = _maxPrice;
    }

    function MAX_PRICE() external view returns (uint128) {
        return maxPrice;
    }

    /// @notice Mock implementation of updatePriceData
    /// @dev Stores the prices for later verification in tests
    function updatePriceData(uint256 hwmPrice, uint256 closingPrice) external {
        lastHwmPrice = hwmPrice;
        lastClosingPrice = closingPrice;
        updateCount++;
    }
}
