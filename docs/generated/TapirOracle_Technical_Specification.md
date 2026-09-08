# TapirOracle technical specification

**Source:** `contracts/TapirOracle.sol`
**Solidity:** ^0.8.27
**License:** BUSL-1.1

---

## Overview

TapirOracle aggregates multiple on-chain price sources, derives manipulation-resistant reference prices, and pushes those prices to a DepegPool. It supports four price sources (API3, Chainlink, RedStone Classic, Tellor), stores checkpoints in a ring buffer, and computes two outputs:

- **High watermark price:** max(min(triplet)) over consecutive daily prices -- captures the highest robustly sustained price
- **Closing price:** median of daily representative prices within a lookback window -- smooths short-term anomalies

The oracle can operate same-chain or cross-chain (L1 to L2 via CrossDomainMessenger).

---

## Architecture

```
Price Sources (API3, Chainlink, RedStone, Tellor)
  → record*Price() [operator-only]
    → latestXxxPrice storage slots

Checkpointing [operator-only]
  → checkpoint()
    → median/selection of fresh sources
    → ring buffer (400 slots)

Output [operator-only]
  → writePriceData()
    → computes HWM and closing price from ring buffer
    → sends to DepegPool (direct or cross-chain)
```

Inherits `AccessControl` and `Pausable`. Implements `ITapirOracle`.

---

## Roles

| Role | Capabilities |
|------|-------------|
| `DEFAULT_ADMIN_ROLE` | `setSources`, `setConfig`, `pause`, `unpause` |
| `OPERATOR_ROLE` | `recordApi3Price`, `recordChainlinkPrice`, `recordRedStoneClassicPrice`, `recordTellorPrice`, `checkpoint`, `writePriceData` |

`writePriceData()` is restricted to `OPERATOR_ROLE` and requires the oracle not to be paused.

---

## Configuration

### Config struct

| Field | Type | Description |
|-------|------|-------------|
| `minCheckpointSpacing` | `uint32` | Minimum seconds between checkpoints |
| `minValidSources` | `uint8` | Minimum fresh sources required per checkpoint (1–4) |
| `closingPriceLookbackPeriod` | `uint32` | Window (seconds) for closing price calculation |
| `depegPool` | `address` | Target DepegPool |
| `xChainMode` | `bool` | If true, send prices via cross-domain messenger |
| `xDomainMessengerL1` | `address` | L1 messenger contract (only used if xChainMode is true) |

### Sources struct

Per-source configuration (all optional):
- Activation flag (`bool`)
- Contract address
- Decimal metadata (`uint8`)
- Max staleness threshold (`uint32`, per-source)

Supported sources: API3 ReaderProxy, Chainlink AggregatorV3, RedStone Classic (Push, Chainlink-compatible), Tellor (via GuardedLiquityV2 adaptor, Chainlink-compatible).

Both structs are updated instantly via `setConfig()` and `setSources()` (admin-only).

---

## Price ingestion

Each `record*Price()` function (operator-only):

1. Checks source is active; active sources require a non-zero address when sources are configured
2. Reads price and timestamp from the source contract
3. Validates: positive price, non-zero timestamp, not in the future, not older than last recorded
4. Normalizes decimals to the asset's native decimals
5. Validates normalized price fits in `uint192`
6. Stores `(price, timestamp)` in the source's dedicated slot

Normalization:
```
if sourceDecimals < targetDecimals:
    normalized = value * 10^(targetDecimals - sourceDecimals)
else if sourceDecimals > targetDecimals:
    normalized = value / 10^(sourceDecimals - targetDecimals)
else:
    normalized = value
```

API3 uses `IApi3ReaderProxy.read()`. The other three use `IAggregatorV3.latestRoundData()` via a shared internal helper `_recordAggregatorV3Price()`.

---

## Checkpointing

```solidity
function checkpoint() public virtual whenNotPaused onlyRole(OPERATOR_ROLE)
```

1. Enforces `minCheckpointSpacing` since last checkpoint
2. Loads latest prices from all four source slots
3. Filters to valid entries: source is active AND price > 0 AND not older than source-specific `maxStaleness`
4. Requires `validCount >= minValidSources`
5. Derives checkpoint price:
   - 3+ sources: median (sorted, middle value for odd count, average of two middle for even)
   - 2 sources: price closest to the previous checkpoint (or average if no history)
   - 1 source: that price directly
6. Pushes to ring buffer with `block.timestamp`
7. Emits `Checkpoint(price, timestamp)`

When a checkpoint is the first recorded in a new UTC day, the oracle calculates a candidate from the existing buffer and increases `persistedHwm` if that candidate is higher.

---

## Ring buffer

- Fixed-size array: `PricePoint[400]` where `PricePoint = { uint192 price, uint64 ts }`
- `_head`: next write index (circular)
- `_count`: valid entries (capped at 400)
- 400 slots supports approximately 13 months at daily cadence
- Oldest entries are overwritten when full
- `_materialize()` returns all points oldest-to-newest for read-only algorithms

---

## Daily aggregation

Before computing HWM or closing price, raw checkpoints are aggregated to daily representative prices via `_aggregateToDailyPrices()`:

- Groups checkpoints by UTC day
- Per day:
  - 1 checkpoint: use that price
  - 2 checkpoints: use the smaller price
  - 3+ checkpoints: use the median

This produces one price per calendar day.

---

## Price outputs

### writePriceData

```solidity
function writePriceData(uint32 _gaslimit)
    external payable virtual whenNotPaused onlyRole(OPERATOR_ROLE)
```

Computes HWM and closing price from the ring buffer, then sends both to the DepegPool. It is callable only by `OPERATOR_ROLE` while not paused.

### High watermark price

Computed by `_highWatermarkPrice()`:

1. Materializes all checkpoints (oldest first)
2. Aggregates to daily prices
3. Requires at least 3 days
4. For each consecutive triplet of daily prices, takes the minimum
5. Returns the maximum of all triplet minimums

`writePriceData()` uses the greater of this current candidate and `persistedHwm`.

```
P_hwm = max_i( min(p_i, p_{i+1}, p_{i+2}) )
```

**Example:** daily prices `[1, 9, 7, 6, 8, 5]`
- Triplet mins: `[1, 6, 6, 5]`
- HWM = 6

### Closing price

Computed by `_medianOfLastEligibleCheckpoints()`:

1. Counts checkpoints within `closingPriceLookbackPeriod` (from most recent backwards)
2. Requests at least 5 checkpoints (reaches further back if needed, but uses fewer when fewer exist)
3. Retrieves those checkpoints
4. Aggregates to daily representative prices
5. Returns the median of those daily prices

### Delivery

`_sendPriceDataToDepegPool()` handles dispatch:
- **Same-chain** (`xChainMode = false`): calls `IDepegPool.updatePriceData(hwmPrice, closingPrice)` directly
- **Cross-chain** (`xChainMode = true`): encodes the call and sends via `ICrossDomainMessenger.sendMessage()`, forwarding any `msg.value`.

---

## Security controls

- **Access control:** Recording, checkpointing, and price writing are operator-gated. Config/sources are admin-only.
- **Pausable:** Admin can pause price recording, checkpointing, and price writing.
- **Monotonic timestamps:** Each source rejects timestamps older than the last recorded.
- **Normalization bounds:** Prices must fit in `uint192`.
- **Source validation:** Rejects inactive or stale feeds; an active source must have a non-zero address when sources are configured.
- **Checkpoint spacing:** Enforces the configured spacing, which may be zero.
- **Minimum valid sources:** Configurable threshold of fresh sources per checkpoint.
- **Per-source staleness:** Each source has its own `maxStaleness` so sources with different heartbeats coexist.

## Errors

| Error | Trigger |
|-------|---------|
| `SourceNotActive` | Source flag is false |
| `SourceNotConfigured` | An active source is configured with a zero address |
| `InvalidPrice` | Non-positive price |
| `InvalidTimestamp` | Zero timestamp |
| `FutureTimestamp` | Timestamp exceeds `block.timestamp` |
| `TimestampOlderThanLatest` | New reading older than stored |
| `PriceExceedsMax` | Normalized price > `uint192` max |
| `CheckpointTooSoon` | Spacing constraint violated |
| `InvalidMinValidSources` | Config sets threshold to 0 or greater than 4 |
| `NotEnoughValidSources` | Insufficient fresh sources |
| `NoCheckpointsAvailable` | Internal closing-price helper called with no checkpoints |
| `InsufficientCheckpointsForHWM` | No persisted HWM and fewer than 3 daily prices for a candidate |
| `MessengerNotConfigured` | Cross-chain mode without messenger |

---

## Events

```solidity
event Checkpoint(uint192 price, uint64 asOfTs);
event ConfigUpdated(Config cfg);
event SourcesUpdated(Sources src);
event PriceRecorded(uint64 indexed blockTimestamp, uint192 normalizedPrice, string sourceName);
```

Inherited events from OpenZeppelin: `Paused`, `Unpaused`, `RoleGranted`, `RoleRevoked`.

---

## Constructor

```solidity
constructor(
    string memory _assetSymbol,
    address _asset,
    uint8 _assetDecimals,
    ITapirOracle.Sources memory sources_,
    ITapirOracle.Config memory cfg_,
    address admin
)
```

- `_assetSymbol`: descriptive label (e.g., "weETH")
- `_asset`: ERC20 address (can be address(0) if unused)
- `_assetDecimals`: decimals for all output prices
- `sources_`: initial source configuration
- `cfg_`: initial oracle configuration
- `admin`: granted `DEFAULT_ADMIN_ROLE`
