import { BitcoinRawTx, BitcoinTxHash, BitcoinUtxo } from "../../src"
import { BigNumber } from "@ethersproject/bignumber"

/**
 * An example address taken from the BTC testnet and having a non-zero balance.
 * This address and its transaction data can be used to make deposits during tests.
 */
export const testnetAddress = "tb1q0tpdjdu2r3r7tzwlhqy4e2276g2q6fexsz4j0m"

/**
 * Private key corresponding to the testnetAddress.
 */
export const testnetPrivateKey =
  "cRJvyxtoggjAm9A94cB86hZ7Y62z2ei5VNJHLksFi2xdnz1GJ6xt"

/**
 * Hash of one of the transactions originating from testnetAddress.
 */
export const testnetTransactionHash = BitcoinTxHash.from(
  "2f952bdc206bf51bb745b967cb7166149becada878d3191ffe341155ebcd4883"
)

/**
 * Transaction corresponding to testnetTransactionHash and originating
 * from testnetAddress. It can be decoded, for example, with:
 * https://live.blockcypher.com/btc-testnet/decodetx
 */
export const testnetTransaction: BitcoinRawTx = {
  transactionHex:
    "0100000000010162cae24e74ad64f9f0493b09f3964908b3b3038f4924882d3dbd853b" +
    "4c9bc7390100000000ffffffff02102700000000000017a914867120d5480a9cc0c11c" +
    "1193fa59b3a92e852da78710043c00000000001600147ac2d9378a1c47e589dfb8095c" +
    "a95ed2140d272602483045022100b70bd9b7f5d230444a542c7971bea79786b4ebde67" +
    "03cee7b6ee8cd16e115ebf02204d50ea9d1ee08de9741498c2cc64266e40d52c4adb9e" +
    "f68e65aa2727cd4208b5012102ee067a0273f2e3ba88d23140a24fdb290f27bbcd0f94" +
    "117a9c65be3911c5c04e00000000",
}

/**
 * An UTXO from the testnetTransaction.
 */
export const testnetUTXO: BitcoinUtxo & BitcoinRawTx = {
  transactionHash: testnetTransactionHash,
  outputIndex: 1,
  value: BigNumber.from(3933200),
  ...testnetTransaction,
}

/**
 * Private key of the wallet on testnet.
 */
export const testnetWalletPrivateKey =
  "cRk1zdau3jp2X3XsrRKDdviYLuC32fHfyU186wLBEbZWx4uQWW3v"

/**
 * Address corresponding to testnetWalletPrivateKey.
 */
export const testnetWalletAddress = "tb1q3k6sadfqv04fmx9naty3fzdfpaecnphkfm3cf3"
