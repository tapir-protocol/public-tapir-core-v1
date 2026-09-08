// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IDepegToken.sol";
import "./ITapirOracle.sol";

// @dev DepegPool is also Ownable (by factory), ReentrancyGuard, Pausable
interface IDepegPool {
    // ===== Events =====

    /// @dev Split token event
    /// @param counterparty Address of the counterparty for the split.
    /// @param amount Amount of base asset to split.
    event SplitToken(address indexed counterparty, uint256 amount);

    /// @dev Unsplit tokens event - amount is burned from both YB and DP tokens
    event UnSplitTokens(address indexed counterparty, uint256 indexed amounts, uint256 baseReceived, uint256 totalFees);

    /// @dev Depeg resolution event
    event DepegPriceResolved(bool indexed poolHasDepegged, uint256 depegSize, uint256 timestamp);
    /// @dev Oracle update event
    event OracleUpdated(address indexed newOracle);
    /// @dev Oracle change proposed event
    event OracleChangeProposed(address indexed newOracle, uint256 executeTime);
    /// @dev Treasury fee event
    event TreasuryFeeCollected(uint256 amount);
    /// @dev Redeem tokens event
    event RedeemTokens(address indexed counterparty, uint256 indexed amountDP, uint256 indexed amountYB, uint256 baseReceived, uint256 feesPaid);
    /// @dev Authorised router updated event
    event AuthorisedRouterUpdated(address indexed router, bool authorised);
    /// @dev Redemption fee rate update event
    event RedemptionFeeBpUpdated(uint256 newRate);
    /// @dev Price update event
    event PriceDataUpdated(uint256 newHwmPrice, uint256 newResolutionPrice);
    /// @dev Resolution cooldown updated event
    event CooldownDurationUpdated(uint256 newCooldown);
    /// @dev Minimum price age updated event
    event MinPriceAgeUpdated(uint256 newMinAge);

    // ===== Structs =====

    struct PriceData {
        uint256 hwmPrice;
        uint256 resolutionPrice;
        uint256 timestamp;
    }

    /// @dev Token metadata for DP/YB tokens
    struct TokenMetadata {
        string name;
        string symbol;
    }

    /// @dev Parameters for deploying a DepegPool
    struct DepegPoolParams {
        address assetAddress; // Address of the base ERC20 asset token
        TokenMetadata dpMetadata;
        TokenMetadata ybMetadata;
        address oracle; // Oracle address (on L1 or L2)
        uint32 poolActiveDuration; // Duration (in seconds) for which the pool remains active
        string name; // Name of the pool
        string flag; // Flag identifier of the pool
        uint8 redemptionFeeBp; // Redemption fee in basis points
        uint32 cooldownDuration; // Duration (in seconds) for which the pool remains in cooldown after depeg resolution
        address poolOwner; // Address of the pool owner
        uint128 minPrice; // Minimum allowed price (inclusive)
        uint128 maxPrice; // Maximum allowed price (inclusive)
        address treasury; // Address of the treasury
        address authorisedRouter; // Initial authorised router address
        uint256 minPriceAge; // Minimum price age (in seconds)
        address xDomainMessengerL2; // Address of the xDomain messenger contract on L2, if applicable (otherwise 0 address)
    }

    // ===== Functions =====

    // Core user functions
    function splitToken(address _counterparty, uint256 _amount) external;
    function unSplitTokens(address _counterparty, uint256 _amounts) external;
    function redeemTokens(address _counterparty, uint256 _amountDP, uint256 _amountYB) external;

    // Resolution functions
    function resolvePriceDepeg() external;
    function getState() external view returns (uint8 currentState);

    // Oracle functions
    function proposeOracleChange(address _oracle) external;
    function executeOracleChange() external;
    function updatePriceData(uint256 _hwmPrice, uint256 _resolutionPrice) external;

    // Admin functions
    function setRedemptionFeeBp(uint8 _feeRate) external;
    function setCooldownDuration(uint32 _cooldown) external;
    function setMinPriceAge(uint256 _minAge) external;
    function pause() external;
    function unpause() external;
    function rescueErc20(address _token, uint256 _amount) external;
    function setAuthorisedRouter(address _router, bool _authorised) external;
    function isAuthorisedRouter(address _router) external view returns (bool);

    // Treasury functions
    function sweepFeesToTreasury() external;

    // State variable getters
    function name() external view returns (string memory);
    function flag() external view returns (string memory);
    function DP_ASSET() external view returns (IDepegToken);
    function YB_ASSET() external view returns (IDepegToken);
    function ASSET() external view returns (IERC20);
    function oracle() external view returns (ITapirOracle);
    function redemptionFeeBp() external view returns (uint8);
    function poolActiveDuration() external view returns (uint32);
    function depegResolved() external view returns (bool);
    function poolHasDepegged() external view returns (bool);
    function depegSize() external view returns (uint16);
    function startTime() external view returns (uint256);
    function cooldownDuration() external view returns (uint32);
    function minPriceAge() external view returns (uint256);
    function pendingOracle() external view returns (address);
    function oracleChangeTimestamp() external view returns (uint256);
    function MIN_PRICE() external view returns (uint128);
    function MAX_PRICE() external view returns (uint128);

    // Constants
    function BP_IN_INTEGER() external view returns (uint16);
    function MIN_DURATION() external view returns (uint32);
    function MAX_DURATION() external view returns (uint32);
    function ORACLE_CHANGE_DELAY() external view returns (uint32);

    // Getters for public struct state variables
    function finalPriceData() external view returns (uint256 hwmPrice, uint256 resolutionPrice, uint256 timestamp);
}
