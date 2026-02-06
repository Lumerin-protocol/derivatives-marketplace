export function roundToNearest(value: bigint, increment: bigint): bigint {
  return ((value + increment / 2n) / increment) * increment;
}
