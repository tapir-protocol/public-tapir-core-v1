# Tapir Core V1

Core contracts for Tapir Protocol, a DeFi depeg protection marketplace. The protocol splits a base asset into two tranches: DP (depeg protected) and YB (yield boosted). At resolution, the YB side absorbs depeg losses up to the structural 50% cap implied by the 1-into-0.5/0.5 token split.

- Docs site: <https://docs.tapir.money>
- Website: <https://tapir.money>

## How it works

1. A user splits an even base-asset amount into equal DP and YB amounts via `DepegPool.splitToken()` (or through `TapirRouter`, which combines split and swap); odd smallest-unit amounts round down.
2. The pool moves through a one-way lifecycle: `ACTIVE → COOLDOWN → RESOLUTION → REDEMPTIONS`.
3. At resolution, the pool uses oracle-submitted high-watermark and resolution prices to determine whether a depeg occurred. DP redemption value is capped at 200% and YB redemption value falls to zero at the cap.
4. The solvency invariant `dpValue + ybValue = 20000` (basis points) is enforced at resolution.

## Contracts

| Contract | Role |
|---|---|
| `DepegFactory` | Deploys pools; owner-gated `deployDepeg` |
| `DepegPool` | Core pool: split/unsplit, lifecycle, resolution, redemption |
| `DepegToken` | DP/YB ERC20; mint/burn callable only by its pool |
| `TapirOracle` | Multi-source price oracle (Chainlink, API3, RedStone, Tellor) with checkpointing and high-watermark logic |
| `TapirPtrwOracle` | PT Redemption Witness: proves a Pendle PT depeg from actual redemption output at maturity |
| `TapirVrpOracle` | Vault Redeem Preview: tracks ERC-4626 vault share value via `previewRedeem` quotes |
| `TapirRouter` | User-facing convenience wrapper (split + swap flows) |

Libraries: `TimeDecay`, `UniswapV3Math`. Interfaces and test mocks live under `contracts/interfaces/` and `contracts/mock/`.

### Stale comments in the frozen sources

The deployed core sources retain their audited bytes. Their stale comments are clarified
below. The unused `UniswapV3Math` helper was corrected after the audit; its original
source is retained separately so [VERIFICATION.md](VERIFICATION.md) remains reproducible.

| Location | Comment says | Reality |
|---|---|---|
| `contracts/TapirOracle.sol` (header, "Outputs") | `writePriceData()` is "callable by anyone" | it carries `onlyRole(OPERATOR_ROLE)` |
| `contracts/TapirPtrwOracle.sol` (lifecycle comment) | anyone can call `resolvePtrw()` | it carries `onlyRole(OPERATOR_ROLE)` |
| `contracts/TapirPtrwOracle.sol` (`resolvePtrw()` NatSpec) | the function can be called only once | it has no `ptrwResolved` entry guard and can overwrite the witness values after newly supplied PT is redeemed |
| `contracts/TapirRouter.sol` (`redeem()` NatSpec) | the pool must be active | `DepegPool.redeemTokens()` requires the `REDEMPTIONS` state |

`UniswapV3Math.mulDiv` now delegates to OpenZeppelin's full-precision implementation,
fixing checked-arithmetic panics for 512-bit products. This helper is not used by the
seven deployed core contracts. The original is retained under `verification/original/`
only for audit reconstruction; it must not be used as an implementation.

### Trust and asset assumptions

- Pools require standard, non-rebasing ERC20 assets without transfer fees or hooks.
  `splitToken()` mints from the requested transfer amount, so these unsupported token
  behaviours can invalidate backing assumptions.
- Pool and oracle administrators and operators are trusted. Oracle source/configuration
  changes take effect immediately; the pool's seven-day oracle-replacement timelock
  does not delay changes within the current oracle.
- Pool admins/operators can change redemption fees up to 2.55%, pause user operations,
  and rescue core assets to the treasury after the documented 30-day delay. Rescue
  does not reserve assets for outstanding token holders. See the
  [lifecycle and risk controls](docs/tapir_pool_lifecycle_risk_controls.md).
- Operators must maintain and check observation freshness. Price writing can fall back
  to checkpoints older than the configured lookback, and missing UTC days are omitted
  from the high-watermark calculation. `minPriceAge` delays settlement after submission;
  it does not validate the age of the underlying observations.

## Related repositories

DP and YB trade against each other on a Tapir-modified fork of Uniswap V3, maintained separately in
[tapir-protocol/public-tmarket-univ3-based](https://github.com/tapir-protocol/public-tmarket-univ3-based).
The fork adds three things to vanilla Uniswap V3:

- **`tapirAdmin`** — an address set immutably at pool creation, authorised for the two actions below.
- **Dynamic fees** — the pool stores a fee that `tapirAdmin` can change through `setFee(uint24)`, read via `dynamicFee()`.
- **Pausing** — `tapirAdmin` can halt swaps through `setPaused(bool)`; liquidity management (mint, burn, collect) stays available while paused.

Swaps are otherwise identical to vanilla Uniswap V3. `TapirRouter` in this repository combines pool
operations with swaps against that AMM, so integrators should account for the extra revert conditions the
dynamic fee and paused state introduce.

## Getting started

Hardhat project. The release has been verified with Node.js 22 and npm 11. The test
commands use a POSIX shell (Linux, macOS, or WSL).

```bash
npm ci
npm run compile
npm test                    # deterministic suite
npm run test:mainnetfork    # optional; requires ETH_RPC and ETH_FORK_BLOCK
npm run test:pool           # per-contract suites: test:factory, test:oracle, test:token, ...
npm run lint                # solhint; mocks, libraries, and interfaces are excluded
```

No `.env` or private key is needed for compilation or the default test suite. If you
need optional network settings, copy `.env.example` to `.env` and fill only the values
you use. Leave `HARDHAT_FORK_RPC_URL` empty for local tests; `test:mainnetfork` uses
`ETH_RPC` separately. Use `npm run test:gas` to enable gas reporting.

The default suite runs entirely offline, including router swap-flow and PTRW redemption
regressions. `npm run test:live` opts into live oracle-feed checks. The optional
`test:mainnetfork` suite requires `ETH_RPC` and a fixed `ETH_FORK_BLOCK` with the funded
PT-holder fixture; it fails if that fixture is absent. These external integrations
are separate from the offline release checks.

`npm run verify:audit` reconstructs the original audited source tree. Formatting checks
exclude those exact frozen sources through `.prettierignore`; their bytes are checked
by the audit verifier instead. New fixtures and the corrected helper are formatted
normally. CI runs the build, tests, type checking, lint, formatting, audit proof, and
an npm advisory check. See [PUBLICATION_REVIEW.md](PUBLICATION_REVIEW.md) for results and
the remaining low-severity upstream development-tool advisory.

## Documentation map

- `docs/` — protocol docs: litepaper, access control, pool lifecycle and risk controls.
- `docs/` oracle specs — depeg oracle, PT redemption witness, VRP oracle, oracle module overview, resolution spec.
- `docs/generated/` — generated technical specifications.
- AMM contracts are documented in the [public-tmarket-univ3-based](https://github.com/tapir-protocol/public-tmarket-univ3-based) repository, not here.
- `docs/audits/` — audit reports and briefs.

## Deployments

The Base (chain 8453) protocol-level deployments documented by this repository are:

| Contract | Address |
|---|---|
| `DepegFactory` | [`0xc0C409aEdCE4fE91Fa26971EdF23E7d97C81d1c5`](https://basescan.org/address/0xc0C409aEdCE4fE91Fa26971EdF23E7d97C81d1c5#code) |
| `TapirRouter` | [`0xe549F51772E4C889a4F68144405163c81EE69e09`](https://basescan.org/address/0xe549F51772E4C889a4F68144405163c81EE69e09#code) |

Both are source-verified on [Sourcify](https://sourcify.dev) for chain 8453, and both are
byte-identical to the artifacts compiled from this repository. Check that yourself — after
`npm ci && npm run compile`, this prints nothing and exits zero:

```bash
diff <(cast code 0xc0C409aEdCE4fE91Fa26971EdF23E7d97C81d1c5 --rpc-url https://mainnet.base.org) \
     <(jq -r .deployedBytecode artifacts/contracts/DepegFactory.sol/DepegFactory.json)

diff <(cast code 0xe549F51772E4C889a4F68144405163c81EE69e09 --rpc-url https://mainnet.base.org) \
     <(jq -r .deployedBytecode artifacts/contracts/TapirRouter.sol/TapirRouter.json)
```

Individual markets are deliberately not listed here. `DepegFactory` deploys one `DepegPool` per
market, each with its own DP and YB tokens, its own oracle and its own immutable price band, and
markets are opened and retired independently of this code. The factory's registry is the
authoritative list — read it on-chain, incrementing the index until the call reverts:

```bash
cast call 0xc0C409aEdCE4fE91Fa26971EdF23E7d97C81d1c5 \
  'getDepegModule(uint256)(address,address,address)' 0 --rpc-url https://mainnet.base.org
```

Each entry returns `(dpAsset, ybAsset, depegPool)`. A pool's own getters then describe it:
`ASSET()`, `oracle()`, `MIN_PRICE()`, `MAX_PRICE()` and `getState()` for its lifecycle state.
Pool and oracle instances are deployed with constructor immutables that differ per market, so their
runtime bytecode matches the artifacts here only once those immutable ranges are masked out.

Verify addresses independently before interacting.

## Audits

Two independent audits cover the original core snapshot. Auditor-hosted reports are
linked below. Hashlock is also retained locally; the Quantstamp report is linked to
its publisher rather than redistributed. The corrected unused math helper and new
test fixtures are post-audit changes, described in [VERIFICATION.md](VERIFICATION.md).

| Auditor | Published by the auditor | Copy in this repository |
|---|---|---|
| Hashlock | [Final Report v2](https://hashlock.com/wp-content/uploads/2026/08/Tapir-Money-Review-Smart-Contract-Audit-Report-Final-Report-v2.pdf) | [`docs/audits/Hashlock.pdf`](docs/audits/Hashlock.pdf) |
| Quantstamp | [Verified Security Certificate](https://certificate.quantstamp.com/full/tapir-protocol/f96d902f-85a1-4310-92e8-fcac6fa48f07/index.html) | Publisher link only |

The auditor-hosted versions are canonical. The committed Hashlock PDF is the report as published at
that link on 2026-09-08, pinned here at SHA-256
`35c1471d946744562cc966117611b73349d15bba9ca750365b5197f16e783029`. Check the committed copy against
that pin at any time:

```bash
sha256sum docs/audits/Hashlock.pdf
```

The hosted file is outside this repository's control and may be revised or re-exported. If it is,
the command below will differ from the pin above — that indicates a newer upstream release, not a
modified copy here. Compare them yourself:

```bash
curl -sSL https://hashlock.com/wp-content/uploads/2026/08/Tapir-Money-Review-Smart-Contract-Audit-Report-Final-Report-v2.pdf | sha256sum
```

`docs/audits/260707_hashlock_brief.md` is the scope brief Hashlock worked from.

Hashlock records findings L-01, Q-01 and Q-02 as *Acknowledged* rather than Resolved. Two of those
behaviours are accepted and present in this release: `resolvePtrw()` has no `ptrwResolved` entry
guard, and `sellAndUnsplit()` computes its payout from the router's absolute token balances rather
than per-call balance changes. The third, Q-02, was addressed in code during the fix review — the
VRP-adjusted high watermark is clamped to the pool's `MAX_PRICE`. Read the report for the full
descriptions and severity rationale.

## Audit verification

Both reports pin git commit hashes from the development repository.
[VERIFICATION.md](VERIFICATION.md) reconstructs every one of those commits and proves
cryptographically that the retained source snapshot is byte-identical to the Hashlock
fix-review tree. All seven core contracts retain their audited bytes; the corrected
unused library is explicitly distinguished from its archived original. No access to
the development repository is required.

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure process. Audit reports are in `docs/audits/`.

## License

Business Source License 1.1 (BUSL-1.1). Licensor: Tapir Labs. The Licensed Work converts to GPL-2.0-or-later on the Change Date or the fourth anniversary of the first public distribution of a version, whichever comes first. See [LICENSE](LICENSE).

File-level MIT/GPL licenses and third-party rights are described in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), with license texts in `LICENSES/`.
