import { BigNumber } from "@ethersproject/bignumber"
import { ethers } from "hardhat"

// TODO: It is deprecated and `to1ePrecision` from the
// https://github.com/keep-network/hardhat-helpers/blob/main/src/number.ts should
// be used instead.
export function to1ePrecision(n: number, precision: number): bigint {
  const decimalMultiplier = BigInt(10) ** precision
  return BigInt(n) * decimalMultiplier
}

export function to1e18(n: number): bigint {
  const decimalMultiplier = BigInt(10) ** 18n
  return BigInt(n) * decimalMultiplier
}

export function toSatoshis(amountInBtc: number): bigint {
  return to1ePrecision(amountInBtc, 8)
}

export async function getBlockTime(blockNumber: number): Promise<number> {
  return (await ethers.provider.getBlock(blockNumber)).timestamp
}

export function strip0xPrefix(hexString: string): string {
  return hexString.substring(0, 2) === "0x" ? hexString.substring(2) : hexString
}

export function concatenateHexStrings(strs: Array<string>): string {
  let current = "0x"
  for (let i = 0; i < strs.length; i += 1) {
    current = `${current}${strip0xPrefix(strs[i])}`
  }
  return current
}
