import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import { BigNumber } from "ethers"
import * as secp256k1 from "@bitcoinerlab/secp256k1"
import { payments, Transaction } from "bitcoinjs-lib"
import {
  testnetAddress,
  testnetPrivateKey,
  testnetTransaction,
  testnetTransactionHash,
  testnetUTXO,
} from "../data/deposit"
import {
  BitcoinAddressConverter,
  BitcoinLocktimeUtils,
  BitcoinNetwork,
  BitcoinPrivateKeyUtils,
  BitcoinRawTx,
  BitcoinTxHash,
  BitcoinUtxo,
  Deposit,
  DepositFunding,
  DepositorProxy,
  DepositReceipt,
  DepositRefund,
  DepositScript,
  DepositScriptType,
  DepositsService,
  EthereumAddress,
  extractBitcoinRawTxVectors,
  DestinationChainName,
  CrossChainDepositor,
  Hex,
  CrossChainInterfaces,
  ChainIdentifier,
  BitcoinRawTxVectors,
  CrossChainContracts,
  BitcoinTaprootUtils,
  toBitcoinJsLibNetwork,
} from "../../src"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { txToJSON } from "../utils/helpers"
import {
  depositRefundOfNonWitnessDepositAndWitnessRefunderAddress,
  depositRefundOfWitnessDepositAndNonWitnessRefunderAddress,
  depositRefundOfWitnessDepositAndWitnessRefunderAddress,
  refunderPrivateKey,
} from "../data/deposit-refund"

chai.use(chaiAsPromised)
import { MockDepositorProxy } from "../utils/mock-depositor-proxy"
import {
  MockCrossChainExtraDataEncoder,
  MockL1BitcoinDepositor,
  MockBitcoinDepositor,
  MockL2BitcoinDepositor,
  MockL2TBTCToken,
  MockL2BitcoinRedeemer,
  MockL1BitcoinRedeemer,
} from "../utils/mock-cross-chain"

describe("Deposits", () => {
  const depositCreatedAt: number = 1640181600
  const depositRefundLocktimeDuration: number = 2592000

  const depositAmount = BigNumber.from(10000) // 0.0001 BTC

  const depositFixture = {
    receipt: {
      depositor: EthereumAddress.from(
        "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
      ),
      // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
      walletPublicKeyHash: Hex.from("8db50eb52063ea9d98b3eac91489a90f738986f6"),
      // HASH160 of 0300d6f28a2f6bf9836f57fcda5d284c9a8f849316119779f0d6090830d97763a9.
      refundPublicKeyHash: Hex.from("28e081f285138ccbe389c1eb8985716230129f89"),
      blindingFactor: Hex.from("f9f0c90d00039523"),
      refundLocktime: BitcoinLocktimeUtils.calculateLocktime(
        depositCreatedAt,
        depositRefundLocktimeDuration
      ),
      extraData: undefined,
    },
    expectedScript:
      "14934b98637ca318a4d6e7ca6ffd1690b8e77df6377508f9f0c90d000395237576a91" +
      "48db50eb52063ea9d98b3eac91489a90f738986f68763ac6776a91428e081f285138c" +
      "cbe389c1eb8985716230129f89880460bcea61b175ac68",
    expectedP2WSHData: {
      transactionHash: BitcoinTxHash.from(
        "9eb901fc68f0d9bcaf575f23783b7d30ac5dd8d95f3c83dceaa13dce17de816a"
      ),

      // HEX of the expected P2WSH deposit transaction. It can be decoded with:
      // https://live.blockcypher.com/btc-testnet/decodetx.
      transaction: {
        transactionHex:
          "010000000001018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56" +
          "b20dc2b952f0100000000ffffffff021027000000000000220020df74a2e385542c" +
          "87acfafa564ea4bc4fc4eb87d2b6a37d6c3b64722be83c636f10d73b00000000001" +
          "600147ac2d9378a1c47e589dfb8095ca95ed2140d272602483045022100ac3d4148" +
          "2338262654418825c37a4c7b327ed4e0b1dfb80eba0c98f264a6cc2e02201cd321f" +
          "1b806cc946141d71b229dd0a440917c9f429b5f8840f7be59d70dbfee012102ee06" +
          "7a0273f2e3ba88d23140a24fdb290f27bbcd0f94117a9c65be3911c5c04e0000000" +
          "0",
      },

      scriptHash:
        "df74a2e385542c87acfafa564ea4bc4fc4eb87d2b6a37d6c3b64722be83c636f",

      mainnetAddress:
        "bc1qma629cu92skg0t86lftyaf9uflzwhp7jk63h6mpmv3ezh6puvdhsdxuv4m",

      testnetAddress:
        "tb1qma629cu92skg0t86lftyaf9uflzwhp7jk63h6mpmv3ezh6puvdhs6w2r05",
    },
    expectedP2SHData: {
      transactionHash: BitcoinTxHash.from(
        "f21a9922c0c136c6d288cf1258b732d0f84a7d50d14a01d7d81cb6cd810f3517"
      ),

      // HEX of the expected P2SH deposit transaction. It can be decoded with:
      // https://live.blockcypher.com/btc-testnet/decodetx.
      transaction: {
        transactionHex:
          "010000000001018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56" +
          "b20dc2b952f0100000000ffffffff02102700000000000017a9142c1444d23936c5" +
          "7bdd8b3e67e5938a5440cda455877ed73b00000000001600147ac2d9378a1c47e58" +
          "9dfb8095ca95ed2140d27260247304402204582016a3cd3fa61fae1e1911b575625" +
          "fe2ca75319de72349089724e80fb4a2f02207e76f992f64d0615779af763b157699" +
          "a0d37270e136122408196084c1753a19e012102ee067a0273f2e3ba88d23140a24f" +
          "db290f27bbcd0f94117a9c65be3911c5c04e00000000",
      },

      scriptHash: "2c1444d23936c57bdd8b3e67e5938a5440cda455",

      mainnetAddress: "35i5wHdLir1hdjCr6hiQNk3yTH9ufe61eH",

      testnetAddress: "2MwGJ12ZNLJX3qWqPmqLGzh3EfdN5XAEGQ8",
    },
  }

  const depositWithExtraDataFixture = {
    receipt: {
      ...depositFixture.receipt,
      extraData: Hex.from(
        "a9b38ea6435c8941d6eda6a46b68e3e2117196995bd154ab55196396b03d9bda"
      ),
    },
    expectedScript:
      "14934b98637ca318a4d6e7ca6ffd1690b8e77df6377520a9b38ea6435c8941d6eda6a46" +
      "b68e3e2117196995bd154ab55196396b03d9bda7508f9f0c90d000395237576a9148db5" +
      "0eb52063ea9d98b3eac91489a90f738986f68763ac6776a91428e081f285138ccbe389c" +
      "1eb8985716230129f89880460bcea61b175ac68",
    expectedP2WSHData: {
      transactionHash: BitcoinTxHash.from(
        "32577973ff05a55f72b19378baaafb04e009c4ac512def4453d5d8d0032131c9"
      ),

      // HEX of the expected P2WSH deposit transaction. It can be decoded with:
      // https://live.blockcypher.com/btc-testnet/decodetx.
      transaction: {
        transactionHex:
          "010000000001018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56" +
          "b20dc2b952f0100000000ffffffff021027000000000000220020bfaeddba12b0de" +
          "6feeb649af76376876bc1feb6c2248fbfef9293ba3ac51bb4a10d73b00000000001" +
          "600147ac2d9378a1c47e589dfb8095ca95ed2140d272602483045022100bccb772b" +
          "4149b9ce46f426849177f81e359b3f01491dce7ed38474f356a021e202205ed8aee" +
          "19ba5e56f324ab19926a21b05e977210b52cd77282f0de3a879f21f0f012102ee06" +
          "7a0273f2e3ba88d23140a24fdb290f27bbcd0f94117a9c65be3911c5c04e0000000" +
          "0",
      },

      scriptHash:
        "bfaeddba12b0de6feeb649af76376876bc1feb6c2248fbfef9293ba3ac51bb4a",

      mainnetAddress:
        "bc1qh7hdmwsjkr0xlm4kfxhhvdmgw67pl6mvyfy0hlhe9ya68tz3hd9q7vkpyw",

      testnetAddress:
        "tb1qh7hdmwsjkr0xlm4kfxhhvdmgw67pl6mvyfy0hlhe9ya68tz3hd9qfyqw7p",
    },
    expectedP2SHData: {
      transactionHash: BitcoinTxHash.from(
        "bcdf1661f9623c46b6fc578d6a3c8c8e747161d3ba12cd34600b262918cd8363"
      ),

      // HEX of the expected P2SH deposit transaction. It can be decoded with:
      // https://live.blockcypher.com/btc-testnet/decodetx.
      transaction: {
        transactionHex:
          "010000000001018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56" +
          "b20dc2b952f0100000000ffffffff02102700000000000017a9149fe6615a307aa1" +
          "d7eee668c1227802b2fbcaa919877ed73b00000000001600147ac2d9378a1c47e58" +
          "9dfb8095ca95ed2140d27260247304402200c3e81879621451c4392ed525b2f8514" +
          "a011b35c505299f8b8520b176b8b772d022013dd63eeafa18a19ccfc102f6e85363" +
          "a89e6e9515a2494dc32bca32248e44789012102ee067a0273f2e3ba88d23140a24f" +
          "db290f27bbcd0f94117a9c65be3911c5c04e00000000",
      },

      scriptHash: "9fe6615a307aa1d7eee668c1227802b2fbcaa919",

      mainnetAddress: "3GGVM9WERE3wsN2QfUJxPzhWFtLicRGhHi",

      testnetAddress: "2N7phQtSG2gZJ59exLbvq1wgmUEYtRc51Ly",
    },
  }

  const taprootDepositFixture = {
    receipt: {
      ...depositFixture.receipt,
      // HASH160 of the synthetic compressed Taproot refund key:
      // 0x02 || 11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff.
      refundPublicKeyHash: Hex.from("c2a27a88d8d03e271e8edc556923e9398619f17c"),
      walletXOnlyPublicKey: Hex.from(
        "2336f65004d8f122f1fe947ebd009a8b4add3a0d937356d568e30f7fcc2e4008"
      ),
      refundXOnlyPublicKey: Hex.from(
        "11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff"
      ),
    },
    expectedRefundScript:
      "14934b98637ca318a4d6e7ca6ffd1690b8e77df6377508f9f0c90d00039523" +
      "750460bcea61b1752011223344556677889900aabbccddeeff001122334455667" +
      "78899aabbccddeeffac",
    expectedP2TRData: {
      leafHash:
        "3d6f9a2fea1de0a6c260d1fbc0343c9b2ed84307e6a7231139b78438448ee8c0",
      outputKey:
        "90e7ce2b6cd476b7a1c2c7f6585c3fd0eae4379a508e981ed422b3e28b9ae8c2",
      mainnetAddress:
        "bc1pjrnuu2mv63mt0gwzclm9shpl6r4wgdu62z8fs8k5y2e79zu6arpqzm9yvt",
      testnetAddress:
        "tb1pjrnuu2mv63mt0gwzclm9shpl6r4wgdu62z8fs8k5y2e79zu6arpq4nntky",
    },
  }

  const taprootDepositWithExtraDataFixture = {
    receipt: {
      ...taprootDepositFixture.receipt,
      extraData: depositWithExtraDataFixture.receipt.extraData,
    },
    expectedRefundScript:
      "14934b98637ca318a4d6e7ca6ffd1690b8e77df6377520a9b38ea6435c8941d" +
      "6eda6a46b68e3e2117196995bd154ab55196396b03d9bda7508f9f0c90d0003" +
      "9523750460bcea61b1752011223344556677889900aabbccddeeff0011223344" +
      "5566778899aabbccddeeffac",
    expectedP2TRData: {
      leafHash:
        "6968648895261db4f667ff977b3bbd9b4684fe756050894b092fd0e24e24f90f",
      outputKey:
        "b57ad22351a7a074b6588836d08fbecae35b61ef9eeb35376a1c5f3d6049376e",
      mainnetAddress:
        "bc1pk4adyg6357s8fdjc3qmdpra7et34kc00nm4n2dm2r30n6czfxahqxmhf78",
      testnetAddress:
        "tb1pk4adyg6357s8fdjc3qmdpra7et34kc00nm4n2dm2r30n6czfxahq3npxyg",
    },
  }

  /**
   * Checks if script given in argument is correct
   * @param script - script as an un-prefixed hex string.
   * @param fixture - fixture the script should be validated against.
   * @returns void
   */
  function assertValidDepositScript(
    script: string,
    fixture: typeof depositFixture | typeof depositWithExtraDataFixture
  ): void {
    // Returned script should be the same as expectedDepositScript but
    // here we make a breakdown and assert specific parts are as expected.
    expect(script.length).to.be.equal(fixture.expectedScript.length)

    // Assert the depositor identifier is encoded correctly.
    // According the Bitcoin script format, the first byte before arbitrary
    // data must determine the length of those data. In this case the first
    // byte is 0x14 which is 20 in decimal, and this is correct because we
    // have a 20 bytes depositor identifier as subsequent data.
    expect(script.substring(0, 2)).to.be.equal("14")
    expect(script.substring(2, 42)).to.be.equal(
      fixture.receipt.depositor.identifierHex
    )

    // According to https://en.bitcoin.it/wiki/Script#Constants, the
    // OP_DROP opcode is 0x75.
    expect(script.substring(42, 44)).to.be.equal("75")

    let offset = 0
    if (typeof fixture.receipt.extraData !== "undefined") {
      // Assert optional extra data is encoded correctly. The first byte
      // is 0x20 which is 32 in decimal, and this is correct because we
      // have a 32-byte extra data as subsequent vector.
      expect(script.substring(44, 46)).to.be.equal("20")
      expect(script.substring(46, 110)).to.be.equal(
        (fixture.receipt.extraData as Hex).toString()
      )

      // OP_DROP opcode is 0x75.
      expect(script.substring(110, 112)).to.be.equal("75")

      // If extra data is present, we need to offset the following checks by
      // 1 + 32 + 1 = 34 bytes. That gives 68 characters.
      offset = 68
    }

    // Assert the blinding factor is encoded correctly.
    // The first byte (0x08) before the blinding factor is this byte length.
    // In this case it's 8 bytes.
    expect(script.substring(44 + offset, 46 + offset)).to.be.equal("08")
    expect(script.substring(46 + offset, 62 + offset)).to.be.equal(
      fixture.receipt.blindingFactor.toString()
    )

    // OP_DROP opcode is 0x75.
    expect(script.substring(62 + offset, 64 + offset)).to.be.equal("75")

    // OP_DUP opcode is 0x76.
    expect(script.substring(64 + offset, 66 + offset)).to.be.equal("76")

    // OP_HASH160 opcode is 0xa9.
    expect(script.substring(66 + offset, 68 + offset)).to.be.equal("a9")

    // Assert the wallet public key hash is encoded correctly.
    // The first byte (0x14) before the public key is this byte length.
    // In this case it's 20 bytes which is a correct length for a HASH160.
    expect(script.substring(68 + offset, 70 + offset)).to.be.equal("14")
    expect(script.substring(70 + offset, 110 + offset)).to.be.equal(
      fixture.receipt.walletPublicKeyHash.toString()
    )

    // OP_EQUAL opcode is 0x87.
    expect(script.substring(110 + offset, 112 + offset)).to.be.equal("87")

    // OP_IF opcode is 0x63.
    expect(script.substring(112 + offset, 114 + offset)).to.be.equal("63")

    // OP_CHECKSIG opcode is 0xac.
    expect(script.substring(114 + offset, 116 + offset)).to.be.equal("ac")

    // OP_ELSE opcode is 0x67.
    expect(script.substring(116 + offset, 118 + offset)).to.be.equal("67")

    // OP_DUP opcode is 0x76.
    expect(script.substring(118 + offset, 120 + offset)).to.be.equal("76")

    // OP_HASH160 opcode is 0xa9.
    expect(script.substring(120 + offset, 122 + offset)).to.be.equal("a9")

    // Assert the refund public key hash is encoded correctly.
    // The first byte (0x14) before the public key is this byte length.
    // In this case it's 20 bytes which is a correct length for a HASH160.
    expect(script.substring(122 + offset, 124 + offset)).to.be.equal("14")
    expect(script.substring(124 + offset, 164 + offset)).to.be.equal(
      fixture.receipt.refundPublicKeyHash.toString()
    )

    // OP_EQUALVERIFY opcode is 0x88.
    expect(script.substring(164 + offset, 166 + offset)).to.be.equal("88")

    // Assert the locktime is encoded correctly.
    // The first byte (0x04) before the locktime is this byte length.
    // In this case it's 4 bytes.
    expect(script.substring(166 + offset, 168 + offset)).to.be.equal("04")
    expect(script.substring(168 + offset, 176 + offset)).to.be.equal(
      Buffer.from(
        BigNumber.from(1640181600 + 2592000)
          .toHexString()
          .substring(2),
        "hex"
      )
        .reverse()
        .toString("hex")
    )

    // OP_CHECKLOCKTIMEVERIFY opcode is 0xb1.
    expect(script.substring(176 + offset, 178 + offset)).to.be.equal("b1")

    // OP_DROP opcode is 0x75.
    expect(script.substring(178 + offset, 180 + offset)).to.be.equal("75")

    // OP_CHECKSIG opcode is 0xac.
    expect(script.substring(180 + offset, 182 + offset)).to.be.equal("ac")

    // OP_ENDIF opcode is 0x68.
    expect(script.substring(182 + offset, 184 + offset)).to.be.equal("68")
  }

  function createTestnetP2PKHUtxo(
    value: BigNumber = BigNumber.from(3933200)
  ): BitcoinUtxo & BitcoinRawTx {
    const network = toBitcoinJsLibNetwork(BitcoinNetwork.Testnet)
    const depositorKeyPair = BitcoinPrivateKeyUtils.createKeyPair(
      testnetPrivateKey,
      BitcoinNetwork.Testnet
    )
    const depositorLegacyAddress = BitcoinAddressConverter.publicKeyToAddress(
      Hex.from(depositorKeyPair.publicKey),
      BitcoinNetwork.Testnet,
      false
    )
    const p2pkhScript = payments.p2pkh({
      address: depositorLegacyAddress,
      network,
    }).output!

    const transaction = new Transaction()
    transaction.version = 1
    transaction.addInput(Buffer.alloc(32, 1), 0)
    transaction.addOutput(p2pkhScript, value.toNumber())

    return {
      transactionHash: BitcoinTxHash.from(transaction.getId()),
      outputIndex: 0,
      value,
      transactionHex: transaction.toHex(),
    }
  }

  function createTestnetP2SHUtxo(
    value: BigNumber = BigNumber.from(3933200)
  ): BitcoinUtxo & BitcoinRawTx {
    const network = toBitcoinJsLibNetwork(BitcoinNetwork.Testnet)
    const depositorKeyPair = BitcoinPrivateKeyUtils.createKeyPair(
      testnetPrivateKey,
      BitcoinNetwork.Testnet
    )
    const p2wpkhScript = payments.p2wpkh({
      pubkey: Buffer.from(depositorKeyPair.publicKey),
      network,
    }).output!
    const p2shScript = payments.p2sh({
      redeem: {
        output: p2wpkhScript,
      },
      network,
    }).output!

    const transaction = new Transaction()
    transaction.version = 1
    transaction.addInput(Buffer.alloc(32, 1), 0)
    transaction.addOutput(p2shScript, value.toNumber())

    return {
      transactionHash: BitcoinTxHash.from(transaction.getId()),
      outputIndex: 0,
      value,
      transactionHex: transaction.toHex(),
    }
  }

  describe("DepositFunding", () => {
    describe("submitTransaction", () => {
      let bitcoinClient: MockBitcoinClient

      beforeEach(async () => {
        bitcoinClient = new MockBitcoinClient()

        // Tie testnetTransaction to testnetUTXO. This is needed since
        // DepositFunding.submitTransaction attach transaction data to each UTXO.
        const rawTransactions = new Map<string, BitcoinRawTx>()
        rawTransactions.set(
          testnetTransactionHash.toString(),
          testnetTransaction
        )
        bitcoinClient.rawTransactions = rawTransactions
      })

      context("when deposit does not have optional extra data", () => {
        context("when witness option is true", () => {
          let transactionHash: BitcoinTxHash
          let depositUtxo: BitcoinUtxo

          beforeEach(async () => {
            const fee = BigNumber.from(1520)

            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(depositFixture.receipt, true)
            )

            ;({ transactionHash, depositUtxo } =
              await depositFunding.submitTransaction(
                depositAmount,
                [testnetUTXO],
                fee,
                testnetPrivateKey,
                bitcoinClient
              ))
          })

          it("should broadcast P2WSH transaction with proper structure", async () => {
            expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
            expect(bitcoinClient.broadcastLog[0]).to.be.eql(
              depositFixture.expectedP2WSHData.transaction
            )
          })

          it("should return the proper transaction hash", async () => {
            expect(transactionHash).to.be.deep.equal(
              depositFixture.expectedP2WSHData.transactionHash
            )
          })

          it("should return the proper deposit UTXO", () => {
            const expectedDepositUtxo = {
              transactionHash: depositFixture.expectedP2WSHData.transactionHash,
              outputIndex: 0,
              value: depositAmount,
            }

            expect(depositUtxo).to.be.eql(expectedDepositUtxo)
          })
        })

        context("when input UTXO is P2PKH", () => {
          let inputUtxo: BitcoinUtxo & BitcoinRawTx

          beforeEach(async () => {
            const fee = BigNumber.from(1520)

            inputUtxo = createTestnetP2PKHUtxo()
            bitcoinClient.rawTransactions = new Map<string, BitcoinRawTx>([
              [
                inputUtxo.transactionHash.toString(),
                { transactionHex: inputUtxo.transactionHex },
              ],
            ])

            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(depositFixture.receipt, true)
            )

            await depositFunding.submitTransaction(
              depositAmount,
              [inputUtxo],
              fee,
              testnetPrivateKey,
              bitcoinClient
            )
          })

          it("should sign the input using scriptSig without witness data", () => {
            expect(bitcoinClient.broadcastLog.length).to.be.equal(1)

            const txJSON = txToJSON(
              bitcoinClient.broadcastLog[0].transactionHex,
              BitcoinNetwork.Testnet
            )

            expect(txJSON.inputs.length).to.be.equal(1)

            const input = txJSON.inputs[0]

            expect(input.hash).to.be.equal(inputUtxo.transactionHash.toString())
            expect(input.index).to.be.equal(inputUtxo.outputIndex)
            expect(input.script.length).to.be.greaterThan(0)
            expect(input.witness.length).to.be.equal(0)
          })
        })

        context("when input UTXO has an unsupported script", () => {
          it("should throw an explicit unsupported script error", async () => {
            const inputUtxo = createTestnetP2SHUtxo()
            bitcoinClient.rawTransactions = new Map<string, BitcoinRawTx>([
              [
                inputUtxo.transactionHash.toString(),
                { transactionHex: inputUtxo.transactionHex },
              ],
            ])

            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(depositFixture.receipt, true)
            )

            await expect(
              depositFunding.submitTransaction(
                depositAmount,
                [inputUtxo],
                BigNumber.from(1520),
                testnetPrivateKey,
                bitcoinClient
              )
            ).to.be.rejectedWith(
              "Unsupported UTXO script type; only P2PKH and P2WPKH inputs are supported"
            )
          })
        })

        context("when witness option is false", () => {
          let transactionHash: BitcoinTxHash
          let depositUtxo: BitcoinUtxo

          beforeEach(async () => {
            const fee = BigNumber.from(1410)

            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(depositFixture.receipt, false)
            )

            ;({ transactionHash, depositUtxo } =
              await depositFunding.submitTransaction(
                depositAmount,
                [testnetUTXO],
                fee,
                testnetPrivateKey,
                bitcoinClient
              ))
          })

          it("should broadcast P2SH transaction with proper structure", async () => {
            expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
            expect(bitcoinClient.broadcastLog[0]).to.be.eql(
              depositFixture.expectedP2SHData.transaction
            )
          })

          it("should return the proper transaction hash", async () => {
            expect(transactionHash).to.be.deep.equal(
              depositFixture.expectedP2SHData.transactionHash
            )
          })

          it("should return the proper deposit UTXO", () => {
            const expectedDepositUtxo = {
              transactionHash: depositFixture.expectedP2SHData.transactionHash,
              outputIndex: 0,
              value: depositAmount,
            }

            expect(depositUtxo).to.be.eql(expectedDepositUtxo)
          })
        })
      })

      context("when deposit has optional extra data", () => {
        context("when witness option is true", () => {
          let transactionHash: BitcoinTxHash
          let depositUtxo: BitcoinUtxo

          beforeEach(async () => {
            const fee = BigNumber.from(1520)

            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(
                depositWithExtraDataFixture.receipt,
                true
              )
            )

            ;({ transactionHash, depositUtxo } =
              await depositFunding.submitTransaction(
                depositAmount,
                [testnetUTXO],
                fee,
                testnetPrivateKey,
                bitcoinClient
              ))
          })

          it("should broadcast P2WSH transaction with proper structure", async () => {
            expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
            expect(bitcoinClient.broadcastLog[0]).to.be.eql(
              depositWithExtraDataFixture.expectedP2WSHData.transaction
            )
          })

          it("should return the proper transaction hash", async () => {
            expect(transactionHash).to.be.deep.equal(
              depositWithExtraDataFixture.expectedP2WSHData.transactionHash
            )
          })

          it("should return the proper deposit UTXO", () => {
            const expectedDepositUtxo = {
              transactionHash:
                depositWithExtraDataFixture.expectedP2WSHData.transactionHash,
              outputIndex: 0,
              value: depositAmount,
            }

            expect(depositUtxo).to.be.eql(expectedDepositUtxo)
          })
        })

        context("when witness option is false", () => {
          let transactionHash: BitcoinTxHash
          let depositUtxo: BitcoinUtxo

          beforeEach(async () => {
            const fee = BigNumber.from(1410)

            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(
                depositWithExtraDataFixture.receipt,
                false
              )
            )

            ;({ transactionHash, depositUtxo } =
              await depositFunding.submitTransaction(
                depositAmount,
                [testnetUTXO],
                fee,
                testnetPrivateKey,
                bitcoinClient
              ))
          })

          it("should broadcast P2SH transaction with proper structure", async () => {
            expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
            expect(bitcoinClient.broadcastLog[0]).to.be.eql(
              depositWithExtraDataFixture.expectedP2SHData.transaction
            )
          })

          it("should return the proper transaction hash", async () => {
            expect(transactionHash).to.be.deep.equal(
              depositWithExtraDataFixture.expectedP2SHData.transactionHash
            )
          })

          it("should return the proper deposit UTXO", () => {
            const expectedDepositUtxo = {
              transactionHash:
                depositWithExtraDataFixture.expectedP2SHData.transactionHash,
              outputIndex: 0,
              value: depositAmount,
            }

            expect(depositUtxo).to.be.eql(expectedDepositUtxo)
          })
        })
      })
    })

    describe("assembleTransaction", () => {
      context("when deposit does not have optional extra data", () => {
        context("when witness option is true", () => {
          let transactionHash: BitcoinTxHash
          let depositUtxo: BitcoinUtxo
          let transaction: BitcoinRawTx

          beforeEach(async () => {
            const fee = BigNumber.from(1520)

            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(depositFixture.receipt, true)
            )

            ;({
              transactionHash,
              depositUtxo,
              rawTransaction: transaction,
            } = await depositFunding.assembleTransaction(
              BitcoinNetwork.Testnet,
              depositAmount,
              [testnetUTXO],
              fee,
              testnetPrivateKey
            ))
          })

          it("should return P2WSH transaction with proper structure", async () => {
            // Compare HEXes.
            expect(transaction).to.be.eql(
              depositFixture.expectedP2WSHData.transaction
            )

            // Convert raw transaction to JSON to make detailed comparison.
            const txJSON = txToJSON(
              transaction.transactionHex,
              BitcoinNetwork.Testnet
            )

            expect(txJSON.hash).to.be.equal(
              depositFixture.expectedP2WSHData.transactionHash.toString()
            )
            expect(txJSON.version).to.be.equal(1)

            // Validate inputs.
            expect(txJSON.inputs.length).to.be.equal(1)

            const input = txJSON.inputs[0]

            expect(input.hash).to.be.equal(
              testnetUTXO.transactionHash.toString()
            )
            expect(input.index).to.be.equal(testnetUTXO.outputIndex)
            // Transaction should be signed but this is SegWit input so the `script`
            // field should be empty and the `witness` field should be filled instead.
            expect(input.script.length).to.be.equal(0)
            expect(input.witness.length).to.be.greaterThan(0)

            // Validate outputs.
            expect(txJSON.outputs.length).to.be.equal(2)

            const depositOutput = txJSON.outputs[0]
            const changeOutput = txJSON.outputs[1]

            // Value should correspond to the deposit amount.
            expect(depositOutput.value).to.be.equal(depositAmount.toNumber())
            // Should be OP_0 <script-hash>. The script hash should be prefixed
            // with its byte length: 0x20. The OP_0 opcode is 0x00.
            expect(depositOutput.script).to.be.equal(
              `0020${depositFixture.expectedP2WSHData.scriptHash}`
            )
            expect(depositOutput.address).to.be.equal(
              depositFixture.expectedP2WSHData.testnetAddress
            )

            // Change value should be equal to: inputValue - depositAmount - fee.
            expect(changeOutput.value).to.be.equal(3921680)
            // Should be OP_0 <public-key-hash>. Public key corresponds to
            // depositor BTC address.
            expect(changeOutput.script).to.be.equal(
              "00147ac2d9378a1c47e589dfb8095ca95ed2140d2726"
            )
            // Should return the change to depositor BTC address.
            expect(changeOutput.address).to.be.equal(testnetAddress)
          })

          it("should return the proper transaction hash", async () => {
            expect(transactionHash).to.be.deep.equal(
              depositFixture.expectedP2WSHData.transactionHash
            )
          })

          it("should return the proper deposit UTXO", () => {
            const expectedDepositUtxo = {
              transactionHash: depositFixture.expectedP2WSHData.transactionHash,
              outputIndex: 0,
              value: depositAmount,
            }

            expect(depositUtxo).to.be.eql(expectedDepositUtxo)
          })
        })

        context("when witness option is false", () => {
          let transactionHash: BitcoinTxHash
          let depositUtxo: BitcoinUtxo
          let transaction: BitcoinRawTx

          beforeEach(async () => {
            const fee = BigNumber.from(1410)

            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(depositFixture.receipt, false)
            )

            ;({
              transactionHash,
              depositUtxo,
              rawTransaction: transaction,
            } = await depositFunding.assembleTransaction(
              BitcoinNetwork.Testnet,
              depositAmount,
              [testnetUTXO],
              fee,
              testnetPrivateKey
            ))
          })

          it("should return P2SH transaction with proper structure", async () => {
            // Compare HEXes.
            expect(transaction).to.be.eql(
              depositFixture.expectedP2SHData.transaction
            )

            // Convert raw transaction to JSON to make detailed comparison.
            const txJSON = txToJSON(
              transaction.transactionHex,
              BitcoinNetwork.Testnet
            )

            expect(txJSON.hash).to.be.equal(
              depositFixture.expectedP2SHData.transactionHash.toString()
            )
            expect(txJSON.version).to.be.equal(1)

            // Validate inputs.
            expect(txJSON.inputs.length).to.be.equal(1)

            const input = txJSON.inputs[0]

            expect(input.hash).to.be.equal(
              testnetUTXO.transactionHash.toString()
            )
            expect(input.index).to.be.equal(testnetUTXO.outputIndex)
            // Transaction should be signed but this is SegWit input so the `script`
            // field should be empty and the `witness` field should be filled instead.
            expect(input.script.length).to.be.equal(0)
            expect(input.witness.length).to.be.greaterThan(0)

            // Validate outputs.
            expect(txJSON.outputs.length).to.be.equal(2)

            const depositOutput = txJSON.outputs[0]
            const changeOutput = txJSON.outputs[1]

            // Value should correspond to the deposit amount.
            expect(depositOutput.value).to.be.equal(depositAmount.toNumber())
            // Should be OP_HASH160 <script-hash> OP_EQUAL. The script hash
            // should be prefixed with its byte length: 0x14. The OP_HASH160
            // opcode is 0xa9 and OP_EQUAL is 0x87.
            expect(depositOutput.script).to.be.equal(
              `a914${depositFixture.expectedP2SHData.scriptHash}87`
            )
            expect(depositOutput.address).to.be.equal(
              depositFixture.expectedP2SHData.testnetAddress
            )

            // Change value should be equal to: inputValue - depositAmount - fee.
            expect(changeOutput.value).to.be.equal(3921790)
            // Should be OP_0 <public-key-hash>. Public key corresponds to
            // depositor BTC address.
            expect(changeOutput.script).to.be.equal(
              "00147ac2d9378a1c47e589dfb8095ca95ed2140d2726"
            )
            // Should return the change to depositor BTC address.
            expect(changeOutput.address).to.be.equal(testnetAddress)
          })

          it("should return the proper transaction hash", async () => {
            expect(transactionHash).to.be.deep.equal(
              depositFixture.expectedP2SHData.transactionHash
            )
          })

          it("should return the proper deposit UTXO", () => {
            const expectedDepositUtxo = {
              transactionHash: depositFixture.expectedP2SHData.transactionHash,
              outputIndex: 0,
              value: depositAmount,
            }

            expect(depositUtxo).to.be.deep.equal(expectedDepositUtxo)
          })
        })

        context("when script type is P2TR", () => {
          let transaction: BitcoinRawTx

          beforeEach(async () => {
            const fee = BigNumber.from(1520)

            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(
                taprootDepositFixture.receipt,
                DepositScriptType.P2TR
              )
            )

            ;({ rawTransaction: transaction } =
              await depositFunding.assembleTransaction(
                BitcoinNetwork.Testnet,
                depositAmount,
                [testnetUTXO],
                fee,
                testnetPrivateKey
              ))
          })

          it("should return transaction with P2TR deposit output", async () => {
            const fundingTransaction = Transaction.fromHex(
              transaction.transactionHex
            )
            const depositOutput = fundingTransaction.outs[0]

            expect(depositOutput.value).to.be.equal(depositAmount.toNumber())
            expect(depositOutput.script.toString("hex")).to.be.equal(
              `5120${taprootDepositFixture.expectedP2TRData.outputKey}`
            )
            expect(
              BitcoinAddressConverter.outputScriptToAddress(
                Hex.from(depositOutput.script),
                BitcoinNetwork.Testnet
              )
            ).to.be.equal(taprootDepositFixture.expectedP2TRData.testnetAddress)
          })
        })
      })

      context("when deposit has optional extra data", () => {
        context("when witness option is true", () => {
          let transactionHash: BitcoinTxHash
          let depositUtxo: BitcoinUtxo
          let transaction: BitcoinRawTx

          beforeEach(async () => {
            const fee = BigNumber.from(1520)

            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(
                depositWithExtraDataFixture.receipt,
                true
              )
            )

            ;({
              transactionHash,
              depositUtxo,
              rawTransaction: transaction,
            } = await depositFunding.assembleTransaction(
              BitcoinNetwork.Testnet,
              depositAmount,
              [testnetUTXO],
              fee,
              testnetPrivateKey
            ))
          })

          it("should return P2WSH transaction with proper structure", async () => {
            // Compare HEXes.
            expect(transaction).to.be.eql(
              depositWithExtraDataFixture.expectedP2WSHData.transaction
            )

            // Convert raw transaction to JSON to make detailed comparison.
            const txJSON = txToJSON(
              transaction.transactionHex,
              BitcoinNetwork.Testnet
            )

            expect(txJSON.hash).to.be.equal(
              depositWithExtraDataFixture.expectedP2WSHData.transactionHash.toString()
            )
            expect(txJSON.version).to.be.equal(1)

            // Validate inputs.
            expect(txJSON.inputs.length).to.be.equal(1)

            const input = txJSON.inputs[0]

            expect(input.hash).to.be.equal(
              testnetUTXO.transactionHash.toString()
            )
            expect(input.index).to.be.equal(testnetUTXO.outputIndex)
            // Transaction should be signed but this is SegWit input so the `script`
            // field should be empty and the `witness` field should be filled instead.
            expect(input.script.length).to.be.equal(0)
            expect(input.witness.length).to.be.greaterThan(0)

            // Validate outputs.
            expect(txJSON.outputs.length).to.be.equal(2)

            const depositOutput = txJSON.outputs[0]
            const changeOutput = txJSON.outputs[1]

            // Value should correspond to the deposit amount.
            expect(depositOutput.value).to.be.equal(depositAmount.toNumber())
            // Should be OP_0 <script-hash>. The script hash should be prefixed
            // with its byte length: 0x20. The OP_0 opcode is 0x00.
            expect(depositOutput.script).to.be.equal(
              `0020${depositWithExtraDataFixture.expectedP2WSHData.scriptHash}`
            )
            expect(depositOutput.address).to.be.equal(
              depositWithExtraDataFixture.expectedP2WSHData.testnetAddress
            )

            // Change value should be equal to: inputValue - depositAmount - fee.
            expect(changeOutput.value).to.be.equal(3921680)
            // Should be OP_0 <public-key-hash>. Public key corresponds to
            // depositor BTC address.
            expect(changeOutput.script).to.be.equal(
              "00147ac2d9378a1c47e589dfb8095ca95ed2140d2726"
            )
            // Should return the change to depositor BTC address.
            expect(changeOutput.address).to.be.equal(testnetAddress)
          })

          it("should return the proper transaction hash", async () => {
            expect(transactionHash).to.be.deep.equal(
              depositWithExtraDataFixture.expectedP2WSHData.transactionHash
            )
          })

          it("should return the proper deposit UTXO", () => {
            const expectedDepositUtxo = {
              transactionHash:
                depositWithExtraDataFixture.expectedP2WSHData.transactionHash,
              outputIndex: 0,
              value: depositAmount,
            }

            expect(depositUtxo).to.be.eql(expectedDepositUtxo)
          })
        })

        context("when witness option is false", () => {
          let transactionHash: BitcoinTxHash
          let depositUtxo: BitcoinUtxo
          let transaction: BitcoinRawTx

          beforeEach(async () => {
            const fee = BigNumber.from(1410)

            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(
                depositWithExtraDataFixture.receipt,
                false
              )
            )

            ;({
              transactionHash,
              depositUtxo,
              rawTransaction: transaction,
            } = await depositFunding.assembleTransaction(
              BitcoinNetwork.Testnet,
              depositAmount,
              [testnetUTXO],
              fee,
              testnetPrivateKey
            ))
          })

          it("should return P2SH transaction with proper structure", async () => {
            // Compare HEXes.
            expect(transaction).to.be.eql(
              depositWithExtraDataFixture.expectedP2SHData.transaction
            )

            // Convert raw transaction to JSON to make detailed comparison.
            const txJSON = txToJSON(
              transaction.transactionHex,
              BitcoinNetwork.Testnet
            )

            expect(txJSON.hash).to.be.equal(
              depositWithExtraDataFixture.expectedP2SHData.transactionHash.toString()
            )
            expect(txJSON.version).to.be.equal(1)

            // Validate inputs.
            expect(txJSON.inputs.length).to.be.equal(1)

            const input = txJSON.inputs[0]

            expect(input.hash).to.be.equal(
              testnetUTXO.transactionHash.toString()
            )
            expect(input.index).to.be.equal(testnetUTXO.outputIndex)
            // Transaction should be signed but this is SegWit input so the `script`
            // field should be empty and the `witness` field should be filled instead.
            expect(input.script.length).to.be.equal(0)
            expect(input.witness.length).to.be.greaterThan(0)

            // Validate outputs.
            expect(txJSON.outputs.length).to.be.equal(2)

            const depositOutput = txJSON.outputs[0]
            const changeOutput = txJSON.outputs[1]

            // Value should correspond to the deposit amount.
            expect(depositOutput.value).to.be.equal(depositAmount.toNumber())
            // Should be OP_HASH160 <script-hash> OP_EQUAL. The script hash
            // should be prefixed with its byte length: 0x14. The OP_HASH160
            // opcode is 0xa9 and OP_EQUAL is 0x87.
            expect(depositOutput.script).to.be.equal(
              `a914${depositWithExtraDataFixture.expectedP2SHData.scriptHash}87`
            )
            expect(depositOutput.address).to.be.equal(
              depositWithExtraDataFixture.expectedP2SHData.testnetAddress
            )

            // Change value should be equal to: inputValue - depositAmount - fee.
            expect(changeOutput.value).to.be.equal(3921790)
            // Should be OP_0 <public-key-hash>. Public key corresponds to
            // depositor BTC address.
            expect(changeOutput.script).to.be.equal(
              "00147ac2d9378a1c47e589dfb8095ca95ed2140d2726"
            )
            // Should return the change to depositor BTC address.
            expect(changeOutput.address).to.be.equal(testnetAddress)
          })

          it("should return the proper transaction hash", async () => {
            expect(transactionHash).to.be.deep.equal(
              depositWithExtraDataFixture.expectedP2SHData.transactionHash
            )
          })

          it("should return the proper deposit UTXO", () => {
            const expectedDepositUtxo = {
              transactionHash:
                depositWithExtraDataFixture.expectedP2SHData.transactionHash,
              outputIndex: 0,
              value: depositAmount,
            }

            expect(depositUtxo).to.be.deep.equal(expectedDepositUtxo)
          })
        })
      })
    })
  })

  describe("DepositScript", () => {
    describe("getPlainText", () => {
      let script: Hex

      context("when deposit does not have optional extra data", () => {
        beforeEach(async () => {
          script = await DepositScript.fromReceipt(
            depositFixture.receipt
          ).getPlainText()
        })

        it("should return script with proper structure", async () => {
          assertValidDepositScript(script.toString(), depositFixture)
        })
      })

      context("when deposit has optional extra data", () => {
        beforeEach(async () => {
          script = await DepositScript.fromReceipt(
            depositWithExtraDataFixture.receipt
          ).getPlainText()
        })

        it("should return script with proper structure", async () => {
          assertValidDepositScript(
            script.toString(),
            depositWithExtraDataFixture
          )
        })
      })

      context("when deposit is Taproot-native", () => {
        beforeEach(async () => {
          script = await DepositScript.fromReceipt(
            taprootDepositFixture.receipt,
            DepositScriptType.P2TR
          ).getPlainText()
        })

        it("should return refund tapscript with proper structure", async () => {
          expect(script.toString()).to.be.equal(
            taprootDepositFixture.expectedRefundScript
          )
        })
      })

      context("when Taproot-native deposit has optional extra data", () => {
        beforeEach(async () => {
          script = await DepositScript.fromReceipt(
            taprootDepositWithExtraDataFixture.receipt,
            DepositScriptType.P2TR
          ).getPlainText()
        })

        it("should return refund tapscript with proper structure", async () => {
          expect(script.toString()).to.be.equal(
            taprootDepositWithExtraDataFixture.expectedRefundScript
          )
        })
      })
    })

    describe("getHash", () => {
      context("when deposit does not have optional extra data", () => {
        context("when witness option is true", () => {
          let scriptHash: Buffer

          beforeEach(async () => {
            scriptHash = await DepositScript.fromReceipt(
              depositFixture.receipt,
              true
            ).getHash()
          })

          it("should return proper witness script hash", async () => {
            // The plain-text script is in the expectedScript property of the fixture.
            // The hash of this script should correspond to the OP_SHA256 opcode
            // which applies SHA-256 on the input. The hash can be verified with
            // the following command:
            // echo -n $SCRIPT | xxd -r -p | openssl dgst -sha256
            expect(scriptHash.toString("hex")).to.be.equal(
              depositFixture.expectedP2WSHData.scriptHash
            )
          })
        })

        context("when witness option is false", () => {
          let scriptHash: Buffer

          beforeEach(async () => {
            scriptHash = await DepositScript.fromReceipt(
              depositFixture.receipt,
              false
            ).getHash()
          })

          it("should return proper non-witness script hash", async () => {
            // The plain-text script is in the expectedScript property of the fixture.
            // The hash of this script should correspond to the OP_HASH160 opcode
            // which applies SHA-256 and then RIPEMD-160 on the input. The hash
            // can be verified with the following command:
            // echo -n $SCRIPT | xxd -r -p | openssl dgst -sha256 -binary | openssl dgst -rmd160
            expect(scriptHash.toString("hex")).to.be.equal(
              depositFixture.expectedP2SHData.scriptHash
            )
          })
        })
      })

      context("when deposit has optional extra data", () => {
        context("when witness option is true", () => {
          let scriptHash: Buffer

          beforeEach(async () => {
            scriptHash = await DepositScript.fromReceipt(
              depositWithExtraDataFixture.receipt,
              true
            ).getHash()
          })

          it("should return proper witness script hash", async () => {
            // The plain-text script is in the expectedScript property of the fixture.
            // The hash of this script should correspond to the OP_SHA256 opcode
            // which applies SHA-256 on the input. The hash can be verified with
            // the following command:
            // echo -n $SCRIPT | xxd -r -p | openssl dgst -sha256
            expect(scriptHash.toString("hex")).to.be.equal(
              depositWithExtraDataFixture.expectedP2WSHData.scriptHash
            )
          })
        })

        context("when witness option is false", () => {
          let scriptHash: Buffer

          beforeEach(async () => {
            scriptHash = await DepositScript.fromReceipt(
              depositWithExtraDataFixture.receipt,
              false
            ).getHash()
          })

          it("should return proper non-witness script hash", async () => {
            // The plain-text script is in the expectedScript property of the fixture.
            // The hash of this script should correspond to the OP_HASH160 opcode
            // which applies SHA-256 and then RIPEMD-160 on the input. The hash
            // can be verified with the following command:
            // echo -n $SCRIPT | xxd -r -p | openssl dgst -sha256 -binary | openssl dgst -rmd160
            expect(scriptHash.toString("hex")).to.be.equal(
              depositWithExtraDataFixture.expectedP2SHData.scriptHash
            )
          })
        })
      })

      context("when deposit is Taproot-native", () => {
        let scriptHash: Buffer

        beforeEach(async () => {
          scriptHash = await DepositScript.fromReceipt(
            taprootDepositFixture.receipt,
            DepositScriptType.P2TR
          ).getHash()
        })

        it("should return proper TapLeaf hash", async () => {
          expect(scriptHash.toString("hex")).to.be.equal(
            taprootDepositFixture.expectedP2TRData.leafHash
          )
        })
      })
    })

    describe("getTaprootOutputKey", () => {
      it("should return proper Taproot output key", async () => {
        const outputKey = await DepositScript.fromReceipt(
          taprootDepositFixture.receipt,
          DepositScriptType.P2TR
        ).getTaprootOutputKey()

        expect(outputKey.toString()).to.be.equal(
          taprootDepositFixture.expectedP2TRData.outputKey
        )
      })

      it("should return proper Taproot output key when extra data is present", async () => {
        const outputKey = await DepositScript.fromReceipt(
          taprootDepositWithExtraDataFixture.receipt,
          DepositScriptType.P2TR
        ).getTaprootOutputKey()

        expect(outputKey.toString()).to.be.equal(
          taprootDepositWithExtraDataFixture.expectedP2TRData.outputKey
        )
      })
    })

    describe("deriveAddress", () => {
      let address: string

      context("when deposit does not have optional extra data", () => {
        context("when network is mainnet", () => {
          context("when witness option is true", () => {
            beforeEach(async () => {
              address = await DepositScript.fromReceipt(
                depositFixture.receipt,
                true
              ).deriveAddress(BitcoinNetwork.Mainnet)
            })

            it("should return proper address with prefix bc1", async () => {
              // Address is created using the script hash held by the
              // expectedP2WSHData.scriptHash property of the fixture.
              // According to https://en.bitcoin.it/wiki/List_of_address_prefixes,
              // the P2WSH (Bech32) address prefix for mainnet is bc1.
              expect(address).to.be.equal(
                depositFixture.expectedP2WSHData.mainnetAddress
              )
            })
          })

          context("when witness option is false", () => {
            beforeEach(async () => {
              address = await DepositScript.fromReceipt(
                depositFixture.receipt,
                false
              ).deriveAddress(BitcoinNetwork.Mainnet)
            })

            it("should return proper address with prefix 3", async () => {
              // Address is created using the script hash held by the
              // expectedP2SHData.scriptHash property of the fixture.
              // According to https://en.bitcoin.it/wiki/List_of_address_prefixes,
              // the P2SH address prefix for mainnet is 3.
              expect(address).to.be.equal(
                depositFixture.expectedP2SHData.mainnetAddress
              )
            })
          })
        })

        context("when network is testnet", () => {
          context("when witness option is true", () => {
            beforeEach(async () => {
              address = await DepositScript.fromReceipt(
                depositFixture.receipt,
                true
              ).deriveAddress(BitcoinNetwork.Testnet)
            })

            it("should return proper address with prefix tb1", async () => {
              // Address is created using the script hash held by the
              // expectedP2WSHData.scriptHash property of the fixture.
              // According to https://en.bitcoin.it/wiki/List_of_address_prefixes,
              // the P2WSH (Bech32) address prefix for testnet is tb1.
              expect(address).to.be.equal(
                depositFixture.expectedP2WSHData.testnetAddress
              )
            })
          })

          context("when witness option is false", () => {
            beforeEach(async () => {
              address = await DepositScript.fromReceipt(
                depositFixture.receipt,
                false
              ).deriveAddress(BitcoinNetwork.Testnet)
            })

            it("should return proper address with prefix 2", async () => {
              // Address is created using the script hash held by the
              // expectedP2SHData.scriptHash property of the fixture.
              // According to https://en.bitcoin.it/wiki/List_of_address_prefixes,
              // the P2SH address prefix for testnet is 2.
              expect(address).to.be.equal(
                depositFixture.expectedP2SHData.testnetAddress
              )
            })
          })
        })
      })

      context("when deposit has optional extra data", () => {
        context("when network is mainnet", () => {
          context("when witness option is true", () => {
            beforeEach(async () => {
              address = await DepositScript.fromReceipt(
                depositWithExtraDataFixture.receipt,
                true
              ).deriveAddress(BitcoinNetwork.Mainnet)
            })

            it("should return proper address with prefix bc1", async () => {
              // Address is created using the script hash held by the
              // expectedP2WSHData.scriptHash property of the fixture.
              // According to https://en.bitcoin.it/wiki/List_of_address_prefixes,
              // the P2WSH (Bech32) address prefix for mainnet is bc1.
              expect(address).to.be.equal(
                depositWithExtraDataFixture.expectedP2WSHData.mainnetAddress
              )
            })
          })

          context("when witness option is false", () => {
            beforeEach(async () => {
              address = await DepositScript.fromReceipt(
                depositWithExtraDataFixture.receipt,
                false
              ).deriveAddress(BitcoinNetwork.Mainnet)
            })

            it("should return proper address with prefix 3", async () => {
              // Address is created using the script hash held by the
              // expectedP2SHData.scriptHash property of the fixture.
              // According to https://en.bitcoin.it/wiki/List_of_address_prefixes,
              // the P2SH address prefix for mainnet is 3.
              expect(address).to.be.equal(
                depositWithExtraDataFixture.expectedP2SHData.mainnetAddress
              )
            })
          })
        })

        context("when network is testnet", () => {
          context("when witness option is true", () => {
            beforeEach(async () => {
              address = await DepositScript.fromReceipt(
                depositWithExtraDataFixture.receipt,
                true
              ).deriveAddress(BitcoinNetwork.Testnet)
            })

            it("should return proper address with prefix tb1", async () => {
              // Address is created using the script hash held by the
              // expectedP2WSHData.scriptHash property of the fixture.
              // According to https://en.bitcoin.it/wiki/List_of_address_prefixes,
              // the P2WSH (Bech32) address prefix for testnet is tb1.
              expect(address).to.be.equal(
                depositWithExtraDataFixture.expectedP2WSHData.testnetAddress
              )
            })
          })

          context("when witness option is false", () => {
            beforeEach(async () => {
              address = await DepositScript.fromReceipt(
                depositWithExtraDataFixture.receipt,
                false
              ).deriveAddress(BitcoinNetwork.Testnet)
            })

            it("should return proper address with prefix 2", async () => {
              // Address is created using the script hash held by the
              // expectedP2SHData.scriptHash property of the fixture.
              // According to https://en.bitcoin.it/wiki/List_of_address_prefixes,
              // the P2SH address prefix for testnet is 2.
              expect(address).to.be.equal(
                depositWithExtraDataFixture.expectedP2SHData.testnetAddress
              )
            })
          })
        })
      })

      context("when deposit is Taproot-native", () => {
        context("when network is mainnet", () => {
          beforeEach(async () => {
            address = await DepositScript.fromReceipt(
              taprootDepositFixture.receipt,
              DepositScriptType.P2TR
            ).deriveAddress(BitcoinNetwork.Mainnet)
          })

          it("should return proper P2TR address", async () => {
            expect(address).to.be.equal(
              taprootDepositFixture.expectedP2TRData.mainnetAddress
            )
          })
        })

        context("when network is testnet", () => {
          beforeEach(async () => {
            address = await DepositScript.fromReceipt(
              taprootDepositFixture.receipt,
              DepositScriptType.P2TR
            ).deriveAddress(BitcoinNetwork.Testnet)
          })

          it("should return proper P2TR address", async () => {
            expect(address).to.be.equal(
              taprootDepositFixture.expectedP2TRData.testnetAddress
            )
          })
        })
      })

      context("when Taproot-native deposit has optional extra data", () => {
        beforeEach(async () => {
          address = await DepositScript.fromReceipt(
            taprootDepositWithExtraDataFixture.receipt,
            DepositScriptType.P2TR
          ).deriveAddress(BitcoinNetwork.Testnet)
        })

        it("should return proper P2TR address", async () => {
          expect(address).to.be.equal(
            taprootDepositWithExtraDataFixture.expectedP2TRData.testnetAddress
          )
        })
      })
    })
  })

  describe("Deposit", () => {
    describe("getBitcoinAddress", () => {
      const testData = [
        {
          fixture: depositFixture,
          network: BitcoinNetwork.Mainnet,
        },
        {
          fixture: depositFixture,
          network: BitcoinNetwork.Testnet,
        },
        {
          fixture: depositWithExtraDataFixture,
          network: BitcoinNetwork.Mainnet,
        },
        {
          fixture: depositWithExtraDataFixture,
          network: BitcoinNetwork.Testnet,
        },
      ]

      let bitcoinAddress: string

      testData.forEach(({ fixture, network }) => {
        context(`when network is ${network}`, () => {
          beforeEach(async () => {
            const bitcoinClient = new MockBitcoinClient()
            bitcoinClient.network = network
            const tbtcContracts = new MockTBTCContracts()

            const deposit = await Deposit.fromReceipt(
              fixture.receipt,
              tbtcContracts,
              bitcoinClient
            )

            bitcoinAddress = await deposit.getBitcoinAddress()
          })

          it("should return correct address", () => {
            const { mainnetAddress, testnetAddress } = fixture.expectedP2WSHData

            let expectedAddress
            switch (network) {
              case BitcoinNetwork.Mainnet:
                expectedAddress = mainnetAddress
                break
              case BitcoinNetwork.Testnet:
                expectedAddress = testnetAddress
                break
            }

            expect(bitcoinAddress).to.be.equal(expectedAddress)
          })
        })
      })
    })

    describe("detectFunding", () => {
      let bitcoinClient: MockBitcoinClient
      let tbtcContracts: MockTBTCContracts
      let deposit: Deposit
      let utxos: BitcoinUtxo[]

      beforeEach(async () => {
        bitcoinClient = new MockBitcoinClient()
        tbtcContracts = new MockTBTCContracts()

        deposit = await Deposit.fromReceipt(
          depositFixture.receipt,
          tbtcContracts,
          bitcoinClient
        )
      })

      context("when there are no UTXOs from funding transactions", () => {
        context("when Bitcoin client returns undefined", () => {
          beforeEach(async () => {
            // Do not set any value for the address stored in the deposit
            // service so that undefined is returned.
            utxos = await deposit.detectFunding()
          })

          it("should return an empty UTXO array", async () => {
            expect(utxos).to.be.empty
          })
        })

        context("when Bitcoin client returns an empty array", () => {
          beforeEach(async () => {
            const unspentTransactionOutputs = new Map<string, BitcoinUtxo[]>()
            // Set an empty array for the address stored in the deposit service.
            unspentTransactionOutputs.set(await deposit.getBitcoinAddress(), [])
            bitcoinClient.unspentTransactionOutputs = unspentTransactionOutputs
            utxos = await deposit.detectFunding()
          })

          it("should return an empty UTXO array", async () => {
            expect(utxos).to.be.empty
          })
        })
      })

      context("when there are UTXOs from funding transactions", () => {
        const fundingUtxos: BitcoinUtxo[] = [
          {
            transactionHash: BitcoinTxHash.from(
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            ),
            outputIndex: 0,
            value: BigNumber.from(1111),
          },
          {
            transactionHash: BitcoinTxHash.from(
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            ),
            outputIndex: 1,
            value: BigNumber.from(2222),
          },
        ]

        beforeEach(async () => {
          const unspentTransactionOutputs = new Map<string, BitcoinUtxo[]>()
          unspentTransactionOutputs.set(
            await deposit.getBitcoinAddress(),
            fundingUtxos
          )
          bitcoinClient.unspentTransactionOutputs = unspentTransactionOutputs
          utxos = await deposit.detectFunding()
        })

        it("should return funding UTXOs stored in the blockchain", async () => {
          expect(utxos).to.be.equal(fundingUtxos)
        })
      })
    })

    describe("initiateMinting", () => {
      context("auto funding outpoint detection mode", () => {
        context("when no funding UTXOs found", () => {
          let deposit: Deposit

          beforeEach(async () => {
            const tbtcContracts = new MockTBTCContracts()
            const bitcoinClient = new MockBitcoinClient()

            deposit = await Deposit.fromReceipt(
              depositFixture.receipt,
              tbtcContracts,
              bitcoinClient
            )
          })

          it("should throw", async () => {
            await expect(deposit.initiateMinting()).to.be.rejectedWith(
              "Deposit not funded"
            )
          })
        })

        context("when funding UTXOs found", () => {
          const initiateMinting = async (depositorProxy?: DepositorProxy) => {
            const fee = BigNumber.from(1520)
            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(depositFixture.receipt)
            )
            // Create a deposit transaction.
            const result = await depositFunding.assembleTransaction(
              BitcoinNetwork.Testnet,
              depositAmount,
              [testnetUTXO],
              fee,
              testnetPrivateKey
            )
            const transaction: BitcoinRawTx = result.rawTransaction
            const depositUtxo: BitcoinUtxo = result.depositUtxo

            // Initialize the mock Bridge and TBTC contracts.
            const bitcoinClient: MockBitcoinClient = new MockBitcoinClient()
            const tbtcContracts: MockTBTCContracts = new MockTBTCContracts()

            // Create the deposit.
            const deposit = await Deposit.fromReceipt(
              depositFixture.receipt,
              tbtcContracts,
              bitcoinClient,
              depositorProxy
            )

            // Initialize the mock Bitcoin client to return the given deposit
            // UTXO for the depositor address.
            const unspentTransactionOutputs = new Map<string, BitcoinUtxo[]>()
            unspentTransactionOutputs.set(await deposit.getBitcoinAddress(), [
              depositUtxo,
            ])
            bitcoinClient.unspentTransactionOutputs = unspentTransactionOutputs

            // Initialize the mock Bitcoin client to return the raw transaction
            // data for the given deposit UTXO.
            const rawTransactions = new Map<string, BitcoinRawTx>()
            rawTransactions.set(
              depositUtxo.transactionHash.toString(),
              transaction
            )
            bitcoinClient.rawTransactions = rawTransactions

            await deposit.initiateMinting()

            return {
              transaction,
              tbtcContracts,
            }
          }

          context("when deposit does not use a depositor proxy", () => {
            let transaction: BitcoinRawTx
            let tbtcContracts: MockTBTCContracts

            beforeEach(async () => {
              ;({ transaction, tbtcContracts } = await initiateMinting())
            })

            it("should reveal the deposit to the Bridge", () => {
              expect(tbtcContracts.bridge.revealDepositLog.length).to.be.equal(
                1
              )
              const revealDepositLogEntry =
                tbtcContracts.bridge.revealDepositLog[0]
              expect(revealDepositLogEntry.depositTx).to.be.eql(
                extractBitcoinRawTxVectors(transaction)
              )
              expect(revealDepositLogEntry.depositOutputIndex).to.be.equal(0)
              expect(revealDepositLogEntry.deposit).to.be.eql(
                depositFixture.receipt
              )
            })
          })

          context("when deposit uses a depositor proxy", () => {
            let transaction: BitcoinRawTx
            let tbtcContracts: MockTBTCContracts
            let depositorProxy: MockDepositorProxy

            beforeEach(async () => {
              depositorProxy = new MockDepositorProxy()
              ;({ transaction, tbtcContracts } = await initiateMinting(
                depositorProxy
              ))
            })

            it("should not reveal the deposit to the Bridge", () => {
              expect(tbtcContracts.bridge.revealDepositLog.length).to.be.equal(
                0
              )
            })

            it("should reveal the deposit to the DepositorProxy", () => {
              expect(depositorProxy.revealDepositLog.length).to.be.equal(1)
              const revealDepositLogEntry = depositorProxy.revealDepositLog[0]
              expect(revealDepositLogEntry.depositTx).to.be.eql(
                extractBitcoinRawTxVectors(transaction)
              )
              expect(revealDepositLogEntry.depositOutputIndex).to.be.equal(0)
              expect(revealDepositLogEntry.deposit).to.be.eql(
                depositFixture.receipt
              )
            })
          })
        })
      })

      context("manual funding outpoint provision mode", () => {
        const initiateMinting = async (depositorProxy?: DepositorProxy) => {
          const fee = BigNumber.from(1520)

          const depositFunding = DepositFunding.fromScript(
            DepositScript.fromReceipt(depositFixture.receipt)
          )

          // Create a deposit transaction.
          const result = await depositFunding.assembleTransaction(
            BitcoinNetwork.Testnet,
            depositAmount,
            [testnetUTXO],
            fee,
            testnetPrivateKey
          )

          const transaction: BitcoinRawTx = result.rawTransaction
          const depositUtxo: BitcoinUtxo = result.depositUtxo

          // Initialize the mock Bitcoin client to return the raw transaction
          // data for the given deposit UTXO.
          const bitcoinClient: MockBitcoinClient = new MockBitcoinClient()
          const rawTransactions = new Map<string, BitcoinRawTx>()
          rawTransactions.set(
            depositUtxo.transactionHash.toString(),
            transaction
          )
          bitcoinClient.rawTransactions = rawTransactions

          // Initialize the mock Bridge.
          const tbtcContracts: MockTBTCContracts = new MockTBTCContracts()

          await (
            await Deposit.fromReceipt(
              depositFixture.receipt,
              tbtcContracts,
              bitcoinClient,
              depositorProxy
            )
          ).initiateMinting(depositUtxo)

          return {
            transaction,
            tbtcContracts,
          }
        }

        context("when deposit does not use a depositor proxy", () => {
          let transaction: BitcoinRawTx
          let tbtcContracts: MockTBTCContracts

          beforeEach(async () => {
            ;({ transaction, tbtcContracts } = await initiateMinting())
          })

          it("should reveal the deposit to the Bridge", () => {
            expect(tbtcContracts.bridge.revealDepositLog.length).to.be.equal(1)

            const revealDepositLogEntry =
              tbtcContracts.bridge.revealDepositLog[0]
            expect(revealDepositLogEntry.depositTx).to.be.eql(
              extractBitcoinRawTxVectors(transaction)
            )
            expect(revealDepositLogEntry.depositOutputIndex).to.be.equal(0)
            expect(revealDepositLogEntry.deposit).to.be.eql(
              depositFixture.receipt
            )
          })
        })

        context("when deposit uses a depositor proxy", () => {
          let transaction: BitcoinRawTx
          let tbtcContracts: MockTBTCContracts
          let depositorProxy: MockDepositorProxy

          beforeEach(async () => {
            depositorProxy = new MockDepositorProxy()
            ;({ transaction, tbtcContracts } = await initiateMinting(
              depositorProxy
            ))
          })

          it("should not reveal the deposit to the Bridge", () => {
            expect(tbtcContracts.bridge.revealDepositLog.length).to.be.equal(0)
          })

          it("should reveal the deposit to the DepositorProxy", () => {
            expect(depositorProxy.revealDepositLog.length).to.be.equal(1)

            const revealDepositLogEntry = depositorProxy.revealDepositLog[0]
            expect(revealDepositLogEntry.depositTx).to.be.eql(
              extractBitcoinRawTxVectors(transaction)
            )
            expect(revealDepositLogEntry.depositOutputIndex).to.be.equal(0)
            expect(revealDepositLogEntry.deposit).to.be.eql(
              depositFixture.receipt
            )
          })
        })

        context("when deposit is Taproot-native", () => {
          let transaction: BitcoinRawTx
          let tbtcContracts: MockTBTCContracts
          let depositorProxy: MockDepositorProxy

          beforeEach(async () => {
            const fee = BigNumber.from(1520)

            const depositFunding = DepositFunding.fromScript(
              DepositScript.fromReceipt(
                taprootDepositFixture.receipt,
                DepositScriptType.P2TR
              )
            )

            const result = await depositFunding.assembleTransaction(
              BitcoinNetwork.Testnet,
              depositAmount,
              [testnetUTXO],
              fee,
              testnetPrivateKey
            )

            transaction = result.rawTransaction
            const depositUtxo: BitcoinUtxo = result.depositUtxo

            const bitcoinClient: MockBitcoinClient = new MockBitcoinClient()
            const rawTransactions = new Map<string, BitcoinRawTx>()
            rawTransactions.set(
              depositUtxo.transactionHash.toString(),
              transaction
            )
            bitcoinClient.rawTransactions = rawTransactions

            tbtcContracts = new MockTBTCContracts()

            await (
              await Deposit.fromReceipt(
                taprootDepositFixture.receipt,
                tbtcContracts,
                bitcoinClient,
                undefined,
                DepositScriptType.P2TR
              )
            ).initiateMinting(depositUtxo)

            depositorProxy = new MockDepositorProxy()
            await (
              await Deposit.fromReceipt(
                taprootDepositFixture.receipt,
                tbtcContracts,
                bitcoinClient,
                depositorProxy,
                DepositScriptType.P2TR
              )
            ).initiateMinting(depositUtxo)
          })

          it("should reveal the Taproot deposit to the Bridge", () => {
            expect(tbtcContracts.bridge.revealDepositLog.length).to.be.equal(1)

            const revealDepositLogEntry =
              tbtcContracts.bridge.revealDepositLog[0]
            expect(revealDepositLogEntry.depositTx).to.be.eql(
              extractBitcoinRawTxVectors(transaction)
            )
            expect(revealDepositLogEntry.depositOutputIndex).to.be.equal(0)
            expect(revealDepositLogEntry.deposit).to.be.eql(
              taprootDepositFixture.receipt
            )
          })

          it("should reveal the Taproot deposit to the DepositorProxy", () => {
            expect(depositorProxy.revealDepositLog.length).to.be.equal(1)

            const revealDepositLogEntry = depositorProxy.revealDepositLog[0]
            expect(revealDepositLogEntry.depositTx).to.be.eql(
              extractBitcoinRawTxVectors(transaction)
            )
            expect(revealDepositLogEntry.depositOutputIndex).to.be.equal(0)
            expect(revealDepositLogEntry.deposit).to.be.eql(
              taprootDepositFixture.receipt
            )
            expect(
              revealDepositLogEntry.deposit.walletXOnlyPublicKey
            ).to.be.deep.equal(
              taprootDepositFixture.receipt.walletXOnlyPublicKey
            )
            expect(
              revealDepositLogEntry.deposit.refundXOnlyPublicKey
            ).to.be.deep.equal(
              taprootDepositFixture.receipt.refundXOnlyPublicKey
            )
          })
        })
      })
    })
  })

  describe("DepositsService", () => {
    describe("initiateDeposit", () => {
      const depositor = EthereumAddress.from(
        "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
      )
      const bitcoinClient = new MockBitcoinClient()
      const tbtcContracts = new MockTBTCContracts()
      let depositService: DepositsService

      beforeEach(async () => {
        depositService = new DepositsService(
          tbtcContracts,
          bitcoinClient,
          // Mock cross-chain contracts resolver.
          (_: DestinationChainName) => undefined
        )
      })

      context("when default depositor is not set", () => {
        it("should throw", async () => {
          await expect(
            depositService.initiateDeposit("mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc")
          ).to.be.rejectedWith(
            "Default depositor is not set; use setDefaultDepositor first"
          )
        })
      })

      context("when default depositor is set", () => {
        beforeEach(async () => {
          depositService.setDefaultDepositor(depositor)
        })

        context("when active wallet is not set", () => {
          it("should throw", async () => {
            await expect(
              depositService.initiateDeposit(
                "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc"
              )
            ).to.be.rejectedWith("Could not get active wallet public key hash")
          })
        })

        context("when active wallet exposes only a public key hash", () => {
          const activeWalletPublicKeyHash = Hex.from(
            "c92a772f11bc97d8938a16a9db435401f4e6a7bc"
          )

          beforeEach(async () => {
            tbtcContracts.bridge.setActiveWalletPublicKeyHash(
              activeWalletPublicKeyHash
            )
          })

          it("should initiate hash-only active wallet deposit without requiring the wallet public key", async () => {
            const deposit = await depositService.initiateDeposit(
              "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc"
            )

            expect(deposit.getReceipt().walletPublicKeyHash).to.be.deep.equal(
              activeWalletPublicKeyHash
            )
          })
        })

        context("when active wallet is a FROST wallet", () => {
          beforeEach(async () => {
            tbtcContracts.bridge.setActiveWalletPublicKeyHash(
              Hex.from("c92a772f11bc97d8938a16a9db435401f4e6a7bc")
            )
            tbtcContracts.bridge.setActiveWalletID(
              Hex.from(
                "2336f65004d8f122f1fe947ebd009a8b4add3a0d937356d568e30f7fcc2e4008"
              )
            )
          })

          it("should reject legacy deposit scripts", async () => {
            await expect(
              depositService.initiateDeposit(
                "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc"
              )
            ).to.be.rejectedWith(
              "Legacy deposits are not supported for FROST active wallets"
            )
          })
        })

        context("when active wallet is set", () => {
          beforeEach(async () => {
            tbtcContracts.bridge.setActiveWalletPublicKey(
              Hex.from(
                "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
              )
            )
          })

          context("when recovery address is incorrect", () => {
            it("should throw", async () => {
              await expect(
                depositService.initiateDeposit(
                  "2N5WZpig3vgpSdjSherS2Lv7GnPuxCvkQjT" // p2sh address
                )
              ).to.be.rejectedWith(
                "Bitcoin recovery address must be P2PKH or P2WPKH"
              )
            })
          })

          context("when recovery address is correct", () => {
            const assertCommonDepositProperties = (receipt: DepositReceipt) => {
              expect(receipt.depositor).to.be.equal(depositor)

              expect(receipt.walletPublicKeyHash).to.be.deep.equal(
                Hex.from("8db50eb52063ea9d98b3eac91489a90f738986f6")
              )

              // Expect the refund locktime to be in the future.
              const receiptTimestamp = BigNumber.from(
                receipt.refundLocktime.reverse().toPrefixedString()
              ).toNumber()
              const currentTimestamp = Math.floor(new Date().getTime() / 1000)
              expect(receiptTimestamp).to.be.greaterThan(currentTimestamp)

              // Expect blinding factor to be set and 8-byte long.
              expect(receipt.blindingFactor).not.to.be.undefined
              expect(receipt.blindingFactor.toBuffer().length).to.be.equal(8)
            }

            context("when optional extra data is not provided", () => {
              context("when recovery address is P2PKH", () => {
                let deposit: Deposit

                beforeEach(async () => {
                  deposit = await depositService.initiateDeposit(
                    "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc"
                  )
                })

                it("should initiate deposit correctly", async () => {
                  // Inspect the deposit object by looking at its receipt.
                  const receipt = deposit.getReceipt()

                  assertCommonDepositProperties(receipt)

                  expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                    Hex.from("2cd680318747b720d67bf4246eb7403b476adb34")
                  )
                  expect(receipt.extraData).to.be.undefined
                })
              })

              context("when recovery address is P2WPKH", () => {
                let deposit: Deposit

                beforeEach(async () => {
                  deposit = await depositService.initiateDeposit(
                    "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx"
                  )
                })

                it("should initiate deposit correctly", async () => {
                  // Inspect the deposit object by looking at its receipt.
                  const receipt = deposit.getReceipt()

                  assertCommonDepositProperties(receipt)

                  expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                    Hex.from("e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0")
                  )
                  expect(receipt.extraData).to.be.undefined
                })
              })
            })

            context("when optional extra data is provided", () => {
              context("when extra data is not 32-byte", () => {
                it("should throw", async () => {
                  await expect(
                    depositService.initiateDeposit(
                      "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
                      Hex.from("11")
                    )
                  ).to.be.rejectedWith("Extra data is not 32-byte")
                })
              })

              context("when extra data is 32-byte but all-zero", () => {
                it("should throw", async () => {
                  await expect(
                    depositService.initiateDeposit(
                      "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
                      Hex.from(
                        "0000000000000000000000000000000000000000000000000000000000000000"
                      )
                    )
                  ).to.be.rejectedWith("Extra data contains only zero bytes")
                })
              })

              context("when extra data is 32-byte and non-zero", () => {
                let deposit: Deposit

                beforeEach(async () => {
                  deposit = await depositService.initiateDeposit(
                    "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
                    Hex.from(
                      "1111111111111111222222222222222211111111111111112222222222222222"
                    )
                  )
                })

                it("should initiate deposit correctly", async () => {
                  // Inspect the deposit object by looking at its receipt.
                  const receipt = deposit.getReceipt()

                  assertCommonDepositProperties(receipt)

                  expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                    Hex.from("e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0")
                  )
                  expect(receipt.extraData).to.be.eql(
                    Hex.from(
                      "1111111111111111222222222222222211111111111111112222222222222222"
                    )
                  )
                })
              })
            })
          })
        })
      })
    })

    describe("initiateTaprootDeposit", () => {
      const depositor = EthereumAddress.from(
        "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
      )
      const activeWalletPublicKeyHash = Hex.from(
        "c92a772f11bc97d8938a16a9db435401f4e6a7bc"
      )
      const activeWalletID = Hex.from(
        "2336f65004d8f122f1fe947ebd009a8b4add3a0d937356d568e30f7fcc2e4008"
      )
      const taprootRecoveryAddress =
        "tb1pzy3rx3z4vemc3xgq42aueh0wluqpzg3ng32kvaugnx4thnxaamlsk2wdrf"

      let bitcoinClient: MockBitcoinClient
      let tbtcContracts: MockTBTCContracts
      let depositService: DepositsService

      beforeEach(async () => {
        bitcoinClient = new MockBitcoinClient()
        tbtcContracts = new MockTBTCContracts()
        depositService = new DepositsService(
          tbtcContracts,
          bitcoinClient,
          (_: DestinationChainName) => undefined
        )
      })

      context("when default depositor is not set", () => {
        it("should throw", async () => {
          await expect(
            depositService.initiateTaprootDeposit(taprootRecoveryAddress)
          ).to.be.rejectedWith(
            "Default depositor is not set; use setDefaultDepositor first"
          )
        })
      })

      context("when default depositor is set", () => {
        beforeEach(async () => {
          depositService.setDefaultDepositor(depositor)
        })

        context("when active wallet is not set", () => {
          it("should throw", async () => {
            await expect(
              depositService.initiateTaprootDeposit(taprootRecoveryAddress)
            ).to.be.rejectedWith("Could not get active wallet public key hash")
          })
        })

        context("when active wallet is a legacy wallet", () => {
          beforeEach(async () => {
            tbtcContracts.bridge.setActiveWalletPublicKey(
              Hex.from(
                "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
              )
            )
          })

          it("should throw", async () => {
            await expect(
              depositService.initiateTaprootDeposit(taprootRecoveryAddress)
            ).to.be.rejectedWith(
              "Taproot deposits require an active FROST wallet with a P2TR wallet ID"
            )
          })
        })

        context("when active wallet is a FROST wallet", () => {
          beforeEach(async () => {
            tbtcContracts.bridge.setActiveWalletPublicKeyHash(
              activeWalletPublicKeyHash
            )
            tbtcContracts.bridge.setActiveWalletID(activeWalletID)
          })

          context("when recovery address is not P2TR", () => {
            it("should throw", async () => {
              await expect(
                depositService.initiateTaprootDeposit(
                  "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx"
                )
              ).to.be.rejectedWith("Bitcoin recovery address must be P2TR")
            })
          })

          context("when recovery address is P2TR", () => {
            let deposit: Deposit

            beforeEach(async () => {
              deposit = await depositService.initiateTaprootDeposit(
                taprootRecoveryAddress
              )
            })

            it("should initiate Taproot deposit correctly", async () => {
              const receipt = deposit.getReceipt()

              expect(receipt.depositor).to.be.equal(depositor)
              expect(receipt.walletPublicKeyHash).to.be.deep.equal(
                activeWalletPublicKeyHash
              )
              expect(receipt.walletXOnlyPublicKey).to.be.deep.equal(
                activeWalletID
              )
              expect(receipt.refundXOnlyPublicKey).to.be.deep.equal(
                taprootDepositFixture.receipt.refundXOnlyPublicKey
              )
              expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                taprootDepositFixture.receipt.refundPublicKeyHash
              )
              expect(await deposit.getBitcoinAddress()).to.match(/^tb1p/)
            })
          })
        })
      })
    })

    describe("initiateDepositWithProxy", () => {
      const bitcoinClient = new MockBitcoinClient()
      const tbtcContracts = new MockTBTCContracts()
      const depositorProxy = new MockDepositorProxy(true)
      let depositService: DepositsService

      beforeEach(async () => {
        depositService = new DepositsService(
          tbtcContracts,
          bitcoinClient,
          // Mock cross-chain contracts resolver.
          (_: DestinationChainName) => undefined
        )
      })

      context("when active wallet is not set", () => {
        it("should throw", async () => {
          await expect(
            depositService.initiateDepositWithProxy(
              "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
              depositorProxy
            )
          ).to.be.rejectedWith("Could not get active wallet public key hash")
        })

        it("should reject unsupported Taproot proxies before reading wallet state", async () => {
          const unsupportedDepositorProxy: DepositorProxy = {
            getChainIdentifier: () => depositorProxy.getChainIdentifier(),
            revealDeposit: depositorProxy.revealDeposit.bind(depositorProxy),
          }

          await expect(
            depositService.initiateDepositWithProxy(
              "tb1pzy3rx3z4vemc3xgq42aueh0wluqpzg3ng32kvaugnx4thnxaamlsk2wdrf",
              unsupportedDepositorProxy,
              undefined,
              DepositScriptType.P2TR
            )
          ).to.be.rejectedWith(
            "Taproot deposits are not supported by this depositor"
          )
        })
      })

      context("when active wallet is set", () => {
        beforeEach(async () => {
          tbtcContracts.bridge.setActiveWalletPublicKey(
            Hex.from(
              "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
            )
          )
        })

        context("when active wallet is a FROST wallet", () => {
          beforeEach(async () => {
            tbtcContracts.bridge.setActiveWalletPublicKeyHash(
              Hex.from("c92a772f11bc97d8938a16a9db435401f4e6a7bc")
            )
            tbtcContracts.bridge.setActiveWalletID(
              Hex.from(
                "2336f65004d8f122f1fe947ebd009a8b4add3a0d937356d568e30f7fcc2e4008"
              )
            )
          })

          it("should reject legacy deposit scripts", async () => {
            await expect(
              depositService.initiateDepositWithProxy(
                "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
                depositorProxy
              )
            ).to.be.rejectedWith(
              "Legacy deposits are not supported for FROST active wallets"
            )
          })

          it("should reject Taproot deposits for a proxy without explicit support", async () => {
            const unsupportedDepositorProxy: DepositorProxy = {
              getChainIdentifier: () => depositorProxy.getChainIdentifier(),
              revealDeposit: depositorProxy.revealDeposit.bind(depositorProxy),
            }

            await expect(
              depositService.initiateDepositWithProxy(
                "tb1pzy3rx3z4vemc3xgq42aueh0wluqpzg3ng32kvaugnx4thnxaamlsk2wdrf",
                unsupportedDepositorProxy,
                undefined,
                DepositScriptType.P2TR
              )
            ).to.be.rejectedWith(
              "Taproot deposits are not supported by this depositor"
            )
          })

          it("should initiate a Taproot deposit for a proxy", async () => {
            const deposit = await depositService.initiateDepositWithProxy(
              "tb1pzy3rx3z4vemc3xgq42aueh0wluqpzg3ng32kvaugnx4thnxaamlsk2wdrf",
              depositorProxy,
              undefined,
              DepositScriptType.P2TR
            )

            const receipt = deposit.getReceipt()
            expect(receipt.depositor).to.be.deep.equal(
              depositorProxy.getChainIdentifier()
            )
            expect(receipt.walletXOnlyPublicKey).to.be.deep.equal(
              Hex.from(
                "2336f65004d8f122f1fe947ebd009a8b4add3a0d937356d568e30f7fcc2e4008"
              )
            )
            expect(receipt.refundXOnlyPublicKey).to.be.deep.equal(
              taprootDepositFixture.receipt.refundXOnlyPublicKey
            )
            expect(await deposit.getBitcoinAddress()).to.match(/^tb1p/)
          })
        })

        context("when recovery address is incorrect", () => {
          it("should throw", async () => {
            await expect(
              depositService.initiateDepositWithProxy(
                "2N5WZpig3vgpSdjSherS2Lv7GnPuxCvkQjT", // p2sh address
                depositorProxy
              )
            ).to.be.rejectedWith(
              "Bitcoin recovery address must be P2PKH or P2WPKH"
            )
          })
        })

        context("when recovery address is correct", () => {
          const assertCommonDepositProperties = (receipt: DepositReceipt) => {
            expect(receipt.depositor).to.be.deep.equal(
              depositorProxy.getChainIdentifier()
            )

            expect(receipt.walletPublicKeyHash).to.be.deep.equal(
              Hex.from("8db50eb52063ea9d98b3eac91489a90f738986f6")
            )

            // Expect the refund locktime to be in the future.
            const receiptTimestamp = BigNumber.from(
              receipt.refundLocktime.reverse().toPrefixedString()
            ).toNumber()
            const currentTimestamp = Math.floor(new Date().getTime() / 1000)
            expect(receiptTimestamp).to.be.greaterThan(currentTimestamp)

            // Expect blinding factor to be set and 8-byte long.
            expect(receipt.blindingFactor).not.to.be.undefined
            expect(receipt.blindingFactor.toBuffer().length).to.be.equal(8)
          }

          context("when optional extra data is not provided", () => {
            context("when recovery address is P2PKH", () => {
              let deposit: Deposit

              beforeEach(async () => {
                deposit = await depositService.initiateDepositWithProxy(
                  "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
                  depositorProxy
                )
              })

              it("should initiate deposit correctly", async () => {
                // Inspect the deposit object by looking at its receipt.
                const receipt = deposit.getReceipt()

                assertCommonDepositProperties(receipt)

                expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                  Hex.from("2cd680318747b720d67bf4246eb7403b476adb34")
                )
                expect(receipt.extraData).to.be.undefined
              })
            })

            context("when recovery address is P2WPKH", () => {
              let deposit: Deposit

              beforeEach(async () => {
                deposit = await depositService.initiateDepositWithProxy(
                  "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
                  depositorProxy
                )
              })

              it("should initiate deposit correctly", async () => {
                // Inspect the deposit object by looking at its receipt.
                const receipt = deposit.getReceipt()

                assertCommonDepositProperties(receipt)

                expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                  Hex.from("e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0")
                )
                expect(receipt.extraData).to.be.undefined
              })
            })
          })

          context("when optional extra data is provided", () => {
            context("when extra data is not 32-byte", () => {
              it("should throw", async () => {
                await expect(
                  depositService.initiateDepositWithProxy(
                    "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
                    depositorProxy,
                    Hex.from("11")
                  )
                ).to.be.rejectedWith("Extra data is not 32-byte")
              })
            })

            context("when extra data is 32-byte but all-zero", () => {
              it("should throw", async () => {
                await expect(
                  depositService.initiateDepositWithProxy(
                    "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
                    depositorProxy,
                    Hex.from(
                      "0000000000000000000000000000000000000000000000000000000000000000"
                    )
                  )
                ).to.be.rejectedWith("Extra data contains only zero bytes")
              })
            })

            context("when extra data is 32-byte and non-zero", () => {
              let deposit: Deposit

              beforeEach(async () => {
                deposit = await depositService.initiateDepositWithProxy(
                  "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
                  depositorProxy,
                  Hex.from(
                    "1111111111111111222222222222222211111111111111112222222222222222"
                  )
                )
              })

              it("should initiate deposit correctly", async () => {
                // Inspect the deposit object by looking at its receipt.
                const receipt = deposit.getReceipt()

                assertCommonDepositProperties(receipt)

                expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                  Hex.from("e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0")
                )
                expect(receipt.extraData).to.be.eql(
                  Hex.from(
                    "1111111111111111222222222222222211111111111111112222222222222222"
                  )
                )
              })
            })
          })
        })
      })
    })

    describe("initiateCrossChainDeposit - BASE", () => {
      const l2DepositOwner = EthereumAddress.from(
        "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
      )
      const bitcoinClient = new MockBitcoinClient()
      const tbtcContracts = new MockTBTCContracts()
      let depositService: DepositsService

      context("when cross-chain contracts are not initialized", () => {
        beforeEach(async () => {
          depositService = new DepositsService(
            tbtcContracts,
            bitcoinClient,
            // Mock cross-chain contracts resolver that always returns undefined.
            (_: DestinationChainName) => undefined
          )
        })

        it("should throw", async () => {
          await expect(
            depositService.initiateCrossChainDeposit(
              "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
              "Base"
            )
          ).to.be.rejectedWith("Cross-chain contracts for Base not initialized")
        })
      })

      context("when cross-chain contracts are initialized", () => {
        let l2BitcoinDepositor: MockBitcoinDepositor
        let l1BitcoinDepositor: MockL1BitcoinDepositor
        let l2BitcoinRedeemer: MockL2BitcoinRedeemer
        let l1BitcoinRedeemer: MockL1BitcoinRedeemer
        let crossChainContracts: CrossChainContracts

        beforeEach(async () => {
          const l2BitcoinDepositorEncoder = new MockCrossChainExtraDataEncoder()
          // Set valid 32-byte extra data as initiateCrossChainDeposit
          // performs length and content checks on the extra data.
          l2BitcoinDepositorEncoder.setEncoding(
            l2DepositOwner,
            Hex.from(`000000000000000000000000${l2DepositOwner.identifierHex}`)
          )
          l2BitcoinDepositor = new MockL2BitcoinDepositor(
            EthereumAddress.from("49D1e49013Df517Ea30306DE2F462F2D0170212f"),
            l2BitcoinDepositorEncoder
          )

          l1BitcoinDepositor = new MockL1BitcoinDepositor(
            EthereumAddress.from("F4c1B212B37775769c73353264ac48dD7fA5B71E"),
            new MockCrossChainExtraDataEncoder()
          )

          l1BitcoinRedeemer = new MockL1BitcoinRedeemer(
            EthereumAddress.from("0x1111111111111111111111111111111111111111")
          )

          l2BitcoinRedeemer = new MockL2BitcoinRedeemer(
            EthereumAddress.from("0x2222222222222222222222222222222222222222")
          )

          crossChainContracts = {
            destinationChainTbtcToken: new MockL2TBTCToken(),
            destinationChainBitcoinDepositor: l2BitcoinDepositor,
            l1BitcoinDepositor: l1BitcoinDepositor,
            l1BitcoinRedeemer: l1BitcoinRedeemer,
            l2BitcoinRedeemer: l2BitcoinRedeemer,
          }

          const crossChainContractsResolver = (
            l2ChainName: DestinationChainName
          ): CrossChainContracts | undefined => {
            if (l2ChainName === "Base") {
              return crossChainContracts
            }
          }

          depositService = new DepositsService(
            tbtcContracts,
            bitcoinClient,
            crossChainContractsResolver
          )
        })

        context("when L2 deposit owner cannot be resolved", () => {
          it("should throw", async () => {
            await expect(
              depositService.initiateCrossChainDeposit(
                "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
                "Base"
              )
            ).to.be.rejectedWith(
              "Cannot resolve destination chain deposit owner"
            )
          })

          it("should reject unsupported Taproot routes before resolving the owner", async () => {
            await expect(
              depositService.initiateCrossChainDeposit(
                "tb1pzy3rx3z4vemc3xgq42aueh0wluqpzg3ng32kvaugnx4thnxaamlsk2wdrf",
                "Base",
                DepositScriptType.P2TR
              )
            ).to.be.rejectedWith("Taproot deposits are not supported for Base")
          })
        })

        context("when L2 deposit owner can be resolved", () => {
          beforeEach(async () => {
            crossChainContracts.destinationChainBitcoinDepositor.setDepositOwner(
              l2DepositOwner
            )
          })

          context("when active wallet is not set", () => {
            it("should throw", async () => {
              await expect(
                depositService.initiateCrossChainDeposit(
                  "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
                  "Base"
                )
              ).to.be.rejectedWith(
                "Could not get active wallet public key hash"
              )
            })
          })

          context("when active wallet is set", () => {
            beforeEach(async () => {
              tbtcContracts.bridge.setActiveWalletPublicKey(
                Hex.from(
                  "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
                )
              )
            })

            context("when recovery address is incorrect", () => {
              it("should throw", async () => {
                await expect(
                  depositService.initiateCrossChainDeposit(
                    "2N5WZpig3vgpSdjSherS2Lv7GnPuxCvkQjT", // p2sh address
                    "Base"
                  )
                ).to.be.rejectedWith(
                  "Bitcoin recovery address must be P2PKH or P2WPKH"
                )
              })
            })

            context("when recovery address is correct", () => {
              const assertCommonDepositProperties = (
                receipt: DepositReceipt
              ) => {
                expect(receipt.depositor).to.be.equal(
                  l1BitcoinDepositor.getChainIdentifier()
                )

                expect(receipt.walletPublicKeyHash).to.be.deep.equal(
                  Hex.from("8db50eb52063ea9d98b3eac91489a90f738986f6")
                )

                // Expect the refund locktime to be in the future.
                const receiptTimestamp = BigNumber.from(
                  receipt.refundLocktime.reverse().toPrefixedString()
                ).toNumber()
                const currentTimestamp = Math.floor(new Date().getTime() / 1000)
                expect(receiptTimestamp).to.be.greaterThan(currentTimestamp)

                // Expect blinding factor to be set and 8-byte long.
                expect(receipt.blindingFactor).not.to.be.undefined
                expect(receipt.blindingFactor.toBuffer().length).to.be.equal(8)

                expect(receipt.extraData).to.be.eql(
                  Hex.from(
                    `000000000000000000000000${l2DepositOwner.identifierHex}`
                  )
                )
              }

              context("when recovery address is P2PKH", () => {
                let deposit: Deposit

                beforeEach(async () => {
                  deposit = await depositService.initiateCrossChainDeposit(
                    "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
                    "Base"
                  )
                })

                it("should initiate deposit correctly", async () => {
                  // Inspect the deposit object by looking at its receipt.
                  const receipt = deposit.getReceipt()

                  assertCommonDepositProperties(receipt)

                  expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                    Hex.from("2cd680318747b720d67bf4246eb7403b476adb34")
                  )
                })
              })

              context("when recovery address is P2WPKH", () => {
                let deposit: Deposit

                beforeEach(async () => {
                  deposit = await depositService.initiateCrossChainDeposit(
                    "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
                    "Base"
                  )
                })

                it("should initiate deposit correctly", async () => {
                  // Inspect the deposit object by looking at its receipt.
                  const receipt = deposit.getReceipt()

                  assertCommonDepositProperties(receipt)

                  expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                    Hex.from("e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0")
                  )
                })
              })
            })

            context("when active wallet is a FROST wallet", () => {
              const activeWalletPublicKeyHash = Hex.from(
                "c92a772f11bc97d8938a16a9db435401f4e6a7bc"
              )
              const activeWalletID = Hex.from(
                "2336f65004d8f122f1fe947ebd009a8b4add3a0d937356d568e30f7fcc2e4008"
              )

              beforeEach(async () => {
                tbtcContracts.bridge.setActiveWalletPublicKeyHash(
                  activeWalletPublicKeyHash
                )
                tbtcContracts.bridge.setActiveWalletID(activeWalletID)
              })

              it("should reject a Taproot cross-chain deposit when the adapters do not support it", async () => {
                await expect(
                  depositService.initiateCrossChainDeposit(
                    "tb1pzy3rx3z4vemc3xgq42aueh0wluqpzg3ng32kvaugnx4thnxaamlsk2wdrf",
                    "Base",
                    DepositScriptType.P2TR
                  )
                ).to.be.rejectedWith(
                  "Taproot deposits are not supported for Base"
                )
              })

              it("should initiate a Taproot cross-chain deposit when both adapters support it", async () => {
                l2BitcoinDepositor.taprootDepositsSupported = true
                l1BitcoinDepositor.taprootDepositsSupported = true

                const deposit = await depositService.initiateCrossChainDeposit(
                  "tb1pzy3rx3z4vemc3xgq42aueh0wluqpzg3ng32kvaugnx4thnxaamlsk2wdrf",
                  "Base",
                  DepositScriptType.P2TR
                )

                const receipt = deposit.getReceipt()
                expect(receipt.depositor).to.be.equal(
                  l1BitcoinDepositor.getChainIdentifier()
                )
                expect(receipt.walletPublicKeyHash).to.be.deep.equal(
                  activeWalletPublicKeyHash
                )
                expect(receipt.walletXOnlyPublicKey).to.be.deep.equal(
                  activeWalletID
                )
                expect(receipt.refundXOnlyPublicKey).to.be.deep.equal(
                  taprootDepositFixture.receipt.refundXOnlyPublicKey
                )
                expect(receipt.extraData).to.be.eql(
                  Hex.from(
                    `000000000000000000000000${l2DepositOwner.identifierHex}`
                  )
                )
                expect(await deposit.getBitcoinAddress()).to.match(/^tb1p/)
              })
            })
          })
        })
      })
    })
  })

  describe("initiateCrossChainDeposit - ARBITRUM", () => {
    const l2DepositOwner = EthereumAddress.from(
      "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
    )
    const bitcoinClient = new MockBitcoinClient()
    const tbtcContracts = new MockTBTCContracts()
    let depositService: DepositsService

    context("when cross-chain contracts are not initialized", () => {
      beforeEach(async () => {
        depositService = new DepositsService(
          tbtcContracts,
          bitcoinClient,
          // Mock cross-chain contracts resolver that always returns undefined.
          (_: DestinationChainName) => undefined
        )
      })

      it("should throw", async () => {
        await expect(
          depositService.initiateCrossChainDeposit(
            "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
            "Arbitrum"
          )
        ).to.be.rejectedWith(
          "Cross-chain contracts for Arbitrum not initialized"
        )
      })
    })

    context("when cross-chain contracts are initialized", () => {
      let l2BitcoinDepositor: MockBitcoinDepositor
      let l1BitcoinDepositor: MockL1BitcoinDepositor
      let l1BitcoinRedeemer: MockL1BitcoinRedeemer
      let l2BitcoinRedeemer: MockL2BitcoinRedeemer
      let crossChainContracts: CrossChainContracts

      beforeEach(async () => {
        const l2BitcoinDepositorEncoder = new MockCrossChainExtraDataEncoder()
        // Set valid 32-byte extra data as initiateCrossChainDeposit
        // performs length and content checks on the extra data.
        l2BitcoinDepositorEncoder.setEncoding(
          l2DepositOwner,
          Hex.from(`000000000000000000000000${l2DepositOwner.identifierHex}`)
        )
        l2BitcoinDepositor = new MockL2BitcoinDepositor(
          EthereumAddress.from("49D1e49013Df517Ea30306DE2F462F2D0170212f"),
          l2BitcoinDepositorEncoder
        )

        l1BitcoinDepositor = new MockL1BitcoinDepositor(
          EthereumAddress.from("F4c1B212B37775769c73353264ac48dD7fA5B71E"),
          new MockCrossChainExtraDataEncoder()
        )

        l1BitcoinRedeemer = new MockL1BitcoinRedeemer(
          EthereumAddress.from("0x1111111111111111111111111111111111111111")
        )

        l2BitcoinRedeemer = new MockL2BitcoinRedeemer(
          EthereumAddress.from("0x2222222222222222222222222222222222222222")
        )

        crossChainContracts = {
          destinationChainTbtcToken: new MockL2TBTCToken(),
          destinationChainBitcoinDepositor: l2BitcoinDepositor,
          l1BitcoinDepositor: l1BitcoinDepositor,
          l1BitcoinRedeemer: l1BitcoinRedeemer,
          l2BitcoinRedeemer: l2BitcoinRedeemer,
        }

        const crossChainContractsResolver = (
          l2ChainName: DestinationChainName
        ): CrossChainContracts | undefined => {
          if (l2ChainName === "Arbitrum") {
            return crossChainContracts
          }
        }

        depositService = new DepositsService(
          tbtcContracts,
          bitcoinClient,
          crossChainContractsResolver
        )
      })

      context("when L2 deposit owner cannot be resolved", () => {
        it("should throw", async () => {
          await expect(
            depositService.initiateCrossChainDeposit(
              "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
              "Arbitrum"
            )
          ).to.be.rejectedWith("Cannot resolve destination chain deposit owner")
        })
      })

      context("when L2 deposit owner can be resolved", () => {
        beforeEach(async () => {
          crossChainContracts.destinationChainBitcoinDepositor.setDepositOwner(
            l2DepositOwner
          )
        })

        context("when active wallet is not set", () => {
          it("should throw", async () => {
            await expect(
              depositService.initiateCrossChainDeposit(
                "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
                "Arbitrum"
              )
            ).to.be.rejectedWith("Could not get active wallet public key hash")
          })
        })

        context("when active wallet is set", () => {
          beforeEach(async () => {
            tbtcContracts.bridge.setActiveWalletPublicKey(
              Hex.from(
                "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
              )
            )
          })

          context("when recovery address is incorrect", () => {
            it("should throw", async () => {
              await expect(
                depositService.initiateCrossChainDeposit(
                  "2N5WZpig3vgpSdjSherS2Lv7GnPuxCvkQjT", // p2sh address
                  "Arbitrum"
                )
              ).to.be.rejectedWith(
                "Bitcoin recovery address must be P2PKH or P2WPKH"
              )
            })
          })

          context("when recovery address is correct", () => {
            const assertCommonDepositProperties = (receipt: DepositReceipt) => {
              expect(receipt.depositor).to.be.equal(
                l1BitcoinDepositor.getChainIdentifier()
              )

              expect(receipt.walletPublicKeyHash).to.be.deep.equal(
                Hex.from("8db50eb52063ea9d98b3eac91489a90f738986f6")
              )

              // Expect the refund locktime to be in the future.
              const receiptTimestamp = BigNumber.from(
                receipt.refundLocktime.reverse().toPrefixedString()
              ).toNumber()
              const currentTimestamp = Math.floor(new Date().getTime() / 1000)
              expect(receiptTimestamp).to.be.greaterThan(currentTimestamp)

              // Expect blinding factor to be set and 8-byte long.
              expect(receipt.blindingFactor).not.to.be.undefined
              expect(receipt.blindingFactor.toBuffer().length).to.be.equal(8)

              expect(receipt.extraData).to.be.eql(
                Hex.from(
                  `000000000000000000000000${l2DepositOwner.identifierHex}`
                )
              )
            }

            context("when recovery address is P2PKH", () => {
              let deposit: Deposit

              beforeEach(async () => {
                deposit = await depositService.initiateCrossChainDeposit(
                  "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
                  "Arbitrum"
                )
              })

              it("should initiate deposit correctly", async () => {
                // Inspect the deposit object by looking at its receipt.
                const receipt = deposit.getReceipt()

                assertCommonDepositProperties(receipt)

                expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                  Hex.from("2cd680318747b720d67bf4246eb7403b476adb34")
                )
              })
            })

            context("when recovery address is P2WPKH", () => {
              let deposit: Deposit

              beforeEach(async () => {
                deposit = await depositService.initiateCrossChainDeposit(
                  "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
                  "Arbitrum"
                )
              })

              it("should initiate deposit correctly", async () => {
                // Inspect the deposit object by looking at its receipt.
                const receipt = deposit.getReceipt()

                assertCommonDepositProperties(receipt)

                expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                  Hex.from("e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0")
                )
              })
            })
          })
        })
      })
    })
  })

  describe("initiateCrossChainDeposit - SOLANA", () => {
    const l2DepositOwner = EthereumAddress.from(
      "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
    )
    const bitcoinClient = new MockBitcoinClient()
    const tbtcContracts = new MockTBTCContracts()
    let depositService: DepositsService

    context("when cross-chain contracts are not initialized", () => {
      beforeEach(async () => {
        depositService = new DepositsService(
          tbtcContracts,
          bitcoinClient,
          // Mock cross-chain contracts resolver that always returns undefined.
          (_: DestinationChainName) => undefined
        )
      })

      it("should throw", async () => {
        await expect(
          depositService.initiateCrossChainDeposit(
            "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
            "Solana"
          )
        ).to.be.rejectedWith("Cross-chain contracts for Solana not initialized")
      })
    })

    context("when cross-chain contracts are initialized", () => {
      let l2BitcoinDepositor: MockBitcoinDepositor
      let l1BitcoinDepositor: MockL1BitcoinDepositor
      let crossChainContracts: CrossChainInterfaces

      beforeEach(async () => {
        const l2BitcoinDepositorEncoder = new MockCrossChainExtraDataEncoder()
        // Set valid 32-byte extra data as initiateCrossChainDeposit
        // performs length and content checks on the extra data.
        l2BitcoinDepositorEncoder.setEncoding(
          l2DepositOwner,
          Hex.from(`000000000000000000000000${l2DepositOwner.identifierHex}`)
        )
        l2BitcoinDepositor = new MockL2BitcoinDepositor(
          EthereumAddress.from("49D1e49013Df517Ea30306DE2F462F2D0170212f"),
          l2BitcoinDepositorEncoder
        )

        l1BitcoinDepositor = new MockL1BitcoinDepositor(
          EthereumAddress.from("F4c1B212B37775769c73353264ac48dD7fA5B71E"),
          new MockCrossChainExtraDataEncoder()
        )

        crossChainContracts = {
          destinationChainTbtcToken: new MockL2TBTCToken(),
          destinationChainBitcoinDepositor: l2BitcoinDepositor,
          l1BitcoinDepositor: l1BitcoinDepositor,
          l1BitcoinRedeemer: new MockL1BitcoinRedeemer(
            EthereumAddress.from("0x1111111111111111111111111111111111111111")
          ),
        }

        const crossChainContractsResolver = (
          destinationChainName: DestinationChainName
        ): CrossChainInterfaces | undefined => {
          if (destinationChainName === "Solana") {
            return crossChainContracts
          }
        }

        depositService = new DepositsService(
          tbtcContracts,
          bitcoinClient,
          crossChainContractsResolver
        )
      })

      context("when Solana deposit owner cannot be resolved", () => {
        it("should throw", async () => {
          await expect(
            depositService.initiateCrossChainDeposit(
              "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
              "Solana"
            )
          ).to.be.rejectedWith("Cannot resolve destination chain deposit owner")
        })
      })

      context("when L2 deposit owner can be resolved", () => {
        beforeEach(async () => {
          crossChainContracts.destinationChainBitcoinDepositor.setDepositOwner(
            l2DepositOwner
          )
        })

        context("when active wallet is not set", () => {
          it("should throw", async () => {
            await expect(
              depositService.initiateCrossChainDeposit(
                "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
                "Solana"
              )
            ).to.be.rejectedWith("Could not get active wallet public key hash")
          })
        })

        context("when active wallet is set", () => {
          beforeEach(async () => {
            tbtcContracts.bridge.setActiveWalletPublicKey(
              Hex.from(
                "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
              )
            )
          })

          context("when recovery address is incorrect", () => {
            it("should throw", async () => {
              await expect(
                depositService.initiateCrossChainDeposit(
                  "2N5WZpig3vgpSdjSherS2Lv7GnPuxCvkQjT", // p2sh address
                  "Solana"
                )
              ).to.be.rejectedWith(
                "Bitcoin recovery address must be P2PKH or P2WPKH"
              )
            })
          })

          context("when recovery address is correct", () => {
            const assertCommonDepositProperties = (receipt: DepositReceipt) => {
              expect(receipt.depositor).to.be.equal(
                l1BitcoinDepositor.getChainIdentifier()
              )

              expect(receipt.walletPublicKeyHash).to.be.deep.equal(
                Hex.from("8db50eb52063ea9d98b3eac91489a90f738986f6")
              )

              // Expect the refund locktime to be in the future.
              const receiptTimestamp = BigNumber.from(
                receipt.refundLocktime.reverse().toPrefixedString()
              ).toNumber()
              const currentTimestamp = Math.floor(new Date().getTime() / 1000)
              expect(receiptTimestamp).to.be.greaterThan(currentTimestamp)

              // Expect blinding factor to be set and 8-byte long.
              expect(receipt.blindingFactor).not.to.be.undefined
              expect(receipt.blindingFactor.toBuffer().length).to.be.equal(8)

              expect(receipt.extraData).to.be.eql(
                Hex.from(
                  `000000000000000000000000${l2DepositOwner.identifierHex}`
                )
              )
            }

            context("when recovery address is P2PKH", () => {
              let deposit: Deposit

              beforeEach(async () => {
                deposit = await depositService.initiateCrossChainDeposit(
                  "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
                  "Solana"
                )
              })

              it("should initiate deposit correctly", async () => {
                // Inspect the deposit object by looking at its receipt.
                const receipt = deposit.getReceipt()

                assertCommonDepositProperties(receipt)

                expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                  Hex.from("2cd680318747b720d67bf4246eb7403b476adb34")
                )
              })
            })

            context("when recovery address is P2WPKH", () => {
              let deposit: Deposit

              beforeEach(async () => {
                deposit = await depositService.initiateCrossChainDeposit(
                  "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
                  "Solana"
                )
              })

              it("should initiate deposit correctly", async () => {
                // Inspect the deposit object by looking at its receipt.
                const receipt = deposit.getReceipt()

                assertCommonDepositProperties(receipt)

                expect(receipt.refundPublicKeyHash).to.be.deep.equal(
                  Hex.from("e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0")
                )
              })
            })
          })
        })
      })
    })
  })

  describe("DepositRefund", () => {
    const fee = BigNumber.from(1520)

    describe("DepositRefund", () => {
      describe("submitTransaction", () => {
        let bitcoinClient: MockBitcoinClient

        beforeEach(async () => {
          bitcoinClient = new MockBitcoinClient()
        })

        context(
          "when the refund transaction is requested to be witness",
          () => {
            context("when the refunded deposit was witness", () => {
              let transactionHash: BitcoinTxHash

              beforeEach(async () => {
                const utxo =
                  depositRefundOfWitnessDepositAndWitnessRefunderAddress.deposit
                    .utxo
                const deposit =
                  depositRefundOfWitnessDepositAndWitnessRefunderAddress.deposit
                    .data
                const refunderAddress =
                  depositRefundOfWitnessDepositAndWitnessRefunderAddress.refunderAddress
                const refunderPrivateKey =
                  "cTWhf1nXc7aW8BN2qLtWcPtcgcWYKfzRXkCJNsuQ86HR8uJBYfMc"

                const rawTransactions = new Map<string, BitcoinRawTx>()
                rawTransactions.set(utxo.transactionHash.toString(), {
                  transactionHex: utxo.transactionHex,
                })
                bitcoinClient.rawTransactions = rawTransactions

                const depositRefund = DepositRefund.fromScript(
                  DepositScript.fromReceipt(deposit)
                )

                ;({ transactionHash } = await depositRefund.submitTransaction(
                  bitcoinClient,
                  fee,
                  utxo,
                  refunderAddress,
                  refunderPrivateKey
                ))
              })

              it("should broadcast refund transaction with proper structure", async () => {
                expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
                expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                  depositRefundOfWitnessDepositAndWitnessRefunderAddress
                    .expectedRefund.transaction
                )
              })

              it("should return the proper transaction hash", async () => {
                expect(transactionHash).to.be.deep.equal(
                  depositRefundOfWitnessDepositAndWitnessRefunderAddress
                    .expectedRefund.transactionHash
                )
              })
            })

            context("when the refunded deposit was non-witness", () => {
              let transactionHash: BitcoinTxHash

              beforeEach(async () => {
                const utxo =
                  depositRefundOfNonWitnessDepositAndWitnessRefunderAddress
                    .deposit.utxo
                const deposit =
                  depositRefundOfNonWitnessDepositAndWitnessRefunderAddress
                    .deposit.data
                const refunderAddress =
                  depositRefundOfNonWitnessDepositAndWitnessRefunderAddress.refunderAddress

                const rawTransactions = new Map<string, BitcoinRawTx>()
                rawTransactions.set(utxo.transactionHash.toString(), {
                  transactionHex: utxo.transactionHex,
                })
                bitcoinClient.rawTransactions = rawTransactions

                const depositRefund = DepositRefund.fromScript(
                  DepositScript.fromReceipt(deposit)
                )

                ;({ transactionHash } = await depositRefund.submitTransaction(
                  bitcoinClient,
                  fee,
                  utxo,
                  refunderAddress,
                  refunderPrivateKey
                ))
              })

              it("should broadcast refund transaction with proper structure", async () => {
                expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
                expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                  depositRefundOfNonWitnessDepositAndWitnessRefunderAddress
                    .expectedRefund.transaction
                )
              })

              it("should return the proper transaction hash", async () => {
                expect(transactionHash).to.be.deep.equal(
                  depositRefundOfNonWitnessDepositAndWitnessRefunderAddress
                    .expectedRefund.transactionHash
                )
              })
            })

            context("when the refunded deposit was Taproot-native", () => {
              let transactionHash: BitcoinTxHash
              let rawRefundTransaction: BitcoinRawTx
              let depositScript: DepositScript
              let depositUtxo: BitcoinUtxo & BitcoinRawTx
              let refundXOnlyPublicKey: Hex

              const assembleTaprootRefund = async (
                refundXOnlyPublicKey: Hex
              ) => {
                const depositReceipt: DepositReceipt = {
                  ...taprootDepositFixture.receipt,
                  refundPublicKeyHash:
                    BitcoinAddressConverter.taprootOutputKeyToWalletPublicKeyHash(
                      refundXOnlyPublicKey
                    ),
                  refundXOnlyPublicKey,
                }

                depositScript = DepositScript.fromReceipt(
                  depositReceipt,
                  DepositScriptType.P2TR
                )

                const fundingTransaction = new Transaction()
                fundingTransaction.version = 1
                fundingTransaction.addInput(Buffer.alloc(32), 0)
                fundingTransaction.addOutput(
                  await depositScript.deriveOutputScript(
                    BitcoinNetwork.Testnet
                  ),
                  depositAmount.toNumber()
                )

                depositUtxo = {
                  transactionHash: BitcoinTxHash.from(
                    fundingTransaction.getId()
                  ),
                  outputIndex: 0,
                  value: depositAmount,
                  transactionHex: fundingTransaction.toHex(),
                }

                const depositRefund = DepositRefund.fromScript(depositScript)

                ;({ transactionHash, rawTransaction: rawRefundTransaction } =
                  await depositRefund.assembleTransaction(
                    BitcoinNetwork.Testnet,
                    fee,
                    depositUtxo,
                    depositRefundOfWitnessDepositAndWitnessRefunderAddress.refunderAddress,
                    refunderPrivateKey
                  ))
              }

              const assertValidP2TRRefundWitness = async (
                signingXOnlyPublicKey: Hex
              ) => {
                const refundTransaction = Transaction.fromHex(
                  rawRefundTransaction.transactionHex
                )
                const previousOutput = Transaction.fromHex(
                  depositUtxo.transactionHex
                ).outs[depositUtxo.outputIndex]
                const [signature, refundScript, controlBlock] =
                  refundTransaction.ins[0].witness

                expect(refundTransaction.ins[0].witness).to.have.length(3)
                expect(signature).to.have.length(64)
                expect(
                  Hex.from(refundScript).equals(
                    await depositScript.getPlainText()
                  )
                ).to.be.true
                expect(controlBlock).to.have.length(33)
                expect(controlBlock[0] & 0xfe).to.equal(
                  BitcoinTaprootUtils.TAPROOT_LEAF_VERSION
                )
                expect(
                  Hex.from(controlBlock.subarray(1)).equals(
                    taprootDepositFixture.receipt.walletXOnlyPublicKey!
                  )
                ).to.be.true

                const sigHash = refundTransaction.hashForWitnessV1(
                  0,
                  [previousOutput.script],
                  [previousOutput.value],
                  0,
                  (await depositScript.getTaprootLeafHash()).toBuffer()
                )

                expect(
                  secp256k1.verifySchnorr(
                    sigHash,
                    signingXOnlyPublicKey.toBuffer(),
                    signature
                  )
                ).to.be.true
              }

              beforeEach(async () => {
                const refunderKeyPair = BitcoinPrivateKeyUtils.createKeyPair(
                  refunderPrivateKey,
                  BitcoinNetwork.Testnet
                )
                refundXOnlyPublicKey = Hex.from(
                  Buffer.from(refunderKeyPair.publicKey).subarray(1)
                )

                await assembleTaprootRefund(refundXOnlyPublicKey)
              })

              it("should assemble a valid P2TR script-path refund witness", async () => {
                await assertValidP2TRRefundWitness(refundXOnlyPublicKey)
              })

              it("should assemble a valid P2TR script-path refund witness for a BIP86 recovery key", async () => {
                const refunderKeyPair = BitcoinPrivateKeyUtils.createKeyPair(
                  refunderPrivateKey,
                  BitcoinNetwork.Testnet
                )
                refundXOnlyPublicKey =
                  BitcoinTaprootUtils.deriveTaprootOutputKey(
                    Hex.from(Buffer.from(refunderKeyPair.publicKey).subarray(1))
                  )

                await assembleTaprootRefund(refundXOnlyPublicKey)

                await assertValidP2TRRefundWitness(refundXOnlyPublicKey)
              })

              it("should return the proper transaction hash", async () => {
                expect(transactionHash).to.be.deep.equal(
                  BitcoinTxHash.from(
                    Transaction.fromHex(
                      rawRefundTransaction.transactionHex
                    ).getId()
                  )
                )
              })
            })
          }
        )

        context(
          "when the refund transaction is requested to be non-witness",
          () => {
            let transactionHash: BitcoinTxHash

            beforeEach(async () => {
              const utxo =
                depositRefundOfWitnessDepositAndNonWitnessRefunderAddress
                  .deposit.utxo
              const deposit =
                depositRefundOfWitnessDepositAndNonWitnessRefunderAddress
                  .deposit.data
              const refunderAddress =
                depositRefundOfWitnessDepositAndNonWitnessRefunderAddress.refunderAddress

              const rawTransactions = new Map<string, BitcoinRawTx>()
              rawTransactions.set(utxo.transactionHash.toString(), {
                transactionHex: utxo.transactionHex,
              })

              const depositRefund = DepositRefund.fromScript(
                DepositScript.fromReceipt(deposit)
              )

              bitcoinClient.rawTransactions = rawTransactions
              ;({ transactionHash } = await depositRefund.submitTransaction(
                bitcoinClient,
                fee,
                utxo,
                refunderAddress,
                refunderPrivateKey
              ))
            })

            it("should broadcast refund transaction with proper structure", async () => {
              expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
              expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                depositRefundOfWitnessDepositAndNonWitnessRefunderAddress
                  .expectedRefund.transaction
              )
            })

            it("should return the proper transaction hash", async () => {
              expect(transactionHash).to.be.deep.equal(
                depositRefundOfWitnessDepositAndNonWitnessRefunderAddress
                  .expectedRefund.transactionHash
              )
            })
          }
        )
      })
    })
  })

  describe("CrossChainDepositor", () => {
    const l2DepositOwner = EthereumAddress.from(
      "a7C94958CDC477feE1F7D78705275238134699F5"
    )

    let l2BitcoinDepositor: MockBitcoinDepositor
    let l1BitcoinDepositor: MockL1BitcoinDepositor
    let l1BitcoinRedeemer: MockL1BitcoinRedeemer
    let l2BitcoinRedeemer: MockL2BitcoinRedeemer
    let crossChainContracts: CrossChainContracts
    let depositor: CrossChainDepositor

    beforeEach(async () => {
      const l2BitcoinDepositorAddress = EthereumAddress.from(
        "49D1e49013Df517Ea30306DE2F462F2D0170212f"
      )
      const l2BitcoinDepositorEncoder = new MockCrossChainExtraDataEncoder()
      l2BitcoinDepositorEncoder.setEncoding(l2DepositOwner, Hex.from("00E2"))
      l2BitcoinDepositor = new MockL2BitcoinDepositor(
        l2BitcoinDepositorAddress,
        l2BitcoinDepositorEncoder
      )

      const l1BitcoinDepositorAddress = EthereumAddress.from(
        "F4c1B212B37775769c73353264ac48dD7fA5B71E"
      )
      const l1BitcoinDepositorEncoder = new MockCrossChainExtraDataEncoder()
      l1BitcoinDepositorEncoder.setEncoding(l2DepositOwner, Hex.from("00E1"))
      l1BitcoinDepositor = new MockL1BitcoinDepositor(
        l1BitcoinDepositorAddress,
        l1BitcoinDepositorEncoder
      )

      l1BitcoinRedeemer = new MockL1BitcoinRedeemer(
        EthereumAddress.from("0x1111111111111111111111111111111111111111")
      )
      l2BitcoinRedeemer = new MockL2BitcoinRedeemer(
        EthereumAddress.from("0x2222222222222222222222222222222222222222")
      )

      crossChainContracts = {
        destinationChainTbtcToken: new MockL2TBTCToken(),
        destinationChainBitcoinDepositor: l2BitcoinDepositor,
        l1BitcoinDepositor: l1BitcoinDepositor,
        l1BitcoinRedeemer: l1BitcoinRedeemer,
        l2BitcoinRedeemer: l2BitcoinRedeemer,
      }

      depositor = new CrossChainDepositor(crossChainContracts)
    })

    describe("getChainIdentifier", () => {
      it("should return the chain identifier of L1BitcoinDepositor contract", () => {
        const actual = depositor.getChainIdentifier()
        const expected =
          crossChainContracts.l1BitcoinDepositor.getChainIdentifier()

        expect(expected.equals(actual)).to.be.true
      })
    })

    describe("supportsTaprootDeposits", () => {
      it("should fail closed when neither adapter declares support", () => {
        expect(depositor.supportsTaprootDeposits()).to.be.false
      })

      it("should require both destination-chain and L1 support in L2 mode", () => {
        l2BitcoinDepositor.taprootDepositsSupported = true
        expect(depositor.supportsTaprootDeposits()).to.be.false

        l2BitcoinDepositor.taprootDepositsSupported = false
        l1BitcoinDepositor.taprootDepositsSupported = true
        expect(depositor.supportsTaprootDeposits()).to.be.false

        l2BitcoinDepositor.taprootDepositsSupported = true
        expect(depositor.supportsTaprootDeposits()).to.be.true
      })

      it("should require only L1 support in L1 mode", () => {
        depositor = new CrossChainDepositor(
          crossChainContracts,
          "L1Transaction"
        )

        expect(depositor.supportsTaprootDeposits()).to.be.false

        l1BitcoinDepositor.taprootDepositsSupported = true
        expect(depositor.supportsTaprootDeposits()).to.be.true
      })
    })

    describe("extraData", () => {
      context(
        "when the deposit owner is not set in the L2BitcoinDepositor contract",
        () => {
          it("should throw", () => {
            expect(() => depositor.extraData()).to.throw(
              "Cannot resolve destination chain deposit owner"
            )
          })
        }
      )

      context(
        "when the deposit owner is set in the L2BitcoinDepositor contract",
        () => {
          beforeEach(async () => {
            crossChainContracts.destinationChainBitcoinDepositor.setDepositOwner(
              l2DepositOwner
            )
          })

          context("when reveal mode is L2Transaction", () => {
            beforeEach(async () => {
              depositor = new CrossChainDepositor(
                crossChainContracts,
                "L2Transaction"
              )
            })

            it("should return the extra data encoded using the L2BitcoinDepositor contract", async () => {
              const actual = depositor.extraData()
              const expected = Hex.from("00E2")

              expect(expected.equals(actual)).to.be.true
            })
          })

          context("when reveal mode is L1Transaction", () => {
            beforeEach(async () => {
              depositor = new CrossChainDepositor(
                crossChainContracts,
                "L1Transaction"
              )
            })

            it("should return the extra data encoded using the L1BitcoinDepositor contract", async () => {
              const actual = depositor.extraData()
              const expected = Hex.from("00E1")

              expect(expected.equals(actual)).to.be.true
            })
          })
        }
      )
    })

    describe("revealDeposit", () => {
      // Just short byte strings for clarity.
      const depositTx: BitcoinRawTxVectors = {
        version: Hex.from("00000000"),
        inputs: Hex.from("11111111"),
        outputs: Hex.from("22222222"),
        locktime: Hex.from("33333333"),
      }
      const depositOutputIndex: number = 2
      const deposit: DepositReceipt = {
        depositor: EthereumAddress.from(
          "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
        ),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "28e081f285138ccbe389c1eb8985716230129f89"
        ),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: Hex.from("60bcea61"),
        extraData: Hex.from(
          `000000000000000000000000${l2DepositOwner.identifierHex}`
        ),
      }
      const taprootDeposit: DepositReceipt = {
        ...deposit,
        walletXOnlyPublicKey:
          taprootDepositFixture.receipt.walletXOnlyPublicKey,
        refundXOnlyPublicKey:
          taprootDepositFixture.receipt.refundXOnlyPublicKey,
      }
      const vault: ChainIdentifier = EthereumAddress.from(
        "82883a4c7a8dd73ef165deb402d432613615ced4"
      )

      context("when reveal mode is L2Transaction", () => {
        beforeEach(async () => {
          depositor = new CrossChainDepositor(
            crossChainContracts,
            "L2Transaction"
          )

          await depositor.revealDeposit(
            depositTx,
            depositOutputIndex,
            deposit,
            vault
          )
        })

        it("should reveal the deposit using the L2BitcoinDepositor contract", async () => {
          expect(l1BitcoinDepositor.initializeDepositCalls.length).to.be.equal(
            0
          )

          expect(l2BitcoinDepositor.initializeDepositCalls.length).to.be.equal(
            1
          )
          expect(l2BitcoinDepositor.initializeDepositCalls[0]).to.be.eql({
            depositTx,
            depositOutputIndex,
            deposit,
            vault,
          })
        })
      })

      context("when reveal mode is L1Transaction", () => {
        beforeEach(async () => {
          depositor = new CrossChainDepositor(
            crossChainContracts,
            "L1Transaction"
          )

          await depositor.revealDeposit(
            depositTx,
            depositOutputIndex,
            deposit,
            vault
          )
        })

        it("should reveal the deposit using the L1BitcoinDepositor contract", async () => {
          expect(l2BitcoinDepositor.initializeDepositCalls.length).to.be.equal(
            0
          )

          expect(l1BitcoinDepositor.initializeDepositCalls.length).to.be.equal(
            1
          )
          expect(l1BitcoinDepositor.initializeDepositCalls[0]).to.be.eql({
            depositTx,
            depositOutputIndex,
            deposit,
            vault,
          })
        })
      })

      context("when the deposit is Taproot-native", () => {
        it("should reject before calling either adapter when support is absent", async () => {
          await expect(
            depositor.revealDeposit(
              depositTx,
              depositOutputIndex,
              taprootDeposit,
              vault
            )
          ).to.be.rejectedWith(
            "Taproot deposits are not supported by this depositor"
          )

          expect(l2BitcoinDepositor.initializeDepositCalls).to.be.empty
          expect(l1BitcoinDepositor.initializeDepositCalls).to.be.empty
        })

        it("should forward the x-only keys when both adapters support Taproot", async () => {
          l2BitcoinDepositor.taprootDepositsSupported = true
          l1BitcoinDepositor.taprootDepositsSupported = true

          await depositor.revealDeposit(
            depositTx,
            depositOutputIndex,
            taprootDeposit,
            vault
          )

          expect(l2BitcoinDepositor.initializeDepositCalls.length).to.be.equal(
            1
          )

          const forwardedDeposit =
            l2BitcoinDepositor.initializeDepositCalls[0].deposit
          expect(forwardedDeposit).to.be.eql(taprootDeposit)
          expect(forwardedDeposit.walletXOnlyPublicKey).to.be.deep.equal(
            taprootDepositFixture.receipt.walletXOnlyPublicKey
          )
          expect(forwardedDeposit.refundXOnlyPublicKey).to.be.deep.equal(
            taprootDepositFixture.receipt.refundXOnlyPublicKey
          )
        })
      })
    })
  })
})
