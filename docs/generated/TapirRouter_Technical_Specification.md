# TapirRouter technical specification

**Source:** `contracts/TapirRouter.sol`
**Solidity:** ^0.8.27
**License:** BUSL-1.1

---

## Overview

TapirRouter wraps DepegPool and Uniswap V3 interactions into single-call flows. It lets users split-and-buy one side (DP or YB), sell-and-unsplit back to base, or swap between DP and YB. The router is stateless (no storage, no admin functions) and treats `msg.sender` as the counterparty for all operations.

Does not support ERC777 tokens or tokens with transfer hooks.

---

## Architecture

```
User → TapirRouter → DepegPool (split / unsplit / redeem)
                    → Uniswap V3 SwapRouter (exactInputSingle)
```

- Uses OpenZeppelin `SafeERC20` for all token operations
- The router has no storage variables or access-control state

---

## Core interactions (direct pool calls)

These are thin wrappers. The pool administrator must have authorized this router through `setAuthorisedRouter`. `split()` requires the user to approve the base asset to the pool; `unsplit()` and `redeem()` burn DP/YB directly from the user and do not read token allowances. The router does not hold or manage tokens for these functions.

### split

```solidity
function split(address depegPoolAddress, uint256 baseAmount) external
```

Forwards to `IDepegPool.splitToken(msg.sender, baseAmount)`.

### unsplit

```solidity
function unsplit(address depegPoolAddress, uint256 depegAmount) external
```

Forwards to `IDepegPool.unSplitTokens(msg.sender, depegAmount)`.

### redeem

```solidity
function redeem(address depegPoolAddress, uint256 dpAmount, uint256 ybAmount) external
```

Forwards to `IDepegPool.redeemTokens(msg.sender, dpAmount, ybAmount)`.

These three functions have no deadline or slippage parameters. Their applicable pool state and redemption fee are determined when the transaction executes.

---

## Swap-assisted flows

These combine pool operations with Uniswap V3 swaps. The user must have approved the **router** for the relevant tokens. These flows do not require `setAuthorisedRouter`: the router calls the pool with itself as the counterparty, satisfying the pool's `msg.sender == _counterparty` check.

### splitAndBuy

```solidity
function splitAndBuy(
    address depegPoolAddress, address uniV3SwapRouter, uint24 uniV3Fee,
    uint256 uniV3MinOut, uint256 baseAmount, bool buyingYb,
    uint256 minOut, uint256 deadline
) external
```

Acquires a single token type (DP or YB) from base:

1. Check deadline
2. Pull `baseAmount` base from user to router
3. Approve pool, call `splitToken(router, baseAmount)` -- router receives `floor(baseAmount / 2)` DP and YB
4. Swap the unwanted side via Uniswap V3 (`baseAmount/2` in, `uniV3MinOut` minimum out)
5. Verify total output (swap result + kept side) >= `minOut`
6. Transfer desired token to user

### sellAndUnsplit

```solidity
function sellAndUnsplit(
    address depegPoolAddress, address uniV3SwapRouter, uint24 uniV3Fee,
    uint256 uniV3MinOut, uint256 amountIn, uint256 amountInForSwap,
    bool sellingYb, uint256 minOut, uint256 deadline
) external
```

Exits a DP or YB position back to base:

1. Check deadline
2. Pull `amountIn` of the input token (DP or YB) from user
3. Swap `amountInForSwap` portion to the opposite token via Uniswap V3
4. Compute `unsplitAmount = min(dpBalance, ybBalance)` held by router
5. Approve pool for both tokens, call `unSplitTokens(router, unsplitAmount)`
6. Verify base balance >= `minOut`
7. Transfer base to user
8. Return any leftover DP/YB to user

These amounts are calculated from the router's absolute token balances, not balance changes for
this call. Any base, DP, or YB already held by the router can therefore be included in the caller's
payout.

The caller should choose `amountInForSwap` so that post-swap DP and YB balances roughly align. Typically `amountInForSwap ~ amountIn / 2`, adjusted for the current DP/YB price ratio.

### swapExactIn

```solidity
function swapExactIn(
    address depegPoolAddress, address uniV3SwapRouter, uint24 uniV3Fee,
    uint256 uniV3MinOut, uint256 amountIn, bool buyingYb, uint256 deadline
) external
```

Pure DP-to-YB or YB-to-DP swap without pool interaction:

1. Check deadline
2. Pull input token from user
3. Swap via Uniswap V3
4. Transfer output to user

Slippage managed entirely by `uniV3MinOut`.

---

## Internal helper

```solidity
function _approveAndSwapExactIn(
    address tokenIn, address tokenOut, address uniV3SwapRouter,
    uint24 uniV3Fee, uint256 amountIn, uint256 uniV3MinOut
) internal returns (uint256 amountOut)
```

Increases allowance for the Uniswap router, executes `exactInputSingle` with `sqrtPriceLimitX96 = 0`, receives output to the router address.

---

## Errors

| Error | Trigger |
|-------|---------|
| `DeadlineExceeded` | `block.timestamp > deadline` |
| `InsufficientOutputAmount` | Combined flow output below `minOut` |

---

## Slippage and deadline protection

- **Direct calls** (split, unsplit, redeem): no deadline or slippage checks.
- **Swap flows**: two layers of protection:
  - `uniV3MinOut`: minimum output from the Uniswap swap itself
  - `minOut`: minimum total output of the combined flow (swap + pool operation)
- **Deadline**: enforced on all swap flows to prevent stale transactions

---

## Token and allowance handling

- In swap-assisted flows, uses `safeTransferFrom` to pull tokens from users (user must approve the router)
- Uses `safeIncreaseAllowance` for pool and Uniswap approvals (does not reset to zero)
- The router's pool and Uniswap allowances can accumulate across calls; they belong to the router, not to the user

---

## Security considerations

- **Stateless:** the router has no storage variables or administrative roles.
- **Allowance accumulation:** `safeIncreaseAllowance` means repeated calls can increase the router's approvals to a pool or Uniswap router.
- **Pool checks:** the router cannot bypass DepegPool state or caller-authorization checks.
- **Token hooks:** the source declares ERC777 tokens and tokens with transfer hooks unsupported.
