import { BigNumber } from "@ethersproject/bignumber"
import { Hex } from "../../src/lib/utils"
import {
  BitcoinRawTx,
  BitcoinUtxo,
  BitcoinTxHash,
  BitcoinLocktimeUtils,
  DepositReceipt,
  EthereumAddress,
} from "../../src"

/**
 * Testnet private key that can be used to refund the deposits used in tests.
 * The public key associated with this key was used to compute refundPublicKeyHash
 * of the deposits and the refunder addresses used in tests.
 */
export const refunderPrivateKey =
  "cTWhf1nXc7aW8BN2qLtWcPtcgcWYKfzRXkCJNsuQ86HR8uJBYfMc"

/**
 * Represents data for tests of assembling deposit refund transactions.
 */
export interface DepositRefundTestData {
  deposit: {
    utxo: BitcoinUtxo & BitcoinRawTx
    data: DepositReceipt
  }
  refunderAddress: string
  expectedRefund: {
    transactionHash: BitcoinTxHash
    transaction: BitcoinRawTx
  }
}

/**
 * Test data based on a Bitcoin deposit refund transaction in which a witness
 * (P2WSH) deposit was refunded and the refunder's address was witness:
 * https://live.blockcypher.com/btc-testnet/tx/b49bd6c0219066f0c76d85818b047e4685425844cda42dae9b9508b9bfbb483d/
 */
export const depositRefundOfWitnessDepositAndWitnessRefunderAddress: DepositRefundTestData =
  {
    deposit: {
      utxo: {
        transactionHash: BitcoinTxHash.from(
          "6430be26d8564658bf3ff0f74e4a7ddce9d65e9c7157d6e4a203125fc01d3c6d"
        ),
        outputIndex: 0,
        value: BigNumber.from(100000),
        transactionHex:
          "010000000001012b426822cb1900caef0d3bb8dc91227c77dc79305cc939843487" +
          "25fb18a24b4d0100000000ffffffff02a086010000000000220020809dc9315182" +
          "60bb00abe54cc2d8c16e5f4f11529abf3de53f3e745298b5a85f74671c00000000" +
          "00160014e257eccafbc07c381642ce6e7e55120fb077fbed02483045022100cac2" +
          "b693e4897d4b1a007718ff8ddd74cf8e5c610dfeb429a67826d6d4f1f71b02200e" +
          "0ac998e630f51b6904106015bc6126973fda257cc5292afa20047439a279570121" +
          "039d61d62dcd048d3f8550d22eb90b4af908db60231d117aeede04e7bc11907bfa" +
          "00000000",
      },
      data: {
        depositor: EthereumAddress.from(
          "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
        ),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "1b67f27537c7b30a23d8ccefb96a4cacfc72d9a1"
        ),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: BitcoinLocktimeUtils.calculateLocktime(
          1674820800,
          3600
        ),
      },
    },
    // witness address associated with the refunder's private key
    refunderAddress: "tb1qrdnlyafhc7es5g7cenhmj6jv4n789kdpw5kty9",
    expectedRefund: {
      transactionHash: BitcoinTxHash.from(
        "b49bd6c0219066f0c76d85818b047e4685425844cda42dae9b9508b9bfbb483d"
      ),
      transaction: {
        transactionHex:
          "010000000001016d3c1dc05f1203a2e4d657719c5ed6e9dc7d4a4ef7f03fbf58" +
          "4656d826be30640000000000feffffff01b0800100000000001600141b67f275" +
          "37c7b30a23d8ccefb96a4cacfc72d9a10348304502210089cccd9db8c1876295" +
          "a0478373b683c55c055a1a7c895c75de6234cfd9b31f450220075478aee6c10f" +
          "fc93a4e206adb3d9a619ee5d5710f36f9b1ab71fdd02f8690a012103a0677d62" +
          "0a980f1a6035a16d08312793d6717b71b12a948c5b64671beee220635c14934b" +
          "98637ca318a4d6e7ca6ffd1690b8e77df6377508f9f0c90d000395237576a914" +
          "8db50eb52063ea9d98b3eac91489a90f738986f68763ac6776a9141b67f27537" +
          "c7b30a23d8ccefb96a4cacfc72d9a18804d0cad363b175ac68d0cad363",
      },
    },
  }

/**
 * Test data based on a Bitcoin deposit refund transaction in which a non-witness
 * (P2SH) deposit was refunded and the refunder's address was witness:
 * https://live.blockcypher.com/btc-testnet/tx/7df9ed885525899ccbe144fd129062cec59be43d428b85fb847808b8790ad262/
 */
export const depositRefundOfNonWitnessDepositAndWitnessRefunderAddress: DepositRefundTestData =
  {
    deposit: {
      utxo: {
        transactionHash: BitcoinTxHash.from(
          "60650462f367bf89b5a0dc52d7d1f65986296fa8d8903b129c444e2b742f0143"
        ),
        outputIndex: 0,
        value: BigNumber.from(90000),
        transactionHex:
          "01000000000101d5c5fb73a9a426c4d9c509954e11cc0f3070bb06bb7761c3600e" +
          "c817fd63e90f0100000000ffffffff02905f01000000000017a9146447bec3083e" +
          "53cb2822e03849186112a3ed33d98732c2170000000000160014e257eccafbc07c" +
          "381642ce6e7e55120fb077fbed0247304402203251a73b1968fee062d5c0b0b5c7" +
          "1ae02c265ec29d162121615222e02465af71022054ad1a20c6f002ff65422125b3" +
          "b7f0046613cae3cf7875aaae055d48ca6691700121039d61d62dcd048d3f8550d2" +
          "2eb90b4af908db60231d117aeede04e7bc11907bfa00000000",
      },
      data: {
        depositor: EthereumAddress.from(
          "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
        ),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "1b67f27537c7b30a23d8ccefb96a4cacfc72d9a1"
        ),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: BitcoinLocktimeUtils.calculateLocktime(
          1674820800,
          3600
        ),
      },
    },
    // witness address associated with the refunder's private key
    refunderAddress: "tb1qrdnlyafhc7es5g7cenhmj6jv4n789kdpw5kty9",
    expectedRefund: {
      transactionHash: BitcoinTxHash.from(
        "7df9ed885525899ccbe144fd129062cec59be43d428b85fb847808b8790ad262"
      ),
      transaction: {
        transactionHex:
          "010000000143012f742b4e449c123b90d8a86f298659f6d1d752dca0b589bf67f3" +
          "6204656000000000c847304402204fc34e5607a3993b8690a7316d5bb4739ee631" +
          "54dc397c62397711b4e1e81d0602205a484657a4d52c1730681fce0f11a8e5cf63" +
          "07e1b73be05fa5c1b2471d519a6a012103a0677d620a980f1a6035a16d08312793" +
          "d6717b71b12a948c5b64671beee220634c5c14934b98637ca318a4d6e7ca6ffd16" +
          "90b8e77df6377508f9f0c90d000395237576a9148db50eb52063ea9d98b3eac914" +
          "89a90f738986f68763ac6776a9141b67f27537c7b30a23d8ccefb96a4cacfc72d9" +
          "a18804d0cad363b175ac68feffffff01a0590100000000001600141b67f27537c7" +
          "b30a23d8ccefb96a4cacfc72d9a1d0cad363",
      },
    },
  }

/**
 * Test data based on a Bitcoin deposit refund transaction in which a witness
 * (P2WSH) deposit was refunded and the refunder's address was non-witness:
 * https://live.blockcypher.com/btc-testnet/tx/0400678f7ae0275338cb0418236960c04c016b980cb7d1763c1d957f534ae0eb/
 */
export const depositRefundOfWitnessDepositAndNonWitnessRefunderAddress: DepositRefundTestData =
  {
    deposit: {
      utxo: {
        transactionHash: BitcoinTxHash.from(
          "b1fb065a61a6401279cafb95d10b502a6cd22f747bcfdb09ab25d4ee6f64319f"
        ),
        outputIndex: 0,
        value: BigNumber.from(150000),
        transactionHex:
          "0100000000010143012f742b4e449c123b90d8a86f298659f6d1d752dca0b589bf6" +
          "7f3620465600100000000ffffffff02f049020000000000220020809dc931518260" +
          "bb00abe54cc2d8c16e5f4f11529abf3de53f3e745298b5a85f52721500000000001" +
          "60014e257eccafbc07c381642ce6e7e55120fb077fbed02483045022100e9fce79b" +
          "2d66d3fef5c8991e4466b0f6d316559bc8ca7e1e4f206e0c830c8bac022030481d4" +
          "7afaacd6a34e885e9c07e2f422edc36e6d44fe5557f232b1c7875b2ea0121039d61" +
          "d62dcd048d3f8550d22eb90b4af908db60231d117aeede04e7bc11907bfa00000000",
      },
      data: {
        depositor: EthereumAddress.from(
          "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
        ),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "1b67f27537c7b30a23d8ccefb96a4cacfc72d9a1"
        ),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: BitcoinLocktimeUtils.calculateLocktime(
          1674820800,
          3600
        ),
      },
    },
    // non-witness address associated with the refunder's private key
    refunderAddress: "mi1s4c2GtyVpqQb6MEpMbKimq3mwu5Z3a6",
    expectedRefund: {
      transactionHash: BitcoinTxHash.from(
        "0400678f7ae0275338cb0418236960c04c016b980cb7d1763c1d957f534ae0eb"
      ),
      transaction: {
        transactionHex:
          "010000000001019f31646feed425ab09dbcf7b742fd26c2a500bd195fbca791240a" +
          "6615a06fbb10000000000feffffff0100440200000000001976a9141b67f27537c7" +
          "b30a23d8ccefb96a4cacfc72d9a188ac034730440220160a6ec8d34eb8e24800abc" +
          "8bf912418ad41ecc6d53699eff731abf6f1a7fa1102207dc757c520b02bbfd678c0" +
          "6fff5cdfaa67b9d0563308da35b5d60ceda7560df1012103a0677d620a980f1a603" +
          "5a16d08312793d6717b71b12a948c5b64671beee220635c14934b98637ca318a4d6" +
          "e7ca6ffd1690b8e77df6377508f9f0c90d000395237576a9148db50eb52063ea9d9" +
          "8b3eac91489a90f738986f68763ac6776a9141b67f27537c7b30a23d8ccefb96a4c" +
          "acfc72d9a18804d0cad363b175ac68d0cad363",
      },
    },
  }
