/** Mirrors `HashPowerPerpsDEXBase.TimeInForce`. GTD is not supported. */
export const TimeInForce = {
  GTC: 0,
  IOC: 1,
  FOK: 2,
} as const;

export type TimeInForceValue = (typeof TimeInForce)[keyof typeof TimeInForce];
