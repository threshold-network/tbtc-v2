/* eslint-disable import/prefer-default-export */
import {BytesLike} from "ethers"

export const ecdsaWalletTestData = {
  // private key
  privateKey: <BytesLike>(
    "0x18e14a7b6a307f426a94f8114701e7c8e774e7f9a47e2c2035db29a206321725"
  ),

  // public key (X and Y coordinates)
  publicKeyX: <BytesLike>(
    "0x50863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b2352"
  ),
  publicKeyY: <BytesLike>(
    "0x2cd470243453a299fa9e77237716103abc11a1df38855ed6f2ee187e9c582ba6"
  ),

  // public key (X and Y coordinates concatenation)
  publicKey: <BytesLike>(
    "0x50863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b23522cd470243453a299fa9e77237716103abc11a1df38855ed6f2ee187e9c582ba6"
  ),

  // compressed public key
  compressedPublicKey: <BytesLike>(
    "0x0250863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b2352"
  ),

  // Bitcoin's HASH160 of compressedPublicKey i.e. RIPEMD160(SHA256(compressedPublicKey))
  pubKeyHash160: <BytesLike>"0xf54a5851e9372b87810a8e60cdd2e7cfd80b6e31",

  // ID of the ECDSA Wallet from ECDSA Wallet Registry i.e. Keccak256(uncompressedPublicKey)
  walletID: <BytesLike>(
    "0x8c9564d6883a96096c8469d63e9003153d9a39d3f57b126b0c38513d5e289c3e"
  ),
}
