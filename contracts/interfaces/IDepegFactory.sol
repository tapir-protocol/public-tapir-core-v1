// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

import {IDepegPool} from "./IDepegPool.sol";

// @dev DepegFactory is also Ownable (by multisig)
interface IDepegFactory {
    // ===== Structs =====

    struct Depeg {
        address dpAsset;
        address ybAsset;
        address depegPool;
    }

    // ===== Events =====

    event DeployDepeg(address indexed dpAsset, address indexed ybAsset, address indexed depegPool, uint256 poolActiveDuration);

    // ===== Functions =====

    function getDepegModule(uint256 index) external view returns (Depeg memory);

    /// @notice Deploys a new DepegPool contract
    /// @param _params DepegPoolParams struct containing all deployment parameters
    function deployDepeg(IDepegPool.DepegPoolParams calldata _params) external;
}
