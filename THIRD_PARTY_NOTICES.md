# Third-party and file-level licenses

The root [BUSL-1.1 license](LICENSE) is the default license for Tapir's work. Files
carrying a different SPDX identifier retain that license; the BUSL notice does not
relicense them. Audit reports and other external publications retain their publishers'
rights. The Quantstamp report is linked to its publisher and is not redistributed here.

| Material | License and origin |
|---|---|
| `contracts/interfaces/IV3SwapRouter.sol` | [GPL-2.0-or-later](LICENSES/GPL-2.0-or-later.txt); Uniswap swap-router interface, adapted pragma/imports for this project. [Upstream](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/interfaces/IV3SwapRouter.sol). |
| `contracts/interfaces/IUniswapV3SwapCallback.sol` | [GPL-2.0-or-later](LICENSES/GPL-2.0-or-later.txt); Uniswap V3 callback interface. [Upstream](https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/callback/IUniswapV3SwapCallback.sol). |
| `contracts/interfaces/IPMarketFactoryV3.sol` | [GPL-3.0-or-later](LICENSES/GPL-3.0-or-later.txt); Pendle market-factory interface. [Upstream](https://github.com/pendle-finance/pendle-core-v2-public/blob/41bd310ac01ecb0cb26dbd0a88774789e1e100cd/contracts/interfaces/IPMarketFactoryV3.sol). |
| `contracts/libraries/UniswapV3Math.sol` and its archived original | [GPL-2.0-or-later](LICENSES/GPL-2.0-or-later.txt) for the incorporated Uniswap V3 TickMath; the original FullMath portion is [MIT](LICENSES/MIT.txt) and credits Remco Bloemen. The current helper now uses OpenZeppelin Math (MIT). [TickMath](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol), [FullMath](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/FullMath.sol). The checked-arithmetic correction is dated in the current source. |
| Other files with `SPDX-License-Identifier: MIT` | [MIT](LICENSES/MIT.txt), as specified in each file. |

Uniswap contributors retain rights in their original interface and math code. Pendle
contributors retain rights in their original interface code. Tapir modifications do
not remove upstream notices or alter the upstream licenses. The archived math source retains an incomplete MIT header from the audited snapshot.
That header does not relicense its incorporated GPL TickMath code; the GPL terms above
apply to that upstream portion. The current helper corrects the identifier.

The archived sources retain their exact bytes for audit verification; the archive is not a second supported
implementation. The dated source correction and new test fixtures are listed in
[VERIFICATION.md](VERIFICATION.md).

OpenZeppelin and API3 are installed through npm, not vendored into this repository.
Their package contents carry their own license notices. Dependency versions are
recorded in `package-lock.json`; OpenZeppelin 5.0.2 and API3 27.0.0 are pinned because
they participate in source/bytecode reproducibility.
