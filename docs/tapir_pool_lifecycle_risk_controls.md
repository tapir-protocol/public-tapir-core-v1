# DepegPool lifecycle and risk controls

## Purpose

Analysis of the DepegPool lifecycle for security auditors, focusing on temporal controls, oracle risks, and the defense layers that prevent manipulation during resolution.

---

## Lifecycle timeline

```
DEPLOYMENT
│  Factory validates:
│  - Asset address, and oracle address in same-chain mode, are valid contracts
│  - MIN_PRICE > 0, MAX_PRICE > MIN_PRICE
│  Factory and constructor validate:
│  - poolActiveDuration > 0
│  - cooldownDuration and minPriceAge within [4 hours, 30 days]
│
T0 ─────────────────────────────────────────────────────────
│   ACTIVE state begins
│   startTime = block.timestamp
│
│   User operations:
│   - splitToken(): base → DP + YB
│   - unSplitTokens(): DP + YB → base (minus redemption fee)
│
│   Admin operations:
│   - setCooldownDuration() [ACTIVE only]
│   - setMinPriceAge() [ACTIVE or COOLDOWN]
│
T1 = T0 + poolActiveDuration ───────────────────────────────
│   COOLDOWN state begins
│   Pool split, unsplit, and redemption operations are unavailable
│
│   Oracle sets final prices:
│   - updatePriceData(_hwmPrice, _resolutionPrice)
│     Both prices in a single call
│     Records block.timestamp
│     hwmPrice must be within [MIN_PRICE, MAX_PRICE]
│     resolutionPrice must be <= MAX_PRICE (no lower bound)
│
│   Waiting for:
│   - cooldownDuration to elapse
│   - Price data to be set
│
T2 = T1 + cooldownDuration (if final price data is set) ───
│   RESOLUTION state begins
│
│   Additional wait:
│   - finalPriceData.timestamp + minPriceAge must have passed
│
│   Earliest resolution:
│   MAX(
│     T0 + poolActiveDuration + cooldownDuration,
│     finalPriceData.timestamp + minPriceAge
│   )
│
│   resolvePriceDepeg() [permissionless]
│   - Calculates depeg size
│   - Sets dpValue and ybValue
│   - Sets depegResolved = true (irreversible)
│
T3 = resolution complete ───────────────────────────────────
│   REDEMPTIONS state begins
│
│   User operations:
│   - redeemTokens(): burn DP/YB for base
│   - sweepFeesToTreasury(): send accumulated fees to treasury
│
│   Blocked:
│   - Cannot resolve again
│   - Cannot split/unsplit
│   - Cannot update price data
│
T1 + cooldownDuration + 30 days ────────────────────────────
│   Core-token rescue becomes available
│   (or earlier, 30 days after the latest pause while the pool remains paused)
│   onlyAdminOrOperator can transfer DP, YB, or base asset to TREASURY
│   (Non-core tokens are also onlyAdminOrOperator, but have no time delay)
```

---

## Temporal security controls

### 1. Cooldown duration

**Allowed range:** 4 hours to 30 days (configurable by admin, ACTIVE state only)

Creates a mandatory waiting period after pool expiry before the pool can enter RESOLUTION.

```
Pool expiry → [cooldown period] → resolution becomes possible
```

The configured period is part of the state-transition condition.

### 2. Minimum price age (minPriceAge)

**Range:** 4 hours to 30 days (configurable by admin, ACTIVE or COOLDOWN only)

Prevents resolution until the submitted price data has reached the configured age.

```
Oracle sets prices → [aging period] → prices usable in resolution
```

The timestamp is recorded when `updatePriceData()` is called. Resolution requires:
```solidity
block.timestamp - finalPriceData.timestamp >= minPriceAge
```

If the oracle updates price data multiple times during cooldown, the timestamp resets to the latest call. This means each update restarts the aging clock.

### 3. Combined temporal conditions

```
Layer 1: Pool expiry           (fixed at deployment)
Layer 2: Cooldown duration     (configurable delay, admin-controlled)
Layer 3: Price data aging      (observation window since price submission)
Layer 4: Validation checks     (bounds, depeg threshold)
```

Minimum total delay from pool expiry to resolution:
```
= MAX(cooldownDuration, time_from_price_set_to_age_requirement)

If oracle sets prices at T1 (expiry) and cooldown = minPriceAge = 5h:
  - Cooldown ends at T1 + 5h
  - Prices are 5h old at T1 + 5h
  - Resolution possible at T1 + 5h

If oracle sets prices 2h after expiry:
  - Cooldown ends at T1 + 5h
  - Prices age 5h at T1 + 7h
  - Resolution possible at T1 + 7h
```

---

## Oracle risk controls

### Control 1: oracle timelock (7 days)

Two-step oracle replacement with mandatory 7-day delay:

1. `proposeOracleChange(_oracle)` -- in same-chain mode, validates interface and pool match; in cross-chain mode it skips those local checks and sets the unlock time
2. `executeOracleChange()` -- callable by anyone after 7 days

The pending oracle cannot replace the current oracle before the timelock expires.

### Control 2: price bounds

`updatePriceData()` validates:
- `hwmPrice` within `[MIN_PRICE, MAX_PRICE]` (both immutable, set at deployment)
- `resolutionPrice` within `[0, MAX_PRICE]` (no lower bound to allow severe depegs)

These bounds catch extreme price manipulation while allowing the full range of legitimate depeg scenarios.

### Control 3: depeg threshold

A nominal 0.1% price drop is required to register as a depeg:
```solidity
minPriceDrop = hwmPrice * 10 / 10000
```

The calculation uses integer division, so the threshold is rounded down (and is zero when `hwmPrice < 1000`). Deployments should account for that rounding at their configured price scale.

### Control 4: one-time resolution

```solidity
depegResolved = true  // set once, irreversible
```

Once `resolvePriceDepeg()` succeeds, the result cannot be changed. No re-resolution with different prices is possible.

---

The configured oracle can overwrite price data while the pool remains in COOLDOWN. Each successful update replaces the prior data and records a new timestamp, so the age condition applies to the replacement.

---

## Access gates

- `DEFAULT_ADMIN_ROLE` gates `proposeOracleChange()`, `setAuthorisedRouter()`, `setCooldownDuration()`, `setMinPriceAge()`, and `unpause()`.
- `onlyAdminOrOperator` gates `setRedemptionFeeBp()`, `pause()`, and `rescueErc20()`.
- `onlyOracle` gates `updatePriceData()`: in same-chain mode it requires the configured oracle directly; in cross-chain mode it requires the configured L2 messenger and that messenger's L1 sender to equal the configured oracle.
- `executeOracleChange()`, `resolvePriceDepeg()`, and `sweepFeesToTreasury()` are permissionless, subject to their respective time/state checks. `splitToken()`, `unSplitTokens()`, and `redeemTokens()` require the counterparty itself or an authorised router.
- `DepegFactory.deployDepeg()` is restricted to the factory `owner`; the pool constructor grants `DEFAULT_ADMIN_ROLE` to `poolOwner` and initially grants no `OPERATOR_ROLE`.

---

## State transition invariants

**Invariant 1:** `depegResolved` is one-way (false to true, never back)

**Invariant 2:** `poolHasDepegged` is only set during `resolvePriceDepeg()` and locked once `depegResolved` is true

**Invariant 3:** Pool activity is time-bound and deterministic
```
Active when: block.timestamp < startTime + poolActiveDuration
Cannot be extended or reset
```

**Invariant 4:** dpValue + ybValue = 20000 always holds after resolution

**Invariant 5:** After resolution, DP value is capped at 20,000 basis points.

---

## Defense layers summary

| Layer | Mechanism |
|-------|-----------|
| Access control | Admin/operator/oracle role separation |
| Temporal | Cooldown duration + price aging + oracle timelock |
| Value bounds | MIN_PRICE/MAX_PRICE + depeg threshold formula + DP 200% cap |
| State protection | One-way resolution flag, reentrancy guard, pausable |
| Arithmetic | Solidity 0.8.27 overflow checks, explicit bound validation |

---
