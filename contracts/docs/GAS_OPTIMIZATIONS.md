# HashPowerPerpsDEX — Gas Optimisation Summary

Measured on `createOrder` via `tests/gas-createOrder.test.ts`.  
All scenarios use a single seller (maker) placing N resting orders, then a single buyer (taker) sweeping them in one `createOrder` call.

---

## Results

| Scenario | Baseline | Round 1–7 | + DLL (Round 8) | + Micro-opts (Round 9, no DLL) | Total saved (baseline → R9) | % |
|---|---:|---:|---:|---:|---:|---:|
| Resting only (no match) | 393,610 | 376,018 | **369,001** | **371,260** | -22,350 | -5.7% |
| 1 match | 338,467 | 337,190 | **329,391** | **336,196** | -2,271 | -0.7% |
| 3 matches (1 level) | 410,999 | 392,865 | **376,061** | **390,916** | -20,083 | -4.9% |
| 10 matches (1 level) | 795,267 | 730,676 | **686,135** | **724,689** | -70,578 | -8.9% |
| 10 matches (5 levels) | 869,548 | 809,504 | **748,720** | **803,518** | -66,030 | -7.6% |
| 20 matches (1 level) | 1,343,788 | 1,212,812 | **1,128,647** | **1,201,057** | -142,731 | -10.6% |
| 20 matches (10 levels) | 1,510,922 | 1,390,176 | **1,269,464** | **1,378,422** | -132,500 | -8.8% |
| **32 matches (1 level)** | **2,002,040** | **1,791,375** | **1,659,661** | **1,772,699** | **-229,341** | **-11.5%** |

### Average gas per match (32-match scenario)

| | Gas |
|---|---:|
| Baseline | 62,564 |
| After rounds 1–7 | 55,980 |
| After DLL (round 8) | **51,864** |
| Round 9 (micro-opts only, no DLL) | **55,397** |
| Total reduction vs baseline (R9) | **-7,167 (-11.5%)** |

---

## Changes Made

### 1. Remove `createdAt` from `Order` struct

`Order` shrank from 4 storage slots to 3 by dropping the `createdAt` field.  
The indexer reads timestamps from block metadata instead.

**Impact:** saves 1 cold SLOAD per maker order read (~2,100 gas × N matches).

```solidity
// Before (4 slots)
struct Order {
    address participant;
    uint256 price;
    int256 quantity;
    uint256 createdAt;  // removed
}

// After (3 slots)
struct Order {
    address participant;
    uint256 price;
    int256 quantity;
}
```

---

### 2. Settle taker funding once before the matching loop

`_settleFunding(taker)` was previously called inside `_updateUserPosition` on every match.  
Since `cumulativeFundingPerUnit` is constant within a transaction, calls 2–N were no-op reads.

**Fix:** call `_settleFunding(_msgSender())` once in `createOrder` before the loop; `_createPosition` skips settlement for the taker on each iteration.

**Impact:** saves ~3 SLOADs × (N−1) redundant calls.

---

### 3. Defer `_removePriceLevelIfEmpty` to after each price level

Previously called inside `_removeOrder` on every fully-filled maker order.  
For N orders at one price level, N−1 of those calls were no-ops (queue still had orders).

**Fix:** removed the call from `_removeOrder`; `_matchOrdersAtPrice` calls it once after its inner loop, and `cancelOrder` calls it directly.

**Impact:** saves ~(N−1) × ~200 gas per price level swept.

---

### 4. Replace `sizeOf()` loop guard with head-pointer check

`_matchOrdersAtPrice` checked `makerOrderQueue.sizeOf() > 0` (1 SLOAD) on every iteration before getting the head node (2 SLOADs).

**Fix:** read the head pointer once before the loop and re-read it after each removal.

**Impact:** saves 1 SLOAD per match.

---

### 5. Cache `makerParticipant` and `makerPrice` in `_executeMatch`

`_makerOrder.participant` was read from storage three times (struct copy, `_chargeMatchFee`, `userTotalOrderValue`). `_makerOrder.price` was read twice.

**Fix:** cache both fields at the top of `_executeMatch`; pass `makerParticipant` directly to `_createPosition` (eliminating `Order memory orderCopy`) and to `_removeOrder`.

**Impact:** saves 2 warm SLOADs per match for participant; eliminates the full struct memory copy.

---

### 6. Move `userTotalOrderValue` decrement out of `_removeOrder`

`_removeOrder` always subtracted the order's notional value from `userTotalOrderValue`.  
When called from `_executeMatch` after a full fill, `order.quantity` was already 0, making it a no-op SSTORE.

**Fix:** callers own the decrement. `_executeMatch` decrements by `notionalValue` (already done before the call). `cancelOrder` decrements by the remaining order value before calling `_removeOrder`.  
`_removeOrder` now only handles structural removal: queue, participant index, and storage delete.

**Impact:** saves 1 warm SSTORE per full fill.

---

### 7. Cache `sizeOf()` in `_addPriceLevel`

`priceList.sizeOf()` was called twice (capacity check + empty check).

**Fix:** read once into a local variable.

**Impact:** saves 1 SLOAD per resting order placement.

---

### 8. Remove dead code: `_isOppositeSign`

The function was defined but never called. Removed for clarity.

---

### 8. Replace `StructuredLinkedList` with custom `DLL` library

`StructuredLinkedList` uses nested mappings (`mapping(uint256 => mapping(bool => uint256))`),
requiring **two** keccak256 slot derivations per node pointer access, and `remove()` always
zeros both pointers and decrements the `size` counter (3 extra SSTOREs).

**Fix:** new `DLL` library (`contracts/DLL.sol`) with:

- **Flat mappings** — `mapping(uint256 => uint256) next` and `prev` (1 keccak256 per access).
- **`removeFast`** — skips zeroing node pointers and the size decrement. Safe for order queues
  where node IDs are unique keccak256 hashes and are never reinserted.
- **`isEmpty()`** — checks `next[0] == 0` instead of `sizeOf() == 0`, correct without a
  maintained size counter.
- **`getNext(node)`** — returns plain `uint256` (no discarded `bool` in every call site).

Order queues use `pushBack` / `removeFast` / `isEmpty` / `getNext`.  
Price lists use `pushFront` / `insertBefore` / `insertAfter` / `remove` / `nodeExists` / `sizeOf` / `getNext` (full semantics, same as before).

**Impact:** ~4,100 gas saved per match; ~7,000 gas saved on the resting-only path.

---

### 9. Micro-optimisations (Round 9, no DLL — applied 2026-02-20)

Applied worktree optimisations without swapping the linked-list implementation.

1. **Skip `_settleFunding` when funding is not configured**  
   Early return when `lastFundingUpdateTime == 0` or `fundingPeriod == 0`. Benchmarks use disabled funding, so this saves storage reads on the hot path.

2. **Cache `_msgSender()` in `createOrder`**  
   Resolve `address sender = _msgSender()` once; reuse throughout.

3. **Validation inlining**  
   Inline `_quantity == 0` and `_price` checks at function start instead of calling `_validateQty` / `_validatePrice`.

4. **`_executeMatch` micro-opts**  
   Cache `makerQty`, compute `newMakerQty` once, use `unchecked { return _remainingQty - matchQty }`.

5. **`_createPosition` simplification**  
   Remove redundant taker parameter (was passed twice); simplify signature to `(makerParticipant, taker, ...)`.

6. **Cheaper order IDs**  
   Replace `keccak256(abi.encode(...))` with `bytes32(++nonce)`. Sequential counter is unique within the contract and much cheaper.

**Impact (Round 9 vs Round 1–7, no DLL):** ~4.8K gas on resting-only; ~1–19K gas on matching scenarios. DLL migration (Round 8) would yield additional ~4.1K gas per match.

---

## What was considered but not done

| Idea | Reason skipped |
|---|---|
| Cache `takerFeeBps` / `liquidationFee` before loop | Slots become warm after first match; EVM warm-slot cache already handles subsequent reads at 100 gas |
| Skip `_settleFunding` for maker when same address appears in multiple consecutive orders | Maker addresses vary in production; the optimisation would only help the synthetic single-seller benchmark |
