# Tapir PT Redemption-Witness Oracle specification

## Scope

`TapirPtrwOracle` extends `TapirOracle`. It uses the amount of Pendle PT held by the oracle at redemption time and the base-token output returned by Pendle's router to adjust the base oracle's closing price. It does not itself determine the `DepegPool` result; the pool applies its usual resolution logic after receiving the adjusted closing price.

The contract inherits the base oracle's source recording, checkpointing, high-watermark calculation, and same-chain or cross-chain price delivery support.

## Configuration

The constructor receives `PendleConfig`:

```solidity
struct PendleConfig {
    address pendleBase;
    address pendleRouter;
    address pendleYT;
    address pendlePT;
    uint256 errorTolerance;
}
```

All four addresses must be non-zero. `errorTolerance` is a raw absolute amount added to `ptrwArv`. The contract does not normalize between the PT balance used as `ptrwErv` and the base-token output used as `ptrwArv`, so their units must be compatible for the comparison to have its intended meaning. The contract has no function to acquire or deposit PT; PT must already be held by the oracle before `resolvePtrw()` can use it.

## Resolution

`resolvePtrw()` is restricted to `OPERATOR_ROLE` and requires the oracle not to be paused. It requires `pendlePT.isExpired()`.

1. It reads the oracle's PT balance into `ptrwErv`; a zero balance reverts.
2. It approves that PT amount to `pendleRouter` and calls `redeemPyToToken()` with `pendleBase` as both output and redeem-SY token.
3. It stores the returned `netTokenOut` as `ptrwArv` and transfers any `pendleBase` balance held by the oracle to the caller.
4. When `ptrwArv` is zero, it sets `forceManualResolve`, emits `MustResolveManually()`, and returns without setting `ptrwResolved`. Otherwise it sets `ptrwResolved` and emits `PtrwResolved(ptrwArv)`.

A Pendle-router revert reverts the entire transaction; it does not set a redemption-failure status.
`resolvePtrw()` does not check `ptrwResolved` on entry. If more PT is later sent to the oracle, an
operator can call it again and overwrite `ptrwErv` and `ptrwArv`.

## Manual backup resolution

`manualBackupResolvePtrw(uint256 _ptrwErv, uint256 _ptrwArv)` is restricted to `DEFAULT_ADMIN_ROLE` and requires the PT to be expired and `_ptrwErv` to be non-zero.

Unless `forceManualResolve` is set, it also requires that PTRW is not already resolved and that the oracle holds no PT. It then sets `ptrwErv`, `ptrwArv`, and `ptrwResolved`. `resetForceManualResolve()` is also admin-only and clears the force-manual flag.

## Closing-price adjustment

`writePriceData(uint32 _gaslimit)` is payable, requires `OPERATOR_ROLE`, requires the oracle not to be paused, and requires `ptrwResolved`.

```text
if ptrwArv + errorTolerance < ptrwErv:
    ptrwDepeg = (ptrwArv + errorTolerance) * 10000 / ptrwErv
else:
    ptrwDepeg = 10000

adjustedClosingPrice = closingPrice * ptrwDepeg / 10000
```

The high-watermark price is not adjusted by PTRW. The override forwards that high-watermark and the adjusted closing price through the inherited delivery helper.
