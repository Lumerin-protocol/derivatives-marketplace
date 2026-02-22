# Worktree Optimisations Report

**Task:** Gas optimisations for `PerpsSimple.sol`  
**Date:** 2026-02-20  
**Worktrees:** 17 total (1 main + 16 agent worktrees)

---

## Overview

Four of 16 agent worktrees produced substantive optimisation changes to the `createOrder` path in `PerpsSimple.sol`. All agents worked from the same baseline: rounds 1–8 (including the DLL migration from `StructuredLinkedList`). The following summarises each agent’s approach, changes, and results.

---

## Agent Worktrees With Changes

### pgq — **Highest Impact (-18.0%)**

**Approach:** Extra “Round 9” optimisations targeting both the funding path and the match loop.

**Optimisations added:**
1. **Skip `_settleFunding` when funding not configured**
   - Early return when `lastFundingUpdateTime == 0` or `fundingPeriod == 0`.
   - Large savings in the benchmark suite (funding disabled in fixtures).
2. **Per-match work reductions in `_executeMatch` and `_createPosition`**
   - Cache `makerQty`, compute `newMakerQty` once, use `unchecked { return _remainingQty - matchQty }`.
   - Remove redundant taker parameter in `_createPosition` (was passed twice).
3. **Cheaper order IDs**
   - Replace `keccak256(abi.encode(...))` with `bytes32(++nonce)`.
   - Small but measurable savings on resting-only path.

**32-match scenario:** 1,640,932 gas (−361,108 / −18.0%)  
**Best result among all agents.**

---

### qmq — **DLL + Validation Focus (-7.4% vs pre-change)**

**Approach:** DLL migration plus validation inlining and sender caching. Introduced deterministic benchmarks via `freezeTimestamp()` in tests.

**Optimisations added:**
1. **DLL migration** (same as baseline)
   - Replace `StructuredLinkedList` with `DLL`, use `removeFast` for order queues.
2. **`createOrder` sender caching**
   - `address sender = _msgSender()`; reuse through the function.
3. **Validation inlining**
   - Inline `_quantity` / `_price` checks at start of `createOrder` instead of helper calls.
4. **`isEmpty()` in DLL**
   - Add `isEmpty()` helper: `return self.next[0] == 0` for order queue empty checks.

**Tried and reverted:**
- Caching `cumulativeFundingPerUnit` in `_settleFunding` (matching regressed).
- Iterating maker queue via `getNext(currentOrderId)` (regressed vs `getNext(0)` loop).

**Files touched:** `GAS_OPTIMIZATIONS.md`, `PerpsSimple.sol`, `DLL.sol`, `gas-createOrder.test.ts`

---

### skt — **Micro-opts + Correctness (-17.1%)**

**Approach:** Small hot-path improvements plus fixes for correct behaviour with `removeFast`.

**Optimisations added:**
1. **Cache `_msgSender()` in `createOrder`**
   - Called 5× before; resolve once.
2. **Unchecked nonce increment**
   - `unchecked { nonce++; }` in `_createOrder`.
3. **`getNext(0) == 0` for order queue empty check**
   - With `removeFast`, `size` is not decremented; use head-pointer check instead of `sizeOf() == 0`.
4. **Simplify `getBestBidPrice` / `getBestAskPrice`**
   - Return `activeBidPrices.getNext(0)` directly; remove `sizeOf() == 0` guard (DLL already returns 0 when empty).

**Note:** Uses `getNext(0)==0` inline instead of `isEmpty()` helper. Result close to baseline DLL round.

---

### wyz — **Micro-opts, Minimal API (-17.1%)**

**Approach:** Minimal code-surface changes; avoids adding `isEmpty()` and relies on inline checks.

**Optimisations added:**
1. **Cache `_msgSender()` as `taker`**
   - Resolve once; use in 4 call sites.
2. **`unchecked { nonce++ }` in `_createOrder`**
   - Nonce overflow deemed impossible in practice.
3. **`abi.encodePacked` instead of `abi.encode` in `_createOrder`**
   - All params fixed-size; removes ABI padding.
4. **Remove `isEmpty()` from DLL**
   - Use `getNext(0) == 0` inline for order queues (no extra helper).
5. **Remove redundant `sizeOf() == 0` guard in `_matchWithOppositeOrders`**
   - Loop already handles empty list.

**Impact:** ~46 gas saved on resting-only path; negligible on matching path once `msg.sender` is warm.

---

## Agent Worktrees With No Changes

| Worktree | Status |
|----------|--------|
| bmn | No changes |
| fmu | No changes |
| gkx | No changes |
| hks | No changes |
| lgh | No changes |
| ppt | No changes |
| szt | No changes |
| tes | No changes |
| tgo | No changes |
| vyp | No changes |
| yhl | No changes |

---

## Comparison Summary

| Worktree | 32-match gas | Savings vs baseline | Notable focus |
|----------|-------------:|--------------------:|---------------|
| **pgq**  | 1,640,932    | **-18.0%**          | Funding skip, match loop, order IDs |
| **qmq**  | 1,659,600    | -7.4% vs pre-change | Validation inlining, sender cache, tests |
| **skt**  | 1,659,715    | -17.1%              | Sender cache, unchecked nonce, empty-check correctness |
| **wyz**  | 1,659,561    | -17.1%              | Micro-opts, minimal API, no `isEmpty()` |

---

## Recommendations

1. **pgq’s Round 9** yields the largest improvement and is the best candidate to merge, especially:
   - Early return in `_settleFunding` when funding is disabled.
   - Per-match changes in `_executeMatch` / `_createPosition`.
   - Sequential order IDs with `bytes32(++nonce)` instead of keccak.
2. **qmq’s `isEmpty()` helper** is a useful addition for clarity; pgq/skt/wyz rely on inline `getNext(0)==0`, which is equivalent.
3. **qmq’s deterministic benchmarks** (`freezeTimestamp`) should be adopted for reproducible gas measurements.
4. **Avoid:** Caching `cumulativeFundingPerUnit` in `_settleFunding` and iterating via `getNext(currentOrderId)` (both regress matching gas, per qmq).
