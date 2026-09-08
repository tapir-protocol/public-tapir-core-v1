// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "../interfaces/ITapirOracle.sol";
import "../interfaces/IDepegPool.sol";

/**
 * @title SimpleMockOracle
 * @dev Minimal mock oracle for testing DepegPool
 * @dev Includes function to push price data to pool for resolution testing
 */
contract SimpleMockOracle {
    uint256 public price;
    uint256 public timestamp;
    address public depegPool;

    constructor() {
        price = 1e18;
        timestamp = block.timestamp;
    }

    function cfg() external view returns (ITapirOracle.Config memory) {
        return ITapirOracle.Config({minCheckpointSpacing: 86400, minValidSources: 2, closingPriceLookbackPeriod: 86400, depegPool: depegPool, xChainMode: false, xDomainMessengerL1: address(0)});
    }

    function setDepegPool(address _depegPool) external {
        depegPool = _depegPool;
    }

    function latestMedian() external view returns (uint256, uint256) {
        return (price, timestamp);
    }

    function setPrice(uint256 _price) external {
        price = _price;
        timestamp = block.timestamp;
    }

    function setTimestamp(uint256 _timestamp) external {
        timestamp = _timestamp;
    }

    /**
     * @notice Push price data to the DepegPool for resolution
     * @dev This allows the mock oracle to trigger pool resolution in testnet
     * @param _hwmPrice High water mark price during the pool's active period
     * @param _resolutionPrice Final/closing price at maturity
     */
    function pushPriceDataToPool(uint256 _hwmPrice, uint256 _resolutionPrice) external {
        require(depegPool != address(0), "SimpleMockOracle: depegPool not set");
        IDepegPool(depegPool).updatePriceData(_hwmPrice, _resolutionPrice);
    }

    // Allow contract to receive ETH (needed for impersonation testing)
    receive() external payable {}
}
