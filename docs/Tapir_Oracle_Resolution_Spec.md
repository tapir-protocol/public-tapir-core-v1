# Tapir oracle resolution spec

## Overview

Tapir resolution is a two-contract process:

1. **TapirOracle records source prices and checkpoints.**
   - Operators record latest prices from active oracle feeds.
   - Operators call `checkpoint()` to resolve those feed prices into one robust checkpoint price.
   - The oracle stores checkpoints in a ring buffer.

2. **TapirOracle computes final prices and writes them to DepegPool.**
   - `hwmPrice`: robust high watermark over historical daily prices.
   - `resolutionPrice`: robust closing price near maturity.
   - `writePriceData()` sends both values to `DepegPool.updatePriceData()`.

3. **DepegPool resolves the depeg.**
   - After cooldown and price-aging requirements are satisfied, anyone can call `resolvePriceDepeg()`.
   - The pool compares `resolutionPrice` to `hwmPrice`.
   - If the price drop is at least 0.1%, DP/YB redemption values are adjusted.

---

## Resolution Timeline

```
ACTIVE
|
| Operators keep oracle updated:
| - recordApi3Price()
| - recordChainlinkPrice()
| - recordRedStoneClassicPrice()
| - recordTellorPrice()
| - checkpoint()
|
T1 = pool start + poolActiveDuration
|
COOLDOWN
|
| Oracle writes final price data:
| - writePriceData(_gaslimit)
| - DepegPool.updatePriceData(_hwmPrice, _resolutionPrice)
|
| Same-chain: finalPriceData.timestamp = block.timestamp of the direct pool call.
| Cross-chain: finalPriceData.timestamp = block.timestamp of the L2 message execution.
|
T2 = pool start + poolActiveDuration + cooldownDuration
| (RESOLUTION begins only after final price data is set)
|
RESOLUTION
|
| Additional price age condition:
| - block.timestamp - finalPriceData.timestamp >= minPriceAge
|
| Anyone can call:
| - resolvePriceDepeg()
|
REDEMPTIONS
```

Earliest final resolution:

```text
max(
  pool.startTime + pool.poolActiveDuration + pool.cooldownDuration,
  pool.finalPriceData.timestamp + pool.minPriceAge
)
```

---

## Price Sources

The base oracle supports four source slots:

| Source | Read method | Timestamp used | Notes |
|--------|-------------|----------------|-------|
| API3 ReaderProxy V1 | `read()` | API3 feed timestamp | Returns signed value and timestamp |
| Chainlink AggregatorV3 | `latestRoundData()` | `updatedAt` | Standard Chainlink-compatible interface |
| RedStone Classic | `latestRoundData()` | `updatedAt` | Chainlink-compatible push feed |
| Tellor adaptor | `latestRoundData()` | `updatedAt` | Chainlink-compatible adaptor |

All source prices are normalized into the protected asset's native decimals.

Example:

```text
sourceDecimals = 8
assetDecimals = 18
storedPrice = sourcePrice * 10^(18 - 8)
```

---

## Source Recording

Each source has its own recording function:

| Function | Required role | Source gate |
|----------|---------------|-------------|
| `recordApi3Price()` | `OPERATOR_ROLE` | `api3ReaderProxyV1IsActive` |
| `recordChainlinkPrice()` | `OPERATOR_ROLE` | `chainlinkAggregatorV3IsActive` |
| `recordRedStoneClassicPrice()` | `OPERATOR_ROLE` | `redStoneClassicIsActive` |
| `recordTellorPrice()` | `OPERATOR_ROLE` | `tellorIsActive` |

Each recording function also requires the oracle not to be paused.

### Validation

The source configuration and recording logic validate:

- Source is active.
- An active source has a non-zero configured address (enforced when sources are set).
- Price is greater than zero.
- Timestamp is non-zero.
- Timestamp is not in the future.
- Timestamp is not older than the previous timestamp recorded for that same source.
- Normalized price fits into `uint192`.

If valid, the source-specific latest price slot is updated:

```solidity
PriceData {
    price: normalizedPrice,
    asOfTs: sourceTimestamp
}
```

Implementation note:

- Source active flags are enforced when recording a source price.
- `checkpoint()` checks the source active flag, non-zero price, and staleness.

---

## Checkpoint Resolution

`checkpoint()` is the core feed-resolution step. It converts the latest source slots into a single checkpoint price.

Access and timing:

| Check | Rule |
|-------|------|
| Role | `OPERATOR_ROLE` |
| Pausing | Reverts while oracle is paused |
| Spacing | `block.timestamp >= lastCheckpointTs + minCheckpointSpacing` |
| Minimum sources | `1 <= minValidSources <= 4` |

### Valid Source Filter

At checkpoint time, a source is valid if:

```text
source.isActive
and
source.price > 0
and
block.timestamp < source.asOfTs + source.maxStaleness
```

Each source uses its own max staleness parameter:

| Source | Staleness field |
|--------|-----------------|
| API3 | `api3ReaderProxyV1MaxStaleness` |
| Chainlink | `chainlinkAggregatorV3MaxStaleness` |
| RedStone Classic | `redStoneClassicMaxStaleness` |
| Tellor | `tellorMaxStaleness` |

If `validCount < minValidSources`, checkpointing reverts with `NotEnoughValidSources()`.

### Price Selection

| Valid source count | Checkpoint price rule |
|--------------------|-----------------------|
| 4 | Average of the two middle prices |
| 3 | Median price |
| 2 | Price closer to previous checkpoint; if no previous checkpoint, average |
| 1 | The single source price |
| 0 | Revert unless `minValidSources` is incorrectly set to 0, which is also rejected |

For 4 sources:

```text
sorted = [p0, p1, p2, p3]
checkpointPrice = (p1 + p2) / 2
```

For 2 sources with history:

```text
checkpointPrice =
  abs(p0 - previousCheckpoint) < abs(p1 - previousCheckpoint)
  ? p0
  : p1
```

Ties choose the second valid source because the implementation uses `diff1 <= diff0`.

### Checkpoint Storage

The resolved checkpoint is written to a circular ring buffer:

```solidity
PricePoint {
    price: checkpointPrice,
    ts: uint64(block.timestamp)
}
```

| Field | Value |
|-------|-------|
| `MAX_POINTS` | 400 |
| `_count` | Number of valid checkpoints, capped at 400 |
| `_head` | Next ring-buffer write index |
| `lastCheckpointTs` | Timestamp of last successful checkpoint |

The checkpoint timestamp is the block timestamp of the checkpoint transaction, not the source feed timestamp.

---

## Daily Price Aggregation

Final price calculations do not use raw checkpoints directly. They first aggregate checkpoints into daily representative prices.

Day boundary:

```text
dayStart = timestamp - (timestamp % 86400)
```

This means days are UTC days starting at 00:00:00.

### Representative Price Per Day

For all checkpoints in the same UTC day:

| Checkpoints in day | Daily representative price |
|--------------------|----------------------------|
| 1 | That price |
| 2 | The smaller price |
| 3 or more | Median of that day's prices |

For an even median, the implementation averages the two middle values.

Example:

| Day | Raw checkpoints | Daily representative |
|-----|-----------------|----------------------|
| 1 | `[1.00]` | `1.00` |
| 2 | `[0.98, 0.96]` | `0.96` |
| 3 | `[0.92, 0.95, 0.90]` | `0.92` |
| 4 | `[0.88, 0.94, 0.91, 0.85]` | `(0.88 + 0.91) / 2 = 0.895` |
| 5 | `[0.80, 0.87, 0.83, 0.89, 0.81]` | `0.83` |

Daily representative array:

```text
[1.00, 0.96, 0.92, 0.895, 0.83]
```

---

## High Watermark Price

The high watermark price captures the highest price level that was robustly held across three consecutive daily observations.

It is calculated from all available daily representative prices in chronological order:

$$
P_{\text{hwm}} = \max_i \left(\min(p_i, p_{i+1}, p_{i+2})\right)
$$

Requirements:

- At least 3 daily representative prices are required to compute an HWM candidate.
- If no persisted HWM exists and fewer than 3 daily prices are available, `writePriceData()` reverts through `InsufficientCheckpointsForHWM()`.

Example:

```text
Daily prices: [1.00, 0.96, 0.92, 0.895, 0.83]

Triplet 1: min(1.00, 0.96, 0.92)  = 0.92
Triplet 2: min(0.96, 0.92, 0.895) = 0.895
Triplet 3: min(0.92, 0.895, 0.83) = 0.83

High watermark = max(0.92, 0.895, 0.83) = 0.92
```

Purpose:

- Ignores one-day upward spikes.
- Requires a price level to appear in three adjacent observed UTC-day representatives.
- Still selects the highest robustly observed level over the pool life.

Days without checkpoints are omitted. The three observations need not be on consecutive
calendar days, and the latest observed day may still be in progress.

---

## Closing / Resolution Price

The closing price is the robust reference price near pool maturity. It becomes `resolutionPrice` in the pool.

### Lookback Count

The oracle first counts checkpoints whose timestamps are inside the configured lookback window:

```text
checkpoint.ts > block.timestamp - closingPriceLookbackPeriod
```

Then it applies a hard minimum:

```text
requestedCount = max(checkpointsInsideLookback, MIN_CHECKPOINTS_FOR_MEDIAN)
```

where:

```text
MIN_CHECKPOINTS_FOR_MEDIAN = 5
```

If fewer than `requestedCount` checkpoints exist, the implementation uses all available checkpoints. This means the minimum requests at least 5 recent checkpoints when available, but it does not require 5 checkpoints to exist.

The lookback is not a maximum permitted observation age. If no checkpoints are inside
it, price writing can still use the last available checkpoints. Operators must check
freshness before submitting final prices; the pool timestamps submission, not the
underlying observations.

### Closing Calculation

1. Retrieve the latest `requestedCount` checkpoints, newest first.
2. Aggregate them into daily representative prices.
3. Return the median of those daily representative prices.

Formally:

$$
P_{\text{close}} = \mathrm{median}(D_1, D_2, \dots, D_n)
$$

Where each \(D_i\) is a daily representative price derived from the selected checkpoint window.

Example:

```text
Daily representatives: [1.00, 0.96, 0.92, 0.895, 0.83]
Sorted: [0.83, 0.895, 0.92, 0.96, 1.00]

Closing price = 0.92
```

Important nuance:

- If 24 hourly checkpoints happen inside one UTC day, they aggregate into one daily representative price.
- In that case, the closing price can be the median of that single day, not the median of 24 separate final observations.

---

## Writing Price Data

The base oracle exposes:

```solidity
writePriceData(uint32 _gaslimit)
```

This payable function requires `OPERATOR_ROLE` and that `TapirOracle` is not paused.

Flow:

1. Calculate `hwmPrice` using the high-watermark triplet algorithm.
2. Calculate `closingPrice` using recent daily representative prices.
3. Send both values to `DepegPool.updatePriceData(_hwmPrice, _resolutionPrice)`.

### Same-Chain Mode

If:

```text
cfg.xChainMode == false
```

then the oracle calls the pool directly:

```solidity
IDepegPool(cfg.depegPool).updatePriceData(_hwmPrice, _resolutionPrice)
```

### Cross-Chain Mode

If:

```text
cfg.xChainMode == true
```

then the oracle sends an L1-to-L2 message:

```solidity
ICrossDomainMessenger(cfg.xDomainMessengerL1).sendMessage{value: msg.value}(
    cfg.depegPool,
    abi.encodeWithSelector(IDepegPool.updatePriceData.selector, hwmPrice, closingPrice),
    _gaslimit
)
```

The L2 pool accepts the call only if:

```text
msg.sender == xDomainMessengerL2
and
xDomainMessengerL2.xDomainMessageSender() == oracle
```

If cross-chain mode is enabled and `xDomainMessengerL1` is zero, the oracle reverts with `MessengerNotConfigured()`.

---

## DepegPool Price Acceptance

`DepegPool.updatePriceData()` can only be called:

- by the configured oracle, or
- through the configured L2 cross-domain messenger from the configured L1 oracle.

It can only run during COOLDOWN.

Validation:

| Price | Bound |
|-------|-------|
| `hwmPrice` | `MIN_PRICE <= hwmPrice <= MAX_PRICE` |
| `resolutionPrice` | `resolutionPrice <= MAX_PRICE` |

There is no lower bound on `resolutionPrice`, so a severe depeg can resolve down to zero.

On success:

```solidity
finalPriceData = PriceData({
    hwmPrice: _hwmPrice,
    resolutionPrice: _resolutionPrice,
    timestamp: block.timestamp
})
```

Calling `updatePriceData()` again during COOLDOWN overwrites the previous values and resets `finalPriceData.timestamp`.

---

## Final Depeg Resolution

`resolvePriceDepeg()` is permissionless. Any address may call it once the pool is in RESOLUTION state.

Requirements:

| Requirement | Rule |
|-------------|------|
| Pool state | `getState() == RESOLUTION` |
| Price age | `block.timestamp - finalPriceData.timestamp >= minPriceAge` |
| One-time settlement | `depegResolved == false` implied by state |

### Depeg Detection

A depeg is detected only if:

```text
hwmPrice > resolutionPrice
and
hwmPrice - resolutionPrice >= hwmPrice * 10 / 10000
```

This is a nominal 0.1% minimum price-drop threshold. Integer division rounds the threshold down; when `hwmPrice < 1000`, the computed threshold is zero, so any strictly lower resolution price meets this check.

If the drop is below the computed `minPriceDrop`, no depeg is recorded.

### Principal Depegged Value

If the depeg threshold is met:

$$
\mathrm{principalDepeggedValue}
=
\frac{P_{\text{resolution}} \times 10000}{P_{\text{hwm}}}
$$

In Solidity:

```solidity
principalDepeggedValue = uint16(
    (finalPriceData.resolutionPrice * 10000) / finalPriceData.hwmPrice
)
```

Examples:

| HWM | Resolution | Principal value | Depeg size |
|-----|------------|-----------------|------------|
| `1.00` | `1.00` | `0` (unset; no depeg) | `0%` |
| `1.00` | `0.99` | `9900` | `1%` |
| `1.00` | `0.80` | `8000` | `20%` |
| `1.00` | `0.00` | `0` | `100%` |

After this, the pool sets:

```solidity
poolHasDepegged = true
```

If no depeg is detected, `poolHasDepegged` remains false.

---

## Redemption Values

After depeg detection, `_calculateRedeemValues()` sets the final DP and YB values.

### No Depeg

```text
dpValue = 10000
ybValue = 10000
```

Both tokens redeem 1:1 for base asset before the redemption fee.

### Depeg

DP gains value and YB loses value.

```text
dpValue = 10000 * 10000 / principalDepeggedValue
ybValue = 20000 - dpValue
```

DP value is capped at 20000, or 200%.

If:

```text
principalDepeggedValue == 0
or
rawDpValue >= 20000
```

then:

```text
dpValue = 20000
ybValue = 0
```

Examples:

| Depeg | Principal value | DP value | YB value |
|-------|-----------------|----------|----------|
| 0% | 0 (unset; no depeg) | 10000 | 10000 |
| 20% | 8000 | 12500 | 7500 |
| 40% | 6000 | 16666 | 3334 |
| 50% or worse | 5000 or less | 20000 | 0 |
| 100% | 0 | 20000 | 0 |

Finalization:

```solidity
depegResolved = true
```

This moves the pool into REDEMPTIONS state and cannot be undone.

---

## Parameters

### TapirOracle Config

| Parameter | Type | Description |
|-----------|------|-------------|
| `minCheckpointSpacing` | `uint32` | Minimum seconds between checkpoints |
| `minValidSources` | `uint8` | Minimum valid source count required for checkpoint (1–4) |
| `closingPriceLookbackPeriod` | `uint32` | Seconds to look back for closing price checkpoints |
| `depegPool` | `address` | Pool that receives final price data |
| `xChainMode` | `bool` | Whether to send final data through L1 messenger |
| `xDomainMessengerL1` | `address` | L1 messenger used in cross-chain mode |

### TapirOracle Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_POINTS` | 400 | Ring-buffer capacity |
| `MIN_CHECKPOINTS_FOR_MEDIAN` | 5 | Minimum requested recent checkpoints for closing price |

### DepegPool Resolution Parameters

| Parameter | Description |
|-----------|-------------|
| `poolActiveDuration` | Non-zero active trading period from deployment |
| `cooldownDuration` | Delay after active period before resolution can begin |
| `minPriceAge` | Minimum age of final oracle price data before resolution |
| `MIN_PRICE` | Lower bound for `hwmPrice` |
| `MAX_PRICE` | Upper bound for `hwmPrice` and `resolutionPrice` |

`poolActiveDuration` must be non-zero. `cooldownDuration` and `minPriceAge` must be between 4 hours and 30 days; both the factory and the pool constructor enforce these deployment constraints.

---

## PTRW Oracle Variant

`TapirPtrwOracle` extends `TapirOracle` for Pendle PT redemption witness logic.

Additional resolution flow:

1. PT tokens are held by the oracle before `resolvePtrw()` is called.
2. After PT maturity, an operator calls `resolvePtrw()`.
3. The oracle records:
   - `ptrwErv`: expected redemption value, equal to PT balance before redemption.
   - `ptrwArv`: actual base token received from Pendle redemption.
4. If ARV is zero, the oracle sets force-manual mode; an admin can manually resolve or clear that mode with `resetForceManualResolve()`.
5. `writePriceData()` requires `ptrwResolved == true`.

Automated resolution does not check `ptrwResolved` on entry. If more PT is supplied later, an
operator can call `resolvePtrw()` again and overwrite the recorded ERV and ARV.

PTRW adjustment:

```text
if ptrwArv + errorTolerance < ptrwErv:
    ptrwDepeg = (ptrwArv + errorTolerance) * 10000 / ptrwErv
else:
    ptrwDepeg = 10000

adjustedClosingPrice = closingPrice * ptrwDepeg / 10000
```

The HWM price is not adjusted by PTRW. Only the closing price is reduced when the PT redemption witness shows impairment beyond tolerance.

Access note:

- Base `TapirOracle.writePriceData()` is operator-gated.
- `TapirPtrwOracle.writePriceData()` is operator-gated.

---

## VRP Oracle Variant

`TapirVrpOracle` extends `TapirOracle` for ERC-4626 vault redeem-preview logic.

Additional checkpointing:

- Each `checkpoint()` records both:
  - normal source price checkpoint, and
  - `previewRedeem(witnessShares)` as a VRP observation.

Constructor snapshot:

```text
initialVrpPreview = vault.previewRedeem(witnessShares)
```

VRP HWM:

- Derived from VRP observations using the same daily aggregation and triplet HWM rule as the base price oracle.
- If fewer than 3 daily VRP observations exist, it uses the persisted HWM, which is initialized to `initialVrpPreview`.

Resolution flow:

1. Operator calls `resolveVrp()`.
2. Oracle samples current PRV using `previewRedeem(witnessShares)`.
3. If PRV is zero, manual resolution is required.
4. `writePriceData()` requires `vrpResolved == true`.

VRP adjustment:

```text
adjustedHwmPrice =
  hwmPrice * vrpHwm / initialVrpPreview

effectiveClosingVrp =
  min(vrpPrv + errorTolerance, vrpHwm)

adjustedClosingPrice =
  closingPrice * effectiveClosingVrp / initialVrpPreview
```

Before delivery, `TapirVrpOracle` caps both adjusted prices at `DepegPool.MAX_PRICE`; it does not floor them at `MIN_PRICE`. `TapirVrpOracle` rejects cross-chain mode at construction (subject to the base constructor's messenger validation) and in `setConfig()`.

Unlike PTRW, VRP adjusts both HWM and closing price.

---

## Failure Conditions

### Source Configuration and Recording Reverts

| Error | Meaning |
|-------|---------|
| `SourceNotActive()` | Source active flag is false |
| `SourceNotConfigured()` | An active source is configured with a zero address |
| `InvalidPrice()` | Source returned zero or negative price |
| `InvalidTimestamp()` | Source timestamp is zero |
| `FutureTimestamp()` | Source timestamp is greater than current block timestamp |
| `TimestampOlderThanLatest()` | Source timestamp regressed |
| `PriceExceedsMax()` | Normalized price does not fit into `uint192` |

### Checkpoint Reverts

| Error | Meaning |
|-------|---------|
| `CheckpointTooSoon()` | `minCheckpointSpacing` has not elapsed |
| `InvalidMinValidSources()` | A configured value is zero or greater than four; checkpointing also rejects zero |
| `NotEnoughValidSources()` | Fewer valid, non-stale source prices than required |

### Price Writing Reverts

| Error | Meaning |
|-------|---------|
| `InsufficientCheckpointsForHWM()` | No persisted HWM and fewer than 3 daily prices for an HWM candidate |
| `MessengerNotConfigured()` | Cross-chain mode enabled but L1 messenger unset |
| `MustBeInCooldownState()` | Pool is not in COOLDOWN when final prices are written |
| `PriceOutOfBounds()` | HWM or resolution price violates pool bounds |

### Final Resolution Reverts

| Error | Meaning |
|-------|---------|
| `MustBeInResolutionState()` | Pool is not ready for resolution |
| `PriceDataTooRecent()` | `minPriceAge` has not elapsed since price submission |

---

## Algorithm

```python
def record_source_price(source):
    assert caller_has_operator_role()
    assert source.is_active
    assert source.address != ZERO

    price, source_ts = source.read()

    assert price > 0
    assert source_ts != 0
    assert source_ts <= block_timestamp
    assert source_ts >= latest[source].as_of_ts

    normalized = normalize_decimals(price, source.decimals, asset_decimals)
    assert normalized <= uint192.max

    latest[source] = PriceData(normalized, source_ts)


def checkpoint():
    assert caller_has_operator_role()
    assert not paused
    assert block_timestamp >= last_checkpoint_ts + min_checkpoint_spacing
    assert min_valid_sources > 0

    valid = []
    for source in sources:
        latest_price = latest[source]
        if source.is_active and latest_price.price > 0 and block_timestamp < latest_price.as_of_ts + source.max_staleness:
            valid.append(latest_price.price)

    assert len(valid) >= min_valid_sources

    if len(valid) >= 3:
        checkpoint_price = median(valid)
    elif len(valid) == 2:
        if checkpoints_exist:
            checkpoint_price = price_closer_to_previous_checkpoint(valid)
        else:
            checkpoint_price = average(valid[0], valid[1])
    else:
        checkpoint_price = valid[0]

    if checkpoints_exist and utc_day(block_timestamp) > utc_day(previous_checkpoint.ts):
        persisted_hwm = max(persisted_hwm, high_watermark_price(all_checkpoints))

    ring_buffer.push(PricePoint(checkpoint_price, block_timestamp))
    last_checkpoint_ts = block_timestamp


def daily_representative(day_prices):
    if len(day_prices) == 1:
        return day_prices[0]
    if len(day_prices) == 2:
        return min(day_prices)
    return median(day_prices)


def high_watermark_price(all_checkpoints):
    daily = aggregate_to_utc_days(all_checkpoints)
    if len(daily) < 3:
        return 0

    return max(
        min(daily[i], daily[i + 1], daily[i + 2])
        for i in range(0, len(daily) - 2)
    )


def closing_price(recent_checkpoints):
    requested_count = max(
        count_checkpoints_inside_lookback(),
        MIN_CHECKPOINTS_FOR_MEDIAN
    )

    selected = newest_checkpoints(requested_count)
    daily = aggregate_to_utc_days(selected)
    assert len(daily) > 0

    return median(daily)


def write_price_data(_gaslimit):
    assert caller_has_operator_role()
    assert not paused

    hwm = max(persisted_hwm, high_watermark_price(all_checkpoints))
    assert hwm > 0
    close = closing_price(recent_checkpoints)
    send_price_data_to_depeg_pool(hwm, close, _gaslimit)


def resolve_price_depeg():
    assert pool_state == RESOLUTION
    assert block_timestamp - final_price_data.timestamp >= min_price_age

    if hwm_price > resolution_price:
        min_drop = hwm_price * 10 // 10000
        if hwm_price - resolution_price >= min_drop:
            principal_depegged_value = resolution_price * 10000 // hwm_price
            pool_has_depegged = True

    calculate_dp_yb_values()
    depeg_resolved = True
```

---

## Operational Notes

- Recording and checkpointing are operator-gated to reduce adversarial timing.
- Final base oracle price writing is operator-gated.
- Pool resolution is permissionless once all state and timing requirements are met.
- Price data can be overwritten during COOLDOWN, but each overwrite resets the price-aging clock.
- Oracle replacement in `DepegPool` is protected by a 7-day timelock and, in same-chain mode, validates that the new oracle points back to the same pool.
- The pool does not call back into the oracle during `resolvePriceDepeg()`. It only reads the already submitted `finalPriceData`.
