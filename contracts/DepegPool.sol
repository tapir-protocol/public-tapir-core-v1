// SPDX-License-Identifier: BUSL-1.1

/*
                          _,.,.__,--.__,-----.
                      ,""   '))              `.
                    ,'   e                    ))
                   (  .='__,                  ,
                    `~`     `-\  /._____,/   /
                             | | )    (  (   ;
                             | | |    / / / / 
                     vvVVvvVvVVVvvVVVvvVVvVvvvVvPhSv 
                    
                    Tapir DepegPool
*/
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "./interfaces/IDepegPool.sol";
import "./interfaces/ITapirOracle.sol";
import "./interfaces/IDepegToken.sol";
import "./DepegToken.sol";

interface ICrossDomainMessenger {
    function xDomainMessageSender() external view returns (address); // OK: https://specs.optimism.io/protocol/messengers.html
}

// Lifecycle comments
///////////////////////
//
// When DepegPool is created, its state is "ACTIVE" (block.timestamp < startTime + poolActiveDuration);
// Once poolActiveDuration has passed, its state changes to "COOLDOWN";
// Once COOLDOWN has passed AND final price data has been set, its state changes to "RESOLUTION";
// Once resolvePriceDepeg() has been called, its state changes to "REDEMPTIONS";
//
// Functions available during each lifecycle state:
// - ACTIVE: splitToken, unSplitTokens, setMinPriceAge, setCooldownDuration
// - COOLDOWN: updatePriceData, setMinPriceAge
// - RESOLUTION: resolvePriceDepeg
// - REDEMPTIONS: redeemTokens, sweepFeesToTreasury
// - ALWAYS AVAILABLE: proposeOracleChange, executeOracleChange, setRedemptionFeeBp, pause, unpause, rescueErc20 (N.B! pool-related tokens only 30d after pausing/resolution start), setAuthorisedRouter
//
// Internal functions are always available, only public/external functions have state checks.

// Privileged access comments
////////////////////////////////
//
// Implemented via OZ/AccessControl contract
// - DEFAULT_ADMIN_ROLE: pool owner ("superadmin")
// - OPERATOR_ROLE: operator (multiple operational hot wallets)
//
// Custom modifier:
// - onlyAdminOrOperator(): only admin or operator can call (inherited from above)
// - onlyOracle(): only oracle can call (only one address at a time; separately implemented)

// Different price types
//////////////////////////
// - hwmPrice: the high watermark price calculated by the oracle as max(min(triplets)) of consecutive daily prices
// - resolutionPrice: the closing price calculated by the oracle as the median of recent daily prices, compared against hwmPrice to determine depeg size
// - finalPriceData: a struct containing the hwmPrice and resolutionPrice provided by the oracle, and the timestamp when they were set
// - MIN_PRICE: the lowest price allowed for hwmPrice
// - MAX_PRICE: the highest price allowed for hwmPrice and resolutionPrice

// Prices consumed by the pool, provided by the oracle:
// - updatePriceData(): updates the hwmPrice and resolutionPrice, callable during cooldown to determine the depeg size

contract DepegPool is AccessControl, ReentrancyGuard, Pausable, IDepegPool {
    using SafeERC20 for IERC20;

    /// CUSTOM ERRORS
    ////////////////////
    error MinAgeOutOfBounds(uint256 provided, uint256 min, uint256 max);
    error ZeroAddress();
    error NotAContract(address provided);
    error InvalidOracleInterface(address oracle);
    error OracleDepegPoolMismatch(address oracleDepegPool, address thisPool);
    error MustBeInActiveState(uint8 currentState);
    error MustBeInCooldownState(uint8 currentState);
    error MustBeInResolutionState(uint8 currentState);
    error MustBeInRedemptionsState(uint8 currentState);
    error MustBeInActiveOrCooldownState(uint8 currentState);
    error UnauthorizedCaller(address caller);
    error ZeroAmount();
    error PriceOutOfBounds(uint256 price, uint256 min, uint256 max);
    error NoPendingOracle();
    error TimelockNotExpired(uint256 currentTime, uint256 unlockTime);
    error CooldownOutOfBounds(uint32 provided, uint32 min, uint32 max);
    error TooEarlyToRescue();
    error PriceDataTooRecent(uint256 priceAge, uint256 minRequired);
    error MinPriceMustBeGreaterThanZero(uint128 provided);
    error MaxPriceMustBeGreaterThanMinPrice(uint128 maxPrice, uint128 minPrice);
    error ActiveDurationZero();

    /// CONSTANTS
    /////////////
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint16 public constant BP_IN_INTEGER = 10000; // 100% = 10000
    uint32 public constant ORACLE_CHANGE_DELAY = 7 days;
    uint32 public constant MIN_DURATION = 4 hours;
    uint32 public constant MAX_DURATION = 30 days;
    uint8 private constant STATE_ACTIVE = 1;
    uint8 private constant STATE_COOLDOWN = 2;
    uint8 private constant STATE_RESOLUTION = 3;
    uint8 private constant STATE_REDEMPTIONS = 4;

    /// IMMUTABLES
    //////////////
    IDepegToken public immutable DP_ASSET;
    IDepegToken public immutable YB_ASSET;
    IERC20 public immutable ASSET;
    uint128 public immutable MAX_PRICE; // Maximum allowed price (inclusive)
    uint128 public immutable MIN_PRICE; // Minimum allowed price (inclusive)
    address public immutable TREASURY; // Fees and rescued tokens are sent to TREASURY

    /// STORAGE VARIABLES
    /////////////////////

    // Slot 1 (29 bytes): state check variables (read together in getState)
    address public xDomainMessengerL2; // 20 bytes - Address of the xDomain messenger contract on L2, if applicable (otherwise 0 address)
    uint32 public poolActiveDuration; // 4 bytes - Duration (in seconds) for which the pool remains active
    uint32 public cooldownDuration; // 4 bytes
    bool public depegResolved; // 1 byte

    // Slot 2 (28 bytes): redemption value variables (read together in redeemTokens)
    ITapirOracle public oracle; // 20 bytes
    uint8 public redemptionFeeBp; // 1 byte
    bool public poolHasDepegged; // 1 byte
    uint16 public principalDepeggedValue; // 2 bytes - Size of the depeg expressed as 1 - depegSize, in basis points
    uint16 public ybValue; // 2 bytes - Current calculated YB token value
    uint16 public dpValue; // 2 bytes - Current calculated DP token value

    // Slot 3 (20 bytes): pending oracle address
    address public pendingOracle; // 20 bytes

    // Rest
    uint256 public startTime; // Timestamp marking the start of the pool's ACTIVE state
    uint256 public minPriceAge;
    uint256 public oracleChangeTimestamp; // When oracle change can be executed
    uint256 public lastPauseTimestamp; // Timestamp when pause() was called most recently

    IDepegPool.PriceData public finalPriceData; // Set by oracle during COOLDOWN

    string public name;
    string public flag;

    mapping(address => bool) public isAuthorisedRouter; // Addresses authorised to execute actions on behalf of a counterparty

    /**
     * @dev Constructor initializes the pool and deploys the DP/YB tokens.
     * @param _params DepegPoolParams struct containing all initialization parameters
     */
    constructor(IDepegPool.DepegPoolParams memory _params) {
        // Validate critical addresses
        if (_params.poolOwner == address(0)) revert ZeroAddress();
        if (_params.oracle == address(0)) revert ZeroAddress();
        if (_params.assetAddress == address(0)) revert ZeroAddress();
        if (_params.treasury == address(0)) revert ZeroAddress();

        // Grant _poolOwner the DEFAULT_ADMIN_ROLE
        _grantRole(DEFAULT_ADMIN_ROLE, _params.poolOwner);
        // Nobody has the OPERATOR_ROLE at this point

        // Validate price bounds (defense in depth)
        if (_params.minPrice == 0) revert MinPriceMustBeGreaterThanZero(_params.minPrice);
        if (_params.maxPrice <= _params.minPrice) revert MaxPriceMustBeGreaterThanMinPrice(_params.maxPrice, _params.minPrice);

        // Set price bounds
        MIN_PRICE = _params.minPrice;
        MAX_PRICE = _params.maxPrice;

        // Validate durations are within allowed ranges
        if (_params.poolActiveDuration == 0) revert ActiveDurationZero();
        if (_params.cooldownDuration < MIN_DURATION || _params.cooldownDuration > MAX_DURATION) revert CooldownOutOfBounds(_params.cooldownDuration, MIN_DURATION, MAX_DURATION);
        if (_params.minPriceAge < MIN_DURATION || _params.minPriceAge > MAX_DURATION) revert MinAgeOutOfBounds(_params.minPriceAge, MIN_DURATION, MAX_DURATION);

        // Set variables from factory inputs
        ASSET = IERC20(_params.assetAddress);
        oracle = ITapirOracle(_params.oracle);
        redemptionFeeBp = _params.redemptionFeeBp;
        name = _params.name;
        poolActiveDuration = _params.poolActiveDuration;
        startTime = block.timestamp;
        flag = _params.flag;
        cooldownDuration = _params.cooldownDuration;
        TREASURY = _params.treasury;
        if (_params.authorisedRouter != address(0)) {
            isAuthorisedRouter[_params.authorisedRouter] = true;
        }
        minPriceAge = _params.minPriceAge;
        xDomainMessengerL2 = _params.xDomainMessengerL2;
        // Initialize lastPauseTimestamp to max value so rescue timelock works correctly before first pause
        lastPauseTimestamp = type(uint256).max;

        // Get decimals from base asset to ensure DP and YB tokens match
        uint8 assetDecimals = IERC20Metadata(_params.assetAddress).decimals();

        // Deploy DP and YB tokens directly from the pool. The DepegPool will be
        // the owner of those tokens (DepegToken constructor sets owner to msg.sender).
        // Pattern: Instantiate concrete → Setup → Store as interface
        // - Use concrete type for 'new' (interfaces cannot be instantiated)
        // - Call setup methods while we have concrete type reference
        // - Cast to interface type for storage (loose coupling, type safety)
        DepegToken dp = new DepegToken(_params.dpMetadata.name, _params.dpMetadata.symbol, assetDecimals); // Owner is set in constructor to msg.sender (this DepegPool)
        DepegToken yb = new DepegToken(_params.ybMetadata.name, _params.ybMetadata.symbol, assetDecimals); // Owner is set in constructor to msg.sender (this DepegPool)

        // Assign immutables as interface type for encapsulation and clear contract
        DP_ASSET = IDepegToken(address(dp));
        YB_ASSET = IDepegToken(address(yb));
    }

    // ===== DepegPool VIEW FUNCTIONS =====
    ///////////////////////////////////////

    /// @notice Returns the current state of the pool
    /// @return currentState Current state: 1=ACTIVE, 2=COOLDOWN, 3=RESOLUTION, 4=REDEMPTIONS
    function getState() public view returns (uint8 currentState) {
        // No state check: always available

        uint256 activeEnd = startTime + poolActiveDuration;

        // ACTIVE: block.timestamp < startTime + poolActiveDuration
        if (block.timestamp < activeEnd) {
            return STATE_ACTIVE;
        }

        uint256 cooldownEnd = activeEnd + cooldownDuration;

        // COOLDOWN: If final price data has not been set or the cooldown duration has not elapsed
        if ((finalPriceData.resolutionPrice == 0 && finalPriceData.hwmPrice == 0) || block.timestamp < cooldownEnd) {
            // block.timestamp >= activeEnd is implied by previous if
            return STATE_COOLDOWN;
        }

        // Price data to must be set and cooldown duration must have elapsed to get here

        // RESOLUTION: block.timestamp >= startTime + poolActiveDuration + cooldownDuration && !depegResolved
        if (!depegResolved) {
            return STATE_RESOLUTION;
        }

        // Depeg must be resolved for the state to progress any further

        // REDEMPTIONS: block.timestamp >= startTime + poolActiveDuration + cooldownDuration && depegResolved
        // If all other conditions are met, we can return REDEMPTIONS state
        return STATE_REDEMPTIONS;
    }

    /// @notice Returns the depeg size
    /// @return The depeg size as 1 - principalDepeggedValue in basis points
    function depegSize() external view returns (uint16) {
        if (!poolHasDepegged || !depegResolved) {
            return 0; // No depeg occurred or not resolved yet
        }
        return uint16(BP_IN_INTEGER - principalDepeggedValue);
    }

    // ===== ADMIN FUNCTIONS =====
    //////////////////////////////

    /// @notice Proposes a new oracle address with 7-day timelock
    /// @dev Initiates oracle change process. Actual change requires executeOracleChange after delay
    /// @param _oracle oracle address to propose
    function proposeOracleChange(address _oracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // No state check: always available
        if (_oracle == address(0)) revert ZeroAddress();

        // Only validate oracle if NOT in cross-chain mode
        // In cross-chain mode (xDomainMessengerL2 != 0), oracle is on L1 and we can't check its code from L2
        if (xDomainMessengerL2 == address(0)) {
            if (_oracle.code.length == 0) revert NotAContract(_oracle);

            // Test that oracle interface works
            try ITapirOracle(_oracle).cfg() returns (ITapirOracle.Config memory cfg) {
                if (cfg.depegPool != address(this)) revert OracleDepegPoolMismatch(cfg.depegPool, address(this));
            } catch {
                revert InvalidOracleInterface(_oracle);
            }
        }

        pendingOracle = _oracle;
        oracleChangeTimestamp = block.timestamp + ORACLE_CHANGE_DELAY;
        emit OracleChangeProposed(_oracle, oracleChangeTimestamp);
    }

    /// @notice Allows admin to set or revoke authorised router addresses
    /// @dev Only callable by admin. Multiple routers can be authorised simultaneously.
    /// @param _router Router address to authorise or revoke
    /// @param _authorised True to authorise, false to revoke
    function setAuthorisedRouter(address _router, bool _authorised) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // No state check: always available
        isAuthorisedRouter[_router] = _authorised;
        emit AuthorisedRouterUpdated(_router, _authorised);
    }

    /// @notice Allows admin or operator to set redemption fee rate
    /// @dev sets redemption fee rate with 0.01% precision (10000 = 100%)
    /// @param _feeRate fee rate in basis points
    function setRedemptionFeeBp(uint8 _feeRate) external onlyAdminOrOperator {
        // No state check: always available
        redemptionFeeBp = _feeRate; // max 255 = 2.55%
        emit RedemptionFeeBpUpdated(_feeRate);
    }

    /// @notice Allows admin to set the resolution cooldown period
    /// @dev Must be between `MIN_DURATION` and `MAX_DURATION`
    /// @param _cooldown cooldown period in seconds
    function setCooldownDuration(uint32 _cooldown) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // State check: ACTIVE only
        uint8 state = getState();
        if (state != STATE_ACTIVE) revert MustBeInActiveState(state);

        if (_cooldown < MIN_DURATION || _cooldown > MAX_DURATION) revert CooldownOutOfBounds(_cooldown, MIN_DURATION, MAX_DURATION);
        cooldownDuration = _cooldown;
        emit CooldownDurationUpdated(_cooldown);
    }

    /// @notice Allows admin to set the minimum price age for redemption
    /// @dev Can only be changed during ACTIVE/COOLDOWN state
    /// @param _minAge minimum age in seconds (must be between `MIN_DURATION` and `MAX_DURATION`)
    function setMinPriceAge(uint256 _minAge) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // State check: can only change in ACTIVE or COOLDOWN to prevent blocking pool resolution
        uint8 state = getState();
        if (state != STATE_ACTIVE && state != STATE_COOLDOWN) revert MustBeInActiveOrCooldownState(state);
        if (_minAge < MIN_DURATION || _minAge > MAX_DURATION) revert MinAgeOutOfBounds(_minAge, MIN_DURATION, MAX_DURATION);
        minPriceAge = _minAge;
        emit MinPriceAgeUpdated(_minAge);
    }

    /// @notice Pauses all core operations in the pool
    /// @dev Only admin or operator can pause. From OZ/Pausable.
    function pause() external onlyAdminOrOperator {
        // No state check: always available
        lastPauseTimestamp = block.timestamp;
        _pause();
    }

    /// @notice Unpauses all operations
    /// @dev Only admin can unpause. From OZ/Pausable.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        // No state check: always available
        lastPauseTimestamp = type(uint256).max;
        _unpause();
    }

    /// @notice Recovery function for ERC20s
    /// @dev Only callable by admin or operator. Can withdraw DP_ASSET, YB_ASSET, and base asset only after timelock. Transfers to TREASURY.
    /// @param _token Address of the ERC20 token to recover
    /// @param _amount Amount to recover
    function rescueErc20(address _token, uint256 _amount) external onlyAdminOrOperator nonReentrant {
        // No state check: always available
        if (_token == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();

        // Core tokens redeemable only min. 30 days after resolution start OR 30 days after last pause
        if (_token == address(DP_ASSET) || _token == address(YB_ASSET) || _token == address(ASSET)) {
            if (block.timestamp < startTime + poolActiveDuration + cooldownDuration + 30 days) {
                if (lastPauseTimestamp == type(uint256).max || block.timestamp < lastPauseTimestamp + 30 days) {
                    revert TooEarlyToRescue();
                }
            }
        }

        IERC20(_token).safeTransfer(TREASURY, _amount);
    }

    // ===== ORACLE FUNCTIONS =====
    ///////////////////////////////

    /// @notice Allows oracle to update the high watermark and resolution prices during cooldown
    /// @dev Only callable by oracle during COOLDOWN state
    /// @param _hwmPrice high watermark price (normalised to base decimals)
    /// @param _resolutionPrice closing/resolution price (normalised to base decimals)
    function updatePriceData(uint256 _hwmPrice, uint256 _resolutionPrice) external onlyOracle {
        // State check: COOLDOWN
        uint8 state = getState();
        if (state != STATE_COOLDOWN) revert MustBeInCooldownState(state);

        if (_hwmPrice < MIN_PRICE || _hwmPrice > MAX_PRICE) revert PriceOutOfBounds(_hwmPrice, MIN_PRICE, MAX_PRICE);
        // Resolution price only needs upper bound check - it can fall to 0 in severe depeg events
        if (_resolutionPrice > MAX_PRICE) revert PriceOutOfBounds(_resolutionPrice, 0, MAX_PRICE);

        finalPriceData = IDepegPool.PriceData({hwmPrice: _hwmPrice, resolutionPrice: _resolutionPrice, timestamp: block.timestamp});
        emit PriceDataUpdated(_hwmPrice, _resolutionPrice);
    }

    // ===== INTERNAL FUNCTIONS =====
    /////////////////////////////////

    /**
     * @dev Internal function to calculate redemption fee
     * @param _amountToSend Base amount before fees
     * @return feeAmount The calculated redemption fee
     * @return amountAfterFee The amount after deducting the fee
     */
    function _calculateRedemptionFee(uint256 _amountToSend) internal view returns (uint256 feeAmount, uint256 amountAfterFee) {
        if (redemptionFeeBp == 0) {
            return (0, _amountToSend);
        }
        feeAmount = (_amountToSend * redemptionFeeBp) / BP_IN_INTEGER; // Safe with zero redemptionFeeBp
        amountAfterFee = _amountToSend - feeAmount;
        // named return
    }

    // ===== CORE FUNCTIONS =====
    /////////////////////////////

    /**
     * @notice Splits the base asset into DP_ASSET and YB_ASSET equally.
     * @dev The pool must be active to perform the split. The counterparty must have approved base asset.
     * @param _counterparty Address of the counterparty for the split.
     * @param _amount Amount of base asset to split.
     */
    function splitToken(address _counterparty, uint256 _amount) external nonReentrant whenNotPaused {
        // State check: ACTIVE only
        uint8 state = getState();
        if (state != STATE_ACTIVE) revert MustBeInActiveState(state);

        if (msg.sender != _counterparty && !isAuthorisedRouter[msg.sender]) revert UnauthorizedCaller(msg.sender);

        // Do not allow zero amounts
        if (_amount == 0) revert ZeroAmount();

        // Transfer base asset from counterparty to the DepegPool
        ASSET.safeTransferFrom(_counterparty, address(this), _amount); // 2 Base = 1 DP + 1 YB

        // Split the amount into equal parts for DP_ASSET and YB_ASSET
        uint256 mintAmount = _amount / 2; // Safe: rounds down

        // Mint equal amounts of DP_ASSET and YB_ASSET to the counterparty
        DP_ASSET.mint(_counterparty, mintAmount);
        YB_ASSET.mint(_counterparty, mintAmount);

        // Emit event with the counterparty and amount
        emit SplitToken(_counterparty, _amount);
    }

    /**
     * @notice Un-splits previously split DP_ASSET and YB_ASSET back into asset.
     * @dev The pool must be active to perform the un-split. The sender must have approved DP_ASSET and YB_ASSET.
     * @param _counterparty Address of the counterparty for the un-split.
     * @param _amounts Amount of YB_ASSET and DP_ASSET to un-split.
     */
    function unSplitTokens(address _counterparty, uint256 _amounts) external nonReentrant whenNotPaused {
        // State check: ACTIVE only
        uint8 state = getState();
        if (state != STATE_ACTIVE) revert MustBeInActiveState(state);

        if (msg.sender != _counterparty && !isAuthorisedRouter[msg.sender]) revert UnauthorizedCaller(msg.sender);

        // Do not allow zero amounts
        if (_amounts == 0) revert ZeroAmount();

        // Burn YB_ASSET and DP_ASSET from the counterparty
        YB_ASSET.burn(_counterparty, _amounts);
        DP_ASSET.burn(_counterparty, _amounts);

        // Calculate redemption fee using internal function (on base amount)
        (
            uint256 redemptionFeeAmount, // Redemption fee paid by the user
            uint256 finalAmount // Final amount the user receives after redemption fee
        ) = _calculateRedemptionFee(_amounts * 2);

        // Transfer final amount to user; excess (fees) is left in the DepegPool
        ASSET.safeTransfer(_counterparty, finalAmount); // 2 Base = 1 DP + 1 YB

        // Emit combined event with all relevant information
        emit UnSplitTokens(_counterparty, _amounts, finalAmount, redemptionFeeAmount);
    }

    /**
     * @dev Internal function to calculate DP and YB redemption values based on depeg status
     * @dev Strictly called ONCE (in resolvePriceDepeg())
     * @dev Reads principalDepeggedValue directly from state
     * @dev Updates the public dpValue and ybValue variables
     */
    function _calculateRedeemValues() internal {
        if (!poolHasDepegged) {
            // If no depeg occurred, both tokens maintain 1:1 value
            dpValue = BP_IN_INTEGER; // 10000 = 100%
            ybValue = BP_IN_INTEGER; // 10000 = 100%
        } else {
            // Cache state variable to reduce storage reads
            uint16 cachedPrincipalDepeggedValue = principalDepeggedValue;

            // Handle severe depeg case: if principalDepeggedValue is 0 (100% depeg),
            // DP tokens get maximum value (200%) and YB tokens become worthless (0%)
            // This prevents division by zero
            if (cachedPrincipalDepeggedValue == 0) {
                dpValue = uint16(BP_IN_INTEGER * 2); // 200% - DP holders get maximum payout
                // ybValue remains 0 (default value) - YB holders lose everything
                return;
            }

            // If depeg occurred, adjust values based on depeg size
            // DP tokens gain value: dpValue = BP_IN_INTEGER / principalDepeggedValue
            // e.g. at 20% depeg (principalDepeggedValue = 8000): 10000 / 8000 = 1.25 (125%)
            uint256 rawDpValue = (uint256(BP_IN_INTEGER) * BP_IN_INTEGER) / cachedPrincipalDepeggedValue;
            if (rawDpValue >= BP_IN_INTEGER * 2) {
                dpValue = uint16(BP_IN_INTEGER * 2); // Cap DP value at 200% to ensure fund solvency
                // When DP value is capped at maximum, YB tokens become worthless (remain at 0)
                // This prevents over-allocation and ensures the pool remains solvent
                return; // Exit early - ybValue remains 0 (default value)
            } else {
                dpValue = uint16(rawDpValue);
            }

            // YB tokens lose value: ybValue = 2 * BP_IN_INTEGER - dpValue
            // e.g. at 20% depeg: 2 * 10000 - 12500 = 7500 (75%)
            // This calculation only runs when DP value is below the 200% cap
            ybValue = uint16(2 * BP_IN_INTEGER - dpValue);
        }
    }

    /**
     * @notice Redeems YB_ASSET and DP_ASSET tokens for underlying base asset, accounting for depeg impacts.
     * If no depeg, all tokens are returned 1:1. If depeg happened, depeg size is factored into the redemption.
     * @param _counterparty Address of the counterparty for the redemption.
     * @param _amountDP Amount of DP_ASSET to redeem.
     * @param _amountYB Amount of YB_ASSET to redeem.
     */
    function redeemTokens(address _counterparty, uint256 _amountDP, uint256 _amountYB) external nonReentrant whenNotPaused {
        // State check: REDEMPTIONS
        uint8 state = getState();
        if (state != STATE_REDEMPTIONS) revert MustBeInRedemptionsState(state);

        if (msg.sender != _counterparty && !isAuthorisedRouter[msg.sender]) revert UnauthorizedCaller(msg.sender);

        uint256 amountToSend;

        // If no depeg occurred, return full amount 1:1.
        if (!poolHasDepegged) {
            amountToSend = _amountDP + _amountYB;
        }
        // If depeg occurred, adjust redemption amounts based on calculated values.
        else {
            // Calculate redemption amounts using stored values
            // DP tokens gain value: e.g. at 20% depeg, 10 DP * 1.25 = 12.5 base tokens
            // YB tokens lose value: e.g. at 20% depeg, 10 YB * 0.75 = 7.5 base tokens
            uint256 calculatedDpValue = (_amountDP * dpValue) / BP_IN_INTEGER;
            uint256 calculatedYbValue = (_amountYB * ybValue) / BP_IN_INTEGER;
            amountToSend = calculatedDpValue + calculatedYbValue;
        }

        // Calculate redemption fee using internal function (on base amount)
        (uint256 redemptionFeeAmount, uint256 finalAmount) = _calculateRedemptionFee(amountToSend);

        // Burn tokens (effects before interactions)
        YB_ASSET.burn(_counterparty, _amountYB);
        DP_ASSET.burn(_counterparty, _amountDP);

        // Send final amount to user; excess (fees) is left in the DepegPool
        ASSET.safeTransfer(_counterparty, finalAmount);

        // Emit event with all relevant information
        emit RedeemTokens(_counterparty, _amountDP, _amountYB, finalAmount, redemptionFeeAmount);
    }

    // ===== OTHER FUNCTIONS =====
    //////////////////////////////

    /// @notice Executes the pending oracle change after timelock has expired
    /// @dev Can only be called after `ORACLE_CHANGE_DELAY` has passed since proposal
    function executeOracleChange() external {
        // No state check: always available
        // Cache pendingOracle to reduce storage reads
        address cachedPendingOracle = pendingOracle;
        if (cachedPendingOracle == address(0)) revert NoPendingOracle();
        if (block.timestamp < oracleChangeTimestamp) revert TimelockNotExpired(block.timestamp, oracleChangeTimestamp);

        oracle = ITapirOracle(cachedPendingOracle);
        emit OracleUpdated(cachedPendingOracle);

        // Clear pending oracle
        pendingOracle = address(0);
        oracleChangeTimestamp = 0;
    }

    /// @notice Sweeps accumulated fees to TREASURY
    /// @dev Collects any excess asset balance (from fees) and sends to TREASURY.
    /// @dev Can only be called during REDEMPTIONS state. May be called multiple times.
    function sweepFeesToTreasury() external nonReentrant {
        // State check: available during REDEMPTIONS state
        uint8 state = getState();
        if (state != STATE_REDEMPTIONS) revert MustBeInRedemptionsState(state);

        // Calculate the base asset value required to cover all outstanding DP and YB tokens.
        // We must account for the actual redemption values (dpValue/ybValue) since after a depeg,
        // DP tokens may be worth up to 2x base and YB tokens may be worth less (down to 0).
        // This mirrors the calculation in redeemTokens() to ensure consistency.
        // No DOS: If either DP or YB remain unburned (not redeemed), the protocol can withdraw
        // those tokens using the rescueErc20 function.
        uint256 dpSupply = DP_ASSET.totalSupply();
        uint256 ybSupply = YB_ASSET.totalSupply();
        uint256 requiredForDp = (dpSupply * dpValue) / BP_IN_INTEGER; // Same implementation as in redeemTokens/L518
        uint256 requiredForYb = (ybSupply * ybValue) / BP_IN_INTEGER; // Same implementation as in redeemTokens/L519
        uint256 requiredBase = requiredForDp + requiredForYb;
        uint256 baseInContract = ASSET.balanceOf(address(this));
        uint256 feeAmount = baseInContract - requiredBase;
        ASSET.safeTransfer(TREASURY, feeAmount);
        emit TreasuryFeeCollected(feeAmount);
    }

    /**
     * @dev Resolves the price depeg issue by calculating the depeg size.
     * @dev Oracle must have updated finalPriceData before calling this.
     * @dev `minPriceAge` must have elapsed since the final price update.
     * @dev The pool must be in RESOLUTION state and depeg must NOT have been resolved yet.
     */
    function resolvePriceDepeg() external {
        // State check: RESOLUTION
        uint8 state = getState();
        if (state != STATE_RESOLUTION) revert MustBeInResolutionState(state);

        // finalPriceData MUST be AT LEAST minPriceAge old to prevent manipulation
        uint256 priceAge = block.timestamp - finalPriceData.timestamp;
        if (priceAge < minPriceAge) revert PriceDataTooRecent(priceAge, minPriceAge);

        // Check if price at resolution is below high water mark (depeg occurred)
        if (finalPriceData.hwmPrice > finalPriceData.resolutionPrice) {
            uint256 tempBpInInteger = uint256(BP_IN_INTEGER); // Wrap as uint256 for calculations
            // Check for minimum price drop (0.1% threshold to avoid rounding errors)
            uint256 minPriceDrop = (finalPriceData.hwmPrice * 10) / tempBpInInteger;

            if (finalPriceData.hwmPrice - finalPriceData.resolutionPrice >= minPriceDrop) {
                // Calculate depeg size in basis points (BP_IN_INTEGER scale)
                // principalDepeggedValue = resolutionPrice * BP_IN_INTEGER / hwmPrice
                // Note: If resolutionPrice is 0 (100% depeg), principalDepeggedValue will be 0
                // This is handled in _calculateRedeemValues() where DP gets 200% and YB gets 0%
                principalDepeggedValue = uint16(((finalPriceData.resolutionPrice * tempBpInInteger) / finalPriceData.hwmPrice));

                // Example: 1% depeg yields 100bp
                // 10,000 - ((0.990 * 10,000) / 1.000)
                // 10,000 - (9,900 / 1.000)
                // 10,000 - 9,900
                // 100

                // Mark as depegged for any depeg size
                poolHasDepegged = true;
            }
        }

        // Calculate DP and YB values once after depeg resolution
        _calculateRedeemValues();

        // Depeg should be resolved even if there was no depeg; REDEMPTION state relies on this to determine if the pool is in a redeemable state
        depegResolved = true;
        emit DepegPriceResolved(poolHasDepegged, principalDepeggedValue, block.timestamp);
    }

    // ===== MODIFIERS =====
    ///////////////////////////////

    /// @notice Modifier to ensure only oracle can call
    modifier onlyOracle() {
        if (xDomainMessengerL2 != address(0)) {
            if (msg.sender != address(xDomainMessengerL2) || ICrossDomainMessenger(xDomainMessengerL2).xDomainMessageSender() != address(oracle)) revert UnauthorizedCaller(msg.sender);
        } else {
            if (msg.sender != address(oracle)) revert UnauthorizedCaller(msg.sender);
        }
        _;
    }

    /// @notice Modifier to ensure only admin or operator can call
    modifier onlyAdminOrOperator() {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(OPERATOR_ROLE, msg.sender)) revert UnauthorizedCaller(msg.sender);
        _;
    }

    // onlyRole modifier is inherited from OZ/AccessControl
    // nonReentrant modifier is inherited from OZ/ReentrancyGuard
    // whenNotPaused is inherited from OZ/Pausable
}
