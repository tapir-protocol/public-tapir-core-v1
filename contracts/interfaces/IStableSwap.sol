// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

interface IStableSwap {
    function swap(uint256 i, uint256 j, uint256 dx, uint256 minDy) external returns (uint256 dy);
}
