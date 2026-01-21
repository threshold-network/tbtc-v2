import { BigNumber } from "@ethersproject/bignumber"
import { sha256, ripemd160 } from "@ethersproject/sha2"
import { Hex } from "../utils"

/**
 * Computes the HASH160 (i.e. RIPEMD160(SHA256(text))) for the given text.
 * @param text Text the HASH160 is computed for.
 * @returns 20-byte-long hash.
 */
function computeHash160(text: Hex): Hex {
  const sha256Hash = sha256(text.toPrefixedString())
  const hash160 = ripemd160(sha256Hash)

  return Hex.from(hash160)
}

/**
 * Computes the double SHA256 for the given text.
 * @param text Text the double SHA256 is computed for.
 * @returns 32-byte-long hash.
 * @dev Do not confuse it with computeSha256 which computes single SHA256.
 */
function computeHash256(text: Hex): Hex {
  const firstHash = sha256(text.toPrefixedString())
  const secondHash = sha256(firstHash)

  return Hex.from(secondHash)
}

/**
 * Converts a hash in hex string in little endian to a BigNumber.
 * @param hash Hash in hex-string format.
 * @returns BigNumber representation of the hash.
 */
function hashLEToBigNumber(hash: Hex): BigNumber {
  return BigNumber.from(hash.reverse().toPrefixedString())
}

/**
 * Computes the single SHA256 for the given text.
 * @param text Text the single SHA256 is computed for.
 * @returns 32-byte-long hash.
 * @dev Do not confuse it with computeHash256 which computes double SHA256.
 */
function computeSha256(text: Hex): Hex {
  const hash = sha256(text.toPrefixedString())
  return Hex.from(hash)
}

/**
 * Utility functions allowing to deal with Bitcoin hashes.
 */
export const BitcoinHashUtils = {
  computeHash160,
  computeHash256,
  hashLEToBigNumber,
  computeSha256,
}
