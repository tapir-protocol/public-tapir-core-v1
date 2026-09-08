// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

contract MockVaultPT is ERC20, IERC4626 {
    address public asset_;
    uint256 public redemptionRate = 1e18; // 1:1
    bool public isExpired;

    constructor(address _asset, string memory name, string memory symbol) ERC20(name, symbol) {
        asset_ = _asset;
    }

    function setRedemptionRate(uint256 _rate) external {
        redemptionRate = _rate;
    }

    function setExpired(bool _expired) external {
        isExpired = _expired;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // IERC4626 standard implementation
    function asset() external view returns (address) {
        return asset_;
    }

    function totalAssets() external view returns (uint256) {
        return totalSupply() * redemptionRate / 1e18;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return assets * 1e18 / redemptionRate;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return shares * redemptionRate / 1e18;
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxMint(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        return convertToAssets(balanceOf(owner));
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf(owner);
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        return convertToShares(assets);
    }

    function previewMint(uint256 shares) external view returns (uint256) {
        return convertToAssets(shares);
    }

    function previewWithdraw(uint256 assets) external view returns (uint256) {
        return convertToShares(assets);
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        return convertToAssets(shares);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        uint256 shares = convertToShares(assets);
        _mint(receiver, shares);
        return shares;
    }

    function mint(uint256 shares, address receiver) external returns (uint256) {
        _mint(receiver, shares);
        return convertToAssets(shares);
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256) {
        uint256 shares = convertToShares(assets);
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        return shares;
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256) {
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        return convertToAssets(shares);
    }
}
