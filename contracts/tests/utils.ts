/**
 * Reproduce the contract's integer-math funding calculation so tests can
 * assert exact values.
 *
 * `fundingDecimals` and `quantityDecimals` should come from the fixture
 * config so they stay in sync with on-chain constants.
 */
export function computeExpectedFunding(
  netQuantity: bigint,
  markPrice: bigint,
  indexPrice: bigint,
  timeElapsed: bigint,
  fundingPeriod: bigint,
  fundingRateMaxBps: bigint,
  fundingDecimals: number,
  quantityDecimals: number,
): bigint {
  const fundingPrecision = 10n ** BigInt(fundingDecimals);
  const quantityScale = 10n ** BigInt(quantityDecimals);

  const priceDiff = markPrice - indexPrice;
  let fundingRateScaled = (priceDiff * fundingPrecision) / indexPrice;

  const maxRateScaled = (fundingRateMaxBps * fundingPrecision) / 10000n;
  if (fundingRateScaled > maxRateScaled) fundingRateScaled = maxRateScaled;
  if (fundingRateScaled < -maxRateScaled) fundingRateScaled = -maxRateScaled;

  const deltaCumFunding = (fundingRateScaled * indexPrice * timeElapsed) / fundingPeriod;

  return (netQuantity * deltaCumFunding) / (quantityScale * fundingPrecision);
}
