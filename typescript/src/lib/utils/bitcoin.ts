import { BigNumber } from "ethers"

/**
 * Converts the amount to Satoshi precision.
 * @param value The amount to be converted.
 * @returns The amount in Satoshi precision.
 */
export const amountToSatoshi = (value: BigNumber): BigNumber => {
  const satoshiMultiplier = BigNumber.from(1e10)
  const remainder = value.mod(satoshiMultiplier)
  const convertibleAmount = value.sub(remainder)
  return convertibleAmount.div(satoshiMultiplier)
}
