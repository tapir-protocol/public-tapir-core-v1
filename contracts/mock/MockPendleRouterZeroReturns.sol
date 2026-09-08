// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "../interfaces/IPendleRouter.sol";

/// @title MockPendleRouterZeroReturns
/// @notice Mock Pendle Router that returns 0 tokens for testing TAP-3 fix
/// @dev Used to simulate the scenario where PT redemption returns 0 ARV
contract MockPendleRouterZeroReturns {
    /// @notice Mock implementation that always returns 0 tokens
    /// @dev This simulates a failed redemption scenario
    function redeemPyToToken(
        address /* receiver */,
        address /* YT */,
        uint256 /* netPyIn */,
        IPendleRouter.TokenOutput calldata /* output */
    ) external pure returns (uint256 netTokenOut, uint256 netSyInterm) {
        // Return 0 tokens to simulate a failed redemption
        return (0, 0);
    }

    /// @notice Mock implementation for mintPyFromToken (not used in this test)
    function mintPyFromToken(
        address /* receiver */,
        address /* YT */,
        uint256 /* minPyOut */,
        IPendleRouter.TokenInput calldata /* input */
    ) external payable returns (uint256 netPyOut, uint256 netSyInterm) {
        return (0, 0);
    }
}
