# DepegPool and DepegFactory technical specification

**Source:** `contracts/DepegPool.sol`, `contracts/DepegFactory.sol`, `contracts/DepegToken.sol`
**Solidity:** ^0.8.27
**License:** BUSL-1.1

---

## Overview

The Tapir depeg protection protocol splits a base asset into two derivative tokens (DP and YB) that provide asymmetric payoffs depending on whether a depeg occurs during a time-bound observation period. A pool progresses through four lifecycle states: ACTIVE, COOLDOWN, RESOLUTION, REDEMPTIONS.

---

## Contract architecture

```
DepegFactory (Ownable)
  └─ deployDepeg(DepegPoolParams) → new DepegPool

DepegPool (AccessControl, ReentrancyGuard, Pausable)
  ├─ deploys DepegToken (DP)
  ├─ deploys DepegToken (YB)
  ├─ integrates with ITapirOracle
  └─ supports L2 cross-domain oracle calls

DepegToken (ERC20)
  └─ mint/burn restricted to parent DepegPool
```

Dependencies: OpenZeppelin v5 (AccessControl, ReentrancyGuard, Pausable, SafeERC20, Ownable, ERC20).

---

## DepegFactory

Owned through OpenZeppelin `Ownable`. Deploys and registers DepegPool instances.

### deployDepeg

```solidity
function deployDepeg(IDepegPool.DepegPoolParams calldata _params) external onlyOwner
```

Validates:
- Asset address is non-zero and a contract
- Oracle address is non-zero; it must be a contract in same-chain mode
- Pool owner is non-zero
- DP/YB names and symbols are non-empty
- `minPrice > 0`
- `maxPrice > minPrice`
- Treasury is non-zero
- `poolActiveDuration` is non-zero
- `cooldownDuration` and `minPriceAge` are each between 4 hours and 30 days

Deploys a new DepegPool, reads the DP/YB addresses from it, stores them in `depegModule[]`.

### getDepegModule

```solidity
function getDepegModule(uint256 index) external view returns (Depeg memory)
```

Returns `{ dpAsset, ybAsset, depegPool }` at the given index.

---

## DepegPool

### Lifecycle states

Determined by `getState()`:

| State | Code | Condition |
|-------|------|-----------|
| ACTIVE | 1 | `block.timestamp < startTime + poolActiveDuration` |
| COOLDOWN | 2 | Active period ended, AND (price data not yet set OR cooldown not elapsed) |
| RESOLUTION | 3 | Cooldown ended, price data set, `depegResolved == false` |
| REDEMPTIONS | 4 | `depegResolved == true` |

COOLDOWN requires **both** the oracle to have called `updatePriceData()` AND `cooldownDuration` to have elapsed before transitioning to RESOLUTION.

### Constants

| Name | Value |
|------|-------|
| `BP_IN_INTEGER` | 10000 (100% in basis points) |
| `ORACLE_CHANGE_DELAY` | 7 days |
| `MIN_DURATION` | 4 hours |
| `MAX_DURATION` | 30 days |

### Immutables

| Variable | Type | Description |
|----------|------|-------------|
| `DP_ASSET` | `IDepegToken` | DP token contract |
| `YB_ASSET` | `IDepegToken` | YB token contract |
| `ASSET` | `IERC20` | Base asset |
| `MIN_PRICE` | `uint128` | Lower price bound (inclusive) |
| `MAX_PRICE` | `uint128` | Upper price bound (inclusive) |
| `TREASURY` | `address` | Fee destination |

### Storage

| Variable | Type | Description |
|----------|------|-------------|
| `xDomainMessengerL2` | `address` | L2 cross-domain messenger (0 if same-chain) |
| `poolActiveDuration` | `uint32` | Active state duration (seconds) |
| `cooldownDuration` | `uint32` | Cooldown duration (seconds) |
| `depegResolved` | `bool` | Whether resolution occurred (one-way: false to true) |
| `oracle` | `ITapirOracle` | Current oracle |
| `redemptionFeeBp` | `uint8` | Redemption fee rate (max 255 = 2.55%) |
| `poolHasDepegged` | `bool` | Whether depeg was detected |
| `principalDepeggedValue` | `uint16` | Post-depeg value in basis points |
| `dpValue` | `uint16` | DP redemption value (bp) |
| `ybValue` | `uint16` | YB redemption value (bp) |
| `startTime` | `uint256` | Pool creation timestamp |
| `minPriceAge` | `uint256` | Required age of price data before resolution |
| `pendingOracle` | `address` | Proposed oracle address |
| `oracleChangeTimestamp` | `uint256` | When oracle change can execute |
| `lastPauseTimestamp` | `uint256` | Last pause time (initialized to `type(uint256).max`) |
| `finalPriceData` | `PriceData` | HWM price, resolution price, timestamp |
| `isAuthorisedRouter` | `mapping` | Authorized router addresses |

---

## Core functions

### splitToken

```solidity
function splitToken(address _counterparty, uint256 _amount)
    external nonReentrant whenNotPaused
```

**State:** ACTIVE only

Transfers `_amount` base from counterparty to pool. Mints `_amount / 2` DP and `_amount / 2` YB to counterparty. Caller must be counterparty or an authorized router.

**Split ratio:** 1 base = 0.5 DP + 0.5 YB

### unSplitTokens

```solidity
function unSplitTokens(address _counterparty, uint256 _amounts)
    external nonReentrant whenNotPaused
```

**State:** ACTIVE only

Burns `_amounts` DP and `_amounts` YB from counterparty. Returns `_amounts * 2` base minus redemption fee.

```
returnAmount = _amounts * 2
redemptionFee = (returnAmount * redemptionFeeBp) / 10000
finalAmount = returnAmount - redemptionFee
```

The redemption fee is the only fee charged. There is no success fee.

### redeemTokens

```solidity
function redeemTokens(address _counterparty, uint256 _amountDP, uint256 _amountYB)
    external nonReentrant whenNotPaused
```

**State:** REDEMPTIONS only

No depeg:
```
amountToSend = _amountDP + _amountYB
```

Depeg occurred:
```
amountToSend = (_amountDP * dpValue / 10000) + (_amountYB * ybValue / 10000)
```

Redemption fee is then applied to `amountToSend`. Users can redeem DP only, YB only, or both.

### resolvePriceDepeg

```solidity
function resolvePriceDepeg() external
```

**State:** RESOLUTION only. Permissionless.

Requires `block.timestamp - finalPriceData.timestamp >= minPriceAge`.

**Depeg detection:**
```
if hwmPrice > resolutionPrice:
    minPriceDrop = hwmPrice * 10 / 10000   // 0.1% threshold
    if (hwmPrice - resolutionPrice) >= minPriceDrop:
        principalDepeggedValue = resolutionPrice * 10000 / hwmPrice
        poolHasDepegged = true
```

**Value calculation:**

| Scenario | dpValue | ybValue |
|----------|---------|---------|
| No depeg | 10000 (100%) | 10000 (100%) |
| 100% depeg (principalDepeggedValue = 0) | 20000 (200%) | 0 (0%) |
| Partial depeg | min(10000^2 / principalDepeggedValue, 20000) | 20000 - dpValue |

Sets `depegResolved = true` (irreversible).

**Post-resolution allocation invariant:** dpValue + ybValue = 20000. Both values
are zero before resolution. DP is capped at 200%; actual asset backing also depends
on supported token behaviour and the privileged rescue rules below.

### Worked examples

**5% depeg** (resolutionPrice = 95% of hwmPrice):
```
principalDepeggedValue = 9500
dpValue = 100,000,000 / 9500 = 10526 (105.26%)
ybValue = 20000 - 10526 = 9474 (94.74%)

100 DP redeems for: 100 * 10526 / 10000 = 105.26 base
100 YB redeems for: 100 * 9474 / 10000 = 94.74 base
```

**50% depeg** (resolutionPrice = 50% of hwmPrice):
```
principalDepeggedValue = 5000
dpValue = min(100,000,000 / 5000, 20000) = 20000 (capped)
ybValue = 0

100 DP redeems for: 200 base
100 YB redeems for: 0 base
```

---

## Oracle function

### updatePriceData

```solidity
function updatePriceData(uint256 _hwmPrice, uint256 _resolutionPrice)
    external onlyOracle
```

**State:** COOLDOWN only

Sets both prices in a single call. Records `block.timestamp` alongside them.

- `_hwmPrice` must be within `[MIN_PRICE, MAX_PRICE]`
- `_resolutionPrice` must be `<= MAX_PRICE` (no lower bound -- can be 0 for severe depegs)

This is the only oracle function on DepegPool.

---

## Admin functions

| Function | Access | State restriction |
|----------|--------|-------------------|
| `proposeOracleChange(address)` | Admin | Always |
| `executeOracleChange()` | Anyone (after timelock) | Always |
| `setAuthorisedRouter(address, bool)` | Admin | Always |
| `setRedemptionFeeBp(uint8)` | Admin or Operator | Always |
| `setCooldownDuration(uint32)` | Admin | ACTIVE only |
| `setMinPriceAge(uint256)` | Admin | ACTIVE or COOLDOWN |
| `pause()` | Admin or Operator | Always |
| `unpause()` | Admin | Always |
| `rescueErc20(address, uint256)` | Admin or Operator | Always (timelock for core tokens) |

### Oracle change process

1. `proposeOracleChange(oracle)` -- in same-chain mode, validates the oracle implements `ITapirOracle` and its `cfg.depegPool` matches this pool; in cross-chain mode it skips those local code and interface checks. It sets a 7-day timelock.
2. `executeOracleChange()` -- callable by anyone after the timelock expires.

### Token rescue rules

Non-core tokens can be rescued immediately to TREASURY.

Core tokens (DP, YB, base asset) require 30 days to have elapsed since **either**:
- Scheduled resolution boundary (`startTime + poolActiveDuration + cooldownDuration`), OR
- `lastPauseTimestamp`

### sweepFeesToTreasury

```solidity
function sweepFeesToTreasury() external nonReentrant
```

**State:** REDEMPTIONS only. Can be called multiple times.

```
requiredForDp = dpSupply * dpValue / 10000
requiredForYb = ybSupply * ybValue / 10000
feeAmount = baseInContract - (requiredForDp + requiredForYb)
```

Transfers excess base to TREASURY.

---

## Access control

### Roles (OpenZeppelin AccessControl)

| Role | Capabilities |
|------|-------------|
| `DEFAULT_ADMIN_ROLE` | Oracle changes, router auth, cooldown/minPriceAge settings, pause/unpause, rescue, grant/revoke OPERATOR_ROLE |
| `OPERATOR_ROLE` | Set redemption fee, pause, rescue |

### Custom modifiers

| Modifier | Logic |
|----------|-------|
| `onlyOracle` | Same-chain: `msg.sender == oracle`. L2 mode: `msg.sender == xDomainMessengerL2` AND `xDomainMessageSender() == oracle` |
| `onlyAdminOrOperator` | Caller has DEFAULT_ADMIN_ROLE or OPERATOR_ROLE |

---

## Cross-domain support (L2)

When `xDomainMessengerL2 != address(0)`, oracle calls are validated via the Optimism CrossDomainMessenger pattern:

```
L1 Oracle → sendMessage() on L1 CrossDomainMessenger
  → relayed to L2
L2 CrossDomainMessenger → calls DepegPool.updatePriceData()
  → Pool checks msg.sender == xDomainMessengerL2
  → Pool checks xDomainMessageSender() == oracle
```

Compatible with the Optimism CrossDomainMessenger specification.

---

## DepegToken

Minimal ERC20 with `mint` and `burn` restricted to the deploying DepegPool via `onlyDepegPool` modifier. Decimals match the base asset. The pool address is set immutably as `msg.sender` in the constructor.

---

## Events

```solidity
// Core
event SplitToken(address indexed counterparty, uint256 amount);
event UnSplitTokens(address indexed counterparty, uint256 indexed amounts,
    uint256 baseReceived, uint256 totalFees);
event RedeemTokens(address indexed counterparty, uint256 indexed amountDP,
    uint256 indexed amountYB, uint256 baseReceived, uint256 feesPaid);

// Resolution
event DepegPriceResolved(bool indexed poolHasDepegged, uint256 depegSize, uint256 timestamp);
event PriceDataUpdated(uint256 newHwmPrice, uint256 newResolutionPrice);

// Admin
event OracleChangeProposed(address indexed newOracle, uint256 executeTime);
event OracleUpdated(address indexed newOracle);
event AuthorisedRouterUpdated(address indexed router, bool authorised);
event RedemptionFeeBpUpdated(uint256 newRate);
event CooldownDurationUpdated(uint256 newCooldown);
event MinPriceAgeUpdated(uint256 newMinAge);
event TreasuryFeeCollected(uint256 amount);

// Factory
event DeployDepeg(address indexed dpAsset, address indexed ybAsset,
    address indexed depegPool, uint256 poolActiveDuration);
```

`resolvePriceDepeg()` emits `principalDepeggedValue` as the second `DepegPriceResolved` argument, despite the interface parameter name `depegSize`; the value is zero both when no depeg is resolved and when a 100% depeg resolves.

---

## Error reference

| Error | Cause |
|-------|-------|
| `MustBeInActiveState` | Split/unsplit outside ACTIVE |
| `MustBeInCooldownState` | `updatePriceData()` outside COOLDOWN |
| `MustBeInResolutionState` | `resolvePriceDepeg()` in wrong state |
| `MustBeInRedemptionsState` | Redeem/sweep before resolution |
| `MustBeInActiveOrCooldownState` | `setMinPriceAge` outside ACTIVE/COOLDOWN |
| `UnauthorizedCaller` | Wrong caller for oracle, router, or counterparty check |
| `ZeroAmount` | Zero amount supplied to split, unsplit, or token rescue |
| `ZeroAddress` | Zero address provided |
| `NotAContract` | Address has no code |
| `PriceOutOfBounds` | Price outside allowed bounds |
| `PriceDataTooRecent` | Price data not aged enough for resolution |
| `InvalidOracleInterface` | Oracle does not implement ITapirOracle |
| `OracleDepegPoolMismatch` | Oracle's cfg.depegPool does not match this pool |
| `NoPendingOracle` | No oracle change proposed |
| `TimelockNotExpired` | Oracle change called too early |
| `CooldownOutOfBounds` | Cooldown outside [4h, 30d] |
| `MinAgeOutOfBounds` | minPriceAge outside [4h, 30d] |
| `TooEarlyToRescue` | Core token rescue before 30-day timelock |
