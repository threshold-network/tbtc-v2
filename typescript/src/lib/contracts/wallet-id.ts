import { utils } from "ethers"
import { Hex } from "../utils/hex"

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
}
