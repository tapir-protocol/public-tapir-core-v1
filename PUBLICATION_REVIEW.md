# Publication review and fixes

Completed 2026-09-08. This release preserves the seven deployed core contracts and
corrects the unused math helper, development tooling, test coverage, and publication
material. It is a source publication, not a new deployment or a new independent audit.

## Fixed

- **Full-precision arithmetic:** `UniswapV3Math.mulDiv` now uses OpenZeppelin 5.0.2
  `Math.mulDiv`. Tests cover 512-bit products, truncation, zero inputs, zero denominators,
  and overflow. Its incorporated TickMath code is correctly identified as GPL-2.0-or-later.
- **Audit traceability:** the original math helper is retained solely as an audit
  artifact. `npm run verify:audit` reconstructs the complete original contracts tree
  and requires `55a702beef28000dd016c7090f2d5dc6a446c213`. The production core source
  files retain their original bytes. Documentation explicitly identifies post-audit changes.
- **Router coverage:** offline integration tests exercise split/unsplit/redemption,
  authorisation, pause, both swap directions, slippage, deadlines, rollback, remainder
  payouts, fees, and the accepted router-balance behaviour.
- **PTRW coverage:** offline tests exercise real token transfers through the mock
  Pendle router, output adjustment, zero-output fallback, operator/expiry gates,
  and the accepted repeat-resolution behaviour. The six previously skipped PTRW
  output tests now run using a resolved mock fixture.
- **Test separation:** live-feed checks are an explicit optional suite. The Pendle
  fork suite requires an explicit archive block through `ETH_FORK_BLOCK` and fails
  on a missing funded-holder fixture instead of silently skipping tests.
- **Development dependencies:** removed unused Ignition, AMM packages, coverage
  tooling, and mathjs; replaced the toolbox bundle with the plugins actually used;
  upgraded Hardhat and gas reporting; pinned patched transitive packages. All high
  and moderate npm audit findings are eliminated. One upstream low advisory remains
  as described below, rather than being hidden or claimed fixed.
- **Reproducible builds:** OpenZeppelin 5.0.2, API3 27.0.0, Solidity 0.8.27, viaIR,
  optimizer runs 1, and the Paris EVM target are pinned. Installation uses `npm ci`.
- **Local setup:** optional keys and fork RPC settings default to empty. Copying
  `.env.example` no longer causes invalid-key errors or enables a live fork. Additional
  `.env.*` files are ignored. Gas reporting follows `REPORT_GAS=true`.
- **CI:** pinned GitHub Actions run the audit proof, compilation, TypeScript,
  Solhint, formatting, offline tests, and an npm check that rejects moderate-or-higher
  advisories. Frozen source files are byte-checked by the audit verifier instead of
  reformatted; new fixtures and the corrected helper are checked by Prettier.
- **Licensing:** included MIT, GPL-2.0-or-later, and GPL-3.0-or-later texts and a
  provenance/attribution inventory. File-level licenses are distinguished from the
  root BUSL license. The archived helper's incomplete historical SPDX header is
  explicitly clarified in `THIRD_PARTY_NOTICES.md`.
- **Audit distribution:** the Quantstamp PDF is replaced by its publisher's certificate
  link. The public release is a clean Git snapshot without that PDF in its history.
  The Hashlock report remains pinned to the verified publisher download.
- **Documentation:** corrected no-depeg storage values, the timing of redemption,
  the scope of the post-resolution allocation invariant, and the distinction between
  observed days and consecutive calendar days. Documented that the closing lookback
  is not a maximum observation age and that pool/oracle administrators remain trusted.

## Validation

The offline suite passes **449 tests with no pending tests**. Compilation, TypeScript,
formatting, audit-tree verification, and Solhint pass. Solhint retains 13 warnings
in the unchanged audited core; these are recorded findings about naming and the
existing token-transfer pattern, not new compiler or lint errors.

Freshly compiled runtime bytecode matches Sourcify's recorded on-chain bytecode for
[DepegFactory](https://sourcify.dev/server/v2/contract/8453/0xc0C409aEdCE4fE91Fa26971EdF23E7d97C81d1c5?fields=all)
and [TapirRouter](https://sourcify.dev/server/v2/contract/8453/0xe549F51772E4C889a4F68144405163c81EE69e09?fields=all).
The helper fix does not affect either deployment. Direct Base RPC requests from the
review environment returned HTTP 403; this comparison uses Sourcify's recorded data,
not a latest-block RPC observation.

The audit proof's three commit objects, three root trees, and seven listed release
checksums were verified. The downloaded and committed Hashlock PDFs both have SHA-256
`35c1471d946744562cc966117611b73349d15bba9ca750365b5197f16e783029`. Credential-pattern
and relative-file-link checks passed. These checks do not guarantee the absence of
all secrets or vulnerabilities.

## Remaining upstream advisory and scope limits

`npm audit` reports 17 low-severity package/meta-vulnerability entries, all tracing to
[GHSA-848j-6mx2-7j84 / CVE-2025-14505](https://github.com/advisories/GHSA-848j-6mx2-7j84)
in `elliptic` 6.6.1. The upstream advisory lists no patched version. The package remains
transitive to Hardhat 2's legacy ABI dependencies and network helpers. Tests use
local disposable accounts and the ethers 6 plugin. This release does not add or use
an elliptic signing API; do not use the legacy dependency graph as a production
signing service. Replacing cryptographic internals with an unreviewed local patch
would not be a sound resolution. `npm audit --omit=dev` reports zero findings.

The optional live-feed and pinned Pendle-fork suites require external RPC access and
are not part of the offline release result. The new router fixture verifies router
accounting and revert behaviour, not the separate AMM's pricing implementation.
Individual live markets, privileged role assignments, balances, and keeper operation
were not requalified. Known Hashlock accepted behaviours remain part of the deployed
source and are covered/disclosed; this publication does not silently change them.
