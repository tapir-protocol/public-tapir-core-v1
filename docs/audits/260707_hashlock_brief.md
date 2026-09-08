# Audit Brief

This brief intends to give sufficient context for reviewing the security of the Tapir system.

The scope includes the following seven smart contracts on Ethereum mainnet:
1. `contracts/DepegFactory.sol`
2. `contracts/DepegPool.sol`
3. `contracts/TapirOracle.sol`
4. `contracts/TapirPtrwOracle.sol`
5. `contracts/TapirRouter.sol`
6. `contracts/TapirVrpOracle.sol`
7. `contracts/libraries/TimeDecay.sol`

External dependencies and integrations (such as OpenZeppelin, Pendle Router, Zircuit Vault, Chainlink, API3, Tellor, Redstone) are treated as observations rather than formal deliverables.

The scope explicitly excludes:
1. `contracts/DepegToken.sol`
2. All contracts in the `contracts/interfaces/` directory
3. All contracts in the `contracts/mock/` directory
4. All contracts in the `contracts/libraries/` directory, except `TimeDecay.sol`
5. Any smart contract code within inherited contracts or external dependencies
6. Smart contract tests
7. Accuracy of inline documentation as a direct deliverable

## Assumptions
1. **DepegPool:** `DEFAULT_ADMIN_ROLE` and `OPERATOR_ROLE` act honestly and correctly with respect to the end-user of the protocol.
2. **Oracles:** `DEFAULT_ADMIN_ROLE` and `OPERATOR_ROLE` act honestly and correctly. Operators may miss intended checkpoints by a few blocks but do not maliciously spam functions.
3. **Price Feeds:** Majority of external feeds (Chainlink, API3, etc.) are robust and non-manipulatable. 
4. **Configuration:** Pools are initialised with correct decimals and sufficient `MAX_PRICE` headroom for non-malicious growth (e.g., yield-bearing assets).

## Core Security Invariants
*   **1:1 Backing:** `splitToken()` transfers 1 unit of base `ASSET` and mints 0.5 `DP` and 0.5 `YB` per unit, with floor rounding for odd base-unit amounts.
*   **State Monotonicity:** Pool state transitions (`ACTIVE` → `COOLDOWN` → `RESOLUTION` → `REDEMPTIONS`) are strictly one-way and irreversible.

## Specialised Oracle Mechanisms
### PTRW (Principal Token Redemption Witness)
*   **Logic:** Uses the actual redemption value of Pendle PT tokens at maturity to prove a depeg.
*   **Dependency:** Requires PT tokens to be deposited into the oracle contract *before* maturity.
*   **Fallback:** If automatic resolution fails, the `DEFAULT_ADMIN_ROLE` must manually resolve via `manualBackupResolvePtrw`.

### VRP (Vault Redeem Preview)
*   **Logic:** Monitors ERC-4626 `previewRedeem` quotes against a historical High Water Mark (HWM) to detect losses in yield-bearing vaults.
*   **Dependency:** Assumes the vault's `previewRedeem` is a reliable view of share value and cannot be manipulated.

## Integration Boundaries
*   **Standard ERC20:** The system assumes base assets follow standard `IERC20` behaviour. Non-standard tokens (rebasing, fee-on-transfer) are out of scope.
*   **Pendle V2:** PTRW logic assumes the `PendleRouter` and PT tokens strictly follow the Pendle V2 specification for redemptions.

The system lifecycle is described in the pool lifecycle documentation (`docs/tapir_pool_lifecycle_risk_controls.md`)
