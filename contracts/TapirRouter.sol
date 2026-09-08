// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

import {IDepegPool} from "./interfaces/IDepegPool.sol";
import {IV3SwapRouter} from "./interfaces/IV3SwapRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// DAY TO DAY INTERACTIONS
//
// Core interactions with the DepegPool
// split() --> Splits base into DP & YB equally
// unsplit() --> Un-splits DP & YB back into base
// redeem() --> Redeems DP & YB for base
//
// Interactions via UniV3 Pool
// splitAndBuy() --> Split and swaps base into either DP or YB via UniV3 (user gets just DP or YB)
// sellAndUnsplit() --> Sells DP or YB via UniV3 and un-splits back into base (user gets base)
// swapExactIn() --> Swaps either DP or YB via UniV3 into the opposite asset (DP into YB, YB into DP)

/// @title TapirRouter
/// @notice Implements day-to-day interactions with safety checks (slippage, deadline, etc.)
/// @notice Also provides a router method for interacting with the UniV3 Pool & Gamma
/// @notice Opionated such that msg.sender interacts with core; must ensure that msg.sender is the _counterparty
/// @dev Does not support ERC777 tokens or tokens with transfer hooks
contract TapirRouter {
    using SafeERC20 for IERC20;

    /// CUSTOM ERRORS
    ////////////////////
    error DeadlineExceeded();
    error InsufficientOutputAmount();

    // ===== CORE INTERACTIONS =====
    /////////////////////////////////

    /// @notice Splits the base asset into dpAsset and ybAsset equally.
    /// @dev The pool must be active to perform the split. The msg.sender must have approved base asset.
    /// @dev No slippage, deadline checks as there are no frontrunning conditions
    /// @param depegPoolAddress Address of the DepegPool contract.
    /// @param baseAmount Amount of base asset to split.
    function split(address depegPoolAddress, uint256 baseAmount) external {
        IDepegPool(depegPoolAddress).splitToken(msg.sender, baseAmount);
    }

    /// @notice Un-splits previously split dpAsset and ybAsset back into asset.
    /// @dev The pool must be active to perform the un-split. The msg.sender must have approved dpAsset and ybAsset.
    /// @dev No slippage, deadline checks as there are no frontrunning conditions
    /// @param depegPoolAddress Address of the DepegPool contract.
    /// @param depegAmount Amount of ybAsset and dpAsset to un-split (must be equal)
    function unsplit(address depegPoolAddress, uint256 depegAmount) external {
        IDepegPool(depegPoolAddress).unSplitTokens(msg.sender, depegAmount);
    }

    /// @notice Redeems dpAsset and ybAsset tokens for underlying base asset.
    /// @dev The pool must be active to perform the redemption. The msg.sender must have approved dpAsset and ybAsset.
    /// @dev No slippage, deadline checks as there are no frontrunning conditions
    /// @param depegPoolAddress Address of the DepegPool contract.
    /// @param dpAmount Amount of dpAsset to redeem.
    /// @param ybAmount Amount of ybAsset to redeem.
    function redeem(address depegPoolAddress, uint256 dpAmount, uint256 ybAmount) external {
        IDepegPool(depegPoolAddress).redeemTokens(msg.sender, dpAmount, ybAmount);
    }

    // ===== INTERACTIONS VIA UNI V3 POOL =====
    ////////////////////////////////////////////

    /// @notice Splits the base asset into dpAsset and ybAsset equally and buys given asset (DP/YB) via UniV3 Pool.
    /// @dev The pool must be active to perform the split. The msg.sender must have approved base asset to this router.
    /// @param depegPoolAddress Address of the DepegPool contract.
    /// @param uniV3SwapRouter Address of the UniV3 Swap Router contract (which trades YB/DP tokens of the DepegPool).
    /// @param uniV3Fee Fee tier of the UniV3 pool used, in pips.
    /// @param uniV3MinOut Minimum amount of asset to receive (DP/YB) from UniV3 swap.
    /// @param baseAmount Amount of base asset to split.
    /// @param buyingYb Whether to buy YB or DP (true if buying YB, false if buying DP)
    /// @param minOut Minimum total amount of asset to receive (DP/YB) at the end of the flow (swap+split).
    /// @param deadline Deadline for the transaction (last timestamp the transaction can be executed).
    function splitAndBuy(address depegPoolAddress, address uniV3SwapRouter, uint24 uniV3Fee, uint256 uniV3MinOut, uint256 baseAmount, bool buyingYb, uint256 minOut, uint256 deadline) external {
        // Checks
        if (block.timestamp > deadline) revert DeadlineExceeded();

        // Setup
        IDepegPool pool = IDepegPool(depegPoolAddress);
        address baseAsset = address(pool.ASSET());
        address tokenIn = buyingYb ? address(pool.DP_ASSET()) : address(pool.YB_ASSET()); // Swap
        address tokenOut = buyingYb ? address(pool.YB_ASSET()) : address(pool.DP_ASSET()); // Swap

        // Step 1: Pull base tokens from user to router
        IERC20(baseAsset).safeTransferFrom(msg.sender, address(this), baseAmount);

        // Step 2: Approve DepegPool to spend base tokens
        IERC20(baseAsset).safeIncreaseAllowance(depegPoolAddress, baseAmount);

        // Step 3: Split base asset into dpAsset and ybAsset equally (minted to this router)
        pool.splitToken(address(this), baseAmount);

        // Step 4: Execute swap through UniV3
        // Passing baseAmount / 2 as amountIn because user received YB=DP=base/2 (sells all of the token we don't want)
        uint256 swapOut = _approveAndSwapExactIn(tokenIn, tokenOut, uniV3SwapRouter, uniV3Fee, baseAmount / 2, uniV3MinOut);

        // Step 5: Check user will receive minOut (swapOut + (baseAmount / 2) from split)
        uint256 actualOut = swapOut + (baseAmount / 2);
        if (actualOut < minOut) revert InsufficientOutputAmount();

        // Step 6: Transfer tokenOut to user
        IERC20(tokenOut).safeTransfer(msg.sender, actualOut);
    }

    /// @notice Sells DP or YB via UniV3 and un-splits back into base.
    /// @dev The pool must be active to perform the un-split. The msg.sender must have approved dpAsset and ybAsset to this router.
    /// @dev The min amounts should be accurately calculated by the caller; any excess DP/YB are returned back to caller.
    /// @param depegPoolAddress Address of the DepegPool contract.
    /// @param uniV3SwapRouter Address of the UniV3 Swap Router contract (which trades YB/DP tokens of the DepegPool).
    /// @param uniV3Fee Fee tier of the UniV3 pool used, in pips.
    /// @param uniV3MinOut Minimum amount of DP/YB asset to receive from UniV3 swap.
    /// @param amountIn Total amount of DP/YB asset to pull from user.
    /// @param amountInForSwap Amount of the input token to swap via UniV3 (remainder is kept for unsplit).
    /// @param sellingYb Whether to sell YB or DP (true if selling YB, false if selling DP).
    /// @param minOut Minimum total amount of base asset to receive at the end of the flow (swap+un-split).
    /// @param deadline Deadline for the transaction (last timestamp the transaction can be executed).
    function sellAndUnsplit(address depegPoolAddress, address uniV3SwapRouter, uint24 uniV3Fee, uint256 uniV3MinOut, uint256 amountIn, uint256 amountInForSwap, bool sellingYb, uint256 minOut, uint256 deadline) external {
        // Checks
        if (block.timestamp > deadline) revert DeadlineExceeded();

        // Setup
        IDepegPool pool = IDepegPool(depegPoolAddress);
        address baseAsset = address(pool.ASSET());
        address dpAsset = address(pool.DP_ASSET());
        address ybAsset = address(pool.YB_ASSET());
        address tokenIn = sellingYb ? ybAsset : dpAsset; // Swap
        address tokenOut = sellingYb ? dpAsset : ybAsset; // Swap

        // Step 1: Pull DP/YB tokens from user to router
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Step 2: Execute swap via UniV3 (swap only amountInForSwap, keep the rest for unsplit)
        _approveAndSwapExactIn(tokenIn, tokenOut, uniV3SwapRouter, uniV3Fee, amountInForSwap, uniV3MinOut);

        // Step 3: Calculate unsplit amount (minimum of both token balances)
        uint256 dpBalance = IERC20(dpAsset).balanceOf(address(this));
        uint256 ybBalance = IERC20(ybAsset).balanceOf(address(this));
        uint256 unsplitAmount = dpBalance < ybBalance ? dpBalance : ybBalance;

        // Step 4: Approve DP & YB and un-split back into base
        IERC20(dpAsset).safeIncreaseAllowance(depegPoolAddress, unsplitAmount);
        IERC20(ybAsset).safeIncreaseAllowance(depegPoolAddress, unsplitAmount);
        pool.unSplitTokens(address(this), unsplitAmount);

        // Step 5: Check user will receive minOut
        uint256 actualOut = IERC20(baseAsset).balanceOf(address(this));
        if (actualOut < minOut) revert InsufficientOutputAmount();

        // Step 6: Transfer base to user
        IERC20(baseAsset).safeTransfer(msg.sender, actualOut);

        // Step 7: Transfer any excess DP/YB tokens back to user
        uint256 remainingDp = IERC20(dpAsset).balanceOf(address(this));
        uint256 remainingYb = IERC20(ybAsset).balanceOf(address(this));
        if (remainingDp > 0) {
            IERC20(dpAsset).safeTransfer(msg.sender, remainingDp);
        }
        if (remainingYb > 0) {
            IERC20(ybAsset).safeTransfer(msg.sender, remainingYb);
        }
    }

    // There is no "sellAndRedeem" function as the redemption can take any ratio of tokens (call redeem() directly instead)

    /// @notice Swaps either DP or YB via UniV3 into the opposite asset (DP into YB, YB into DP).
    /// @param depegPoolAddress Address of the DepegPool contract.
    /// @param uniV3SwapRouter Address of the UniV3 Swap Router contract (which trades YB/DP tokens of the DepegPool).
    /// @param uniV3Fee Fee tier of the UniV3 pool used, in pips.
    /// @param uniV3MinOut Minimum amount of asset to receive (DP/YB) from UniV3 swap.
    /// @param amountIn Amount of DP/YB token to swap.
    /// @param buyingYb Whether to swap DP into YB or YB into DP (true if swapping DP into YB, false if swapping YB into DP).
    /// @param deadline Deadline for the transaction (last timestamp the transaction can be executed).
    function swapExactIn(address depegPoolAddress, address uniV3SwapRouter, uint24 uniV3Fee, uint256 uniV3MinOut, uint256 amountIn, bool buyingYb, uint256 deadline) external {
        // Checks
        if (block.timestamp > deadline) revert DeadlineExceeded();

        // Setup
        IDepegPool pool = IDepegPool(depegPoolAddress);
        address dpAsset = address(pool.DP_ASSET());
        address ybAsset = address(pool.YB_ASSET());
        address tokenIn = buyingYb ? dpAsset : ybAsset; // Swap
        address tokenOut = buyingYb ? ybAsset : dpAsset; // Swap

        // Step 1: Pull DP/YB tokens from user to router
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Step 2: Execute swap via UniV3
        uint256 amountOut = _approveAndSwapExactIn(tokenIn, tokenOut, uniV3SwapRouter, uniV3Fee, amountIn, uniV3MinOut);

        // No need to check user will receive minOut as the check is already done in the _approveAndSwapExactIn function (via uniV3MinOut)

        // Step 3: Transfer tokenOut to user
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }

    // ===== INTERNAL HELPER FUNCTIONS =====
    ////////////////////////////////////////

    /// @notice Swaps either DP or YB via UniV3 into the opposite asset (DP into YB, YB into DP).
    /// @param tokenIn Address of the token to swap from.
    /// @param tokenOut Address of the token to swap to.
    /// @param uniV3SwapRouter Address of the UniV3 Swap Router contract (which trades YB/DP tokens of the DepegPool).
    /// @param uniV3Fee Fee tier of the UniV3 pool used, in pips.
    /// @param amountIn Amount of token to swap.
    /// @param uniV3MinOut Minimum amount of asset to receive (DP/YB) from UniV3 swap.
    /// @return amountOut The amount of tokenOut received from the swap.
    function _approveAndSwapExactIn(address tokenIn, address tokenOut, address uniV3SwapRouter, uint24 uniV3Fee, uint256 amountIn, uint256 uniV3MinOut) internal returns (uint256 amountOut) {
        IERC20(tokenIn).safeIncreaseAllowance(uniV3SwapRouter, amountIn);
        amountOut = IV3SwapRouter(uniV3SwapRouter).exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: uniV3Fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: uniV3MinOut,
                sqrtPriceLimitX96: 0 // No limit as minimum output is already specified
            })
        );
    }
}
