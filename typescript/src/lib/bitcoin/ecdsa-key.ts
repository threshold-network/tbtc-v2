import { BigNumber } from "ethers"
import { Hex } from "../utils"
import { ECPairFactory, ECPairInterface } from "ecpair"
import * as tinysecp from "@bitcoinerlab/secp256k1"
import { BitcoinNetwork, toBitcoinJsLibNetwork } from "./network"
import { BitcoinAddressConverter } from "./address"
import { BitcoinHashUtils } from "./hash"

/**
 * Checks whether given public key is a compressed Bitcoin public key.
 * @param publicKey - Public key that should be checked.
 * @returns True if the key is a compressed Bitcoin public key, false otherwise.
 */
function isCompressedPublicKey(publicKey: Hex): boolean {
  const publicKeyStr = publicKey.toString()

  // Must have 33 bytes and 02 or 03 prefix.
  return (
    publicKeyStr.length == 66 &&
    (publicKeyStr.substring(0, 2) == "02" ||
      publicKeyStr.substring(0, 2) == "03")
  )
}

/**
 * Compresses the given uncompressed Bitcoin public key.
 * @param publicKey Uncompressed 64-byte public key.
 * @returns Compressed 33-byte public key prefixed with 02 or 03.
 */
function compressPublicKey(publicKey: Hex): string {
  const publicKeyStr = publicKey.toString()

  // Must have 64 bytes and no prefix.
  if (publicKeyStr.length != 128) {
    throw new Error(
      "The public key parameter must be 64-byte. Neither 0x nor 04 prefix is allowed"
    )
  }

  // The X coordinate is the first 32 bytes.
  const publicKeyX = publicKeyStr.substring(0, 64)
  // The Y coordinate is the next 32 bytes.
  const publicKeyY = publicKeyStr.substring(64)

  const prefix = BigNumber.from(`0x${publicKeyY}`).mod(2).eq(0) ? "02" : "03"

  return `${prefix}${publicKeyX}`
}

/**
 * Converts a wallet key into the Bridge wallet public key hash.
 * Legacy ECDSA wallets use HASH160(compressedPublicKey). FROST wallets can
 * identify themselves with their 32-byte x-only wallet ID and use the Bridge
 * compatibility alias HASH160(0x02 || walletID).
 * @param walletKey 33-byte compressed ECDSA key or 32-byte FROST x-only key.
 * @returns 20-byte wallet public key hash accepted by the Bridge.
 */
function walletKeyToPublicKeyHash(walletKey: Hex): Hex {
  const walletKeyBuffer = walletKey.toBuffer()

  if (walletKeyBuffer.length === 32) {
    return BitcoinAddressConverter.taprootOutputKeyToWalletPublicKeyHash(
      walletKey
    )
  }

  return BitcoinHashUtils.computeHash160(walletKey)
}

/**
 * Converts a FROST x-only wallet ID into its compressed-key compatibility
 * representation. This value is used only by legacy SDK interfaces that carry
 * a single `walletPublicKey` field and then derive the Bridge wallet hash from
 * it.
 * @param walletID 32-byte FROST x-only wallet ID.
 * @returns 33-byte 0x02-prefixed compatibility key.
 */
function xOnlyToCompressedPublicKey(walletID: Hex): Hex {
  const walletIDBuffer = walletID.toBuffer()
  if (walletIDBuffer.length !== 32) {
    throw new Error("FROST wallet ID must be 32-byte")
  }

  return Hex.from(Buffer.concat([Buffer.from([0x02]), walletIDBuffer]))
}

/**
 * Utility functions allowing to perform operations on Bitcoin ECDSA public keys.
 */
export const BitcoinPublicKeyUtils = {
  isCompressedPublicKey,
  compressPublicKey,
  walletKeyToPublicKeyHash,
  xOnlyToCompressedPublicKey,
}

/**
 * Creates a Bitcoin key pair based on the given private key.
 * @param privateKey Private key that should be used to create the key pair.
 *                   Should be passed in the WIF format.
 * @param bitcoinNetwork Bitcoin network the given key pair is relevant for.
 * @returns Bitcoin key pair.
 */
function createKeyPair(
  privateKey: string,
  bitcoinNetwork: BitcoinNetwork
): ECPairInterface {
  // eslint-disable-next-line new-cap
  return ECPairFactory(tinysecp).fromWIF(
    privateKey,
    toBitcoinJsLibNetwork(bitcoinNetwork)
  )
}

/**
 * Utility functions allowing to perform operations on Bitcoin ECDSA private keys.
 */
export const BitcoinPrivateKeyUtils = {
  createKeyPair,
}
