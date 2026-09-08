// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IPendleRouter
/// @notice Interface for Pendle Router V3 functions
/// @dev Reference: https://github.com/pendle-finance/pendle-core-v2-public/blob/main/contracts/router/ActionMiscV3.sol
interface IPendleRouter {
    struct SwapData {
        SwapType swapType;
        address extRouter;
        bytes extCalldata;
        bool needScale;
    }

    enum SwapType {
        NONE,
        KYBERSWAP,
        ONE_INCH,
        ETH_WETH
    }

    struct TokenInput {
        address tokenIn;
        uint256 netTokenIn;
        address tokenMintSy;
        address pendleSwap;
        SwapData swapData;
    }

    struct TokenOutput {
        address tokenOut;
        uint256 minTokenOut;
        address tokenRedeemSy;
        address pendleSwap;
        SwapData swapData;
    }

    /// @notice Mints PY (PT+YT) tokens from a base token
    /// @dev For details on the parameters, please refer to IPAllActionTypeV3
    /// @param receiver Address to receive the minted PY tokens
    /// @param YT Address of the YT token
    /// @param minPyOut Minimum amount of PY to receive (slippage protection)
    /// @param input TokenInput struct with token details
    /// @return netPyOut Amount of PY tokens minted
    /// @return netSyInterm Intermediate SY tokens used
    function mintPyFromToken(address receiver, address YT, uint256 minPyOut, TokenInput calldata input) external payable returns (uint256 netPyOut, uint256 netSyInterm);

    /// @notice Redeems PY (PT+YT) tokens for the underlying token
    /// @param receiver Address to receive the redeemed tokens
    /// @param YT Address of the YT token
    /// @param netPyIn Amount of PY tokens to redeem
    /// @param output TokenOutput struct with redemption details
    /// @return netTokenOut Amount of tokens received
    /// @return netSyInterm Intermediate SY tokens
    function redeemPyToToken(address receiver, address YT, uint256 netPyIn, TokenOutput calldata output) external returns (uint256 netTokenOut, uint256 netSyInterm);
}
