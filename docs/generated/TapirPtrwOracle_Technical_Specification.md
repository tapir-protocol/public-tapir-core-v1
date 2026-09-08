# TapirPtrwOracle technical specification

**Source:** `contracts/TapirPtrwOracle.sol`
**Solidity:** ^0.8.27
**License:** BUSL-1.1

---

## Overview

TapirPtrwOracle extends TapirOracle with Pendle Principal Token Redemption Witness (PTRW) functionality. It observes whether Pendle PT redemptions returned less base token than expected. If they did, it applies a depeg factor to the closing price before forwarding to the DepegPool. The HWM price is unaffected.

All base TapirOracle functionality (checkpointing, price sources, ring buffer) is inherited unchanged.

---

## Architecture

```
TapirOracle (checkpointing, HWM, closing price, cross-chain)
  │ inherits
  ▼
TapirPtrwOracle
  ├─ Pendle config (PT, YT, router, base token, error tolerance)
  ├─ PTRW state (ERV, ARV, resolved flag)
  ├─ resolvePtrw() — automated redemption
  ├─ manualBackupResolvePtrw() — admin fallback
  └─ writePriceData() override — applies PTRW factor to closing price
        │
        ▼
  PendleRouter V2: redeemPyToToken()
```

---

## Roles

Inherits all roles from TapirOracle:

| Role | Additional capabilities |
|------|------------------------|
| `DEFAULT_ADMIN_ROLE` | `manualBackupResolvePtrw`, `resetForceManualResolve` |
| `OPERATOR_ROLE` | `resolvePtrw`, `writePriceData` (override adds a PTRW-resolved precondition; the base version is operator-gated too) |

---

## State variables

| Variable | Type | Description |
|----------|------|-------------|
| `ptrwResolved` | `bool` | Whether redemption data has been recorded |
| `ptrwErv` | `uint256` | Expected redemption value (PT balance before redemption) |
| `ptrwArv` | `uint256` | Actual redemption value (base received from Pendle) |
| `errorTolerance` | `uint256 immutable` | Absolute discrepancy allowed before counting as depeg |
| `PTRW_ACCURACY` | `uint256 constant` | 10000 (scaling factor for percentage math) |
| `pendleBase` | `address immutable` | Base token redeemed from PT market |
| `pendleRouter` | `address immutable` | Pendle router for redemption |
| `pendleYT` | `address immutable` | Yield token (identifies the Pendle market) |
| `pendlePT` | `address immutable` | Principal token to redeem |
| `forceManualResolve` | `bool` | Set true when automated redemption yields zero ARV |

---

## Constructor

Extends TapirOracle constructor with an additional `PendleConfig` struct:

```solidity
struct PendleConfig {
    address pendleBase;
    address pendleRouter;
    address pendleYT;
    address pendlePT;
    uint256 errorTolerance;
}
```

All Pendle addresses must be non-zero. Stored as immutables.

---

## PTRW lifecycle

1. **PT funding:** PT tokens are transferred directly to the oracle contract address; the contract does not provide a deposit function or enforce when the transfer occurs.
2. **Post-expiry:** Operator calls `resolvePtrw()` to redeem PT for base and record ERV/ARV.
3. **Output:** Once resolved, operator calls `writePriceData()` which applies the PTRW factor to the closing price.
4. **Fallback:** If automated resolution returns zero ARV, the contract enters force-manual mode and an admin can call `manualBackupResolvePtrw()` or clear that mode with `resetForceManualResolve()`.

---

## Functions

### resolvePtrw

```solidity
function resolvePtrw() external whenNotPaused onlyRole(OPERATOR_ROLE)
```

1. Reverts if `forceManualResolve` is already set
2. Requires `pendlePT.isExpired()`
3. Reads PT balance of the contract as `ptrwErv` and requires it to be non-zero
4. Approves Pendle router for the PT balance
5. Calls `PendleRouter.redeemPyToToken()` with no swap (direct SY-to-base redemption)
6. Sets `ptrwArv` to the amount of base received
7. Transfers any base balance to the caller
8. If `ptrwArv == 0`: sets `forceManualResolve = true`, emits `MustResolveManually`, returns without setting resolved
9. Otherwise: sets `ptrwResolved = true`, emits `PtrwResolved(ptrwArv)`

There is no `ptrwResolved` check on entry. If more PT is later transferred to the oracle, an
operator can call `resolvePtrw()` again and overwrite the recorded ERV and ARV.

### manualBackupResolvePtrw

```solidity
function manualBackupResolvePtrw(uint256 _ptrwErv, uint256 _ptrwArv)
    external onlyRole(DEFAULT_ADMIN_ROLE)
```

Admin fallback for when automated redemption cannot complete.

Guards:
- If `forceManualResolve == false`: requires `ptrwResolved == false` AND contract holds zero PT (prevents bypassing automated path while PT is still present)
- Requires `_ptrwErv > 0` (prevents division by zero)
- Requires `IPendlePT(pendlePT).isExpired()` (PT must be past maturity)

Sets ERV, ARV, and `ptrwResolved = true`.

### writePriceData (override)

```solidity
function writePriceData(uint32 _gaslimit)
    public payable override whenNotPaused onlyRole(OPERATOR_ROLE)
```

Requires `ptrwResolved == true`, `OPERATOR_ROLE`, and the oracle not to be paused.

1. Computes PTRW depeg factor
2. Gets HWM and raw closing price from inherited helpers
3. Applies factor to closing price
4. Sends HWM (unmodified) and adjusted closing price to DepegPool

---

## PTRW depeg factor

```
if ptrwArv + errorTolerance < ptrwErv:
    ptrwDepeg = ((ptrwArv + errorTolerance) * 10000) / ptrwErv
else:
    ptrwDepeg = 10000    (no adjustment)

adjustedClosingPrice = closingPrice * ptrwDepeg / 10000
```

The error tolerance is in raw absolute units. Because the contract does not normalize `ptrwErv` (PT units) against `ptrwArv` (base-token units), those values and the tolerance must use compatible units for the comparison to be meaningful. If the shortfall is within tolerance, no adjustment is made.

**Example:** ERV = 100e18, ARV = 95e18, errorTolerance = 2e18
- `95 + 2 = 97 < 100`, so depeg applies
- `ptrwDepeg = (97 * 10000) / 100 = 9700`
- Closing price reduced by 3%

---

## Errors

| Error | Condition |
|-------|-----------|
| `PtrwNotResolved` | `writePriceData()` called before resolution |
| `PtrwAlreadyResolved` | Manual resolution while already resolved and not in force-manual mode |
| `InvalidPtrwValues` | Zero PT balance or zero ERV |
| `PtBalanceNotZero` | Manual resolution while PT still held |
| `MarketNotExpired` | PTRW resolution attempted before PT maturity |
| `ManualResolveRequired` | `resolvePtrw()` called while force-manual mode is set |
| `InvalidAddress` | Zero address in constructor config |

All TapirOracle errors also apply to checkpointing and price operations.

---

## Events

```solidity
event PtrwResolved(uint256 arv);
event MustResolveManually();
```

Inherited: all TapirOracle events.

---
