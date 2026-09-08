// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.27;

import "../interfaces/ItBase.sol";

contract LiquidityPoolMock {
    uint256 public totalPooledEther = 1000 ether;
    mapping(address => uint256) public shares;

    function amountForShare(uint256 _share) public pure returns (uint256) {
        return _share; // Simplified mock logic
    }

    function sharesForAmount(uint256 _amount) public pure returns (uint256) {
        return _amount; // Simplified mock logic
    }

    function getTotalPooledEther() external view returns (uint256) {
        return totalPooledEther;
    }

    function getTotalEtherClaimOf(address _user) external view returns (uint256) {
        return shares[_user]; // Simplified mock logic
    }

    function mintShares(address TETH, address user, uint256 _amount) external {
        ItBase(TETH).mintShares(user, _amount);
    }

    function burnShares(address TETH, address user, uint256 _amount) external {
        ItBase(TETH).burnShares(user, _amount);
    }
}
