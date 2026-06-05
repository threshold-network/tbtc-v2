import * as crypto from "crypto"
import * as secp256k1 from "@bitcoinerlab/secp256k1"
import { Hex } from "../utils"

const TAPROOT_LEAF_VERSION = 0xc0

function ensure32Bytes(value: Hex, name: string): Buffer {
  const buffer = value.toBuffer()
  if (buffer.length !== 32) {
    throw new Error(`${name} must be 32-byte`)
  }

  return buffer
}

function taggedHash(tag: string, payload: Buffer): Buffer {
  const tagHash = crypto.createHash("sha256").update(tag).digest()

  return crypto
    .createHash("sha256")
    .update(Buffer.concat([tagHash, tagHash, payload]))
    .digest()
}

function compactSizeUint(value: number): Buffer {
  if (value < 0) {
    throw new Error("Compact size uint value cannot be negative")
  }

  if (value <= 252) {
    return Buffer.from([value])
  }

  if (value <= 0xffff) {
    const result = Buffer.alloc(3)
    result[0] = 0xfd
    result.writeUInt16LE(value, 1)
    return result
  }

  if (value <= 0xffffffff) {
    const result = Buffer.alloc(5)
    result[0] = 0xfe
    result.writeUInt32LE(value, 1)
    return result
  }

  throw new Error("Compact size uint value is too large")
}

/**
 * Computes a BIP-341 TapLeaf tagged hash for a tapscript leaf.
 * @param script Leaf script.
 * @param leafVersion Taproot leaf version. Defaults to tapscript 0xc0.
 * @returns 32-byte TapLeaf hash.
 */
function tapLeafHash(
  script: Hex,
  leafVersion: number = TAPROOT_LEAF_VERSION
): Hex {
  if (leafVersion < 0 || leafVersion > 255) {
    throw new Error("Taproot leaf version must fit in one byte")
  }

  const scriptBuffer = script.toBuffer()
  return Hex.from(
    taggedHash(
      "TapLeaf",
      Buffer.concat([
        Buffer.from([leafVersion]),
        compactSizeUint(scriptBuffer.length),
        scriptBuffer,
      ])
    )
  )
}

/**
 * Computes the BIP-341 TapTweak tagged hash.
 * @param internalKey 32-byte x-only internal key.
 * @param merkleRoot Optional 32-byte Taproot tree root.
 * @returns 32-byte tweak.
 */
function tapTweak(internalKey: Hex, merkleRoot?: Hex): Hex {
  const internalKeyBuffer = ensure32Bytes(internalKey, "Taproot internal key")
  const payload =
    typeof merkleRoot === "undefined"
      ? internalKeyBuffer
      : Buffer.concat([
          internalKeyBuffer,
          ensure32Bytes(merkleRoot, "Taproot merkle root"),
        ])

  return Hex.from(taggedHash("TapTweak", payload))
}

/**
 * Derives a BIP-341 Taproot output key for the given internal key and optional
 * script tree root.
 * @param internalKey 32-byte x-only internal key.
 * @param merkleRoot Optional 32-byte Taproot tree root.
 * @returns 32-byte x-only Taproot output key.
 */
function deriveTaprootOutputKey(internalKey: Hex, merkleRoot?: Hex): Hex {
  const internalKeyBuffer = ensure32Bytes(internalKey, "Taproot internal key")
  const tweakBuffer = tapTweak(internalKey, merkleRoot).toBuffer()

  const tweakedKey = secp256k1.xOnlyPointAddTweak(
    internalKeyBuffer,
    tweakBuffer
  )

  if (tweakedKey === null) {
    throw new Error("Cannot derive Taproot output key")
  }

  return Hex.from(Buffer.from(tweakedKey.xOnlyPubkey))
}

/**
 * Utility functions for BIP-341 Taproot key and script tree derivation.
 */
export const BitcoinTaprootUtils = {
  TAPROOT_LEAF_VERSION,
  taggedHash,
  compactSizeUint,
  tapLeafHash,
  tapTweak,
  deriveTaprootOutputKey,
}
