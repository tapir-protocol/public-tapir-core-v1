// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAggregatorV3 {
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals() external view returns (uint8);
}

contract ChainlinkMock is IAggregatorV3 {
    uint80 private roundId;
    int256 private answer;
    uint256 private startedAt;
    uint256 private updatedAt;
    uint80 private answeredInRound;
    uint8 private _decimals;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
        roundId = 1;
        answer = int256(1e18); // default 1:1 price
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
        answeredInRound = 1;
    }

    function setPrice(int256 _price, uint256 _timestamp) external {
        roundId++;
        answer = _price;
        startedAt = _timestamp;
        updatedAt = _timestamp;
        answeredInRound = roundId;
    }

    function setUpdatedAt(uint256 _timestamp) external {
        updatedAt = _timestamp;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }

    function decimals() external view override returns (uint8) {
        return _decimals;
    }
}
