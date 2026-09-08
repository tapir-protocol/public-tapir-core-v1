// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IOnchainTwapOracle {
    function latestTwap1e18() external view returns (uint256 price1e18, uint256 updatedAt, uint256 liquidityUsd1e18);
}

contract AMMTwapMock is IOnchainTwapOracle {
    uint256 private price1e18 = 1e18; // default 1:1 price
    uint256 private updatedAt = block.timestamp;
    uint256 private liquidityUsd1e18 = 5_000_000e18; // default 5M USD liquidity

    function setPrice(uint256 _price, uint256 _timestamp) external {
        price1e18 = _price;
        updatedAt = _timestamp;
    }

    function setLiquidity(uint256 _liquidity) external {
        liquidityUsd1e18 = _liquidity;
    }

    function latestTwap1e18() external view override returns (uint256, uint256, uint256) {
        return (price1e18, updatedAt, liquidityUsd1e18);
    }
}
