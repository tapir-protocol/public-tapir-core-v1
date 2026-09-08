// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ICurvePool {
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
    function get_virtual_price() external view returns (uint256);
    function coins(uint256 i) external view returns (address);
}

contract CurvePoolMock is ICurvePool {
    uint256 public exchangeRate = 1e18; // 1 weETH = 1 ETH (normalized)
    uint256 public virtualPrice = 1e18;
    address public coin0 = address(0x1);
    address public coin1 = address(0x2);

    function setExchangeRate(uint256 _rate) external {
        exchangeRate = _rate;
    }

    function setVirtualPrice(uint256 _price) external {
        virtualPrice = _price;
    }

    function get_dy(int128 /* i */, int128 /* j */, uint256 dx) external view override returns (uint256) {
        // Return exchangeRate normalized to 1e18
        // dx is input amount in 1e18, output should be in 1e18
        return (dx * exchangeRate) / 1e18;
    }

    function get_virtual_price() external view override returns (uint256) {
        return virtualPrice;
    }

    function coins(uint256 i) external view override returns (address) {
        if (i == 0) return coin0;
        if (i == 1) return coin1;
        revert("Invalid coin index");
    }
}
