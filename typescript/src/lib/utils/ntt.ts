import { Hex } from "./hex"

/**
 * Utility functions for fixed-destination NTT (Native Token Transfer) bridges.
 *
 * The L1 NTT depositor uses one configured destination chain per contract
 * instance. Deposit extra data is therefore the full recipient bytes32 and
 * must not pack a chain ID into the high bytes.
 */

/**
 * Normalizes an NTT recipient into the bytes32 format expected by Wormhole NTT.
 *
 * @param recipient - EVM address (20 bytes) or full Wormhole recipient (32 bytes).
 * @returns Recipient as a 32-byte hex string. EVM addresses are left-padded.
 *
 * @example
 * ```typescript
 * const recipient = normalizeNttRecipient("0x1234567890123456789012345678901234567890")
 * // Returns: "0x0000000000000000000000001234567890123456789012345678901234567890"
 * ```
 */
export function normalizeNttRecipient(recipient: Hex | string): Hex {
  const recipientHex =
    typeof recipient === "string" ? recipient : recipient.toPrefixedString()

  const cleanHex = recipientHex.replace(/^0x/, "")

  if (!cleanHex.match(/^[a-fA-F0-9]+$/)) {
    throw new Error(`Invalid recipient hex: ${recipientHex}`)
  }

  if (cleanHex.length !== 40 && cleanHex.length !== 64) {
    throw new Error(
      `Invalid recipient length: ${cleanHex.length}. Expected 40 or 64 hex characters.`
    )
  }

  return Hex.from(`0x${cleanHex.padStart(64, "0")}`)
}

/**
 * Validates whether an NTT recipient can be normalized to bytes32.
 *
 * @param recipient - Recipient data to validate.
 * @returns True if the recipient is a 20-byte address or 32-byte Wormhole recipient.
 */
export function isValidNttRecipient(recipient: Hex | string): boolean {
  try {
    normalizeNttRecipient(recipient)
    return true
  } catch {
    return false
  }
}
