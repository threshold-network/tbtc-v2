import { BigNumber } from "@ethersproject/bignumber"
import { BytesLike } from "@ethersproject/bytes"
import {
  BitcoinAddressConverter,
  BitcoinNetwork,
  BitcoinRawTx,
  BitcoinRawTxVectors,
  BitcoinSpvProof,
  BitcoinTx,
  BitcoinTxHash,
  BitcoinTxMerkleBranch,
  BitcoinUtxo,
  EthereumAddress,
  Hex,
  RedemptionRequest,
  WalletState,
} from "../../src"

/**
 * Private key (testnet) of the wallet.
 */
export const walletPrivateKey =
  "cRk1zdau3jp2X3XsrRKDdviYLuC32fHfyU186wLBEbZWx4uQWW3v"

/**
 * Public key of the wallet in the compressed form corresponding to
 * walletPrivateKey.
 */
export const walletPublicKey = Hex.from(
  "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
)

/**
 * P2PKH address corresponding to walletPrivateKey.
 */
export const p2pkhWalletAddress = "mtSEUCE7G8om9zJttG9twtjoiSsUz7QnY9"

/**
 * P2WPKH address corresponding to walletPrivateKey.
 */
export const p2wpkhWalletAddress = "tb1q3k6sadfqv04fmx9naty3fzdfpaecnphkfm3cf3"

/**
 * Represents a set of data used for given sweep scenario.
 */
export interface RedemptionTestData {
  mainUtxo: BitcoinUtxo & BitcoinRawTx
  pendingRedemptions: {
    redemptionKey: BytesLike
    pendingRedemption: RedemptionRequest
  }[]
  witness: boolean
  expectedRedemption: {
    transactionHash: BitcoinTxHash
    transaction: BitcoinRawTx
  }
}

/**
 * Test data that is based on a Bitcoin redemption transaction with a single
 * P2PKH redeemer address:
 * https://live.blockcypher.com/btc-testnet/tx/c437f1117db977682334b53a71fbe63a42aab42f6e0976c35b69977f86308c20/
 */
export const singleP2PKHRedemptionWithWitnessChange: RedemptionTestData = {
  mainUtxo: {
    transactionHash: BitcoinTxHash.from(
      "523e4bfb71804e5ed3b76c8933d733339563e560311c1bf835934ee7aae5db20"
    ),
    outputIndex: 1,
    value: BigNumber.from(1481680),
    transactionHex:
      "0100000000010160d264b34e51e6567254bcaf4cc67e1e069483f4249dc50784eae68" +
      "2645fd11d0100000000ffffffff02d84000000000000022002086a303cdd2e2eab1d1" +
      "679f1a813835dc5a1b65321077cdccaf08f98cbf04ca96d09b1600000000001600148" +
      "db50eb52063ea9d98b3eac91489a90f738986f602483045022100ed5fa06ea5e9d4a9" +
      "f0cf0df86a2cd473f693e5bda3d808ba82b04ee26d72b73f0220648f4d7bb25be7819" +
      "22349d382cf0f32ffcbbf89c483776472c2d15644a48d67012103989d253b17a6a0f4" +
      "1838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d900000000",
  },
  pendingRedemptions: [
    {
      redemptionKey:
        "0xcb493004c645792101cfa4cc5da4c16aa3148065034371a6f1478b7df4b92d39",
      pendingRedemption: {
        redeemer: EthereumAddress.from(
          "82883a4c7a8dd73ef165deb402d432613615ced4"
        ),
        // script for testnet P2PKH address mmTeMR8RKu6QzMGTG4ipA71uewm3EuJng5
        redeemerOutputScript: Hex.from(
          "76a9144130879211c54df460e484ddf9aac009cb38ee7488ac"
        ),
        requestedAmount: BigNumber.from(10000),
        treasuryFee: BigNumber.from(1000),
        txMaxFee: BigNumber.from(1600),
        requestedAt: 1650623240,
      },
    },
  ],
  witness: true,
  expectedRedemption: {
    transactionHash: BitcoinTxHash.from(
      "c437f1117db977682334b53a71fbe63a42aab42f6e0976c35b69977f86308c20"
    ),
    transaction: {
      transactionHex:
        "0100000000010120dbe5aae74e9335f81b1c3160e563953333d733896cb7d35e4e80" +
        "71fb4b3e520100000000ffffffff02e81c0000000000001976a9144130879211c54d" +
        "f460e484ddf9aac009cb38ee7488aca8781600000000001600148db50eb52063ea9d" +
        "98b3eac91489a90f738986f602483045022100e1bcecbf3c6fc9a4ce2fc8029264d9" +
        "8a1bef4ff3d590816532097fbb93b7fdfb02206bca6c7af1db4c70d4d2c819eeb4c8" +
        "430a291f5fe874c73c8f44acdd06c25d33012103989d253b17a6a0f41838b84ff0d2" +
        "0e8898f9d7b1a98f2564da4cc29dcf8581d900000000",
    },
  },
}

/**
 * Test data that is based on a Bitcoin redemption transaction with a single
 * P2WPKH redeemer address:
 * https://live.blockcypher.com/btc-testnet/tx/925e61dc31396e7f2cbcc8bc9b4009b4f24ba679257762df078b7e9b875ea110/
 */
export const singleP2WPKHRedemptionWithWitnessChange: RedemptionTestData = {
  mainUtxo: {
    transactionHash: BitcoinTxHash.from(
      "c437f1117db977682334b53a71fbe63a42aab42f6e0976c35b69977f86308c20"
    ),
    outputIndex: 1,
    value: BigNumber.from(1472680),
    transactionHex:
      "0100000000010120dbe5aae74e9335f81b1c3160e563953333d733896cb7d35e4e807" +
      "1fb4b3e520100000000ffffffff02e81c0000000000001976a9144130879211c54df4" +
      "60e484ddf9aac009cb38ee7488aca8781600000000001600148db50eb52063ea9d98b" +
      "3eac91489a90f738986f602483045022100e1bcecbf3c6fc9a4ce2fc8029264d98a1b" +
      "ef4ff3d590816532097fbb93b7fdfb02206bca6c7af1db4c70d4d2c819eeb4c8430a2" +
      "91f5fe874c73c8f44acdd06c25d33012103989d253b17a6a0f41838b84ff0d20e8898" +
      "f9d7b1a98f2564da4cc29dcf8581d900000000",
  },
  pendingRedemptions: [
    {
      redemptionKey:
        "0x52a5e94b7f933cbc9565c61d43a83921a6b7bbf950156a2dfda7743a7cefffbf",
      pendingRedemption: {
        redeemer: EthereumAddress.from(
          "82883a4c7a8dd73ef165deb402d432613615ced4"
        ),
        // script for testnet P2WPKH address tb1qgycg0ys3c4xlgc8ysnwln2kqp89n3mn5ts7z3l
        redeemerOutputScript: Hex.from(
          "00144130879211c54df460e484ddf9aac009cb38ee74"
        ),
        requestedAmount: BigNumber.from(15000),
        treasuryFee: BigNumber.from(1100),
        txMaxFee: BigNumber.from(1700),
        requestedAt: 1650623240,
      },
    },
  ],
  witness: true,
  expectedRedemption: {
    transactionHash: BitcoinTxHash.from(
      "925e61dc31396e7f2cbcc8bc9b4009b4f24ba679257762df078b7e9b875ea110"
    ),
    transaction: {
      transactionHex:
        "01000000000101208c30867f97695bc376096e2fb4aa423ae6fb713ab534236877b9" +
        "7d11f137c40100000000ffffffff02a82f0000000000001600144130879211c54df4" +
        "60e484ddf9aac009cb38ee745c421600000000001600148db50eb52063ea9d98b3ea" +
        "c91489a90f738986f602483045022100ee8273dd93e85e8a0e0055498803335a370e" +
        "3d25c51ad2890f0b61294e884e8702204ebf3e04161b8172fbdf6070f7b1f22097f3" +
        "d87c0bd32bc53a786971776e7b45012103989d253b17a6a0f41838b84ff0d20e8898" +
        "f9d7b1a98f2564da4cc29dcf8581d900000000",
    },
  },
}

/**
 * Test data that is based on a Bitcoin redemption transaction with a single
 * P2SH redeemer address:
 * https://live.blockcypher.com/btc-testnet/tx/ef25c9c8f4df673def035c0c1880278c90030b3c94a56668109001a591c2c521/
 */
export const singleP2SHRedemptionWithWitnessChange: RedemptionTestData = {
  mainUtxo: {
    transactionHash: BitcoinTxHash.from(
      "925e61dc31396e7f2cbcc8bc9b4009b4f24ba679257762df078b7e9b875ea110"
    ),
    outputIndex: 1,
    value: BigNumber.from(1458780),
    transactionHex:
      "01000000000101208c30867f97695bc376096e2fb4aa423ae6fb713ab534236877b9" +
      "7d11f137c40100000000ffffffff02a82f0000000000001600144130879211c54df4" +
      "60e484ddf9aac009cb38ee745c421600000000001600148db50eb52063ea9d98b3ea" +
      "c91489a90f738986f602483045022100ee8273dd93e85e8a0e0055498803335a370e" +
      "3d25c51ad2890f0b61294e884e8702204ebf3e04161b8172fbdf6070f7b1f22097f3" +
      "d87c0bd32bc53a786971776e7b45012103989d253b17a6a0f41838b84ff0d20e8898" +
      "f9d7b1a98f2564da4cc29dcf8581d900000000",
  },
  pendingRedemptions: [
    {
      redemptionKey:
        "0x4f5c364239f365622168b8fcb3f4556a8bbad22f5b5ae598757c4fe83b3a78d7",
      pendingRedemption: {
        redeemer: EthereumAddress.from(
          "82883a4c7a8dd73ef165deb402d432613615ced4"
        ),
        // script for testnet P2SH address 2Mxy76sc1qAxiJ1fXMXDXqHvVcPLh6Lf12C
        redeemerOutputScript: Hex.from(
          "a9143ec459d0f3c29286ae5df5fcc421e2786024277e87"
        ),
        requestedAmount: BigNumber.from(13000),
        treasuryFee: BigNumber.from(800),
        txMaxFee: BigNumber.from(1700),
        requestedAt: 1650623240,
      },
    },
  ],
  witness: true,
  expectedRedemption: {
    transactionHash: BitcoinTxHash.from(
      "ef25c9c8f4df673def035c0c1880278c90030b3c94a56668109001a591c2c521"
    ),
    transaction: {
      transactionHex:
        "0100000000010110a15e879b7e8b07df62772579a64bf2b409409bbcc8bc2c7f6e3" +
        "931dc615e920100000000ffffffff02042900000000000017a9143ec459d0f3c292" +
        "86ae5df5fcc421e2786024277e87b4121600000000001600148db50eb52063ea9d9" +
        "8b3eac91489a90f738986f6024830450221009740ad12d2e74c00ccb4741d533d2e" +
        "cd6902289144c4626508afb61eed790c97022006e67179e8e2a63dc4f1ab758867d" +
        "8bbfe0a2b67682be6dadfa8e07d3b7ba04d012103989d253b17a6a0f41838b84ff0" +
        "d20e8898f9d7b1a98f2564da4cc29dcf8581d900000000",
    },
  },
}

/**
 * Test data that is based on a Bitcoin redemption transaction with a single
 * P2SH redeemer address:
 * https://live.blockcypher.com/btc-testnet/tx/3d28bb5bf73379da51bc683f4d0ed31d7b024466c619d80ebd9378077d900be3/
 */
export const singleP2WSHRedemptionWithWitnessChange: RedemptionTestData = {
  mainUtxo: {
    transactionHash: BitcoinTxHash.from(
      "ef25c9c8f4df673def035c0c1880278c90030b3c94a56668109001a591c2c521"
    ),
    outputIndex: 1,
    value: BigNumber.from(1446580),
    transactionHex:
      "0100000000010110a15e879b7e8b07df62772579a64bf2b409409bbcc8bc2c7f6e3" +
      "931dc615e920100000000ffffffff02042900000000000017a9143ec459d0f3c292" +
      "86ae5df5fcc421e2786024277e87b4121600000000001600148db50eb52063ea9d9" +
      "8b3eac91489a90f738986f6024830450221009740ad12d2e74c00ccb4741d533d2e" +
      "cd6902289144c4626508afb61eed790c97022006e67179e8e2a63dc4f1ab758867d" +
      "8bbfe0a2b67682be6dadfa8e07d3b7ba04d012103989d253b17a6a0f41838b84ff0" +
      "d20e8898f9d7b1a98f2564da4cc29dcf8581d900000000",
  },
  pendingRedemptions: [
    {
      redemptionKey:
        "0x2636de6d29da2c7e229a31f3a39b151e2dcd149b1cc2c4e28008f9ab1b02c112",
      pendingRedemption: {
        redeemer: EthereumAddress.from(
          "82883a4c7a8dd73ef165deb402d432613615ced4"
        ),
        // script for testnet P2WSH address tb1qs63s8nwjut4tr5t8nudgzwp4m3dpkefjzpmumn90pruce0cye2tq2jkq0y
        redeemerOutputScript: Hex.from(
          "002086a303cdd2e2eab1d1679f1a813835dc5a1b65321077cdccaf08f98cbf04ca96"
        ),
        requestedAmount: BigNumber.from(18000),
        treasuryFee: BigNumber.from(1000),
        txMaxFee: BigNumber.from(1400),
        requestedAt: 1650623240,
      },
    },
  ],
  witness: true,
  expectedRedemption: {
    transactionHash: BitcoinTxHash.from(
      "3d28bb5bf73379da51bc683f4d0ed31d7b024466c619d80ebd9378077d900be3"
    ),
    transaction: {
      transactionHex:
        "0100000000010121c5c291a50190106866a5943c0b03908c2780180c5c03ef3d67d" +
        "ff4c8c925ef0100000000ffffffff02f03c00000000000022002086a303cdd2e2ea" +
        "b1d1679f1a813835dc5a1b65321077cdccaf08f98cbf04ca964cd01500000000001" +
        "600148db50eb52063ea9d98b3eac91489a90f738986f602483045022100bef6177f" +
        "72f434248271cf5d18c1ce6add52dcf533ddda215240a858cb63cd070220016a68c" +
        "457f84f01108e1b001e8f81a9b073a3e08511265614318fa0d395ef4d012103989d" +
        "253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d900000000",
    },
  },
}

/**
 * Test data that is based on a Bitcoin redemption transaction with multiple
 * redeemer addresses (P2PKH, P2WPKH, P2SH and P2WSH):
 * https://live.blockcypher.com/btc-testnet/tx/f70ff89fd2b6226183e4b8143cc5f0f457f05dd1dca0c6151ab66f4523d972b7/
 */
export const multipleRedemptionsWithWitnessChange: RedemptionTestData = {
  mainUtxo: {
    transactionHash: BitcoinTxHash.from(
      "3d28bb5bf73379da51bc683f4d0ed31d7b024466c619d80ebd9378077d900be3"
    ),
    outputIndex: 1,
    value: BigNumber.from(1429580),
    transactionHex:
      "0100000000010121c5c291a50190106866a5943c0b03908c2780180c5c03ef3d67d" +
      "ff4c8c925ef0100000000ffffffff02f03c00000000000022002086a303cdd2e2ea" +
      "b1d1679f1a813835dc5a1b65321077cdccaf08f98cbf04ca964cd01500000000001" +
      "600148db50eb52063ea9d98b3eac91489a90f738986f602483045022100bef6177f" +
      "72f434248271cf5d18c1ce6add52dcf533ddda215240a858cb63cd070220016a68c" +
      "457f84f01108e1b001e8f81a9b073a3e08511265614318fa0d395ef4d012103989d" +
      "253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d900000000",
  },
  pendingRedemptions: [
    {
      redemptionKey:
        "0xcb493004c645792101cfa4cc5da4c16aa3148065034371a6f1478b7df4b92d39",
      pendingRedemption: {
        redeemer: EthereumAddress.from(
          "82883a4c7a8dd73ef165deb402d432613615ced4"
        ),
        // script for testnet P2PKH address mmTeMR8RKu6QzMGTG4ipA71uewm3EuJng5
        redeemerOutputScript: Hex.from(
          "76a9144130879211c54df460e484ddf9aac009cb38ee7488ac"
        ),
        requestedAmount: BigNumber.from(18000),
        treasuryFee: BigNumber.from(1000),
        txMaxFee: BigNumber.from(1100),
        requestedAt: 1650623240,
      },
    },
    {
      redemptionKey:
        "0x52a5e94b7f933cbc9565c61d43a83921a6b7bbf950156a2dfda7743a7cefffbf",
      pendingRedemption: {
        redeemer: EthereumAddress.from(
          "82883a4c7a8dd73ef165deb402d432613615ced4"
        ),
        // script for testnet P2WPKH address tb1qgycg0ys3c4xlgc8ysnwln2kqp89n3mn5ts7z3l
        redeemerOutputScript: Hex.from(
          "00144130879211c54df460e484ddf9aac009cb38ee74"
        ),
        requestedAmount: BigNumber.from(13000),
        treasuryFee: BigNumber.from(800),
        txMaxFee: BigNumber.from(900),
        requestedAt: 1650623240,
      },
    },
    {
      redemptionKey:
        "0x4f5c364239f365622168b8fcb3f4556a8bbad22f5b5ae598757c4fe83b3a78d7",
      pendingRedemption: {
        redeemer: EthereumAddress.from(
          "82883a4c7a8dd73ef165deb402d432613615ced4"
        ),
        // script for testnet P2SH address 2Mxy76sc1qAxiJ1fXMXDXqHvVcPLh6Lf12C
        redeemerOutputScript: Hex.from(
          "a9143ec459d0f3c29286ae5df5fcc421e2786024277e87"
        ),
        requestedAmount: BigNumber.from(12000),
        treasuryFee: BigNumber.from(1100),
        txMaxFee: BigNumber.from(1000),
        requestedAt: 1650623240,
      },
    },
    {
      redemptionKey:
        "0x2636de6d29da2c7e229a31f3a39b151e2dcd149b1cc2c4e28008f9ab1b02c112",
      pendingRedemption: {
        redeemer: EthereumAddress.from(
          "82883a4c7a8dd73ef165deb402d432613615ced4"
        ),
        // script for testnet P2WSH address tb1qs63s8nwjut4tr5t8nudgzwp4m3dpkefjzpmumn90pruce0cye2tq2jkq0y
        redeemerOutputScript: Hex.from(
          "002086a303cdd2e2eab1d1679f1a813835dc5a1b65321077cdccaf08f98cbf04ca96"
        ),
        requestedAmount: BigNumber.from(15000),
        treasuryFee: BigNumber.from(700),
        txMaxFee: BigNumber.from(1400),
        requestedAt: 1650623240,
      },
    },
  ],
  witness: true,
  expectedRedemption: {
    transactionHash: BitcoinTxHash.from(
      "f70ff89fd2b6226183e4b8143cc5f0f457f05dd1dca0c6151ab66f4523d972b7"
    ),
    transaction: {
      transactionHex:
        "01000000000101e30b907d077893bd0ed819c66644027b1dd30e4d3f68bc51da793" +
        "3f75bbb283d0100000000ffffffff051c3e0000000000001976a9144130879211c5" +
        "4df460e484ddf9aac009cb38ee7488ac242c0000000000001600144130879211c54" +
        "df460e484ddf9aac009cb38ee74ac2600000000000017a9143ec459d0f3c29286ae" +
        "5df5fcc421e2786024277e87643200000000000022002086a303cdd2e2eab1d1679" +
        "f1a813835dc5a1b65321077cdccaf08f98cbf04ca96ccfb1400000000001600148d" +
        "b50eb52063ea9d98b3eac91489a90f738986f602483045022100adc5b0cffc65444" +
        "cf16873eb57cb702414ee36ca907ad3cf57676abe83c0f80502204a206d9b55eeee" +
        "05d9647e95d15ed5143eaad6cc8c5bc2c1919b69addc18db29012103989d253b17a" +
        "6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d900000000",
    },
  },
}

/**
 * Test data that is based on a Bitcoin redemption transaction with two redeemer
 * addresses and has no change:
 * https://live.blockcypher.com/btc-testnet/tx/afcdf8f91273b73abc40018873978c22bbb7c3d8d669ef2faffa0c4b0898c8eb/
 */
export const multipleRedemptionsWithoutChange: RedemptionTestData = {
  mainUtxo: {
    transactionHash: BitcoinTxHash.from(
      "7dd38b48cb626580d317871c5b716eaf4a952ceb67ba3aa4ca76e3dc7cdcc65b"
    ),
    outputIndex: 1,
    value: BigNumber.from(10000),
    transactionHex:
      "02000000000101c17208c443a3d3d2223884ef11ac83dadb1a3abe4d3474694414c8d" +
      "cd3c697510100000000feffffff0224d38a5b0000000016001414c829f9d1770ebab9" +
      "8bd1acb39e428cffe7580310270000000000001600148db50eb52063ea9d98b3eac91" +
      "489a90f738986f60247304402205d71cd954aa20b9c04266999baa8b2e1f04b7ecf41" +
      "9d48775ec78b81c3dbf6d5022076eb8cfc0f2fbd6178fdec4039570a1404c76fca4b7" +
      "2f6a34706b9c9c801ff7b0121033483097979eaff12af144dde368235592893fc2cb7" +
      "477c3c4e34a0770f01f4e071832100",
  },
  pendingRedemptions: [
    {
      redemptionKey:
        "0xcb493004c645792101cfa4cc5da4c16aa3148065034371a6f1478b7df4b92d39",
      pendingRedemption: {
        redeemer: EthereumAddress.from(
          "82883a4c7a8dd73ef165deb402d432613615ced4"
        ),
        // script for testnet P2PKH address mmTeMR8RKu6QzMGTG4ipA71uewm3EuJng5
        redeemerOutputScript: Hex.from(
          "76a9144130879211c54df460e484ddf9aac009cb38ee7488ac"
        ),
        requestedAmount: BigNumber.from(6000),
        treasuryFee: BigNumber.from(0),
        txMaxFee: BigNumber.from(800),
        requestedAt: 1650623240,
      },
    },
    {
      redemptionKey:
        "0xa690d9da3e64c337eb11344b94cf948ec2da333f0a985e09f1c120a326f6de87",
      pendingRedemption: {
        redeemer: EthereumAddress.from(
          "82883a4c7a8dd73ef165deb402d432613615ced4"
        ),
        // script for testnet P2WPKH address tb1qf0ulldawp79s7knz9v254j5zjyn0demfx2d0xx
        redeemerOutputScript: Hex.from(
          "00144bf9ffb7ae0f8b0f5a622b154aca829126f6e769"
        ),
        requestedAmount: BigNumber.from(4000),
        treasuryFee: BigNumber.from(0),
        txMaxFee: BigNumber.from(900),
        requestedAt: 1650623240,
      },
    },
  ],
  witness: true,
  expectedRedemption: {
    transactionHash: BitcoinTxHash.from(
      "afcdf8f91273b73abc40018873978c22bbb7c3d8d669ef2faffa0c4b0898c8eb"
    ),
    transaction: {
      transactionHex:
        "010000000001015bc6dc7cdce376caa43aba67eb2c954aaf6e715b1c8717d380656" +
        "2cb488bd37d0100000000ffffffff0250140000000000001976a9144130879211c5" +
        "4df460e484ddf9aac009cb38ee7488ac1c0c0000000000001600144bf9ffb7ae0f8" +
        "b0f5a622b154aca829126f6e76902473044022077174ae4d0a8e9d802f45b1a67cb" +
        "4079abbbc4f110919b2e6b67fc991326e0ca02206efb3d36a58f48d123e845fd868" +
        "593af27e905adecb261d0120ba5b05ccc96fd012103989d253b17a6a0f41838b84f" +
        "f0d20e8898f9d7b1a98f2564da4cc29dcf8581d900000000",
    },
  },
}

/**
 * Test data that is based on a Bitcoin redemption transaction with one
 * redeemer address and P2PKH change:
 * https://live.blockcypher.com/btc-testnet/tx/0fec22d0fecd6607a0429210d04e9465681507d514f3edf0f07def96eda0f89d/
 */
export const singleP2SHRedemptionWithNonWitnessChange: RedemptionTestData = {
  mainUtxo: {
    transactionHash: BitcoinTxHash.from(
      "f70ff89fd2b6226183e4b8143cc5f0f457f05dd1dca0c6151ab66f4523d972b7"
    ),
    outputIndex: 4,
    value: BigNumber.from(1375180),
    transactionHex:
      "01000000000101e30b907d077893bd0ed819c66644027b1dd30e4d3f68bc51da7933f" +
      "75bbb283d0100000000ffffffff051c3e0000000000001976a9144130879211c54df4" +
      "60e484ddf9aac009cb38ee7488ac242c0000000000001600144130879211c54df460e" +
      "484ddf9aac009cb38ee74ac2600000000000017a9143ec459d0f3c29286ae5df5fcc4" +
      "21e2786024277e87643200000000000022002086a303cdd2e2eab1d1679f1a813835d" +
      "c5a1b65321077cdccaf08f98cbf04ca96ccfb1400000000001600148db50eb52063ea" +
      "9d98b3eac91489a90f738986f602483045022100adc5b0cffc65444cf16873eb57cb7" +
      "02414ee36ca907ad3cf57676abe83c0f80502204a206d9b55eeee05d9647e95d15ed5" +
      "143eaad6cc8c5bc2c1919b69addc18db29012103989d253b17a6a0f41838b84ff0d20" +
      "e8898f9d7b1a98f2564da4cc29dcf8581d900000000",
  },
  pendingRedemptions: [
    {
      redemptionKey:
        "0x4f5c364239f365622168b8fcb3f4556a8bbad22f5b5ae598757c4fe83b3a78d7",
      pendingRedemption: {
        redeemer: EthereumAddress.from(
          "82883a4c7a8dd73ef165deb402d432613615ced4"
        ),
        // script for testnet P2SH address 2Mxy76sc1qAxiJ1fXMXDXqHvVcPLh6Lf12C
        redeemerOutputScript: Hex.from(
          "a9143ec459d0f3c29286ae5df5fcc421e2786024277e87"
        ),
        requestedAmount: BigNumber.from(12000),
        treasuryFee: BigNumber.from(1000),
        txMaxFee: BigNumber.from(1200),
        requestedAt: 1650623240,
      },
    },
  ],
  witness: false, // False will result in a P2PKH output
  expectedRedemption: {
    transactionHash: BitcoinTxHash.from(
      "0fec22d0fecd6607a0429210d04e9465681507d514f3edf0f07def96eda0f89d"
    ),
    transaction: {
      transactionHex:
        "01000000000101b772d923456fb61a15c6a0dcd15df057f4f0c53c14b8e4836122b" +
        "6d29ff80ff70400000000ffffffff02482600000000000017a9143ec459d0f3c292" +
        "86ae5df5fcc421e2786024277e87d4d01400000000001976a9148db50eb52063ea9" +
        "d98b3eac91489a90f738986f688ac02473044022007fe551170700fa35bda9362d3" +
        "c9d340a674e1ae3300b266c5c10a283aa703b9022067910d6bfe4c62b14bd2f3244" +
        "47d65bddf732db3d3074e40910d51964c072e6d012103989d253b17a6a0f41838b8" +
        "4ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d900000000",
    },
  },
}

/**
 * Represents data for tests of assembling redemption proofs.
 */
export interface RedemptionProofTestData {
  bitcoinChainData: {
    transaction: BitcoinTx
    rawTransaction: BitcoinRawTx
    accumulatedTxConfirmations: number
    latestBlockHeight: number
    headersChain: Hex
    transactionMerkleBranch: BitcoinTxMerkleBranch
    coinbaseRawTransaction: BitcoinRawTx
    coinbaseMerkleBranch: BitcoinTxMerkleBranch
  }
  expectedRedemptionProof: {
    redemptionTx: BitcoinRawTxVectors
    redemptionProof: BitcoinSpvProof
    mainUtxo: BitcoinUtxo
    walletPublicKey: Hex
  }
}

/**
 * Test data that is based on a Bitcoin testnet transaction with multiple redemption outputs
 * https://live.blockcypher.com/btc-testnet/tx/f70ff89fd2b6226183e4b8143cc5f0f457f05dd1dca0c6151ab66f4523d972b7/
 */
export const redemptionProof: RedemptionProofTestData = {
  bitcoinChainData: {
    transaction: {
      transactionHash: BitcoinTxHash.from(
        "f70ff89fd2b6226183e4b8143cc5f0f457f05dd1dca0c6151ab66f4523d972b7"
      ),
      inputs: [
        {
          transactionHash: BitcoinTxHash.from(
            "3d28bb5bf73379da51bc683f4d0ed31d7b024466c619d80ebd9378077d900be3"
          ),
          outputIndex: 1,
          scriptSig: Hex.from(""),
        },
      ],
      outputs: [
        {
          outputIndex: 0,
          value: BigNumber.from(15900),
          scriptPubKey: Hex.from(
            "76a9144130879211c54df460e484ddf9aac009cb38ee7488ac"
          ),
        },
        {
          outputIndex: 1,
          value: BigNumber.from(11300),
          scriptPubKey: Hex.from(
            "00144130879211c54df460e484ddf9aac009cb38ee74"
          ),
        },
        {
          outputIndex: 2,
          value: BigNumber.from(9900),
          scriptPubKey: Hex.from(
            "a9143ec459d0f3c29286ae5df5fcc421e2786024277e87"
          ),
        },
        {
          outputIndex: 3,
          value: BigNumber.from(12900),
          scriptPubKey: Hex.from(
            "002086a303cdd2e2eab1d1679f1a813835dc5a1b65321077cdccaf08f98cbf04ca96"
          ),
        },
        {
          outputIndex: 4,
          value: BigNumber.from(1375180),
          scriptPubKey: Hex.from(
            "00148db50eb52063ea9d98b3eac91489a90f738986f6"
          ),
        },
      ],
    },
    accumulatedTxConfirmations: 50,
    rawTransaction: {
      transactionHex:
        "01000000000101e30b907d077893bd0ed819c66644027b1dd30e4d3f68bc51da7933" +
        "f75bbb283d0100000000ffffffff051c3e0000000000001976a9144130879211c54d" +
        "f460e484ddf9aac009cb38ee7488ac242c0000000000001600144130879211c54df4" +
        "60e484ddf9aac009cb38ee74ac2600000000000017a9143ec459d0f3c29286ae5df5" +
        "fcc421e2786024277e87643200000000000022002086a303cdd2e2eab1d1679f1a81" +
        "3835dc5a1b65321077cdccaf08f98cbf04ca96ccfb1400000000001600148db50eb5" +
        "2063ea9d98b3eac91489a90f738986f602483045022100adc5b0cffc65444cf16873" +
        "eb57cb702414ee36ca907ad3cf57676abe83c0f80502204a206d9b55eeee05d9647e" +
        "95d15ed5143eaad6cc8c5bc2c1919b69addc18db29012103989d253b17a6a0f41838" +
        "b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d900000000",
    },
    latestBlockHeight: 2226015,
    headersChain: Hex.from(
      "04e000203d93e4b82b59ccaae5aff315b9319248c1119f8f848e421516000000000000" +
        "00f28145109cd15498a2c4264dcda1c3d40d1ab1117f6365cc345e5bab9eb8e5a2f990" +
        "5e62341f5c19adebd9480000c020a33f8505bae0c529af29b00741e2828e4b4ef2cf4d" +
        "a2af790d00000000000000f1dad96fa7c65ae0b2582268ebf6e47b1af887ae9b5af064" +
        "ff87b361259f9bb212915e62341f5c19913d8a790000002074ac47fe867411f520786b" +
        "bb056d33cc5e412799355f22541600000000000000e428a225d38073c8e8584cf162b4" +
        "cdc17eaf766f2fc1beae23f0ebac8b29964ec4955e62ffff001d5ec11e770000a020bc" +
        "1e329ea2658a4e0dfe27cb80e2f9712d78e02c5428eb86db93c7e3000000006381e8dd" +
        "f3245ddd74afb580b6d1e508273673d14b3620c098bde4c50bdbf65de1975e62341f5c" +
        "195a29773400006020e7fc1afb505baced47a255d8a14cb7162b6f94d6aea6a89f4300" +
        "000000000000ad26d482c0f48d0aeb1e1d9a8189df9f8dae693203c117a777c6c15522" +
        "2da759ef975e62341f5c19595dff820000802004bdf8678a1fd09fd50987f884793410" +
        "62e7f2ad11098bd00800000000000000add66b467729d264031adec83bc06e30781153" +
        "0b98f49b095bd4c1fee2472e841d995e62341f5c19945d657200004020f8228183708c" +
        "5f703e673f381ecee895a8642eed9f700b9c2b00000000000000465ec2f30447552a4a" +
        "30ee63964aaebcb040649269eab449fb51823d58835a4aed9a5e62341f5c192fd94baa"
    ),
    transactionMerkleBranch: {
      blockHeight: 2196313,
      merkle: [
        Hex.from(
          "2e89760feb82c022f9b6757c0a758f8fea953ffce9051cbe5a7cc20e0603c940"
        ),
        Hex.from(
          "ad1cae6d060b5dac5d7ff1a933680f15dac822f52316c89e95363856b8a742ae"
        ),
        Hex.from(
          "acf6ecc3da4654362678ac2bf0abf82aba1f2071e143718df2b079124e88fec7"
        ),
        Hex.from(
          "65ea59172f35ee6db6e4194227bea23daedbda8299bea94710f21c97f3e9cc17"
        ),
        Hex.from(
          "8c5b4ce089d0c450bf6125e7d342114246802bf4c9638d222aa9fcbe8e06024e"
        ),
      ],
      position: 4,
    },
    coinbaseRawTransaction: {
      transactionHex:
        "0200000000010100000000000000000000000000000000000000000000000000000000" +
        "00000000ffffffff480359832104f6905e62425443506f6f6cfabe6d6d44b54ffb3a8b" +
        "00ab84e3907bfb9fe78157ce719a54630a1321f50b37116f9f71040000002a8dcca602" +
        "04dad94668000000000000ffffffff028d644b000000000017a9147bef0b4a4dafa77b" +
        "2ec52b81659cbcf0d9a91487870000000000000000266a24aa21a9ed533404630c2732" +
        "6df0f77bad5822ad39e6ef184f61ac334eb6264af532bee74801200000000000000000" +
        "00000000000000000000000000000000000000000000000000000000",
    },
    coinbaseMerkleBranch: {
      blockHeight: 2196313,
      merkle: [
        Hex.from(
          "f0ba82de74f59444ebe27dc395ecf2f6c769d29050f455ad1017f3dcdcd2dd59"
        ),
        Hex.from(
          "1e7b3d5fb5b83ecd12bfe89d9bbd9de747ab544f111063339f11b57f08228ba3"
        ),
        Hex.from(
          "983edacf13f754bf8b6f8c584b7fe12d0d0c0e890e7ce2d29e0c7335021d8b71"
        ),
        Hex.from(
          "65ea59172f35ee6db6e4194227bea23daedbda8299bea94710f21c97f3e9cc17"
        ),
        Hex.from(
          "8c5b4ce089d0c450bf6125e7d342114246802bf4c9638d222aa9fcbe8e06024e"
        ),
      ],
      position: 0,
    },
  },
  expectedRedemptionProof: {
    redemptionTx: {
      version: Hex.from("01000000"),
      inputs: Hex.from(
        "01e30b907d077893bd0ed819c66644027b1dd30e4d3f68bc51da7933f75bbb283d0" +
          "100000000ffffffff"
      ),
      outputs: Hex.from(
        "051c3e0000000000001976a9144130879211c54df460e484ddf9aac009cb38ee748" +
          "8ac242c0000000000001600144130879211c54df460e484ddf9aac009cb38ee74ac" +
          "2600000000000017a9143ec459d0f3c29286ae5df5fcc421e2786024277e8764320" +
          "0000000000022002086a303cdd2e2eab1d1679f1a813835dc5a1b65321077cdccaf" +
          "08f98cbf04ca96ccfb1400000000001600148db50eb52063ea9d98b3eac91489a90" +
          "f738986f6"
      ),
      locktime: Hex.from("00000000"),
    },
    redemptionProof: {
      merkleProof: Hex.from(
        "40c903060ec27c5abe1c05e9fc3f95ea8f8f750a7c75b6f922c082eb0f76892eae4" +
          "2a7b8563836959ec81623f522c8da150f6833a9f17f5dac5d0b066dae1cadc7fe88" +
          "4e1279b0f28d7143e171201fba2af8abf02bac7826365446dac3ecf6ac17cce9f39" +
          "71cf21047a9be9982dadbae3da2be274219e4b66dee352f1759ea654e02068ebefc" +
          "a92a228d63c9f42b8046421142d3e72561bf50c4d089e04c5b8c"
      ),
      txIndexInBlock: 4,
      bitcoinHeaders: Hex.from(
        "04e000203d93e4b82b59ccaae5aff315b9319248c1119f8f848e421516000000000" +
          "00000f28145109cd15498a2c4264dcda1c3d40d1ab1117f6365cc345e5bab9eb8e5" +
          "a2f9905e62341f5c19adebd9480000c020a33f8505bae0c529af29b00741e2828e4" +
          "b4ef2cf4da2af790d00000000000000f1dad96fa7c65ae0b2582268ebf6e47b1af8" +
          "87ae9b5af064ff87b361259f9bb212915e62341f5c19913d8a790000002074ac47f" +
          "e867411f520786bbb056d33cc5e412799355f22541600000000000000e428a225d3" +
          "8073c8e8584cf162b4cdc17eaf766f2fc1beae23f0ebac8b29964ec4955e62ffff0" +
          "01d5ec11e770000a020bc1e329ea2658a4e0dfe27cb80e2f9712d78e02c5428eb86" +
          "db93c7e3000000006381e8ddf3245ddd74afb580b6d1e508273673d14b3620c098b" +
          "de4c50bdbf65de1975e62341f5c195a29773400006020e7fc1afb505baced47a255" +
          "d8a14cb7162b6f94d6aea6a89f4300000000000000ad26d482c0f48d0aeb1e1d9a8" +
          "189df9f8dae693203c117a777c6c155222da759ef975e62341f5c19595dff820000" +
          "802004bdf8678a1fd09fd50987f88479341062e7f2ad11098bd0080000000000000" +
          "0add66b467729d264031adec83bc06e307811530b98f49b095bd4c1fee2472e841d" +
          "995e62341f5c19945d657200004020f8228183708c5f703e673f381ecee895a8642" +
          "eed9f700b9c2b00000000000000465ec2f30447552a4a30ee63964aaebcb0406492" +
          "69eab449fb51823d58835a4aed9a5e62341f5c192fd94baa"
      ),
      coinbasePreimage: Hex.from(
        "5fb81be0d06e1573231f6b5f4eba3055f3160e1b45a7db6c9cb816b0c184b419"
      ),
      coinbaseProof: Hex.from(
        "59ddd2dcdcf31710ad55f45090d269c7f6f2ec95c37de2eb4494f574de82baf0a38" +
          "b22087fb5119f336310114f54ab47e79dbd9b9de8bf12cd3eb8b55f3d7b1e718b1d" +
          "0235730c9ed2e27c0e890e0c0d2de17f4b588c6f8bbf54f713cfda3e9817cce9f39" +
          "71cf21047a9be9982dadbae3da2be274219e4b66dee352f1759ea654e02068ebefc" +
          "a92a228d63c9f42b8046421142d3e72561bf50c4d089e04c5b8c"
      ),
    },
    mainUtxo: {
      transactionHash: BitcoinTxHash.from(
        "3d28bb5bf73379da51bc683f4d0ed31d7b024466c619d80ebd9378077d900be3"
      ),
      outputIndex: 1,
      value: BigNumber.from(1429580),
    },
    walletPublicKey: Hex.from(
      "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
    ),
  },
}

interface FindWalletForRedemptionWalletData {
  data: {
    state: WalletState
    mainUtxoHash: Hex
    walletPublicKey: Hex
    btcAddress: string
    mainUtxo: BitcoinUtxo
    transactions: BitcoinTx[]
    pendingRedemptionsValue: BigNumber
  }
  event: {
    blockNumber: number
    blockHash: Hex
    transactionHash: Hex
    ecdsaWalletID: Hex
    walletPublicKeyHash: Hex
  }
}

export const findWalletForRedemptionData: {
  liveWallet: FindWalletForRedemptionWalletData
  walletWithoutUtxo: FindWalletForRedemptionWalletData
  nonLiveWallet: FindWalletForRedemptionWalletData
  walletWithPendingRedemption: FindWalletForRedemptionWalletData
  pendingRedemption: RedemptionRequest
} = {
  liveWallet: {
    data: {
      state: WalletState.Live,
      mainUtxoHash: Hex.from(
        "0x3ded9dcfce0ffe479640013ebeeb69b6a82306004f9525b1346ca3b553efc6aa"
      ),
      walletPublicKey: Hex.from(
        "0x028ed84936be6a9f594a2dcc636d4bebf132713da3ce4dac5c61afbf8bbb47d6f7"
      ),
      btcAddress: "tb1qqwm566yn44rdlhgph8sw8vecta8uutg79afuja",
      mainUtxo: {
        transactionHash: Hex.from(
          "0x5b6d040eb06b3de1a819890d55d251112e55c31db4a3f5eb7cfacf519fad7adb"
        ),
        outputIndex: 0,
        value: BigNumber.from("791613461"),
      },
      transactions: [
        {
          transactionHash: Hex.from(
            "0x5b6d040eb06b3de1a819890d55d251112e55c31db4a3f5eb7cfacf519fad7adb"
          ),
          inputs: [], // not relevant
          outputs: [
            {
              outputIndex: 0,
              value: BigNumber.from("791613461"),
              scriptPubKey: BitcoinAddressConverter.addressToOutputScript(
                "tb1qqwm566yn44rdlhgph8sw8vecta8uutg79afuja",
                BitcoinNetwork.Testnet
              ),
            },
          ],
        },
      ],
      pendingRedemptionsValue: BigNumber.from(0),
    },
    event: {
      blockNumber: 8367602,
      blockHash: Hex.from(
        "0x908ea9c82b388a760e6dd070522e5421d88b8931fbac6702119f9e9a483dd022"
      ),
      transactionHash: Hex.from(
        "0xc1e995d0ac451cc9ffc9d43f105eddbaf2eb45ea57a61074a84fc022ecf5bda9"
      ),
      ecdsaWalletID: Hex.from(
        "0x5314e0e5a62b173f52ea424958e5bc04bd77e2159478934a89d4fa193c7b3b72"
      ),
      walletPublicKeyHash: Hex.from(
        "0x03b74d6893ad46dfdd01b9e0e3b3385f4fce2d1e"
      ),
    },
  },
  walletWithoutUtxo: {
    data: {
      state: WalletState.Live,
      mainUtxoHash: Hex.from(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      ),
      walletPublicKey: Hex.from(
        "0x030fbbae74e6d85342819e719575949a1349e975b69fb382e9fef671a3a74efc52"
      ),
      btcAddress: "tb1qkct7r24k4wutnsun84rvp3qsyt8yfpvqz89d2y",
      mainUtxo: {
        transactionHash: Hex.from(
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        ),
        outputIndex: 0,
        value: BigNumber.from("0"),
      },
      transactions: [],
      pendingRedemptionsValue: BigNumber.from(0),
    },
    event: {
      blockNumber: 9103428,
      blockHash: Hex.from(
        "0x92ad328db2cb1d2aad60ac809660e05e2b6763ddd376ca21630e304c98f23600"
      ),
      transactionHash: Hex.from(
        "0x309085ebb92e10eb9e665c7d90c94e053f13b36f9bc8017e820bc879ba629b8e"
      ),
      ecdsaWalletID: Hex.from(
        "0xd27bfaaad9c3489e613eb3664c3b9958bd9a494377123689733267cb4a5767ba"
      ),
      walletPublicKeyHash: Hex.from(
        "0xb617e1aab6abb8b9c3933d46c0c41022ce448580"
      ),
    },
  },

  nonLiveWallet: {
    data: {
      state: WalletState.Unknown,
      mainUtxoHash: Hex.from(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      ),
      walletPublicKey: Hex.from(
        "0x02633b102417009ae55103798f4d366dfccb081dcf20025088b9bf10a8e15d8ded"
      ),
      btcAddress: "tb1qf6jvyd680ncf9dtr5znha9ql5jmw84lupwwuf6",
      mainUtxo: {
        transactionHash: Hex.from(
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        ),
        outputIndex: 0,
        value: BigNumber.from("0"),
      },
      transactions: [],
      pendingRedemptionsValue: BigNumber.from(0),
    },
    event: {
      blockNumber: 9171960,
      blockHash: Hex.from(
        "0xe9a404b724183cb8f77e45718b365051e8d5ccc4a72dfece30af7596eeee4748"
      ),
      transactionHash: Hex.from(
        "0x867f2c985cbe44f92a7ca2c14268b9ae78275e1c339692e1847548725484e72d"
      ),
      ecdsaWalletID: Hex.from(
        "0x96975ddd76bbb2e15ed4498de6d92187ec5282913b3af3891a4e2d60581a8787"
      ),
      walletPublicKeyHash: Hex.from(
        "0x4ea4c237477cf092b563a0a77e941fa4b6e3d7fc"
      ),
    },
  },
  walletWithPendingRedemption: {
    data: {
      state: WalletState.Live,
      mainUtxoHash: Hex.from(
        "0xb3024ef698084cfdfba459338864a595d31081748b28aa5eb02312671a720531"
      ),
      walletPublicKey: Hex.from(
        "0x02ab193a63b3523bfab77d3645d11da10722393687458c4213b350b7e08f50b7ee"
      ),
      btcAddress: "tb1qx2xejtjltdcau5dpks8ucszkhxdg3fj88404lh",
      mainUtxo: {
        transactionHash: Hex.from(
          "0x81c4884a8c2fccbeb57745a5e59f895a9c1bb8fc42eecc82269100a1a46bbb85"
        ),
        outputIndex: 0,
        value: BigNumber.from("3370000"), // 0.0337 BTC
      },
      transactions: [
        {
          transactionHash: Hex.from(
            "0x81c4884a8c2fccbeb57745a5e59f895a9c1bb8fc42eecc82269100a1a46bbb85"
          ),
          inputs: [], // not relevant
          outputs: [
            {
              outputIndex: 0,
              value: BigNumber.from("3370000"), // 0.0337 BTC
              scriptPubKey: BitcoinAddressConverter.addressToOutputScript(
                "tb1qx2xejtjltdcau5dpks8ucszkhxdg3fj88404lh",
                BitcoinNetwork.Testnet
              ),
            },
          ],
        },
      ],
      pendingRedemptionsValue: BigNumber.from(2370000), // 0.0237 BTC
    },
    event: {
      blockNumber: 8981644,
      blockHash: Hex.from(
        "0x6681b1bb168fb86755c2a796169cb0e06949caac9fc7145d527d94d5209a64ad"
      ),
      transactionHash: Hex.from(
        "0xea3a8853c658145c95165d7847152aeedc3ff29406ec263abfc9b1436402b7b7"
      ),
      ecdsaWalletID: Hex.from(
        "0x7a1437d67f49adfd44e03ddc85be0f6988715d7c39dfb0ca9780f1a88bcdca25"
      ),
      walletPublicKeyHash: Hex.from(
        "0x328d992e5f5b71de51a1b40fcc4056b99a88a647"
      ),
    },
  },
  pendingRedemption: {
    redeemer: EthereumAddress.from(
      "0xeb9af8E66869902476347a4eFe59a527a57240ED"
    ),
    // script for testnet P2PKH address mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc
    redeemerOutputScript: Hex.from(
      "76a9142cd680318747b720d67bf4246eb7403b476adb3488ac"
    ),
    requestedAmount: BigNumber.from(1000000),
    treasuryFee: BigNumber.from(20000),
    txMaxFee: BigNumber.from(20000),
    requestedAt: 1688724606,
  },
}
