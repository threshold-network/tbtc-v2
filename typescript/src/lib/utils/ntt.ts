import { Hex } from "./hex"

/**
 * Utility functions for NTT (Native Token Transfer) bridges.
 * These functions provide encoding and decoding capabilities for destination
 * chain and recipient data, which were removed from on-chain contracts to
 * reduce bytecode size.
 */

/**
 * Encodes destination chain ID and recipient address into a 32-byte value.
 *
 * @param chainId - Wormhole chain ID of the destination chain (uint16)
 * @param recipient - Recipient address on the destination chain (20 bytes)
 * @returns The encoded receiver data as a 32-byte hex string
 *
 * @example
 * ```typescript
 * const encoded = encodeDestinationReceiver(40, "0x1234567890123456789012345678901234567890")
 * // Returns: "0x00000000000000000000000000000000000000000000000000000000000000281234567890123456789012345678901234567890"
 * ```
 */
export function encodeDestinationReceiver(
  chainId: number,
  recipient: string
): Hex {
  // Validate chainId is within uint16 range
  if (chainId < 0 || chainId > 65535) {
    throw new Error(`Chain ID must be between 0 and 65535, got ${chainId}`)
  }

  // Validate recipient address format
  if (!recipient.match(/^0x[a-fA-F0-9]{40}$/)) {
    throw new Error(`Invalid recipient address format: ${recipient}`)
  }

  // Remove 0x prefix from recipient
  const recipientHex = recipient.replace(/^0x/, "")

  // Encode: chainId (2 bytes) + recipient (20 bytes) = 22 bytes total
  // Left-pad to 32 bytes for bytes32 compatibility
  const encoded = (BigInt(chainId) << BigInt(240)) | BigInt(`0x${recipientHex}`)

  return Hex.from(`0x${encoded.toString(16).padStart(64, "0")}`)
}

/**
 * Decodes destination chain ID and recipient address from encoded receiver data.
 *
 * @param encodedReceiver - The encoded receiver data (32 bytes)
 * @returns Object containing the decoded chain ID and recipient address
 *
 * @example
 * ```typescript
 * const { chainId, recipient } = decodeDestinationReceiver("0x00000000000000000000000000000000000000000000000000000000000000281234567890123456789012345678901234567890")
 * // Returns: { chainId: 40, recipient: "0x1234567890123456789012345678901234567890" }
 * ```
 */
export function decodeDestinationReceiver(encodedReceiver: Hex | string): {
  chainId: number
  recipient: string
} {
  const encodedHex =
    typeof encodedReceiver === "string"
      ? encodedReceiver
      : encodedReceiver.toPrefixedString()

  // Remove 0x prefix if present
  const cleanHex = encodedHex.replace(/^0x/, "")

  // Validate length (should be 64 hex characters for 32 bytes)
  if (cleanHex.length !== 64) {
    throw new Error(
      `Invalid encoded receiver length: ${cleanHex.length}. Expected 64 hex characters (32 bytes).`
    )
  }

  // Convert to BigInt for bit manipulation
  const encodedBigInt = BigInt(`0x${cleanHex}`)

  // Extract chain ID (first 2 bytes, shifted right by 240 bits)
  const chainId = Number(encodedBigInt >> BigInt(240))

  // Extract recipient address (last 20 bytes, mask with 0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
  const recipientMask = BigInt(
    "0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
  )
  const recipientBigInt = encodedBigInt & recipientMask
  const recipient = `0x${recipientBigInt.toString(16).padStart(40, "0")}`

  return { chainId, recipient }
}

/**
 * Validates that an encoded receiver has the correct format.
 *
 * @param encodedReceiver - The encoded receiver data to validate
 * @returns True if the format is valid, false otherwise
 */
export function isValidEncodedReceiver(encodedReceiver: Hex | string): boolean {
  try {
    const encodedHex =
      typeof encodedReceiver === "string"
        ? encodedReceiver
        : encodedReceiver.toPrefixedString()

    const cleanHex = encodedHex.replace(/^0x/, "")

    // Check length
    if (cleanHex.length !== 64) {
      return false
    }

    // Check if it's valid hex
    if (!cleanHex.match(/^[a-fA-F0-9]{64}$/)) {
      return false
    }

    // Try to decode to validate structure
    decodeDestinationReceiver(encodedReceiver)
    return true
  } catch {
    return false
  }
}

/**
 * Gets the chain ID from encoded receiver data without full decoding.
 *
 * @param encodedReceiver - The encoded receiver data
 * @returns The chain ID
 */
export function getChainIdFromEncodedReceiver(
  encodedReceiver: Hex | string
): number {
  const encodedHex =
    typeof encodedReceiver === "string"
      ? encodedReceiver
      : encodedReceiver.toPrefixedString()

  const cleanHex = encodedHex.replace(/^0x/, "")

  if (cleanHex.length !== 64) {
    throw new Error(
      `Invalid encoded receiver length: ${cleanHex.length}. Expected 64 hex characters (32 bytes).`
    )
  }

  const encodedBigInt = BigInt(`0x${cleanHex}`)
  return Number(encodedBigInt >> BigInt(240))
}

/**
 * Gets the recipient address from encoded receiver data without full decoding.
 *
 * @param encodedReceiver - The encoded receiver data
 * @returns The recipient address
 */
export function getRecipientFromEncodedReceiver(
  encodedReceiver: Hex | string
): string {
  const encodedHex =
    typeof encodedReceiver === "string"
      ? encodedReceiver
      : encodedReceiver.toPrefixedString()

  const cleanHex = encodedHex.replace(/^0x/, "")

  if (cleanHex.length !== 64) {
    throw new Error(
      `Invalid encoded receiver length: ${cleanHex.length}. Expected 64 hex characters (32 bytes).`
    )
  }

  const encodedBigInt = BigInt(`0x${cleanHex}`)
  const recipientMask = BigInt(
    "0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
  )
  const recipientBigInt = encodedBigInt & recipientMask
  return `0x${recipientBigInt.toString(16).padStart(40, "0")}`
}
