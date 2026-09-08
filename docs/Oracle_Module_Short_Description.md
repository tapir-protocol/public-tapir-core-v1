# Oracle module short description

### Description
The base `TapirOracle` aggregates configured on-chain oracle-source contracts and records a robust checkpoint price. It does not fetch prices from an off-chain service itself.

An account with `OPERATOR_ROLE` calls the enabled source-specific functions—`recordApi3Price()`, `recordChainlinkPrice()`, `recordRedStoneClassicPrice()`, and/or `recordTellorPrice()`—then calls `checkpoint()`. These functions are unavailable while the oracle is paused. The contract enforces the configured `minCheckpointSpacing`; a roughly daily, randomized cadence is an operating convention, not a fixed on-chain interval.

Each successful checkpoint stores its selected price and the current block timestamp in a 400-point circular buffer. The source records retain their respective source timestamps, but a checkpoint timestamp is the time `checkpoint()` is called.

Highwatermark price
To reduce the effect of short-lived spikes, the high watermark is the highest minimum among consecutive triplets of **daily representative prices**.

Closing price
The closing (resolution) price is used by `DepegPool` to calculate a depeg. It is the median of daily representative prices produced from the selected recent raw checkpoints.

### Overview

Its primary function is to provide price data to a configured `DepegPool`; the pool, rather than the oracle, decides whether a depeg occurred. Each deployment can configure its own asset decimals, active sources, freshness limits, checkpoint spacing, closing-price lookback, and delivery mode.

### Calculations

#### Price sampling schedule

The following is an **off-chain operating convention** for sampling roughly every 24 hours in a three-hour window. `TapirOracle` does not enforce these UTC windows, random draws, retries, or a one-sample-per-day rule; on-chain it only enforces `minCheckpointSpacing` between checkpoints.

Rationale:
**Capture high volume trading window**  - The chosen interval may overlap liquid trading hours; its relationship to market opens varies with daylight-saving time.
**Have robust randomness** - Uniform random is better than normal due to being more random for our usecase.


- Prices are sampled **once per 24 hours**.

- Each day has an active sampling window between **14:30 and 17:30 UTC**.


**Sampling flow:**

1. **Primary attempt:**

    - A random timestamp is drawn uniformly between **14:30 and 16:30 UTC**.

    - The operator records the enabled sources and attempts `checkpoint()` at this random time.

2. **Immediate retries (soft fails):**

    - If a call fails due to network or temporary issue, the bot retries immediately with short backoff (1s → 2s → 4s → … up to 60s).

3. **Fallback attempt:**

    - If no valid sample was recorded by **16:30 UTC**, a second random time is drawn uniformly between **16:30 and 17:30 UTC** and sampling proceeds there.

    - By this convention, the first successful checkpoint is treated as that day's operational observation. The contract instead derives a daily representative when prices are later calculated: one checkpoint uses that price, two use the smaller price, and three or more use their median.

4. **Randomness:**

    - The drawn timestamp should be **logged or verifiable** afterward for auditability.


**Purpose of timing design:**

- Aligns with **high-liquidity trading hours** (US market open overlaps Europe).

- The random timing reduces the chance of targeted manipulation.

- The fallback ensures daily coverage even if an issue occurs during the first window.



#### Highwatermark price
This should capture the highest robustly held price of the asset.

Logic for determining:
Lowest price of the highest price triplets.

When price data is written, the oracle materializes the current 400-checkpoint ring buffer, first converts raw checkpoints to UTC-day representative prices, and evaluates every consecutive triplet of daily observations. The candidate is the highest triplet minimum, or zero when fewer than three distinct UTC days are available. `persistedHwm` is updated monotonically when a checkpoint begins a new UTC day, before that new checkpoint is added; the written high watermark is the larger of `persistedHwm` and the current buffer candidate. This preserves a lifetime high watermark after older checkpoints are overwritten.

$\displaystyle P_{\text{hwm}} = \max_{i} \Big( \min(p_i,\, p_{i+1},\, p_{i+2}) \Big)$

Here, each $p_i$ is a daily representative price, not an individual raw checkpoint.

example (one checkpoint on each UTC day, so each listed price is also that day's representative):
##### Recorded prices (in order)

`[1, 9, 7, 6, 8, 5]`

##### All consecutive triplets and their minimums

- Triplet 1: `(1, 9, 7)` → `min = 1`

- Triplet 2: `(9, 7, 6)` → `min = 6`

- Triplet 3: `(7, 6, 8)` → `min = 6`

- Triplet 4: `(6, 8, 5)` → `min = 5`


##### Pick the **highest** of those minimums

Minimums are `[1, 6, 6, 5]` → **max = 6**

**Result (highest robustly held price): 6**

This matches the rule:

$\displaystyle P_{\text{hwm}} = \max_{i} \Big( \min(p_i,\, p_{i+1},\, p_{i+2}) \Big)$

Notes:

- If multiple triplets tie (here Triplet 2 and 3 both give 6), the robust price is still **6**.

- The Solidity implementation uses the resulting price, not a returned triplet. An off-chain audit of this example can identify either `(9, 7, 6)` or `(7, 6, 8)` as a maximizing triplet.



#### Closing Price

The *Closing Price* represents the reference price supplied for pool resolution. It is designed to reduce the effect of short-term variation through a configurable lookback and daily aggregation; the contract does not impose a fixed two-day window or require a sample at a particular time near maturity.

**Computation Method:**
The closing price is the **median** of daily representative prices derived from selected recent raw checkpoints. The oracle counts raw checkpoints whose timestamp is strictly within `closingPriceLookbackPeriod`; if fewer than five qualify, it requests five checkpoints instead. It retrieves the available minimum of that request and the buffer count, then groups the retrieved checkpoints by UTC day. A day with one checkpoint uses it, a day with two uses the smaller one, and a day with three or more uses their median.

Formally:

$$
\mathrm{ClosingPrice} = \mathrm{median}\!\left(D_1,\, D_2,\, \dots,\, D_n\right)
$$

where
- $D_i$ = daily representative price derived from the selected raw-checkpoint subset.

`writePriceData(uint32 _gaslimit)` can only be called by `OPERATOR_ROLE` while the oracle is unpaused. `DepegPool.updatePriceData()` accepts its output only during the pool's cooldown; it records the final prices with the update timestamp. The pool later requires that timestamp to be at least `minPriceAge` old before anyone can call `resolvePriceDepeg()`.

---

### Example

| Day  | Price |
|:----:|:-----:|
| -10 | 4 |
| -9  | 4 |
| -8  | 5 |
| -7  | 5 |
| -6  | 6 |
| -5  | 6 |
| -4  | 6 |
| -3  | 7 |
| -2  | 10 |
| -1  | 1 |

Assume there is one checkpoint per listed UTC day and exactly the five latest checkpoints qualify for the configured lookback. Take the **5 selected checkpoints**: [6, 6, 7, 10, 1]
→ Sorted: [1, 6, 6, 7, 10]
→ **Median = 6**

$$
\mathrm{ClosingPrice} = 6
$$


#### Happy Path Example without a depeg event

For a yield-bearing product, the token’s value may increase monotonically over time when no depeg event occurs. In the one-checkpoint-per-day, five-latest-checkpoint selection used below, the **Closing Price** is not lower than the **High Watermark Price**. This is an illustrative path, not an invariant for every possible lookback configuration or checkpoint density.

---

### Recorded Prices
Assume one checkpoint per UTC day and that the configured closing-price selection yields the five latest checkpoints.
`[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]`

---

**High Watermark Price**

$$
P_{\text{hwm}} = \max_i \big(\min(p_i, p_{i+1}, p_{i+2})\big)
$$

Triplet minimums → `[1, 2, 3, 4, 5, 6, 7, 8]`
→ **High Watermark = 8**

---

**Closing Price**

Last 5 prices → `[6, 7, 8, 9, 10]`
Median → **8**

---

**Result**

$$
P_{\text{closing}} = 8 \geq P_{\text{hwm}} = 8
$$

✅ For this monotonic path and stated selection, the closing price equals the high watermark.




### Responsibilities

- **Data aggregation:** Reads enabled API3, Chainlink, RedStone Classic, and Tellor source contracts, normalizes each price to the asset's configured decimals, and stores the latest reading that passes the source function's positivity and timestamp checks.
- **Checkpoint selection:** Requires at least the configured number of active, non-zero, non-stale sources (from one to four). With three or four valid sources it uses the median (the average of the middle two for four); with two it selects the value closer to the preceding checkpoint, or their average when no prior checkpoint exists; with one it uses that value.
- **Depeg event tracking:** Supplies the high-watermark and resolution prices from which `DepegPool` determines whether a depeg event occurred.
- **Output generation:** Emits `PriceRecorded` and `Checkpoint` while collecting data, then provides price data for the pool's depeg-resolution flow.

### Outputs Provided

- **High watermark price:** `writePriceData(uint32 _gaslimit)` derives the daily-triplet high watermark and uses the maximum of that value and `persistedHwm`. It reverts with `InsufficientCheckpointsForHWM` only if neither a persisted high watermark nor the current candidate is non-zero; a new oracle normally needs three daily representatives to produce its first candidate.
- **Closing/resolution price:** The same call derives the median daily price described above and sends both values to `DepegPool.updatePriceData(uint256,uint256)`.
- **Delivery:** In same-chain mode, the oracle calls the pool directly. In cross-chain mode, it calls the configured L1 messenger's `sendMessage` with the encoded `updatePriceData` call and `_gaslimit`; the L2 pool accepts it only from its configured messenger with the configured oracle as `xDomainMessageSender`.
- **Depeg status & magnitude:** `DepegPool` stores the submitted values during cooldown and, in its resolution state after `minPriceAge`, allows anyone to call `resolvePriceDepeg()`. A depeg is recorded only when the resolution price is below the high watermark by at least `floor(hwmPrice * 10 / 10,000)` (nominally 0.1%); `depegSize()` returns `10,000 - floor(resolutionPrice * 10,000 / hwmPrice)` basis points.

### Caveats & Design Considerations

- **Robustness:** The contract filters by enabled source, non-zero price, per-source freshness, configured source count, daily aggregation, and the triplet/median calculations; those checks do not independently establish that a source is free from anomalies.
- **Manipulation resistance:** Permissioning collection and checkpointing to `OPERATOR_ROLE` reduces adversarial timing of those calls, but the safety of the result still depends on source configuration and off-chain operation.
- **Bounds and capacity:** The checkpoint buffer holds 400 raw points. `DepegPool` accepts a high watermark only within its inclusive `MIN_PRICE` and `MAX_PRICE`; it accepts a resolution price from zero through `MAX_PRICE`. The base and PTRW oracles can use cross-chain delivery when configured, while `TapirVrpOracle` rejects cross-chain mode and caps its adjusted values at the pool's `MAX_PRICE`.
- **PTRW extension:** `TapirPtrwOracle.writePriceData()` requires `ptrwResolved`. It leaves the price high watermark unchanged and scales the closing price by the capped PTRW factor `min(1, (ptrwArv + errorTolerance) / ptrwErv)` using integer arithmetic; resolving PTRW is operator-only after the Pendle PT reports expiry, with an admin backup path. Automated resolution has no `ptrwResolved` entry guard, so a later operator call with newly supplied PT can overwrite the recorded witness values.
- **VRP extension:** `TapirVrpOracle.writePriceData()` requires `vrpResolved`. It scales the high watermark by the VRP high watermark relative to the constructor's `previewRedeem(witnessShares)` value, and scales the closing price by `min(vrpHwm, vrpPrv + errorTolerance)` relative to that same initial value; both adjusted values are capped at `MAX_PRICE`.
- **Latency tolerance:** The contract does not calculate a TWAP. Updates must satisfy `minCheckpointSpacing`, and the selected lookback, source freshness limits, and operating cadence determine the latency/security trade-off.

### Inputs Consumed

#### On-Chain Price Feeds
- **API3 ReaderProxy V1:** Read through `read()` when the API3 source is enabled.
- **Chainlink AggregatorV3:** Read through `latestRoundData()` when enabled.
- **RedStone Classic and Tellor adapter:** Each is read through the Chainlink-compatible `latestRoundData()` interface when enabled.

#### Off-Chain Price Feeds
- **External operation:** An off-chain operator may choose when to invoke the permissioned recording and checkpoint functions, including the sampling convention above.
- **Contract boundary:** The Solidity contracts in this repository do not directly query optimistic-oracle, dispute, or other off-chain services; their price inputs are the configured on-chain source interfaces listed above.
