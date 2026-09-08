// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title ChainlinkAggregatorMock
 * @dev Mock implementation of Chainlink AggregatorV3 for testing
 */
contract ChainlinkAggregatorMock {
    int256 private _answer;
    uint256 private _updatedAt;
    uint8 private _decimals;

    constructor(int256 initialAnswer, uint256 initialUpdatedAt, uint8 decimals_) {
        _answer = initialAnswer;
        _updatedAt = initialUpdatedAt;
        _decimals = decimals_;
    }

    /// @notice Returns the latest round data
    /// @dev Mimics the Chainlink AggregatorV3 interface
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
        return (1, _answer, _updatedAt, _updatedAt, 1);
    }

    /// @notice Returns the number of decimals
    function decimals() external view returns (uint8) {
        return _decimals;
    }

    /// @notice Updates the mock answer
    /// @param newAnswer The new price answer
    function setAnswer(int256 newAnswer) external {
        _answer = newAnswer;
    }

    /// @notice Updates the mock timestamp
    /// @param newUpdatedAt The new timestamp
    function setUpdatedAt(uint256 newUpdatedAt) external {
        _updatedAt = newUpdatedAt;
    }

    /// @notice Updates both answer and timestamp
    /// @param newAnswer The new price answer
    /// @param newUpdatedAt The new timestamp
    function setData(int256 newAnswer, uint256 newUpdatedAt) external {
        _answer = newAnswer;
        _updatedAt = newUpdatedAt;
    }
}
