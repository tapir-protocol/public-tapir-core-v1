// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IV3SwapRouter} from "../interfaces/IV3SwapRouter.sol";

/// @dev Test-only swap fixture: funded inventory, configurable rate and pause state.
contract RouterSwapMock {
    uint256 public rate = 1e18;
    bool public paused;

    function setRate(uint256 value) external {
        rate = value;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function exactInputSingle(IV3SwapRouter.ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        require(!paused, "PAUSED");
        amountOut = (params.amountIn * rate) / 1e18;
        require(amountOut >= params.amountOutMinimum, "SLIPPAGE");
        require(IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn));
        require(IERC20(params.tokenOut).transfer(params.recipient, amountOut));
    }
}
