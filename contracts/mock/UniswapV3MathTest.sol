// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {UniswapV3Math} from "../libraries/UniswapV3Math.sol";

contract UniswapV3MathTest {
    function mulDiv(uint256 a, uint256 b, uint256 denominator) external pure returns (uint256) {
        return UniswapV3Math.mulDiv(a, b, denominator);
    }
}
