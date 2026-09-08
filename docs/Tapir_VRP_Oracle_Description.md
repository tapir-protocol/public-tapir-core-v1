# Tapir VRP oracle description

## Purpose

The VRP oracle is used when the protected asset depends on an ERC-4626 vault share price.

The base oracle already tracks the market price path of the protected asset. VRP adds a second signal:

```text
How many underlying assets would a fixed witness amount of vault shares redeem for?
```

This signal is sampled through:

```solidity
IERC4626(vault).previewRedeem(witnessShares)
```

If the vault's redeem-preview value falls below its robust high watermark by more than `errorTolerance`, the oracle reduces the final closing price before submitting settlement data to `DepegPool`.

---

## Terminology

| Term | Meaning |
|------|---------|
| VRP | Vault Redeem Preview |
| PRV | Preview Redemption Value, the current `previewRedeem(witnessShares)` value sampled at resolution |
| VRP HWM | Robust high watermark of historical preview values |
| `witnessShares` | Fixed share amount used for all preview quotes |
| `initialVrpPreview` | Constructor-time `previewRedeem(witnessShares)` value |
| `errorTolerance` | Absolute tolerance added to PRV before treating a VRP drop as impairment |

---

## Lifecycle

```
DEPLOYMENT
|
| Constructor records initialVrpPreview:
| - previewRedeem(witnessShares)
| - must be non-zero
| - becomes the scaling denominator
|
ACTIVE / NORMAL ORACLE OPERATION
|
| Operator records source prices as usual:
| - recordApi3Price()
| - recordChainlinkPrice()
| - recordRedStoneClassicPrice()
| - recordTellorPrice()
|
| Operator calls checkpoint():
| - base TapirOracle checkpoint is recorded
| - VRP preview checkpoint is recorded in the same transaction
|
RESOLUTION PREP
|
| Operator calls resolveVrp():
| - samples current PRV with previewRedeem(witnessShares)
| - marks vrpResolved if PRV is non-zero
| - enters manual mode if PRV is zero
|
PRICE DATA WRITE
|
| writePriceData(_gaslimit):
| - computes base HWM and base closing price
| - computes VRP HWM
| - adjusts HWM and closing price
| - sends adjusted values to DepegPool
```

---

## Deployment Parameters

`TapirVrpOracle` uses all normal `TapirOracle` constructor parameters plus:

```solidity
struct VaultConfig {
    address vault;
    uint256 witnessShares;
    uint256 errorTolerance;
}
```

Validation:

| Check | Rule |
|-------|------|
| Vault address | Must be non-zero |
| `witnessShares` | Must be at least `VRP_ACCURACY` |
| `initialVrpPreview` | Must be non-zero |
| `initialVrpPreview` size | Must fit into `uint192` |

Constants:

| Constant | Value | Description |
|----------|-------|-------------|
| `VRP_ACCURACY` | `10000` | Basis-point-style accuracy |
| `MAX_VRP_POINTS` | `400` | VRP ring-buffer capacity |

---

## Constructor Snapshot

On deployment, the oracle immediately samples the vault:

```solidity
initialVrpPreview = IERC4626(vault).previewRedeem(witnessShares)
```

It also pushes that initial preview value into the VRP ring buffer:

```solidity
VrpPoint {
    preview: initialVrpPreview,
    ts: block.timestamp
}
```

Purpose:

- Creates the initial reference value for scaling.
- Ensures later HWM and closing calculations can be expressed relative to the vault state at oracle deployment.
- Prevents division by zero in `writePriceData()`.

---

## Checkpoint Behavior

`TapirVrpOracle.checkpoint()` overrides the base oracle checkpoint:

```solidity
function checkpoint() public override onlyRole(OPERATOR_ROLE) {
    super.checkpoint();
    _checkpointVrp();
}
```

This means each successful checkpoint records two synchronized observations:

1. A base oracle price checkpoint from feed sources.
2. A VRP checkpoint from `previewRedeem(witnessShares)`.

`_checkpointVrp()`:

```solidity
currentPrv = IERC4626(vault).previewRedeem(witnessShares)
_pushVrpPoint(uint192(currentPrv), uint64(block.timestamp))
newHwm = persistedVrpHwm
```

Validation:

- `currentPrv` may be zero during checkpointing.
- `currentPrv` must fit into `uint192`.

---

## VRP Ring Buffer

VRP observations are stored separately from normal price checkpoints:

```solidity
struct VrpPoint {
    uint192 preview;
    uint64 ts;
}
```

The buffer is circular:

| Field | Meaning |
|-------|---------|
| `_vrpPoints` | Fixed array of 400 observations |
| `_vrpCount` | Number of valid VRP points, capped at 400 |
| `_vrpHead` | Next write index |

The initial constructor snapshot counts as the first VRP point.

---

## VRP High Watermark

`vrpHwm()` returns the maximum of `persistedVrpHwm` and `_vrpHighWatermarkPreview()`.

The VRP HWM reuses the same daily aggregation rules as the base oracle:

| VRP observations in UTC day | Daily representative preview |
|-----------------------------|------------------------------|
| 1 | That preview |
| 2 | Smaller preview |
| 3 or more | Median preview |

If there are at least 3 daily preview values:

$$
\mathrm{VRP\_HWM} = \max_i \left(\min(v_i, v_{i+1}, v_{i+2})\right)
$$

If there are fewer than 3 daily preview values in the current buffer, the candidate is zero and the VRP HWM is the persisted value. That value is initialized at deployment and retains any higher candidate finalized earlier:

```text
VRP_HWM = persistedVrpHwm
```

This fallback is different from the base price HWM, which reverts if fewer than 3 daily prices exist and no persisted HWM is available.

### Example: Spike Resistance

```text
Daily previews: [2.0, 3.0, 2.0, 2.0, 2.0]

Triplet mins:
- min(2.0, 3.0, 2.0) = 2.0
- min(3.0, 2.0, 2.0) = 2.0
- min(2.0, 2.0, 2.0) = 2.0

VRP HWM = 2.0
```

The one-day `3.0` spike does not increase the VRP HWM.

### Example: Sustained Growth

```text
Daily previews: [2.0, 2.5, 3.0, 3.5]

Triplet mins:
- min(2.0, 2.5, 3.0) = 2.0
- min(2.5, 3.0, 3.5) = 2.5

VRP HWM = 2.5
```

A sustained higher preview level increases the VRP HWM.

---

## Resolving VRP

Before price data can be written, VRP must be resolved:

```solidity
resolveVrp()
```

Access:

| Function | Caller |
|----------|--------|
| `resolveVrp()` | `OPERATOR_ROLE` |
| `manualBackupResolveVrp()` | `DEFAULT_ADMIN_ROLE` |

`resolveVrp()`:

1. Requires `OPERATOR_ROLE` and the oracle not to be paused.
2. Reverts if VRP is already resolved or manual mode is already forced.
3. Calls `_checkpointVrp()`, recording one more current preview observation.
4. Stores the current preview as `vrpPrv`.
5. If `vrpPrv == 0`, sets `forceManualResolve = true`, emits `MustResolveManually()`, and does not mark resolved.
6. Otherwise sets `vrpResolved = true` and emits `VrpResolved(vrpPrv)`.

Important:

- `resolveVrp()` does not transfer, redeem, deposit, or burn any vault shares.
- It is a read-only economic witness based on the ERC-4626 preview function, although the transaction mutates oracle state by saving the sampled value.

---

## Manual Backup Resolution

Manual backup is admin-only and can set the preview value directly at any time.

```solidity
manualBackupResolveVrp(uint256 _vrpPrv)
```

Rules:

| Condition | Result |
|-----------|--------|
| Caller is not admin | Revert via access control |

On success:

```solidity
vrpPrv = _vrpPrv
vrpResolved = true
emit VrpResolved(_vrpPrv)
```

Implementation note: manual backup does not validate `_vrpPrv`, does not require `forceManualResolve`, and can overwrite a previously resolved value.

---

## Price Data Writing

`writePriceData(uint32 _gaslimit)` overrides the base oracle.

Access requires `OPERATOR_ROLE`.

The oracle must not be paused.

It first requires:

```solidity
vrpResolved == true
```

Then it computes:

| Variable | Meaning |
|----------|---------|
| `hwmPrice` | Base oracle high watermark price |
| `closingPrice` | Base oracle closing price |
| `vrpHwmValue` | Robust VRP high watermark |
| `initialVrpPreview` | Deployment-time VRP reference |
| `vrpPrv` | Resolution-time preview redemption value |

### Adjusted HWM

The HWM is scaled by vault-preview growth versus the initial preview:

$$
P_{\text{hwm,adj}}
=
P_{\text{hwm}}
\times
\frac{\mathrm{VRP\_HWM}}{\mathrm{initialVrpPreview}}
$$

In Solidity:

```solidity
adjustedHwmPrice = Math.mulDiv(
    hwmPrice,
    vrpHwmValue,
    initialVrpPreview
)
```

### Adjusted Closing Price

The closing preview component is capped at VRP HWM and includes tolerance:

```solidity
effectiveClosingVrp =
    vrpPrv + errorTolerance < vrpHwmValue
        ? vrpPrv + errorTolerance
        : vrpHwmValue
```

Then:

$$
P_{\text{close,adj}}
=
P_{\text{close}}
\times
\frac{\min(\mathrm{PRV} + \epsilon,\ \mathrm{VRP\_HWM})}{\mathrm{initialVrpPreview}}
$$

In Solidity:

```solidity
adjustedClosingPrice = Math.mulDiv(
    closingPrice,
    effectiveClosingVrp,
    initialVrpPreview
)
```

Before delivery, the implementation caps each adjusted price at `IDepegPool(_cfg.depegPool).MAX_PRICE()`. It does not raise either adjusted price to `MIN_PRICE`: an adjusted HWM below that bound is rejected by `DepegPool.updatePriceData()`, while an adjusted closing price may be below it.

Finally:

```solidity
_sendPriceDataToDepegPool(adjustedHwmPrice, adjustedClosingPrice, _gaslimit)
```

---

## Why Both Prices Are Adjusted

The VRP oracle treats the final submitted price as:

```text
market-price component * vault-preview component
```

The base oracle price path captures external market movement.

The VRP path captures internal ERC-4626 vault share value movement.

Therefore:

- HWM uses the robust high watermark of both components.
- Closing uses the current resolved VRP value, with tolerance, capped at VRP HWM.

This allows the pool to resolve depegs caused by:

| Cause | Example |
|-------|---------|
| Market price drop only | Base oracle HWM > base closing, VRP unchanged |
| Vault preview drop only | Base HWM == base closing, PRV < VRP HWM |
| Both | Base price falls and PRV falls |

---

## Examples From Tests

### VRP Depeg Only

Initial:

```text
base HWM = 1.2
base closing = 1.2
initialVrpPreview = 2.0 * witnessShares
VRP HWM = 2.0 * witnessShares
PRV = 1.0 * witnessShares
errorTolerance = 1,000
```

Effective closing VRP:

```text
PRV + tolerance = 101,000
VRP HWM = 200,000
factor = 101,000 / 200,000 = 0.505
```

Result:

```text
adjustedHwm = 1.2
adjustedClosing = 1.2 * 0.505 = 0.606
```

With 6 asset decimals:

```text
hwmPrice = 1,200,000
resolutionPrice = 606,000
```

### Sustained Vault Growth

Initial:

```text
base HWM = 1.2
base closing = 1.2
initialVrpPreview = 2.0 * witnessShares
VRP HWM = 3.0 * witnessShares
PRV = 3.0 * witnessShares
```

Result:

```text
adjustedHwm = 1.2 * 3 / 2 = 1.8
adjustedClosing = 1.2 * 3 / 2 = 1.8
```

No depeg is introduced because both adjusted values move together.

### Combined Base Oracle and VRP Depeg

Initial:

```text
base HWM = 1.4
base closing = 1.0
initialVrpPreview = 2.0 * witnessShares
VRP HWM = 2.0 * witnessShares
PRV = 1.0 * witnessShares
factor with tolerance = 0.505
```

Result:

```text
adjustedHwm = 1.4
adjustedClosing = 1.0 * 0.505 = 0.505
```

With 6 asset decimals:

```text
hwmPrice = 1,400,000
resolutionPrice = 505,000
```

---

## Access Control Notes

| Function | Implemented access |
|----------|--------------------|
| `checkpoint()` | `OPERATOR_ROLE` |
| `resolveVrp()` | `OPERATOR_ROLE` |
| `manualBackupResolveVrp()` | `DEFAULT_ADMIN_ROLE` |
| `writePriceData()` | `OPERATOR_ROLE` after `vrpResolved` |

The implementation applies `onlyRole(OPERATOR_ROLE)` and adjusts both HWM and closing price.

---

## Failure Conditions

| Error | Trigger |
|-------|---------|
| `InvalidAddress()` | Base-oracle `admin` is zero at construction, the VRP vault is zero, or a non-cross-chain `setConfig()` call gives a zero `depegPool` |
| `InvalidVrpValues()` | `witnessShares < 10000`, the constructor-time preview is zero or exceeds `uint192`, or a checkpoint/resolve preview exceeds `uint192` |
| `VrpAlreadyResolved()` | `resolveVrp()` called after VRP has resolved |
| `VrpNotResolved()` | `writePriceData()` called before VRP resolution |
| `ManualResolveRequired()` | An unresolved `resolveVrp()` call is made after force-manual mode is set |
| `XChainModeNotSupported()` | A valid constructor config or a `setConfig()` call enables cross-chain mode; if the constructor config also leaves its required L1 messenger unset, base-constructor validation instead reverts with `MessengerNotConfigured()` first |

Inherited base-oracle errors still apply for price source recording, checkpointing, and HWM calculation; DepegPool price acceptance can also revert with the pool's errors. Cross-chain mode is not supported by `TapirVrpOracle`.

---

## Algorithm

```python
def constructor(vault, witness_shares, error_tolerance):
    assert vault != ZERO_ADDRESS
    assert witness_shares >= 10000

    initial = vault.previewRedeem(witness_shares)
    assert initial > 0
    assert initial <= uint192.max

    initial_vrp_preview = initial
    persisted_vrp_hwm = initial
    push_vrp_point(initial, block_timestamp)


def checkpoint():
    # inherited source-price checkpoint
    TapirOracle.checkpoint()

    # VRP checkpoint
    current_prv = vault.previewRedeem(witness_shares)
    assert current_prv <= uint192.max
    if utc_day(block_timestamp) > utc_day(latest_vrp_point.ts):
        persisted_vrp_hwm = max(persisted_vrp_hwm, vrp_hwm_candidate())
    push_vrp_point(current_prv, block_timestamp)


def vrp_hwm():
    daily = aggregate_vrp_points_to_utc_days()

    candidate = 0
    if len(daily) >= 3:
        candidate = max(
            min(daily[i], daily[i + 1], daily[i + 2])
            for i in range(0, len(daily) - 2)
        )

    return max(persisted_vrp_hwm, candidate)


def resolve_vrp():
    assert caller_has_operator_role()
    assert not paused
    assert not vrp_resolved
    assert not force_manual_resolve

    current_prv, _ = checkpoint_vrp()
    vrp_prv = current_prv

    if vrp_prv == 0:
        force_manual_resolve = True
        emit MustResolveManually()
        return

    vrp_resolved = True
    emit VrpResolved(vrp_prv)


def write_price_data(gas_limit):
    assert caller_has_operator_role()
    assert not paused
    assert vrp_resolved

    base_close = closing_price()
    base_hwm = max(persisted_hwm, high_watermark_price())
    assert base_hwm > 0
    hwm_vrp = vrp_hwm()

    adjusted_hwm = base_hwm * hwm_vrp // initial_vrp_preview

    effective_close_vrp = min(vrp_prv + error_tolerance, hwm_vrp)
    adjusted_close = base_close * effective_close_vrp // initial_vrp_preview

    adjusted_hwm = min(adjusted_hwm, depeg_pool.MAX_PRICE)
    adjusted_close = min(adjusted_close, depeg_pool.MAX_PRICE)

    send_price_data_to_depeg_pool(adjusted_hwm, adjusted_close, gas_limit)
```

---

## Summary

`TapirVrpOracle` adds ERC-4626 vault-share accounting risk to Tapir's oracle resolution.

It keeps the normal multi-source price oracle unchanged, but every checkpoint also records a `previewRedeem(witnessShares)` quote. At resolution, it compares the current preview value against a robust preview HWM. Final submitted prices are scaled by the vault-preview component, so the DepegPool can capture depegs caused by external market price changes, internal vault share-value changes, or both.
