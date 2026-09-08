# Audit Verification

Two audits pin commit hashes from the private development repository. All three `tapir-core-v1`
commits pinned by the reports' scope listings are reconstructed below.

| Report | Report field | Commit hash |
|---|---|---|
| Hashlock Final Report v2, page 7 — [published](https://hashlock.com/wp-content/uploads/2026/08/Tapir-Money-Review-Smart-Contract-Audit-Report-Final-Report-v2.pdf) · [committed](docs/audits/Hashlock.pdf) | Audited GitHub Commit Hash | `e951edc34939d8191d65c5ef29c2fc2e4ac5a462` |
| Hashlock Final Report v2, page 7 — [published](https://hashlock.com/wp-content/uploads/2026/08/Tapir-Money-Review-Smart-Contract-Audit-Report-Final-Report-v2.pdf) · [committed](docs/audits/Hashlock.pdf) | Fix Review GitHub Commit Hash | `9fc06de7ad6531771ab245e01828459d9b0b00a7` |
| Quantstamp, front page — [certificate](https://certificate.quantstamp.com/full/tapir-protocol/f96d902f-85a1-4310-92e8-fcac6fa48f07/index.html) | Source Code, `tapir-core-v1` | `4ec27b5f3a97a39deb45a847b5b8605776607e4c` |

The seven top-level core contracts retain the state at Hashlock's **fix-review**
commit. The unused `contracts/libraries/UniswapV3Math.sol` was corrected after the
review, and two test-only mock contracts were added. Consequently, the current
`HEAD:contracts` hash is intentionally different from the audited tree.

The original library bytes are retained at
[`verification/original/UniswapV3Math.sol`](verification/original/UniswapV3Math.sol).
[`verification/audited-contracts.json`](verification/audited-contracts.json) lists the
original paths. `scripts/verify-audit.py` reads all of those files, substituting only
the archived library, and hashes their Git blobs and directories to reconstruct the
exact auditor-pinned tree. This also checks every retained core source byte.

The proof below reconstructs the Quantstamp baseline, Hashlock audited commit, and
Hashlock fix-review commit. The first two have different expected source trees.

## How the proof works

A git commit hash is the SHA-1 of a small commit object. The commit object names a root tree hash; the root tree names a hash for each subdirectory. Hashes are derived purely from content, so equality of the `contracts/` subtree hash proves equality of every byte under `contracts/`.

Run the steps below inside a clone of this repository. Each step's expected output is shown.

## Step 1 — Reconstruct the pinned fix-review commit

The following is the complete, unmodified commit object whose SHA-1 is the fix-review hash pinned in the report. Hash it yourself:

```bash
git hash-object -t commit --stdin <<'EOF'
tree f432ef9ee1bb97243da8e2401483f72cbe00f430
parent f84628429116f3b2fc41457a111dc0d00bcff4e8
author Juuso Roinevirta <jroinevirta@gmail.com> 1785338269 +0300
committer Juuso Roinevirta <jroinevirta@gmail.com> 1785338269 +0300

Fix: Hashlock M-01
EOF
```

Expected output:

```
9fc06de7ad6531771ab245e01828459d9b0b00a7
```

This matches the report and proves the fix-review commit's root tree is `f432ef9ee1bb97243da8e2401483f72cbe00f430`.

## Step 2 — Reconstruct the fix-review root tree

The following is the raw root tree object of `f432ef9e…`, base64-encoded. Decoding and hashing it proves its contents:

```bash
base64 -d <<'EOF' | git hash-object -t tree -w --stdin
MTAwNjQ0IC5lbnYuZXhhbXBsZQDKX36R+CbgdDNYXfYA81lw/ZrKrzEwMDY0NCAuZ2l0aWdub3JlAJWQRxSfg2t0CXEV8Nb9m4nED+OvMTAwNjQ0IC5wcmV0dGllcnJjLmpzb24AzNtSIXiTcCiLxT53upWqcsGVE0YxMDA2NDQgLnNvbGhpbnRpZ25vcmUAt1yrXSYV53CqcKFAGcQnhlnoIUgxMDA2NDQgLnNvbGhpbnRyYy5qc29uAA1IU86kSYN6VxayQ4I9sdAlbstFMTAwNjQ0IExJQ0VOU0UARyLFRKr/jwpJ1rhYmE7T0b2foq4xMDA2NDQgTElGRUNZQ0xFLm1kAGEz6v2c+pVZCpcQa9TC31P1dcj0NDAwMDAgY29udHJhY3RzAFWnAr7vKAAN0BbHCQ8tXcakRsITNDAwMDAgZG9jcwDIcvRk2u3tocpuyEoSqwY2pGSCMzEwMDY0NCBoYXJkaGF0LmNvbmZpZy50cwCXh65pDMkCWdDeRaSoadmX7vtMMzQwMDAwIGhlbHBlcnMAlZehSPJsPheBT+rBLLCoOYSO1Xs0MDAwMCBpZ25pdGlvbgDa33BYPYe+YW++6QfQ63GfJ9n5sDEwMDY0NCBwYWNrYWdlLWxvY2suanNvbgCWPZdv2v4jEnOGOCzCaRqAWcHqUDEwMDY0NCBwYWNrYWdlLmpzb24ACX1iddZuBYY5CVVQAl4/fuZIgD80MDAwMCBzY3JpcHRzAHYgM6Is/qPCVyLWq/mTeG3IoMADNDAwMDAgdGVzdADPz9k0dnrsk36JdG9/2R+5aS/L8TEwMDY0NCB0c2NvbmZpZy5qc29uAPk6h3+XVrhIlk0krw8mwDSvBVM3
EOF
```

Expected output (matches the tree named in Step 1):

```
f432ef9ee1bb97243da8e2401483f72cbe00f430
```

Now read the imported tree and find the `contracts` entry:

```bash
git cat-file -p f432ef9ee1bb97243da8e2401483f72cbe00f430 | grep contracts
```

Expected output:

```
040000 tree 55a702beef28000dd016c7090f2d5dc6a446c213	contracts
```

This proves the audited fix-review `contracts/` subtree hash is `55a702beef28000dd016c7090f2d5dc6a446c213`.

## Step 3 — Reconstruct and compare the retained audit snapshot

Run with Python 3 from the repository root:

```bash
python3 scripts/verify-audit.py
```

Expected output:

```text
Audited contracts tree verified: 55a702beef28000dd016c7090f2d5dc6a446c213
```

The reconstructed tree equals the tree committed by the fix-review commit above.
This proves byte identity for the original snapshot, without claiming the corrected
helper or new tests were audited. The script uses Git's documented object encoding
and SHA-1 hashing; it does not trust a stored per-file checksum as a substitute for
reading source contents.

Post-audit changes under `contracts/`:

- `libraries/UniswapV3Math.sol`: delegates `mulDiv` to OpenZeppelin 5.0.2 `Math.mulDiv`,
  fixing wrapping arithmetic that reverted under Solidity 0.8, and corrects the
  SPDX identifier to GPL-2.0-or-later for incorporated TickMath code. Its original is archived.
- `mock/RouterSwapMock.sol`: a funded swap fixture for router integration tests.
- `mock/UniswapV3MathTest.sol`: exposes the corrected internal helper for regression tests.

None changes the source or runtime bytecode of the seven top-level core contracts.

## The audited (pre-fix) commit

The same technique applies to the audited commit `e951edc3…`. Its commit object:

```bash
git hash-object -t commit --stdin <<'EOF'
tree 3d2d0cc64a893ecba34944bcbbe69fc61362497b
parent bfaac2e3f4c042132a41953047122d64849b24a8
author Juuso Roinevirta <jroinevirta@gmail.com> 1779254291 +0300
committer Juuso Roinevirta <jroinevirta@gmail.com> 1779254291 +0300

Add 2d VRP sepolia
EOF
```

Expected output: `e951edc34939d8191d65c5ef29c2fc2e4ac5a462`.

Its root tree object:

```bash
base64 -d <<'EOF' | git hash-object -t tree -w --stdin
MTAwNjQ0IC5lbnYuZXhhbXBsZQDKX36R+CbgdDNYXfYA81lw/ZrKrzEwMDY0NCAuZ2l0aWdub3JlAJWQRxSfg2t0CXEV8Nb9m4nED+OvMTAwNjQ0IC5wcmV0dGllcnJjLmpzb24AzNtSIXiTcCiLxT53upWqcsGVE0YxMDA2NDQgLnNvbGhpbnRpZ25vcmUAt1yrXSYV53CqcKFAGcQnhlnoIUgxMDA2NDQgLnNvbGhpbnRyYy5qc29uAA1IU86kSYN6VxayQ4I9sdAlbstFMTAwNjQ0IExJQ0VOU0UA8Q77TAp/QtGsYVOSClFeeBGmcMYxMDA2NDQgTElGRUNZQ0xFLm1kALy0ZIYFCuIy+6B24A29+SWKxiVWMTAwNjQ0IE1vY2tXZUVUSF9mbGF0dGVuZWQuc29sAOm4WvfS7zAntFvFo+udR679TkKyNDAwMDAgY29udHJhY3RzAEfT31esqM8z4IBeC1BzmWlfADzQNDAwMDAgZG9jcwD2cvFWyRmjwXWvHdmQHuINNdwykDEwMDY0NCBoYXJkaGF0LmNvbmZpZy50cwD2wKsYehR9uhEyczLp/Fw026oPsjQwMDAwIGhlbHBlcnMAlZehSPJsPheBT+rBLLCoOYSO1Xs0MDAwMCBpZ25pdGlvbgAjNVuvCjtbixuHqPReC5GQ24x4bDEwMDY0NCBwYWNrYWdlLWxvY2suanNvbgDPOJ8psrtVfrHUd8JfD1wpIPjYFzEwMDY0NCBwYWNrYWdlLmpzb24Av4+fYPm4sSjqv6t2kt1cCqab+ME0MDAwMCBzY3JpcHRzAB5Ckg2dtpmLKeSZHT3+mCZwK2MANDAwMDAgdGVzdADGklrh7RoBPyqrjiOzo/iebw7inTEwMDY0NCB0c2NvbmZpZy5qc29uAPk6h3+XVrhIlk0krw8mwDSvBVM3
EOF
```

Expected output: `3d2d0cc64a893ecba34944bcbbe69fc61362497b`, whose `contracts` entry is `47d3df57aca8cf33e0805e0b507399695f003cd0`.

This repository intentionally does **not** match the pre-fix subtree. The audited and fix-review
commits are separated by 28 commits; that range includes the remediation work Hashlock re-reviewed,
among it the fixes for findings H-01, M-01, L-02 and L-03. The difference between `47d3df57…` (audited) and
`55a702be…` (the retained audit snapshot) touches seven files under `contracts/` — `DepegFactory.sol`,
`DepegPool.sol`, `TapirOracle.sol`, `TapirPtrwOracle.sol`, `TapirVrpOracle.sol`,
`interfaces/ITapirOracle.sol` and `mock/MockDepegPoolForOracle.sol`. The fix-review commit is the
state Hashlock signed off on, and its original snapshot is retained here as described above.

This subtree identity proves *which source* Hashlock reviewed. It is not a claim that every finding
was fixed: the report records L-01, Q-01 and Q-02 as acknowledged, and the behaviours behind L-01
and Q-01 are part of the source proven here. See the Audits section of the README.

## The Quantstamp baseline commit

The Quantstamp report's front page pins `tapir-core-v1` at `#4ec27b5`. That commit is the baseline
Hashlock later used as its delta base. Its commit object:

```bash
git hash-object -t commit --stdin <<'EOF'
tree 7f67110e273a6fc8bca5539691b40a0239e58f59
parent 0311a9455e72a02fbe92d6b35afa56b44ec56819
author Juuso Roinevirta <jroinevirta@gmail.com> 1764864056 +0200
committer Juuso Roinevirta <jroinevirta@gmail.com> 1764864056 +0200

Prettier
EOF
```

Expected output: `4ec27b5f3a97a39deb45a847b5b8605776607e4c`, matching the abbreviated `#4ec27b5` on
the report's front page. Its root tree object:

```bash
base64 -d <<'EOF' | git hash-object -t tree -w --stdin
MTAwNjQ0IC5lbnYuZXhhbXBsZQD0s5wRjKRiNEDIZhWYJZsN3VlV+zEwMDY0NCAuZ2l0aWdub3JlAF/XNYAFGo1nGcZYJDqV/MAd56qlMTAwNjQ0IC5wcmV0dGllcnJjLmpzb24AzNtSIXiTcCiLxT53upWqcsGVE0YxMDA2NDQgLnNvbGhpbnRpZ25vcmUAt1yrXSYV53CqcKFAGcQnhlnoIUgxMDA2NDQgLnNvbGhpbnRyYy5qc29uAA1IU86kSYN6VxayQ4I9sdAlbstFMTAwNjQ0IExJQ0VOU0UA8Q77TAp/QtGsYVOSClFeeBGmcMYxMDA2NDQgUk9MRVMubWQA4FCKO7S2UhgRXOvdirWH9E8svAY0MDAwMCBjb250cmFjdHMAGYiTJ0BNWnWpVrnAmUQU2hL/fQI0MDAwMCBkZXBsb3ltZW50cwAHZdP6mey6uqDpkVaHN4FeYRW5+DQwMDAwIGRvY3MAEFWHabWS1FA8bRzGfG9ANM3q7iUxMDA2NDQgaGFyZGhhdC5jb25maWcudHMAasPkj1SDQyhp38sSHbyBC9lhves0MDAwMCBoZWxwZXJzAJWXoUjybD4XgU/qwSywqDmEjtV7NDAwMDAgaWduaXRpb24AmV8Cl8FpgwnYPk59ARAx23gVV20xMDA2NDQgcGFja2FnZS1sb2NrLmpzb24AoZTvpF98BQD5jEHQuf2CHVINM1sxMDA2NDQgcGFja2FnZS5qc29uAL+Pn2D5uLEo6r+rdpLdXAqmm/jBMTAwNjQ0IHBvb2xfbGlmZWN5Y2xlX3Jpc2tfY29udHJvbHMubWQALTJvkiCjcQkFNQixw1iIOjfJTao0MDAwMCB0ZXN0ABE+rqfeuXgak2MchHcFcdvO2+F8MTAwNjQ0IHRzY29uZmlnLmpzb24A+TqHf5dWuEiWTSSvDybANK8FUzc=
EOF
```

Expected output: `7f67110e273a6fc8bca5539691b40a0239e58f59`, whose `contracts` entry is
`19889327404d5a75a956b9c0994414da12ff7d02`.

As with the pre-fix commit, this repository intentionally does **not** match that subtree — it retains
the later fix-review snapshot, with the post-audit changes listed above. What ties the two together is Quantstamp's own file manifest: the report
lists an abbreviated SHA-256 per reviewed file, and those abbreviations are reproduced exactly by
the files at `4ec27b5f…`.

| File | Report | SHA-256 at `4ec27b5f…` |
|---|---|---|
| `contracts/DepegFactory.sol` | `249...cc7` | `24982851d173aaa3db91be966e69e88f7bb6e745d3b487a58fabb2a449b71cc7` |
| `contracts/DepegPool.sol` | `4fa...58c` | `4fab8a9e63eea707b9c5b5fb41bb5cf8b1c0e31686f298673f84f8399e0df58c` |
| `contracts/DepegToken.sol` | `c14...d24` | `c14169324e1386a9ab11f9635d5b4341257c6a6ef873d6b8d91da6a6a945ed24` |
| `contracts/TapirOracle.sol` | `cab...dc1` | `cab356cb0e75653b0683a474c75e9833b549f227e6e62429cd003832c5f71dc1` |
| `contracts/TapirPtrwOracle.sol` | `5e7...1f0` | `5e7605a01ac0e16e1dd96c3e6c0df36ad570198bd7a6bc28824592449235a1f0` |
| `contracts/TapirRouter.sol` | `bee...7ac` | `beed330790201f9c11b04baa862f5c57ae19e4a69a4f9b016fc6b3f5335907ac` |
| `contracts/libraries/TimeDecay.sol` | `d67...03d` | `d672996fd02938d3a25d911d88621ddd772c7f5758c0fdf56085f8c868ed603d` |
| `contracts/libraries/UniswapV3Math.sol` | `4a1...b5a` | `4a15a490e2dca060e2acb69a3d4903e9d656a3afba06937d0cc81f29c722eb5a` |

`contracts/TapirVrpOracle.sol` does not appear in that manifest because the file did not exist at
`4ec27b5f…`. The VRP oracle was added afterwards and reviewed by Hashlock, not by Quantstamp — so
Quantstamp's core scope covers eight of the nine Solidity files this repository ships at the top
level of `contracts/` plus `contracts/libraries/` (seven top-level files and two library files) —
every one except `contracts/TapirVrpOracle.sol` — and none of the VRP oracle.

`contracts/DepegToken.sol` and the archived original `UniswapV3Math.sol` still hash to
the Quantstamp values above. The current math helper has the explicit post-audit fix.
The other six files changed between the Quantstamp baseline and the fix-review state;
their current hashes are in the next section.

The Quantstamp report also pins the AMM repository at `#ff4d820`. That code is not in this
repository; its own proof lives in
[public-tmarket-univ3-based/VERIFICATION.md](https://github.com/tapir-protocol/public-tmarket-univ3-based/blob/main/VERIFICATION.md).

## File-level checksums

SHA-256 of the seven audited contracts at the fix-review commit (and in this repository — verify with `sha256sum`):

| File | SHA-256 |
|---|---|
| `contracts/DepegFactory.sol` | `16238a1633677089e7999583b256fcc10b344719ad91a6de85478884656fdbcb` |
| `contracts/DepegPool.sol` | `7ac120827eadc61440ab0a50072b3b74c605bf676321eaa3aafab30133b2b962` |
| `contracts/TapirOracle.sol` | `510157118293556502b993571271e0613bcc9f44406ddd87080151de08e9d937` |
| `contracts/TapirPtrwOracle.sol` | `d90eda294e0f6098e76394031c48fd15075de4a22967c13b817d1b63be10e7d1` |
| `contracts/TapirRouter.sol` | `658403da3007656b2a16e9558905f5b3cdef2c5db97ae6054d21068b9e8f1476` |
| `contracts/TapirVrpOracle.sol` | `cb38d08845949d7b75c030dd0117f191275c6b734d83c235e336e21b1967f2f0` |
| `contracts/libraries/TimeDecay.sol` | `333e5f38a39ffe92dbc4e3b2250f620efd4e5c4990e8bc4abc58ebc954d5adac` |

## Notes

- SHA-1 here is git's object addressing; the file-level table above additionally provides SHA-256.
- All three `tapir-core-v1` commits pinned by the reports' scope listings are reconstructed above: Quantstamp's `4ec27b5f…`, and Hashlock's `e951edc3…` and `9fc06de7…`.
