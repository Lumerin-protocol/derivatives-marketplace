# Liquidation Price & Margin (Perps UI)

Summary for QA and Product: how balance, maintenance margin, and liquidation price work, and how to show them in the UI.

---

## 1. Balance vs Equity

| Term | Meaning | Source |
|------|--------|--------|
| **Balance** | Collateral only (deposits, fees, realized PnL). Matches the contract. | `balanceOf(user)` |
| **Equity** | Balance + unrealized PnL. "Account value" at current mark. | Balance + `getUnrealizedPnl(user)` |

- **Balance** in the UI should **not** include unrealized PnL (so it matches the contract and "withdrawable" notion).
- Show **unrealized PnL** separately (e.g. next to position or in a summary).
- Optionally show **Equity** = Balance + unrealized PnL as "Account value".

---

## 2. Maintenance Margin

- User is liquidatable when: **Balance < Maintenance margin**.
- Maintenance margin **includes**:
  - Margin on current position notional: `positionValue × maintenanceMarginPercent / 100`
  - **Negative** unrealized PnL (adds to required margin)
  - **Positive** pending funding (user owes) — adds to required margin

So: more loss or more funding owed → higher required margin.

---

## 3. Liquidation Price (Formulas)

Assume:
- `colBalance` = collateral balance
- `entryPrice`, `qty` = position entry and signed quantity (e.g. long +64, short -13.46)
- `m` = `maintenanceMarginPercent / 100` (e.g. 0.05 for 5%)

**Long (qty > 0)**  
Liquidation when price falls enough that required margin equals balance:

```
liquidationPrice = (entryPrice × |qty| − colBalance) / (|qty| × (1 − m))
```

**Short (qty < 0)**  
Liquidation when price rises enough:

```
liquidationPrice = (entryPrice × |qty| + colBalance) / (|qty| × (1 + m))
```

---

## 4. What to Show in the UI

- **When the formula gives a valid positive price:** show that price (e.g. "Liquidation price: $X.XX").
- **When it's invalid or meaningless:**
  - **Long:** formula can be **negative** (e.g. very high collateral vs size) → user is not liquidatable at any positive price.
  - **Short:** formula can be negative or unreasonably high → same idea.

**Do not** show the raw negative (or absurd) number.

**Do** show one of:
- **"—"** or **"N/A"**
- **"$0"** with tooltip: "Well collateralized; no liquidation at any positive price."
- Short text: **"No liquidation at any price"** / **"Well collateralized"**

**Implementation:** if computed `liquidationPrice ≤ 0` (or out of display range), render the placeholder/message instead of the number.

---

## 5. Example Checks (for QA)

**Short – liquidatable at higher price**
- colBalance 89.81, entry 3.11, qty -13.46, maintenance 5%
- At market 3.21: maintenance ≈ 3.51, balance 89.81 → not liquidatable.
- Liquidation price (short) ≈ 9.32 (price would need to rise to ~9.32 to hit maintenance).

**Long – "no liquidation price"**
- colBalance 1029, entry 3.22, qty 64, maintenance 5%
- At market 3.21: maintenance ≈ 10.91, balance 1029 → not liquidatable.
- Formula gives negative liquidation price → show **N/A** or "No liquidation at any price" in the UI.
