// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "../interfaces/IPendleRouter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockPendleRouter
/// @notice Mock Pendle Router for testnet testing of TapirPtrwOracle
/// @dev Simulates PT redemption by burning PT tokens and transferring base tokens
/// @dev The contract must hold sufficient base tokens before redemption is called
contract MockPendleRouter {
    /// @notice Address of the PT token this router can redeem
    address public ptToken;
    /// @notice Address of the YT token (for identification)
    address public ytToken;
    /// @notice Address of the base token to return on redemption
    address public baseToken;
    /// @notice Redemption rate (1e18 = 1:1, values below mean depeg)
    uint256 public redemptionRate;

    /// @notice Emitted when PT tokens are redeemed
    event MockRedemption(address indexed receiver, uint256 ptIn, uint256 baseOut);

    constructor(
        address _ptToken,
        address _ytToken,
        address _baseToken,
        uint256 _redemptionRate
    ) {
        ptToken = _ptToken;
        ytToken = _ytToken;
        baseToken = _baseToken;
        redemptionRate = _redemptionRate;
    }

    /// @notice Set the redemption rate (for testing different depeg scenarios)
    /// @param _rate New redemption rate (1e18 = 1:1)
    function setRedemptionRate(uint256 _rate) external {
        redemptionRate = _rate;
    }

    /// @notice Mock implementation of Pendle's redeemPyToToken
    /// @dev Burns PT tokens from sender and transfers base tokens to receiver
    /// @dev Requires this contract to have been pre-funded with base tokens
    function redeemPyToToken(
        address receiver,
        address YT,
        uint256 netPyIn,
        IPendleRouter.TokenOutput calldata /* output */
    ) external returns (uint256 netTokenOut, uint256 netSyInterm) {
        require(YT == ytToken, "MockPendleRouter: Invalid YT");
        
        // Transfer PT tokens from sender (the oracle contract)
        IERC20(ptToken).transferFrom(msg.sender, address(this), netPyIn);
        
        // Calculate output based on redemption rate
        netTokenOut = (netPyIn * redemptionRate) / 1e18;
        
        // Transfer base tokens to receiver
        if (netTokenOut > 0) {
            IERC20(baseToken).transfer(receiver, netTokenOut);
        }
        
        emit MockRedemption(receiver, netPyIn, netTokenOut);
        
        return (netTokenOut, netPyIn);
    }

    /// @notice Mock implementation for mintPyFromToken (for completeness)
    function mintPyFromToken(
        address /* receiver */,
        address /* YT */,
        uint256 /* minPyOut */,
        IPendleRouter.TokenInput calldata /* input */
    ) external payable returns (uint256, uint256) {
        // Not implemented for PTRW testing
        revert("MockPendleRouter: mintPyFromToken not implemented");
    }

    /// @notice Withdraw tokens from this contract (for test cleanup)
    function withdraw(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }
}
