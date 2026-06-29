import { utils } from "ethers"
import { Hex } from "../utils/hex"

const ZERO_BYTES32 = Hex.from(`0x${"00".repeat(32)}`)

/**
 * Utility functions for Bridge wallet identifiers.
 */
export const WalletIDUtils = {
  /**
   * Returns the legacy wallet ID alias used for ECDSA wallets. The alias is
   * the 20-byte wallet public key hash left-padded to 32 bytes.
   * @param walletPublicKeyHash The 20-byte wallet public key hash.
   * @returns 32-byte legacy wallet ID alias.
   */
  legacyWalletIDFromPublicKeyHash(walletPublicKeyHash: Hex): Hex {
    return Hex.from(
      utils.hexZeroPad(walletPublicKeyHash.toPrefixedString(), 32)
    )
  },

  /**
   * Checks whether the wallet ID is the legacy ECDSA alias for the given
   * wallet public key hash.
   * @param walletID Wallet ID to check.
   * @param walletPublicKeyHash The 20-byte wallet public key hash.
   * @returns True if the wallet ID is the legacy alias, false otherwise.
   */
  isLegacyWalletID(walletID: Hex, walletPublicKeyHash: Hex): boolean {
    if (
      walletID.toBuffer().length !== 32 ||
      walletPublicKeyHash.toBuffer().length !== 20
    ) {
      return false
    }

    return WalletIDUtils.legacyWalletIDFromPublicKeyHash(
      walletPublicKeyHash
    ).equals(walletID)
  },

  /**
   * Returns the native Taproot x-only public key encoded by a FROST wallet's
   * walletID, or undefined when the wallet is not FROST or the walletID is the
   * legacy left-padded-public-key-hash alias.
   * @dev FROST wallets have a zero `ecdsaWalletID`, and their native `walletID`
   *      is the 32-byte Taproot x-only public key. Pre-upgrade Bridge ABIs that
   *      lack the on-chain `walletID(...)` view return the legacy left-padded
   *      public-key-hash alias instead; that alias is NOT a real x-only key and
   *      must not be treated as one.
   * @param ecdsaWalletID The wallet's ECDSA wallet ID (zero for FROST wallets).
   * @param walletID The wallet's native wallet ID, if known.
   * @param walletPublicKeyHash The 20-byte wallet public key hash, when
   *        available. Enables the exact legacy-alias guard; when omitted, a shape
   *        guard (reject the 12-leading-zero alias form) is used instead.
   * @returns The 32-byte x-only walletID for a FROST wallet, or undefined.
   */
  frostWalletID(
    ecdsaWalletID: Hex,
    walletID?: Hex,
    walletPublicKeyHash?: Hex
  ): Hex | undefined {
    // Only FROST wallets (zero ecdsaWalletID) carry an x-only walletID.
    if (!ecdsaWalletID || !ecdsaWalletID.equals(ZERO_BYTES32)) {
      return undefined
    }
    if (!walletID) {
      return undefined
    }

    if (walletPublicKeyHash) {
      // Exact guard: reject the legacy left-padded-pubkeyhash alias.
      if (
        walletID.equals(
          WalletIDUtils.legacyWalletIDFromPublicKeyHash(walletPublicKeyHash)
        )
      ) {
        return undefined
      }
    } else {
      // Shape guard (no pubkeyhash available): reject the 12-leading-zero
      // legacy-alias form. A real x-only key cannot have 12 leading zero bytes.
      const buffer = walletID.toBuffer()
      const isLegacyAliasShaped =
        buffer.length === 32 &&
        buffer.subarray(0, 12).every((byte) => byte === 0)
      if (isLegacyAliasShaped) {
        return undefined
      }
    }

    return walletID
  },
}
