/**
 * Converts the amount to Satoshi precision.
 * @param value The amount to be converted.
 * @returns The amount in Satoshi precision.
 */
export const amountToSatoshi = (value: bigint): bigint => {
  const satoshiMultiplier = 10_000_000_000n
  // Truncating division is equivalent to the previous
  // `value.sub(value.mod(multiplier)).div(multiplier)` sequence for
  // non-negative amounts.
  return value / satoshiMultiplier
}
