# tapir_access_control


## OpenZeppelin AccessControl

The tables list contract-specific functions; AccessControl role-management functions are inherited separately.

### DEFAULT_ADMIN_ROLE

| Contract | Capabilities |
|----------|-------------|
| DepegPool | `proposeOracleChange`, `setAuthorisedRouter`, `setCooldownDuration`, `setMinPriceAge`, `unpause` |
| TapirOracle | `setSources`, `setConfig`, `pause`, `unpause` |
| TapirPtrwOracle | `manualBackupResolvePtrw`, `resetForceManualResolve` (plus inherited admin functions from TapirOracle) |
| TapirVrpOracle | `manualBackupResolveVrp` (plus inherited admin functions from TapirOracle) |

### OPERATOR_ROLE

| Contract | Capabilities |
|----------|-------------|
| DepegPool | (none granted at deployment; must be assigned by admin) |
| TapirOracle | `recordApi3Price`, `recordChainlinkPrice`, `recordRedStoneClassicPrice`, `recordTellorPrice`, `checkpoint`, `writePriceData` |
| TapirPtrwOracle | `resolvePtrw`, `writePriceData` (plus inherited operator functions from TapirOracle) |
| TapirVrpOracle | `resolveVrp`, `writePriceData` (plus inherited operator functions from TapirOracle) |

### Admin or Operator (onlyAdminOrOperator modifier)

| Contract | Capabilities |
|----------|-------------|
| DepegPool | `setRedemptionFeeBp`, `pause`, `rescueErc20` |

## Ownership and immutable caller gates

| Contract | Controller | Capabilities |
|----------|------------|-------------|
| DepegFactory | Owner | `deployDepeg` |
| DepegToken | DepegPool (set in constructor) | `mint`, `burn` |

## Custom modifiers

| Modifier | Contract | Allowed caller |
|----------|----------|----------------|
| `onlyOracle` | DepegPool | Oracle contract (direct or via L2 cross-domain messenger) |
| `onlyDepegPool` | DepegToken | Parent DepegPool contract |

## Permissionless functions

| Contract | Function | Notes |
|----------|----------|-------|
| DepegPool | `executeOracleChange` | Anyone, after 7-day timelock |
| DepegPool | `resolvePriceDepeg` | Anyone, once all conditions met |
| DepegPool | `sweepFeesToTreasury` | Anyone, during REDEMPTIONS state |
