// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/Ownable.sol";
import {DepegPool} from "./DepegPool.sol";
import {IDepegFactory} from "./interfaces/IDepegFactory.sol";
import {IDepegPool} from "./interfaces/IDepegPool.sol";

contract DepegFactory is Ownable, IDepegFactory {
    /// CUSTOM ERRORS
    ////////////////////
    error InvalidAssetAddress(address provided);
    error AssetNotAContract(address provided);
    error InvalidOracleAddress(address provided);
    error OracleNotAContract(address provided);
    error NameRequired(string tokenType);
    error SymbolRequired(string tokenType);
    error MinPriceMustBeGreaterThanZero(uint128 provided);
    error MaxPriceMustBeGreaterThanMinPrice(uint128 maxPrice, uint128 minPrice);
    error InvalidTreasuryAddress(address provided);
    error InvalidPoolOwner(address provided);
    error ActiveDurationZero();
    error CooldownOutOfBounds(uint32 provided, uint32 min, uint32 max);
    error MinAgeOutOfBounds(uint256 provided, uint256 min, uint256 max);

    uint32 public constant MIN_DURATION = 4 hours; // same as in DepegPool
    uint32 public constant MAX_DURATION = 30 days; // same as in DepegPool

    IDepegFactory.Depeg[] private depegModule;
    constructor() Ownable(msg.sender) {}

    // ===== VIEW FUNCTIONS =====
    /////////////////////////////

    function getDepegModule(uint256 index) external view returns (IDepegFactory.Depeg memory depeg) {
        return depegModule[index];
    }

    // ===== POOL DEPLOYMENT =====
    ///////////////////////////////

    /// @notice Deploys a new DepegPool contract
    /// @dev Deploys a new DepegPool contract with the given parameters. Ensure use of correct decimals!
    /// @param _params DepegPoolParams struct containing all deployment parameters
    function deployDepeg(IDepegPool.DepegPoolParams calldata _params) external onlyOwner {
        // Validate all critical addresses
        if (_params.assetAddress == address(0)) revert InvalidAssetAddress(_params.assetAddress);
        if (_params.assetAddress.code.length == 0) revert AssetNotAContract(_params.assetAddress);
        if (_params.oracle == address(0)) revert InvalidOracleAddress(_params.oracle);
        // Only validate oracle is a contract if NOT in cross-chain mode
        // In cross-chain mode (xDomainMessengerL2 != 0), oracle is on L1 and we can't check its code from L2
        if (_params.xDomainMessengerL2 == address(0) && _params.oracle.code.length == 0) {
            revert OracleNotAContract(_params.oracle);
        }
        if (_params.poolOwner == address(0)) revert InvalidPoolOwner(_params.poolOwner);

        // Validate token name/symbol inputs
        if (bytes(_params.dpMetadata.name).length == 0) revert NameRequired("DP");
        if (bytes(_params.dpMetadata.symbol).length == 0) revert SymbolRequired("DP");
        if (bytes(_params.ybMetadata.name).length == 0) revert NameRequired("YB");
        if (bytes(_params.ybMetadata.symbol).length == 0) revert SymbolRequired("YB");

        // Validate other inputs
        if (_params.minPrice == 0) revert MinPriceMustBeGreaterThanZero(_params.minPrice);
        if (_params.maxPrice <= _params.minPrice) revert MaxPriceMustBeGreaterThanMinPrice(_params.maxPrice, _params.minPrice);
        if (_params.treasury == address(0)) revert InvalidTreasuryAddress(_params.treasury);

        // Validate durations
        if (_params.poolActiveDuration == 0) revert ActiveDurationZero();
        if (_params.cooldownDuration < MIN_DURATION || _params.cooldownDuration > MAX_DURATION) revert CooldownOutOfBounds(_params.cooldownDuration, MIN_DURATION, MAX_DURATION);
        if (_params.minPriceAge < MIN_DURATION || _params.minPriceAge > MAX_DURATION) revert MinAgeOutOfBounds(_params.minPriceAge, MIN_DURATION, MAX_DURATION);

        // Deploy pool; the pool will create its own DP/YB tokens using the provided names/symbols
        DepegPool depegPool = new DepegPool(_params);

        // Read token addresses from the newly deployed pool
        address yb = address(depegPool.YB_ASSET());
        address dp = address(depegPool.DP_ASSET());

        depegModule.push(
            IDepegFactory.Depeg({
                dpAsset: dp, // Always pass DP first
                ybAsset: yb, // and YB second
                depegPool: address(depegPool)
            })
        );

        emit DeployDepeg(dp, yb, address(depegPool), _params.poolActiveDuration);
    }

    // ===== MODIFIERS =====
    ////////////////////////

    // onlyOwner modifier is inherited from OZ/Ownable
}
