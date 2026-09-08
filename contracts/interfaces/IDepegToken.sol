// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IDepegToken
 * @dev Interface for both DP and YB tokens (unified from IDPasset and IYBasset).
 */

interface IDepegToken is IERC20 {
    function mint(address _account, uint256 _value) external;
    function burn(address _account, uint256 _value) external;
    function depegPool() external view returns (address);
    function decimals() external view returns (uint8);
}
