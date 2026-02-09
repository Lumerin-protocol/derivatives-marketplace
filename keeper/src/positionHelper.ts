// ── Liquidation price computation (pure) ────────────────────────────────────

/**
 * Compute the oracle price at which a user becomes liquidatable.
 *
 * Derivation from the contract's `isLiquidatable` / `getMaintenanceMargin`:
 *
 *   liquidatable when:  balance < orderMargin + positionMaintenance(P)
 *
 *   positionMaintenance(P) = P * |q| / D * mPct/100 + max(0, -(P-e)*q/D)
 *
 * Solving for P:
 *   Long  (q > 0):  P_liq = (e*q - available*D) * 100 / (q * (100 - mPct))
 *   Short (q < 0):  P_liq = (e*Q + available*D) * 100 / (Q * (100 + mPct))
 *
 * where available = balance - orderMargin, Q = |q|
 */
export function computeLiquidationPrice(
  netQuantity: bigint,
  entryPrice: bigint,
  collateral: bigint,
  orderMargin: bigint,
  maintenanceMarginPercent: bigint,
  quantityDecimals: bigint,
): bigint {
  if (netQuantity === 0n) return 0n;

  const available = collateral > orderMargin ? collateral - orderMargin : 0n;

  const D = 10n ** quantityDecimals;

  if (netQuantity > 0n) {
    // Long: liquidatable when price drops BELOW this value
    const numerator = (entryPrice * netQuantity - available * D) * 100n;
    const denominator = netQuantity * (100n - maintenanceMarginPercent);
    if (denominator <= 0n) return 0n;
    return numerator / denominator;
  }

  // Short: liquidatable when price rises ABOVE this value
  const Q = -netQuantity;
  const numerator = (entryPrice * Q + available * D) * 100n;
  const denominator = Q * (100n + maintenanceMarginPercent);
  if (denominator <= 0n) return 0n;
  return numerator / denominator;
}

/**
 * Derive the price-independent order margin from on-chain `getMaintenanceMargin`,
 * then compute the liquidation price — all in one step.
 *
 * `getMaintenanceMargin` returns:
 *   orderComponent (uses marginPercent) + positionComponent(P) (uses maintenanceMarginPercent)
 *
 * We can compute positionComponent(P) ourselves, so:
 *   orderMargin = totalMaintenanceMargin − positionComponent(P)
 */
export function computeLiquidationState(
  netQuantity: bigint,
  entryPrice: bigint,
  collateral: bigint,
  totalMaintenanceMargin: bigint,
  marketPrice: bigint,
  maintenanceMarginPercent: bigint,
  quantityDecimals: bigint,
): { orderMargin: bigint; liquidationPrice: bigint } {
  const D = 10n ** quantityDecimals;

  // Derive order margin by subtracting position component at current price
  const absQ = netQuantity > 0n ? netQuantity : -netQuantity;
  const posValue = (marketPrice * absQ) / D;
  const posMaintenance = (posValue * maintenanceMarginPercent) / 100n;
  const pnl = ((marketPrice - entryPrice) * netQuantity) / D;
  const unrealizedLoss = pnl < 0n ? -pnl : 0n;
  const positionComponent = posMaintenance + unrealizedLoss;

  const orderMargin =
    totalMaintenanceMargin > positionComponent ? totalMaintenanceMargin - positionComponent : 0n;

  const liquidationPrice = computeLiquidationPrice(
    netQuantity,
    entryPrice,
    collateral,
    orderMargin,
    maintenanceMarginPercent,
    quantityDecimals,
  );

  return { orderMargin, liquidationPrice };
}
