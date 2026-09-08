# Tapir depeg oracle specification

## Description

`TapirOracle` records price data from up to four configured sources, produces checkpoint prices, and sends a high-watermark price and a resolution price to a `DepegPool`. The implemented source slots are API3 ReaderProxy V1, Chainlink AggregatorV3, RedStone Classic, and a Tellor Chainlink-compatible adaptor.

All stored and submitted prices use the protected asset's configured decimals. Source readings are normalized before storage.

## Source configuration and recording

`DEFAULT_ADMIN_ROLE` can update the `Sources` struct through `setSources()` and the `Config` struct through `setConfig()`, and can call `pause()` and `unpause()`. An active source must have a non-zero address. `minValidSources` must be between 1 and 4.

An `OPERATOR_ROLE` holder records a configured source through one of:

```solidity
recordApi3Price()
recordChainlinkPrice()
recordRedStoneClassicPrice()
recordTellorPrice()
```

Each recording function is restricted to `OPERATOR_ROLE` and requires the oracle not to be paused. Each successful recording stores the source's latest normalized price and timestamp. The reported source price must be positive, but a normalization that scales down can truncate the stored price to zero; such a source is ineligible for checkpointing. A reading reverts if its timestamp is zero, in the future, or older than the source's previously stored timestamp. The contract does not impose a fixed sampling schedule; checkpoint timing is limited by `cfg.minCheckpointSpacing`.

## Checkpoint calculation

An `OPERATOR_ROLE` holder calls `checkpoint()` while the oracle is not paused. A source is eligible when it is active, has a non-zero stored price, and satisfies:

```text
block.timestamp < source.asOfTs + source.maxStaleness
```

At least `cfg.minValidSources` sources must be eligible. The checkpoint price is selected as follows:

| Eligible sources | Checkpoint price |
|---|---|
| 4 | Average of the two middle sorted prices |
| 3 | Median |
| 2 | Price closest to the previous checkpoint, or their average if none exists |
| 1 | The source price |

The oracle stores each checkpoint as a `(uint192 price, uint64 timestamp)` point in a 400-entry circular buffer.

## Daily prices and high watermark

For final-price calculations, checkpoints are grouped by UTC day. A day's representative price is its sole checkpoint, the smaller of two checkpoints, or the median of three or more checkpoints.

The high-watermark candidate is calculated from all buffered daily representative prices:

$$
P_{\text{hwm}} = \max_i \left(\min(p_i, p_{i+1}, p_{i+2})\right)
$$

At least three daily prices are required for a candidate. `persistedHwm` retains the highest finalized candidate as new UTC days begin, and price writing uses the greater of `persistedHwm` and the current candidate.

## Resolution price

The oracle counts recent raw checkpoints within `cfg.closingPriceLookbackPeriod`, requests at least five checkpoints when that many exist, and uses all available points when fewer exist. Those selected checkpoints are grouped into daily representative prices; their median is the resolution price.

## Price delivery

`writePriceData(uint32 _gaslimit)` is payable, not paused, and restricted to `OPERATOR_ROLE`. It requires a non-zero high watermark, computes the resolution price, and delivers both values to the configured pool.

- In same-chain mode, it calls `DepegPool.updatePriceData(_hwmPrice, _resolutionPrice)` directly.
- In cross-chain mode, it sends the encoded pool call through `cfg.xDomainMessengerL1`; any `msg.value` is forwarded to that messenger.

The pool accepts a price update only during COOLDOWN, from its configured oracle directly or through its configured L2 cross-domain messenger. It bounds `hwmPrice` inclusively by `MIN_PRICE` and `MAX_PRICE`, bounds `resolutionPrice` only by `MAX_PRICE`, and timestamps the accepted data.
