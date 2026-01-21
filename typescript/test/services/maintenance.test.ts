import { BigNumber, BigNumberish } from "@ethersproject/bignumber"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import {
  BitcoinHashUtils,
  BitcoinNetwork,
  BitcoinRawTx,
  BitcoinTx,
  BitcoinTxHash,
  BitcoinTxMerkleBranch,
  BitcoinUtxo,
  Hex,
  MaintenanceService,
  RedemptionRequest,
  WalletTx,
} from "../../src"
import {
  depositSweepProof,
  depositSweepWithNoMainUtxoAndNonWitnessOutput,
  depositSweepWithNoMainUtxoAndWitnessOutput,
  depositSweepWithNonWitnessMainUtxoAndWitnessOutput,
  depositSweepWithWitnessMainUtxoAndWitnessOutput,
  NO_MAIN_UTXO,
} from "../data/deposit-sweep"
import { testnetWalletAddress, testnetWalletPrivateKey } from "../data/deposit"
import { expect } from "chai"
import { txToJSON } from "../utils/helpers"
import {
  multipleRedemptionsWithoutChange,
  multipleRedemptionsWithWitnessChange,
  p2pkhWalletAddress,
  p2wpkhWalletAddress,
  redemptionProof,
  RedemptionTestData,
  singleP2PKHRedemptionWithWitnessChange,
  singleP2SHRedemptionWithNonWitnessChange,
  singleP2SHRedemptionWithWitnessChange,
  singleP2WPKHRedemptionWithWitnessChange,
  singleP2WSHRedemptionWithWitnessChange,
  walletPrivateKey,
  walletPublicKey,
} from "../data/redemption"
import { runRedemptionScenario } from "./redemptions.test"

describe("Maintenance", () => {
  describe("WalletTx", () => {
    describe("DepositSweep", () => {
      const fee = BigNumber.from(1600)

      describe("submitTransaction", () => {
        let tbtcContracts: MockTBTCContracts
        let bitcoinClient: MockBitcoinClient

        beforeEach(async () => {
          tbtcContracts = new MockTBTCContracts()
          bitcoinClient = new MockBitcoinClient()
        })

        context("when the new main UTXO is requested to be witness", () => {
          context(
            "when there is no main UTXO from previous deposit sweep",
            () => {
              let transactionHash: BitcoinTxHash
              let newMainUtxo: BitcoinUtxo

              beforeEach(async () => {
                // Map transaction hashes for UTXOs to transactions in hexadecimal and
                // set the mapping in the mock Bitcoin client
                const rawTransactions = new Map<string, BitcoinRawTx>()
                for (const deposit of depositSweepWithNoMainUtxoAndWitnessOutput.deposits) {
                  rawTransactions.set(deposit.utxo.transactionHash.toString(), {
                    transactionHex: deposit.utxo.transactionHex,
                  })
                }
                bitcoinClient.rawTransactions = rawTransactions

                const utxos: BitcoinUtxo[] =
                  depositSweepWithNoMainUtxoAndWitnessOutput.deposits.map(
                    (data) => {
                      return data.utxo
                    }
                  )

                const deposit =
                  depositSweepWithNoMainUtxoAndWitnessOutput.deposits.map(
                    (deposit) => {
                      return deposit.data
                    }
                  )
                const witness =
                  depositSweepWithNoMainUtxoAndWitnessOutput.witness

                const walletTx = new WalletTx(
                  tbtcContracts,
                  bitcoinClient,
                  witness
                )

                ;({ transactionHash, newMainUtxo } =
                  await walletTx.depositSweep.submitTransaction(
                    fee,
                    testnetWalletPrivateKey,
                    utxos,
                    deposit
                  ))
              })

              it("should broadcast sweep transaction with proper structure", async () => {
                expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
                expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                  depositSweepWithNoMainUtxoAndWitnessOutput.expectedSweep
                    .transaction
                )
              })

              it("should return the proper transaction hash", async () => {
                expect(transactionHash).to.be.deep.equal(
                  depositSweepWithNoMainUtxoAndWitnessOutput.expectedSweep
                    .transactionHash
                )
              })

              it("should return the proper new main UTXO", () => {
                const expectedNewMainUtxo = {
                  transactionHash:
                    depositSweepWithNoMainUtxoAndWitnessOutput.expectedSweep
                      .transactionHash,
                  outputIndex: 0,
                  value: BigNumber.from(35400),
                }

                expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
              })
            }
          )

          context("when there is main UTXO from previous deposit sweep", () => {
            context(
              "when main UTXO from previous deposit sweep is witness",
              () => {
                let transactionHash: BitcoinTxHash
                let newMainUtxo: BitcoinUtxo

                beforeEach(async () => {
                  // Map transaction hashes for UTXOs to transactions in hexadecimal and
                  // set the mapping in the mock Bitcoin client
                  const rawTransactions = new Map<string, BitcoinRawTx>()
                  for (const deposit of depositSweepWithWitnessMainUtxoAndWitnessOutput.deposits) {
                    rawTransactions.set(
                      deposit.utxo.transactionHash.toString(),
                      {
                        transactionHex: deposit.utxo.transactionHex,
                      }
                    )
                  }
                  // The main UTXO resulting from another data set was used as input.
                  // Set raw data of that main UTXO as well.
                  rawTransactions.set(
                    depositSweepWithNoMainUtxoAndWitnessOutput.expectedSweep.transactionHash.toString(),
                    depositSweepWithNoMainUtxoAndWitnessOutput.expectedSweep
                      .transaction
                  )
                  bitcoinClient.rawTransactions = rawTransactions

                  const utxos: BitcoinUtxo[] =
                    depositSweepWithWitnessMainUtxoAndWitnessOutput.deposits.map(
                      (deposit) => {
                        return deposit.utxo
                      }
                    )

                  const deposit =
                    depositSweepWithWitnessMainUtxoAndWitnessOutput.deposits.map(
                      (deposit) => {
                        return deposit.data
                      }
                    )

                  const witness =
                    depositSweepWithWitnessMainUtxoAndWitnessOutput.witness

                  const mainUtxo =
                    depositSweepWithWitnessMainUtxoAndWitnessOutput.mainUtxo

                  const walletTx = new WalletTx(
                    tbtcContracts,
                    bitcoinClient,
                    witness
                  )

                  ;({ transactionHash, newMainUtxo } =
                    await walletTx.depositSweep.submitTransaction(
                      fee,
                      testnetWalletPrivateKey,
                      utxos,
                      deposit,
                      mainUtxo
                    ))
                })

                it("should broadcast sweep transaction with proper structure", async () => {
                  expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
                  expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                    depositSweepWithWitnessMainUtxoAndWitnessOutput
                      .expectedSweep.transaction
                  )
                })

                it("should return the proper transaction hash", async () => {
                  expect(transactionHash).to.be.deep.equal(
                    depositSweepWithWitnessMainUtxoAndWitnessOutput
                      .expectedSweep.transactionHash
                  )
                })

                it("should return the proper new main UTXO", () => {
                  const expectedNewMainUtxo = {
                    transactionHash:
                      depositSweepWithWitnessMainUtxoAndWitnessOutput
                        .expectedSweep.transactionHash,
                    outputIndex: 0,
                    value: BigNumber.from(60800),
                  }

                  expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                })
              }
            )

            context(
              "when main UTXO from previous deposit sweep is non-witness",
              () => {
                let transactionHash: BitcoinTxHash
                let newMainUtxo: BitcoinUtxo

                beforeEach(async () => {
                  // Map transaction hashes for UTXOs to transactions in hexadecimal and
                  // set the mapping in the mock Bitcoin client
                  const rawTransactions = new Map<string, BitcoinRawTx>()
                  for (const deposit of depositSweepWithNonWitnessMainUtxoAndWitnessOutput.deposits) {
                    rawTransactions.set(
                      deposit.utxo.transactionHash.toString(),
                      {
                        transactionHex: deposit.utxo.transactionHex,
                      }
                    )
                  }
                  rawTransactions.set(
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput.mainUtxo.transactionHash.toString(),
                    {
                      transactionHex:
                        depositSweepWithNonWitnessMainUtxoAndWitnessOutput
                          .mainUtxo.transactionHex,
                    }
                  )
                  bitcoinClient.rawTransactions = rawTransactions

                  const utxos: BitcoinUtxo[] =
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput.deposits.map(
                      (deposit) => {
                        return deposit.utxo
                      }
                    )

                  const deposit =
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput.deposits.map(
                      (deposit) => {
                        return deposit.data
                      }
                    )

                  const witness =
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput.witness

                  const mainUtxo =
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput.mainUtxo

                  const walletTx = new WalletTx(
                    tbtcContracts,
                    bitcoinClient,
                    witness
                  )

                  ;({ transactionHash, newMainUtxo } =
                    await walletTx.depositSweep.submitTransaction(
                      fee,
                      testnetWalletPrivateKey,
                      utxos,
                      deposit,
                      mainUtxo
                    ))
                })

                it("should broadcast sweep transaction with proper structure", async () => {
                  expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
                  expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput
                      .expectedSweep.transaction
                  )
                })

                it("should return the proper transaction hash", async () => {
                  expect(transactionHash).to.be.deep.equal(
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput
                      .expectedSweep.transactionHash
                  )
                })

                it("should return the proper new main UTXO", () => {
                  const expectedNewMainUtxo = {
                    transactionHash:
                      depositSweepWithNonWitnessMainUtxoAndWitnessOutput
                        .expectedSweep.transactionHash,
                    outputIndex: 0,
                    value: BigNumber.from(33800),
                  }

                  expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                })
              }
            )
          })
        })

        context("when the new main UTXO is requested to be non-witness", () => {
          // The only difference between deposit sweep transactions with witness and
          // non-witness output is the output type itself.
          // Therefore only one test case was added for non-witness transactions.
          let transactionHash: BitcoinTxHash
          let newMainUtxo: BitcoinUtxo

          beforeEach(async () => {
            // Map transaction hashes for UTXOs to transactions in hexadecimal and
            // set the mapping in the mock Bitcoin client
            const rawTransactions = new Map<string, BitcoinRawTx>()
            for (const deposit of depositSweepWithNoMainUtxoAndNonWitnessOutput.deposits) {
              rawTransactions.set(deposit.utxo.transactionHash.toString(), {
                transactionHex: deposit.utxo.transactionHex,
              })
            }
            bitcoinClient.rawTransactions = rawTransactions

            const utxos =
              depositSweepWithNoMainUtxoAndNonWitnessOutput.deposits.map(
                (data) => {
                  return data.utxo
                }
              )

            const deposits =
              depositSweepWithNoMainUtxoAndNonWitnessOutput.deposits.map(
                (deposit) => {
                  return deposit.data
                }
              )
            const witness =
              depositSweepWithNoMainUtxoAndNonWitnessOutput.witness

            const walletTx = new WalletTx(tbtcContracts, bitcoinClient, witness)

            ;({ transactionHash, newMainUtxo } =
              await walletTx.depositSweep.submitTransaction(
                fee,
                testnetWalletPrivateKey,
                utxos,
                deposits
              ))
          })

          it("should broadcast sweep transaction with proper structure", async () => {
            expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
            expect(bitcoinClient.broadcastLog[0]).to.be.eql(
              depositSweepWithNoMainUtxoAndNonWitnessOutput.expectedSweep
                .transaction
            )
          })

          it("should return the proper transaction hash", async () => {
            expect(transactionHash).to.be.deep.equal(
              depositSweepWithNoMainUtxoAndNonWitnessOutput.expectedSweep
                .transactionHash
            )
          })

          it("should return the proper new main UTXO", () => {
            const expectedNewMainUtxo = {
              transactionHash:
                depositSweepWithNoMainUtxoAndNonWitnessOutput.expectedSweep
                  .transactionHash,
              outputIndex: 0,
              value: BigNumber.from(13400),
            }

            expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
          })
        })
      })

      describe("assembleTransaction", () => {
        let tbtcContracts: MockTBTCContracts
        let bitcoinClient: MockBitcoinClient

        beforeEach(async () => {
          tbtcContracts = new MockTBTCContracts()
          bitcoinClient = new MockBitcoinClient()
        })

        context("when the new main UTXO is requested to be witness", () => {
          context(
            "when there is no main UTXO from previous deposit sweep",
            () => {
              let transactionHash: BitcoinTxHash
              let newMainUtxo: BitcoinUtxo
              let transaction: BitcoinRawTx

              const utxosWithRaw =
                depositSweepWithNoMainUtxoAndWitnessOutput.deposits.map(
                  (data) => {
                    return data.utxo
                  }
                )

              const deposit =
                depositSweepWithNoMainUtxoAndWitnessOutput.deposits.map(
                  (deposit) => {
                    return deposit.data
                  }
                )

              const witness = depositSweepWithNoMainUtxoAndWitnessOutput.witness

              const walletTx = new WalletTx(
                tbtcContracts,
                bitcoinClient,
                witness
              )

              beforeEach(async () => {
                ;({
                  transactionHash,
                  newMainUtxo,
                  rawTransaction: transaction,
                } = await walletTx.depositSweep.assembleTransaction(
                  BitcoinNetwork.Testnet,
                  fee,
                  testnetWalletPrivateKey,
                  utxosWithRaw,
                  deposit
                ))
              })

              it("should return sweep transaction with proper structure", () => {
                // Compare HEXes.
                expect(transaction).to.be.eql(
                  depositSweepWithNoMainUtxoAndWitnessOutput.expectedSweep
                    .transaction
                )

                // Convert raw transaction to JSON to make detailed comparison.
                const txJSON = txToJSON(
                  transaction.transactionHex,
                  BitcoinNetwork.Testnet
                )

                expect(txJSON.hash).to.be.equal(
                  depositSweepWithNoMainUtxoAndWitnessOutput.expectedSweep.transactionHash.toString()
                )
                expect(txJSON.version).to.be.equal(1)

                // Validate inputs.
                expect(txJSON.inputs.length).to.be.equal(2)

                const p2shInput = txJSON.inputs[0]
                expect(p2shInput.hash).to.be.equal(
                  depositSweepWithNoMainUtxoAndWitnessOutput.deposits[0].utxo.transactionHash.toString()
                )
                expect(p2shInput.index).to.be.equal(
                  depositSweepWithNoMainUtxoAndWitnessOutput.deposits[0].utxo
                    .outputIndex
                )
                // Transaction should be signed. As it's not SegWit input, the `witness`
                // field should be empty, while the `script` field should be filled.
                expect(p2shInput.witness).to.be.empty
                expect(p2shInput.script.length).to.be.greaterThan(0)

                const p2wshInput = txJSON.inputs[1]
                expect(p2wshInput.hash).to.be.equal(
                  depositSweepWithNoMainUtxoAndWitnessOutput.deposits[1].utxo.transactionHash.toString()
                )
                expect(p2wshInput.index).to.be.equal(
                  depositSweepWithNoMainUtxoAndWitnessOutput.deposits[1].utxo
                    .outputIndex
                )
                // Transaction should be signed. As it's a SegWit input, the `witness`
                // field should be filled, while the `script` field should be empty.
                expect(p2wshInput.witness.length).to.be.greaterThan(0)
                expect(p2wshInput.script.length).to.be.equal(0)

                // Validate outputs.
                expect(txJSON.outputs.length).to.be.equal(1)
                const sweepOutput = txJSON.outputs[0]

                // Should be OP_0 <public-key-hash>. Public key corresponds to the
                // wallet BTC address.
                expect(sweepOutput.script).to.be.equal(
                  "00148db50eb52063ea9d98b3eac91489a90f738986f6"
                )
                // The output's address should be the wallet's address
                expect(sweepOutput.address).to.be.equal(testnetWalletAddress)
                // The output's value should be equal to the sum of all input values
                // minus fee (25000 + 12000 - 1600)
                expect(sweepOutput.value).to.be.equal(35400)
              })

              it("should return the proper transaction hash", async () => {
                expect(transactionHash).to.be.deep.equal(
                  depositSweepWithNoMainUtxoAndWitnessOutput.expectedSweep
                    .transactionHash
                )
              })

              it("should return the proper new main UTXO", () => {
                const expectedNewMainUtxo = {
                  transactionHash:
                    depositSweepWithNoMainUtxoAndWitnessOutput.expectedSweep
                      .transactionHash,
                  outputIndex: 0,
                  value: BigNumber.from(35400),
                }

                expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
              })
            }
          )

          context("when there is main UTXO from previous deposit sweep", () => {
            context(
              "when main UTXO prom previous deposit sweep is witness",
              () => {
                let transactionHash: BitcoinTxHash
                let newMainUtxo: BitcoinUtxo
                let transaction: BitcoinRawTx

                const utxosWithRaw =
                  depositSweepWithWitnessMainUtxoAndWitnessOutput.deposits.map(
                    (deposit) => {
                      return deposit.utxo
                    }
                  )

                const deposit =
                  depositSweepWithWitnessMainUtxoAndWitnessOutput.deposits.map(
                    (deposit) => {
                      return deposit.data
                    }
                  )

                // P2WPKH
                const mainUtxoWithRaw =
                  depositSweepWithWitnessMainUtxoAndWitnessOutput.mainUtxo

                const witness =
                  depositSweepWithWitnessMainUtxoAndWitnessOutput.witness

                const walletTx = new WalletTx(
                  tbtcContracts,
                  bitcoinClient,
                  witness
                )

                beforeEach(async () => {
                  ;({
                    transactionHash,
                    newMainUtxo,
                    rawTransaction: transaction,
                  } = await walletTx.depositSweep.assembleTransaction(
                    BitcoinNetwork.Testnet,
                    fee,
                    testnetWalletPrivateKey,
                    utxosWithRaw,
                    deposit,
                    mainUtxoWithRaw
                  ))
                })

                it("should return sweep transaction with proper structure", () => {
                  // Compare HEXes.
                  expect(transaction).to.be.eql(
                    depositSweepWithWitnessMainUtxoAndWitnessOutput
                      .expectedSweep.transaction
                  )

                  // Convert raw transaction to JSON to make detailed comparison.
                  const txJSON = txToJSON(
                    transaction.transactionHex,
                    BitcoinNetwork.Testnet
                  )

                  expect(txJSON.hash).to.be.equal(
                    depositSweepWithWitnessMainUtxoAndWitnessOutput.expectedSweep.transactionHash.toString()
                  )
                  expect(txJSON.version).to.be.equal(1)

                  // Validate inputs.
                  expect(txJSON.inputs.length).to.be.equal(3)

                  const p2wkhInput = txJSON.inputs[0]
                  expect(p2wkhInput.hash).to.be.equal(
                    depositSweepWithWitnessMainUtxoAndWitnessOutput.mainUtxo.transactionHash.toString()
                  )
                  expect(p2wkhInput.index).to.be.equal(
                    depositSweepWithWitnessMainUtxoAndWitnessOutput.mainUtxo
                      .outputIndex
                  )
                  // Transaction should be signed. As it's a SegWit input, the `witness`
                  // field should be filled, while the `script` field should be empty.
                  expect(p2wkhInput.witness.length).to.be.greaterThan(0)
                  expect(p2wkhInput.script.length).to.be.equal(0)

                  const p2shInput = txJSON.inputs[1]
                  expect(p2shInput.hash).to.be.equal(
                    depositSweepWithWitnessMainUtxoAndWitnessOutput.deposits[0].utxo.transactionHash.toString()
                  )
                  expect(p2shInput.index).to.be.equal(
                    depositSweepWithWitnessMainUtxoAndWitnessOutput.deposits[0]
                      .utxo.outputIndex
                  )
                  // Transaction should be signed. As it's not SegWit input, the `witness`
                  // field should be empty, while the `script` field should be filled.
                  expect(p2shInput.witness).to.be.empty
                  expect(p2shInput.script.length).to.be.greaterThan(0)

                  const p2wshInput = txJSON.inputs[2]
                  expect(p2wshInput.hash).to.be.equal(
                    depositSweepWithWitnessMainUtxoAndWitnessOutput.deposits[1].utxo.transactionHash.toString()
                  )
                  expect(p2wshInput.index).to.be.equal(
                    depositSweepWithWitnessMainUtxoAndWitnessOutput.deposits[1]
                      .utxo.outputIndex
                  )
                  // Transaction should be signed. As it's a SegWit input, the `witness`
                  // field should be filled, while the `script` field should be empty.
                  expect(p2wshInput.witness.length).to.be.greaterThan(0)
                  expect(p2wshInput.script.length).to.be.equal(0)

                  // Validate outputs.
                  expect(txJSON.outputs.length).to.be.equal(1)

                  const sweepOutput = txJSON.outputs[0]
                  // Should be OP_0 <public-key-hash>. Public key corresponds to the
                  // wallet BTC address.
                  expect(sweepOutput.script).to.be.equal(
                    "00148db50eb52063ea9d98b3eac91489a90f738986f6"
                  )
                  // The output's address should be the wallet's address
                  expect(sweepOutput.address).to.be.equal(testnetWalletAddress)
                  // The output's value should be equal to the sum of all input values
                  // minus fee (17000 + 10000 + 35400 - 1600)
                  expect(sweepOutput.value).to.be.equal(60800)
                })

                it("should return the proper transaction hash", async () => {
                  expect(transactionHash).to.be.deep.equal(
                    depositSweepWithWitnessMainUtxoAndWitnessOutput
                      .expectedSweep.transactionHash
                  )
                })

                it("should return the proper new main UTXO", () => {
                  const expectedNewMainUtxo = {
                    transactionHash:
                      depositSweepWithWitnessMainUtxoAndWitnessOutput
                        .expectedSweep.transactionHash,
                    outputIndex: 0,
                    value: BigNumber.from(60800),
                  }

                  expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                })
              }
            )

            context(
              "when main UTXO from previous deposit sweep is non-witness",
              () => {
                let transactionHash: BitcoinTxHash
                let newMainUtxo: BitcoinUtxo
                let transaction: BitcoinRawTx

                const utxosWithRaw =
                  depositSweepWithNonWitnessMainUtxoAndWitnessOutput.deposits.map(
                    (deposit) => {
                      return deposit.utxo
                    }
                  )

                const deposit =
                  depositSweepWithNonWitnessMainUtxoAndWitnessOutput.deposits.map(
                    (deposit) => {
                      return deposit.data
                    }
                  )

                // P2WPKH
                const mainUtxoWithRaw =
                  depositSweepWithNonWitnessMainUtxoAndWitnessOutput.mainUtxo

                const witness =
                  depositSweepWithNonWitnessMainUtxoAndWitnessOutput.witness

                const walletTx = new WalletTx(
                  tbtcContracts,
                  bitcoinClient,
                  witness
                )

                beforeEach(async () => {
                  ;({
                    transactionHash,
                    newMainUtxo,
                    rawTransaction: transaction,
                  } = await walletTx.depositSweep.assembleTransaction(
                    BitcoinNetwork.Testnet,
                    fee,
                    testnetWalletPrivateKey,
                    utxosWithRaw,
                    deposit,
                    mainUtxoWithRaw
                  ))
                })

                it("should return sweep transaction with proper structure", () => {
                  // Compare HEXes.
                  expect(transaction).to.be.eql(
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput
                      .expectedSweep.transaction
                  )

                  // Convert raw transaction to JSON to make detailed comparison.
                  const txJSON = txToJSON(
                    transaction.transactionHex,
                    BitcoinNetwork.Testnet
                  )

                  expect(txJSON.hash).to.be.equal(
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput.expectedSweep.transactionHash.toString()
                  )
                  expect(txJSON.version).to.be.equal(1)

                  // Validate inputs.
                  expect(txJSON.inputs.length).to.be.equal(2)

                  const p2pkhInput = txJSON.inputs[0] // main UTXO
                  expect(p2pkhInput.hash).to.be.equal(
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput.mainUtxo.transactionHash.toString()
                  )
                  expect(p2pkhInput.index).to.be.equal(
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput.mainUtxo
                      .outputIndex
                  )
                  // Transaction should be signed. As it's not SegWit input, the `witness`
                  // field should be empty, while the `script` field should be filled.
                  expect(p2pkhInput.witness).to.be.empty
                  expect(p2pkhInput.script.length).to.be.greaterThan(0)

                  const p2wshInput = txJSON.inputs[1]
                  expect(p2wshInput.hash).to.be.equal(
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput.deposits[0].utxo.transactionHash.toString()
                  )
                  expect(p2wshInput.index).to.be.equal(
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput
                      .deposits[0].utxo.outputIndex
                  )
                  // Transaction should be signed. As it's a SegWit input, the `witness`
                  // field should be filled, while the `script` field should be empty.
                  expect(p2wshInput.witness.length).to.be.greaterThan(0)
                  expect(p2wshInput.script.length).to.be.equal(0)

                  // Validate outputs.
                  expect(txJSON.outputs.length).to.be.equal(1)

                  const sweepOutput = txJSON.outputs[0]
                  // Should be OP_0 <public-key-hash>. Public key corresponds to the
                  // wallet BTC address.
                  expect(sweepOutput.script).to.be.equal(
                    "00148db50eb52063ea9d98b3eac91489a90f738986f6"
                  )
                  // The output's address should be the wallet's address
                  expect(sweepOutput.address).to.be.equal(testnetWalletAddress)
                  // The output's value should be equal to the sum of all input values
                  // minus fee (16400 + 19000 - 1600)
                  expect(sweepOutput.value).to.be.equal(33800)
                })

                it("should return the proper transaction hash", async () => {
                  expect(transactionHash).to.be.deep.equal(
                    depositSweepWithNonWitnessMainUtxoAndWitnessOutput
                      .expectedSweep.transactionHash
                  )
                })

                it("should return the proper new main UTXO", () => {
                  const expectedNewMainUtxo = {
                    transactionHash:
                      depositSweepWithNonWitnessMainUtxoAndWitnessOutput
                        .expectedSweep.transactionHash,
                    outputIndex: 0,
                    value: BigNumber.from(33800),
                  }

                  expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                })
              }
            )
          })
        })

        context("when the new main UTXO is requested to be non-witness", () => {
          // The only difference between deposit sweep transactions with witness and
          // non-witness output is the output type itself.
          // Therefore only one test case was added for non-witness transactions.
          let transactionHash: BitcoinTxHash
          let newMainUtxo: BitcoinUtxo
          let transaction: BitcoinRawTx

          const utxosWithRaw =
            depositSweepWithNoMainUtxoAndNonWitnessOutput.deposits.map(
              (deposit) => {
                return deposit.utxo
              }
            )

          const deposit =
            depositSweepWithNoMainUtxoAndNonWitnessOutput.deposits.map(
              (deposit) => {
                return deposit.data
              }
            )

          const witness = depositSweepWithNoMainUtxoAndNonWitnessOutput.witness

          const walletTx = new WalletTx(tbtcContracts, bitcoinClient, witness)

          beforeEach(async () => {
            ;({
              transactionHash,
              newMainUtxo,
              rawTransaction: transaction,
            } = await walletTx.depositSweep.assembleTransaction(
              BitcoinNetwork.Testnet,
              fee,
              testnetWalletPrivateKey,
              utxosWithRaw,
              deposit
            ))
          })

          it("should return sweep transaction with proper structure", () => {
            // Compare HEXes.
            expect(transaction).to.be.eql(
              depositSweepWithNoMainUtxoAndNonWitnessOutput.expectedSweep
                .transaction
            )

            // Convert raw transaction to JSON to make detailed comparison.
            const txJSON = txToJSON(
              transaction.transactionHex,
              BitcoinNetwork.Testnet
            )

            expect(txJSON.hash).to.be.equal(
              depositSweepWithNoMainUtxoAndNonWitnessOutput.expectedSweep.transactionHash.toString()
            )
            expect(txJSON.version).to.be.equal(1)

            // Validate inputs.
            expect(txJSON.inputs.length).to.be.equal(1)

            const p2shInput = txJSON.inputs[0]
            expect(p2shInput.hash).to.be.equal(
              depositSweepWithNoMainUtxoAndNonWitnessOutput.deposits[0].utxo.transactionHash.toString()
            )
            expect(p2shInput.index).to.be.equal(
              depositSweepWithNoMainUtxoAndNonWitnessOutput.deposits[0].utxo
                .outputIndex
            )
            // Transaction should be signed. As it's not SegWit input, the `witness`
            // field should be empty, while the `script` field should be filled.
            expect(p2shInput.witness).to.be.empty
            expect(p2shInput.script.length).to.be.greaterThan(0)

            // Validate outputs.
            expect(txJSON.outputs.length).to.be.equal(1)

            const sweepOutput = txJSON.outputs[0]
            // OP_DUP OP_HASH160 0x14 0x8db50eb52063ea9d98b3eac91489a90f738986f6
            // OP_EQUALVERIFY OP_CHECKSIG
            expect(sweepOutput.script).to.be.equal(
              "76a9148db50eb52063ea9d98b3eac91489a90f738986f688ac"
            )
            // The output's address should be the wallet's address
            expect(sweepOutput.address).to.be.equal(
              "mtSEUCE7G8om9zJttG9twtjoiSsUz7QnY9"
            )
            // The output's value should be equal to the sum of all input values
            // minus fee (15000- 1600)
            expect(sweepOutput.value).to.be.equal(13400)
          })

          it("should return the proper transaction hash", async () => {
            expect(transactionHash).to.be.deep.equal(
              depositSweepWithNoMainUtxoAndNonWitnessOutput.expectedSweep
                .transactionHash
            )
          })

          it("should return the proper new main UTXO", () => {
            const expectedNewMainUtxo = {
              transactionHash:
                depositSweepWithNoMainUtxoAndNonWitnessOutput.expectedSweep
                  .transactionHash,
              outputIndex: 0,
              value: BigNumber.from(13400),
            }

            expect(newMainUtxo).to.be.deep.equal(expectedNewMainUtxo)
          })
        })

        context("when there are no UTXOs", () => {
          it("should revert", async () => {
            const walletTx = new WalletTx(tbtcContracts, bitcoinClient)

            await expect(
              walletTx.depositSweep.assembleTransaction(
                BitcoinNetwork.Testnet,
                fee,
                testnetWalletPrivateKey,
                [],
                []
              )
            ).to.be.rejectedWith(
              "There must be at least one deposit UTXO to sweep"
            )
          })
        })

        context(
          "when the numbers of UTXOs and deposit elements are not equal",
          () => {
            const utxosWithRaw =
              depositSweepWithNoMainUtxoAndWitnessOutput.deposits.map(
                (data) => {
                  return data.utxo
                }
              )

            // Add only one element to the deposit
            const deposit = [
              depositSweepWithNoMainUtxoAndWitnessOutput.deposits[0].data,
            ]

            const witness = depositSweepWithNoMainUtxoAndWitnessOutput.witness

            it("should revert", async () => {
              const walletTx = new WalletTx(
                tbtcContracts,
                bitcoinClient,
                witness
              )

              await expect(
                walletTx.depositSweep.assembleTransaction(
                  BitcoinNetwork.Testnet,
                  fee,
                  testnetWalletPrivateKey,
                  utxosWithRaw,
                  deposit
                )
              ).to.be.rejectedWith(
                "Number of UTXOs must equal the number of deposit elements"
              )
            })
          }
        )

        context("when the main UTXO does not belong to the wallet", () => {
          const utxoWithRaw =
            depositSweepWithNoMainUtxoAndWitnessOutput.deposits[0].utxo
          const deposit =
            depositSweepWithNoMainUtxoAndWitnessOutput.deposits[0].data

          // The UTXO below does not belong to the wallet
          const mainUtxoWithRaw = {
            transactionHash: BitcoinTxHash.from(
              "2f952bdc206bf51bb745b967cb7166149becada878d3191ffe341155ebcd4883"
            ),
            outputIndex: 1,
            value: BigNumber.from(3933200),
            transactionHex:
              "0100000000010162cae24e74ad64f9f0493b09f3964908b3b3038f4924882d3d" +
              "bd853b4c9bc7390100000000ffffffff02102700000000000017a914867120d5" +
              "480a9cc0c11c1193fa59b3a92e852da78710043c00000000001600147ac2d937" +
              "8a1c47e589dfb8095ca95ed2140d272602483045022100b70bd9b7f5d230444a" +
              "542c7971bea79786b4ebde6703cee7b6ee8cd16e115ebf02204d50ea9d1ee08d" +
              "e9741498c2cc64266e40d52c4adb9ef68e65aa2727cd4208b5012102ee067a02" +
              "73f2e3ba88d23140a24fdb290f27bbcd0f94117a9c65be3911c5c04e00000000",
          }

          it("should revert", async () => {
            const walletTx = new WalletTx(tbtcContracts, bitcoinClient)

            await expect(
              walletTx.depositSweep.assembleTransaction(
                BitcoinNetwork.Testnet,
                fee,
                testnetWalletPrivateKey,
                [utxoWithRaw],
                [deposit],
                mainUtxoWithRaw
              )
            ).to.be.rejectedWith("UTXO does not belong to the wallet")
          })
        })

        context(
          "when the wallet private does not correspond to the wallet public key",
          () => {
            const utxoWithRaw =
              depositSweepWithNoMainUtxoAndWitnessOutput.deposits[0].utxo
            const deposit =
              depositSweepWithNoMainUtxoAndWitnessOutput.deposits[0].data
            const anotherPrivateKey =
              "cRJvyxtoggjAm9A94cB86hZ7Y62z2ei5VNJHLksFi2xdnz1GJ6xt"

            it("should revert", async () => {
              const walletTx = new WalletTx(tbtcContracts, bitcoinClient)

              await expect(
                walletTx.depositSweep.assembleTransaction(
                  BitcoinNetwork.Testnet,
                  fee,
                  anotherPrivateKey,
                  [utxoWithRaw],
                  [deposit]
                )
              ).to.be.rejectedWith(
                "Wallet public key does not correspond to wallet private key"
              )
            })
          }
        )

        context("when the type of UTXO is unsupported", () => {
          // Use coinbase transaction of some block
          const utxoWithRaw = {
            transactionHash: BitcoinTxHash.from(
              "025de155e6f2ffbbf4851493e0d28dad54020db221a3f38bf63c1f65e3d3595b"
            ),
            outputIndex: 0,
            value: BigNumber.from(5000000000),
            transactionHex:
              "010000000100000000000000000000000000000000000000000000000000000000" +
              "00000000ffffffff0e04db07c34f0103062f503253482fffffffff0100f2052a01" +
              "000000232102db6a0f2ef2e970eb1d2a84eabb5337f9cac0d85b49f209bffc4ec6" +
              "805802e6a5ac00000000",
          }
          const deposit =
            depositSweepWithNoMainUtxoAndWitnessOutput.deposits[0].data

          it("should revert", async () => {
            const walletTx = new WalletTx(tbtcContracts, bitcoinClient)

            await expect(
              walletTx.depositSweep.assembleTransaction(
                BitcoinNetwork.Testnet,
                fee,
                testnetWalletPrivateKey,
                [utxoWithRaw],
                [deposit]
              )
            ).to.be.rejectedWith("Unsupported UTXO script type")
          })
        })
      })
    })

    describe("Redemption", () => {
      describe("submitTransaction", () => {
        let tbtcContracts: MockTBTCContracts
        let bitcoinClient: MockBitcoinClient

        beforeEach(async () => {
          tbtcContracts = new MockTBTCContracts()
          bitcoinClient = new MockBitcoinClient()
        })

        context("when there are redemption requests provided", () => {
          context(
            "when all redeemer output scripts identify pending redemptions",
            () => {
              context("when there is a change created", () => {
                context("when the change output is P2WPKH", () => {
                  context("when there is a single redeemer", () => {
                    context(
                      "when the redeemer output script is derived from a P2PKH address",
                      () => {
                        const data: RedemptionTestData =
                          singleP2PKHRedemptionWithWitnessChange

                        let transactionHash: BitcoinTxHash
                        let newMainUtxo: BitcoinUtxo | undefined

                        beforeEach(async () => {
                          ;({ transactionHash, newMainUtxo } =
                            await runRedemptionScenario(
                              walletPrivateKey,
                              bitcoinClient,
                              tbtcContracts,
                              data
                            ))
                        })

                        it("should broadcast redemption transaction with proper structure", () => {
                          expect(bitcoinClient.broadcastLog.length).to.be.equal(
                            1
                          )
                          expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                            data.expectedRedemption.transaction
                          )
                        })

                        it("should return the proper transaction hash", async () => {
                          expect(transactionHash).to.be.deep.equal(
                            data.expectedRedemption.transactionHash
                          )
                        })

                        it("should return the proper new main UTXO", () => {
                          const expectedNewMainUtxo = {
                            transactionHash:
                              data.expectedRedemption.transactionHash,
                            outputIndex: 1,
                            value: BigNumber.from(1472680),
                          }

                          expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                        })
                      }
                    )

                    context(
                      "when the redeemer output script is derived from a P2WPKH address",
                      () => {
                        const data: RedemptionTestData =
                          singleP2WPKHRedemptionWithWitnessChange

                        let transactionHash: BitcoinTxHash
                        let newMainUtxo: BitcoinUtxo | undefined

                        beforeEach(async () => {
                          ;({ transactionHash, newMainUtxo } =
                            await runRedemptionScenario(
                              walletPrivateKey,
                              bitcoinClient,
                              tbtcContracts,
                              data
                            ))
                        })

                        it("should broadcast redemption transaction with proper structure", () => {
                          expect(bitcoinClient.broadcastLog.length).to.be.equal(
                            1
                          )
                          expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                            data.expectedRedemption.transaction
                          )
                        })

                        it("should return the proper transaction hash", async () => {
                          expect(transactionHash).to.be.deep.equal(
                            data.expectedRedemption.transactionHash
                          )
                        })

                        it("should return the proper new main UTXO", () => {
                          const expectedNewMainUtxo = {
                            transactionHash:
                              data.expectedRedemption.transactionHash,
                            outputIndex: 1,
                            value: BigNumber.from(1458780),
                          }

                          expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                        })
                      }
                    )

                    context(
                      "when the redeemer output script is derived from a P2SH address",
                      () => {
                        const data: RedemptionTestData =
                          singleP2SHRedemptionWithWitnessChange

                        let transactionHash: BitcoinTxHash
                        let newMainUtxo: BitcoinUtxo | undefined

                        beforeEach(async () => {
                          ;({ transactionHash, newMainUtxo } =
                            await runRedemptionScenario(
                              walletPrivateKey,
                              bitcoinClient,
                              tbtcContracts,
                              data
                            ))
                        })

                        it("should broadcast redemption transaction with proper structure", () => {
                          expect(bitcoinClient.broadcastLog.length).to.be.equal(
                            1
                          )
                          expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                            data.expectedRedemption.transaction
                          )
                        })

                        it("should return the proper transaction hash", async () => {
                          expect(transactionHash).to.be.deep.equal(
                            data.expectedRedemption.transactionHash
                          )
                        })

                        it("should return the proper new main UTXO", () => {
                          const expectedNewMainUtxo = {
                            transactionHash:
                              data.expectedRedemption.transactionHash,
                            outputIndex: 1,
                            value: BigNumber.from(1446580),
                          }

                          expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                        })
                      }
                    )

                    context(
                      "when the redeemer output script is derived from a P2WSH address",
                      () => {
                        const data: RedemptionTestData =
                          singleP2WSHRedemptionWithWitnessChange

                        let transactionHash: BitcoinTxHash
                        let newMainUtxo: BitcoinUtxo | undefined

                        beforeEach(async () => {
                          ;({ transactionHash, newMainUtxo } =
                            await runRedemptionScenario(
                              walletPrivateKey,
                              bitcoinClient,
                              tbtcContracts,
                              data
                            ))
                        })

                        it("should broadcast redemption transaction with proper structure", () => {
                          expect(bitcoinClient.broadcastLog.length).to.be.equal(
                            1
                          )
                          expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                            data.expectedRedemption.transaction
                          )
                        })

                        it("should return the proper transaction hash", async () => {
                          expect(transactionHash).to.be.deep.equal(
                            data.expectedRedemption.transactionHash
                          )
                        })

                        it("should return the proper new main UTXO", () => {
                          const expectedNewMainUtxo = {
                            transactionHash:
                              data.expectedRedemption.transactionHash,
                            outputIndex: 1,
                            value: BigNumber.from(1429580),
                          }

                          expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                        })
                      }
                    )
                  })

                  context("when there are multiple redeemers", () => {
                    const data: RedemptionTestData =
                      multipleRedemptionsWithWitnessChange

                    let transactionHash: BitcoinTxHash
                    let newMainUtxo: BitcoinUtxo | undefined

                    beforeEach(async () => {
                      ;({ transactionHash, newMainUtxo } =
                        await runRedemptionScenario(
                          walletPrivateKey,
                          bitcoinClient,
                          tbtcContracts,
                          data
                        ))
                    })

                    it("should broadcast redemption transaction with proper structure", () => {
                      expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
                      expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                        data.expectedRedemption.transaction
                      )
                    })

                    it("should return the proper transaction hash", async () => {
                      expect(transactionHash).to.be.deep.equal(
                        data.expectedRedemption.transactionHash
                      )
                    })

                    it("should return the proper new main UTXO", () => {
                      const expectedNewMainUtxo = {
                        transactionHash:
                          data.expectedRedemption.transactionHash,
                        outputIndex: 4,
                        value: BigNumber.from(1375180),
                      }

                      expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                    })
                  })
                })

                context("when the change output is P2PKH", () => {
                  // The only difference between redemption transactions with P2PKH and
                  // P2WPKH change is the output type.
                  // Therefore only one test case was added for P2PKH transactions.
                  const data: RedemptionTestData =
                    singleP2SHRedemptionWithNonWitnessChange

                  let transactionHash: BitcoinTxHash
                  let newMainUtxo: BitcoinUtxo | undefined

                  beforeEach(async () => {
                    ;({ transactionHash, newMainUtxo } =
                      await runRedemptionScenario(
                        walletPrivateKey,
                        bitcoinClient,
                        tbtcContracts,
                        data
                      ))
                  })

                  it("should broadcast redemption transaction with proper structure", () => {
                    expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
                    expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                      data.expectedRedemption.transaction
                    )
                  })

                  it("should return the proper transaction hash", async () => {
                    expect(transactionHash).to.be.deep.equal(
                      data.expectedRedemption.transactionHash
                    )
                  })

                  it("should return the proper new main UTXO", () => {
                    const expectedNewMainUtxo = {
                      transactionHash: data.expectedRedemption.transactionHash,
                      outputIndex: 1,
                      value: BigNumber.from(1364180),
                    }

                    expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                  })
                })
              })

              context("when there is no change UTXO created", () => {
                // Use test data with the treasury fees of all the redemption requests
                // set to 0. This is the only situation that the redemption transaction
                // will not contain the change output.
                const data: RedemptionTestData =
                  multipleRedemptionsWithoutChange

                let transactionHash: BitcoinTxHash
                let newMainUtxo: BitcoinUtxo | undefined

                beforeEach(async () => {
                  ;({ transactionHash, newMainUtxo } =
                    await runRedemptionScenario(
                      walletPrivateKey,
                      bitcoinClient,
                      tbtcContracts,
                      data
                    ))
                })

                it("should broadcast redemption transaction with proper structure", () => {
                  expect(bitcoinClient.broadcastLog.length).to.be.equal(1)
                  expect(bitcoinClient.broadcastLog[0]).to.be.eql(
                    data.expectedRedemption.transaction
                  )
                })

                it("should return the proper transaction hash", async () => {
                  expect(transactionHash).to.be.deep.equal(
                    data.expectedRedemption.transactionHash
                  )
                })

                it("should not return the new main UTXO", () => {
                  expect(newMainUtxo).to.be.undefined
                })
              })
            }
          )

          context(
            "when not all redeemer output scripts identify pending redemptions",
            () => {
              const data: RedemptionTestData =
                multipleRedemptionsWithWitnessChange

              beforeEach(async () => {
                const rawTransactions = new Map<string, BitcoinRawTx>()
                rawTransactions.set(data.mainUtxo.transactionHash.toString(), {
                  transactionHex: data.mainUtxo.transactionHex,
                })
                bitcoinClient.rawTransactions = rawTransactions

                const pendingRedemptions = new Map<
                  BigNumberish,
                  RedemptionRequest
                >(
                  data.pendingRedemptions.map((redemption) => [
                    redemption.redemptionKey,
                    redemption.pendingRedemption,
                  ])
                )

                // Before setting the pending redemption map in the Bridge, delete
                // one element to simulate absence of that redemption
                pendingRedemptions.delete(
                  data.pendingRedemptions[2].redemptionKey
                )
                tbtcContracts.bridge.setPendingRedemptions(pendingRedemptions)
              })

              it("should revert", async () => {
                const redeemerOutputScripts = data.pendingRedemptions.map(
                  (redemption) =>
                    redemption.pendingRedemption.redeemerOutputScript
                )

                const walletTx = new WalletTx(
                  tbtcContracts,
                  bitcoinClient,
                  data.witness
                )

                await expect(
                  walletTx.redemption.submitTransaction(
                    walletPrivateKey,
                    data.mainUtxo,
                    redeemerOutputScripts
                  )
                ).to.be.rejectedWith("Redemption request does not exist")
              })
            }
          )
        })

        context("when there are no redemption requests provided", () => {
          const data: RedemptionTestData =
            singleP2WPKHRedemptionWithWitnessChange

          beforeEach(async () => {
            const rawTransactions = new Map<string, BitcoinRawTx>()
            rawTransactions.set(data.mainUtxo.transactionHash.toString(), {
              transactionHex: data.mainUtxo.transactionHex,
            })
            bitcoinClient.rawTransactions = rawTransactions
          })

          it("should revert", async () => {
            const walletTx = new WalletTx(
              tbtcContracts,
              bitcoinClient,
              data.witness
            )

            await expect(
              walletTx.redemption.submitTransaction(
                walletPrivateKey,
                data.mainUtxo,
                [] // empty redeemer output script list
              )
            ).to.be.rejectedWith("There must be at least one request to redeem")
          })
        })
      })

      describe("assembleTransaction", () => {
        let tbtcContracts: MockTBTCContracts
        let bitcoinClient: MockBitcoinClient

        beforeEach(async () => {
          tbtcContracts = new MockTBTCContracts()
          bitcoinClient = new MockBitcoinClient()
        })

        context("when there are redemption requests provided", () => {
          context("when there is a change UTXO created", () => {
            describe("when the change output is P2WPKH", () => {
              context("when there is a single redeemer", () => {
                context(
                  "when the redeemer output script is derived from a P2PKH address",
                  () => {
                    const data: RedemptionTestData =
                      singleP2PKHRedemptionWithWitnessChange

                    let transactionHash: BitcoinTxHash
                    let newMainUtxo: BitcoinUtxo | undefined
                    let transaction: BitcoinRawTx

                    beforeEach(async () => {
                      const redemptionRequests = data.pendingRedemptions.map(
                        (redemption) => redemption.pendingRedemption
                      )

                      const walletTx = new WalletTx(
                        tbtcContracts,
                        bitcoinClient,
                        data.witness
                      )

                      ;({
                        transactionHash,
                        newMainUtxo,
                        rawTransaction: transaction,
                      } = await walletTx.redemption.assembleTransaction(
                        BitcoinNetwork.Testnet,
                        walletPrivateKey,
                        data.mainUtxo,
                        redemptionRequests
                      ))
                    })

                    it("should return transaction with proper structure", async () => {
                      // Compare HEXes.
                      expect(transaction).to.be.eql(
                        data.expectedRedemption.transaction
                      )

                      // Convert raw transaction to JSON to make detailed comparison.
                      const txJSON = txToJSON(
                        transaction.transactionHex,
                        BitcoinNetwork.Testnet
                      )

                      expect(txJSON.hash).to.be.equal(
                        data.expectedRedemption.transactionHash.toString()
                      )
                      expect(txJSON.version).to.be.equal(1)

                      // Validate inputs.
                      expect(txJSON.inputs.length).to.be.equal(1)

                      const input = txJSON.inputs[0]

                      expect(input.hash).to.be.equal(
                        data.mainUtxo.transactionHash.toString()
                      )
                      expect(input.index).to.be.equal(data.mainUtxo.outputIndex)
                      // Transaction should be signed but this is SegWit input so the `script`
                      // field should be empty and the `witness` field should be filled instead.
                      expect(input.script.length).to.be.equal(0)
                      expect(input.witness.length).to.be.greaterThan(0)

                      // Validate outputs.
                      expect(txJSON.outputs.length).to.be.equal(2)

                      const p2pkhOutput = txJSON.outputs[0]
                      const changeOutput = txJSON.outputs[1]

                      // P2PKH output
                      // The output value should be `requestedAmount` - `txFee` - `treasuryFee`
                      // which is 10000 - 1600 - 1000 = 7400
                      expect(p2pkhOutput.value).to.be.equal(7400)
                      // The output script should correspond to:
                      // OP_DUP OP_HASH160 0x14 0x4130879211c54df460e484ddf9aac009cb38ee74
                      // OP_EQUALVERIFY OP_CHECKSIG
                      expect(p2pkhOutput.script).to.be.equal(
                        "76a9144130879211c54df460e484ddf9aac009cb38ee7488ac"
                      )
                      // The output address should be P2PKH
                      expect(p2pkhOutput.address).to.be.equal(
                        "mmTeMR8RKu6QzMGTG4ipA71uewm3EuJng5"
                      )

                      // P2WPKH output (change)
                      // The value of fee should be the fee share of the (only) redeem output
                      // which is 1600
                      // The output value should be main UTXO input value - fee - the
                      // value of the output, which is 1472680 = 1481680 - 1600 - 7400
                      expect(changeOutput.value).to.be.equal(1472680)
                      // The output script should correspond to:
                      // OP_0 0x14 0x8db50eb52063ea9d98b3eac91489a90f738986f6
                      expect(changeOutput.script).to.be.equal(
                        "00148db50eb52063ea9d98b3eac91489a90f738986f6"
                      )
                      // The change output address should be the P2WPKH address of the wallet
                      expect(changeOutput.address).to.be.equal(
                        p2wpkhWalletAddress
                      )
                    })

                    it("should return the proper transaction hash", async () => {
                      expect(transactionHash).to.be.deep.equal(
                        data.expectedRedemption.transactionHash
                      )
                    })

                    it("should return the proper new main UTXO", () => {
                      const expectedNewMainUtxo = {
                        transactionHash:
                          data.expectedRedemption.transactionHash,
                        outputIndex: 1,
                        value: BigNumber.from(1472680),
                      }

                      expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                    })
                  }
                )

                context(
                  "when the redeemer output script is derived from a P2WPKH address",
                  () => {
                    const data: RedemptionTestData =
                      singleP2WPKHRedemptionWithWitnessChange

                    let transactionHash: BitcoinTxHash
                    let newMainUtxo: BitcoinUtxo | undefined
                    let transaction: BitcoinRawTx

                    beforeEach(async () => {
                      const redemptionRequests = data.pendingRedemptions.map(
                        (redemption) => redemption.pendingRedemption
                      )

                      const walletTx = new WalletTx(
                        tbtcContracts,
                        bitcoinClient,
                        data.witness
                      )

                      ;({
                        transactionHash,
                        newMainUtxo,
                        rawTransaction: transaction,
                      } = await walletTx.redemption.assembleTransaction(
                        BitcoinNetwork.Testnet,
                        walletPrivateKey,
                        data.mainUtxo,
                        redemptionRequests
                      ))
                    })

                    it("should return transaction with proper structure", async () => {
                      // Compare HEXes.
                      expect(transaction).to.be.eql(
                        data.expectedRedemption.transaction
                      )

                      // Convert raw transaction to JSON to make detailed comparison.
                      const txJSON = txToJSON(
                        transaction.transactionHex,
                        BitcoinNetwork.Testnet
                      )

                      expect(txJSON.hash).to.be.equal(
                        data.expectedRedemption.transactionHash.toString()
                      )
                      expect(txJSON.version).to.be.equal(1)

                      // Validate inputs.
                      expect(txJSON.inputs.length).to.be.equal(1)

                      const input = txJSON.inputs[0]

                      expect(input.hash).to.be.equal(
                        data.mainUtxo.transactionHash.toString()
                      )
                      expect(input.index).to.be.equal(data.mainUtxo.outputIndex)
                      // Transaction should be signed but this is SegWit input so the `script`
                      // field should be empty and the `witness` field should be filled instead.
                      expect(input.script.length).to.be.equal(0)
                      expect(input.witness.length).to.be.greaterThan(0)

                      // Validate outputs.
                      expect(txJSON.outputs.length).to.be.equal(2)

                      const p2wpkhOutput = txJSON.outputs[0]
                      const changeOutput = txJSON.outputs[1]

                      // P2WPKH output
                      // The output value should be `requestedAmount` - `txFee` - `treasuryFee`
                      // which is 15000 - 1700 - 1100 = 12200
                      expect(p2wpkhOutput.value).to.be.equal(12200)
                      // The output script should correspond to:
                      // OP_0 0x14 0x4130879211c54df460e484ddf9aac009cb38ee74
                      expect(p2wpkhOutput.script).to.be.equal(
                        "00144130879211c54df460e484ddf9aac009cb38ee74"
                      )
                      // The output address should be P2WPKH
                      expect(p2wpkhOutput.address).to.be.equal(
                        "tb1qgycg0ys3c4xlgc8ysnwln2kqp89n3mn5ts7z3l"
                      )

                      // P2WPKH output (change)
                      // The value of fee should be the fee share of the (only) redeem output
                      // which is 1700
                      // The output value should be main UTXO input value - fee - the
                      // value of the output, which is 1458780 = 1472680 - 1700 - 12200
                      expect(changeOutput.value).to.be.equal(1458780)
                      // The output script should correspond to:
                      // OP_0 0x14 0x8db50eb52063ea9d98b3eac91489a90f738986f6
                      expect(changeOutput.script).to.be.equal(
                        "00148db50eb52063ea9d98b3eac91489a90f738986f6"
                      )
                      // The change output address should be the P2WPKH address of the wallet
                      expect(changeOutput.address).to.be.equal(
                        p2wpkhWalletAddress
                      )
                    })

                    it("should return the proper transaction hash", async () => {
                      expect(transactionHash).to.be.deep.equal(
                        data.expectedRedemption.transactionHash
                      )
                    })

                    it("should return the proper new main UTXO", () => {
                      const expectedNewMainUtxo = {
                        transactionHash:
                          data.expectedRedemption.transactionHash,
                        outputIndex: 1,
                        value: BigNumber.from(1458780),
                      }

                      expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                    })
                  }
                )

                context(
                  "when the redeemer output script is derived from a P2SH address",
                  () => {
                    const data: RedemptionTestData =
                      singleP2SHRedemptionWithWitnessChange

                    let transactionHash: BitcoinTxHash
                    let newMainUtxo: BitcoinUtxo | undefined
                    let transaction: BitcoinRawTx

                    beforeEach(async () => {
                      const redemptionRequests = data.pendingRedemptions.map(
                        (redemption) => redemption.pendingRedemption
                      )

                      const walletTx = new WalletTx(
                        tbtcContracts,
                        bitcoinClient,
                        data.witness
                      )

                      ;({
                        transactionHash,
                        newMainUtxo,
                        rawTransaction: transaction,
                      } = await walletTx.redemption.assembleTransaction(
                        BitcoinNetwork.Testnet,
                        walletPrivateKey,
                        data.mainUtxo,
                        redemptionRequests
                      ))
                    })

                    it("should return transaction with proper structure", async () => {
                      // Compare HEXes.
                      expect(transaction).to.be.eql(
                        data.expectedRedemption.transaction
                      )

                      // Convert raw transaction to JSON to make detailed comparison.
                      const txJSON = txToJSON(
                        transaction.transactionHex,
                        BitcoinNetwork.Testnet
                      )

                      expect(txJSON.hash).to.be.equal(
                        data.expectedRedemption.transactionHash.toString()
                      )
                      expect(txJSON.version).to.be.equal(1)

                      // Validate inputs.
                      expect(txJSON.inputs.length).to.be.equal(1)

                      const input = txJSON.inputs[0]

                      expect(input.hash).to.be.equal(
                        data.mainUtxo.transactionHash.toString()
                      )
                      expect(input.index).to.be.equal(data.mainUtxo.outputIndex)
                      // Transaction should be signed but this is SegWit input so the `script`
                      // field should be empty and the `witness` field should be filled instead.
                      expect(input.script.length).to.be.equal(0)
                      expect(input.witness.length).to.be.greaterThan(0)

                      // Validate outputs.
                      expect(txJSON.outputs.length).to.be.equal(2)

                      const p2shOutput = txJSON.outputs[0]
                      const changeOutput = txJSON.outputs[1]

                      // P2SH output
                      // The output value should be `requestedAmount` - `txFee` - `treasuryFee`
                      // which is 13000 - 1700 - 800 = 10500
                      expect(p2shOutput.value).to.be.equal(10500)
                      // The output script should correspond to:
                      // OP_HASH160 0x14 0x3ec459d0f3c29286ae5df5fcc421e2786024277e OP_EQUAL
                      expect(p2shOutput.script).to.be.equal(
                        "a9143ec459d0f3c29286ae5df5fcc421e2786024277e87"
                      )
                      // The output address should be P2SH
                      expect(p2shOutput.address).to.be.equal(
                        "2Mxy76sc1qAxiJ1fXMXDXqHvVcPLh6Lf12C"
                      )

                      // P2WPKH output (change)
                      // The value of fee should be the fee share of the (only) redeem output
                      // which is 1700
                      // The output value should be main UTXO input value - fee - the
                      // value of the output, which is 1446580 = 1458780 - 1700 - 10500
                      expect(changeOutput.value).to.be.equal(1446580)
                      // The output script should correspond to:
                      // OP_0 0x14 0x8db50eb52063ea9d98b3eac91489a90f738986f6
                      expect(changeOutput.script).to.be.equal(
                        "00148db50eb52063ea9d98b3eac91489a90f738986f6"
                      )
                      // The change output address should be the P2WPKH address of the wallet
                      expect(changeOutput.address).to.be.equal(
                        p2wpkhWalletAddress
                      )
                    })

                    it("should return the proper transaction hash", async () => {
                      expect(transactionHash).to.be.deep.equal(
                        data.expectedRedemption.transactionHash
                      )
                    })

                    it("should return the proper new main UTXO", () => {
                      const expectedNewMainUtxo = {
                        transactionHash:
                          data.expectedRedemption.transactionHash,
                        outputIndex: 1,
                        value: BigNumber.from(1446580),
                      }

                      expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                    })
                  }
                )

                context(
                  "when the redeemer output script is derived from a P2WSH address",
                  () => {
                    const data: RedemptionTestData =
                      singleP2WSHRedemptionWithWitnessChange

                    let transactionHash: BitcoinTxHash
                    let newMainUtxo: BitcoinUtxo | undefined
                    let transaction: BitcoinRawTx

                    beforeEach(async () => {
                      const redemptionRequests = data.pendingRedemptions.map(
                        (redemption) => redemption.pendingRedemption
                      )

                      const walletTx = new WalletTx(
                        tbtcContracts,
                        bitcoinClient,
                        data.witness
                      )

                      ;({
                        transactionHash,
                        newMainUtxo,
                        rawTransaction: transaction,
                      } = await walletTx.redemption.assembleTransaction(
                        BitcoinNetwork.Testnet,
                        walletPrivateKey,
                        data.mainUtxo,
                        redemptionRequests
                      ))
                    })

                    it("should return transaction with proper structure", async () => {
                      // Compare HEXes.
                      expect(transaction).to.be.eql(
                        data.expectedRedemption.transaction
                      )

                      // Convert raw transaction to JSON to make detailed comparison.
                      const txJSON = txToJSON(
                        transaction.transactionHex,
                        BitcoinNetwork.Testnet
                      )

                      expect(txJSON.hash).to.be.equal(
                        data.expectedRedemption.transactionHash.toString()
                      )
                      expect(txJSON.version).to.be.equal(1)

                      // Validate inputs.
                      expect(txJSON.inputs.length).to.be.equal(1)

                      const input = txJSON.inputs[0]

                      expect(input.hash).to.be.equal(
                        data.mainUtxo.transactionHash.toString()
                      )
                      expect(input.index).to.be.equal(data.mainUtxo.outputIndex)
                      // Transaction should be signed but this is SegWit input so the `script`
                      // field should be empty and the `witness` field should be filled instead.
                      expect(input.script.length).to.be.equal(0)
                      expect(input.witness.length).to.be.greaterThan(0)

                      // Validate outputs.
                      expect(txJSON.outputs.length).to.be.equal(2)

                      const p2wshOutput = txJSON.outputs[0]
                      const changeOutput = txJSON.outputs[1]

                      // P2WSH output
                      // The output value should be `requestedAmount` - `txFee` - `treasuryFee`
                      // which is 18000 - 1400 - 1000 = 15600
                      expect(p2wshOutput.value).to.be.equal(15600)
                      // The output script should correspond to:
                      // OP_0 0x20 0x86a303cdd2e2eab1d1679f1a813835dc5a1b65321077cdccaf08f98cbf04ca96
                      expect(p2wshOutput.script).to.be.equal(
                        "002086a303cdd2e2eab1d1679f1a813835dc5a1b65321077cdccaf08f98cbf04ca96"
                      )
                      // The output address should be P2WSH
                      expect(p2wshOutput.address).to.be.equal(
                        "tb1qs63s8nwjut4tr5t8nudgzwp4m3dpkefjzpmumn90pruce0cye2tq2jkq0y"
                      )

                      // P2WPKH output (change)
                      // The value of fee should be the fee share of the (only) redeem output
                      // which is 1400
                      // The output value should be main UTXO input value - fee - the
                      // value of the output, which is 1429580 = 1446580 - 1400 - 15600
                      expect(changeOutput.value).to.be.equal(1429580)
                      // The output script should correspond to:
                      // OP_0 0x14 0x8db50eb52063ea9d98b3eac91489a90f738986f6
                      expect(changeOutput.script).to.be.equal(
                        "00148db50eb52063ea9d98b3eac91489a90f738986f6"
                      )
                      // The change output address should be the P2WPKH address of the wallet
                      expect(changeOutput.address).to.be.equal(
                        p2wpkhWalletAddress
                      )
                    })

                    it("should return the proper transaction hash", async () => {
                      expect(transactionHash).to.be.deep.equal(
                        data.expectedRedemption.transactionHash
                      )
                    })

                    it("should return the proper new main UTXO", () => {
                      const expectedNewMainUtxo = {
                        transactionHash:
                          data.expectedRedemption.transactionHash,
                        outputIndex: 1,
                        value: BigNumber.from(1429580),
                      }

                      expect(newMainUtxo).to.be.eql(expectedNewMainUtxo)
                    })
                  }
                )
              })

              context("when there are multiple redeemers", () => {
                const data: RedemptionTestData =
                  multipleRedemptionsWithWitnessChange

                let transactionHash: BitcoinTxHash
                let newMainUtxo: BitcoinUtxo | undefined
                let transaction: BitcoinRawTx

                beforeEach(async () => {
                  const redemptionRequests = data.pendingRedemptions.map(
                    (redemption) => redemption.pendingRedemption
                  )

                  const walletTx = new WalletTx(
                    tbtcContracts,
                    bitcoinClient,
                    data.witness
                  )

                  ;({
                    transactionHash,
                    newMainUtxo,
                    rawTransaction: transaction,
                  } = await walletTx.redemption.assembleTransaction(
                    BitcoinNetwork.Testnet,
                    walletPrivateKey,
                    data.mainUtxo,
                    redemptionRequests
                  ))
                })

                it("should return transaction with proper structure", async () => {
                  // Compare HEXes.
                  expect(transaction).to.be.eql(
                    data.expectedRedemption.transaction
                  )

                  // Convert raw transaction to JSON to make detailed comparison.
                  const txJSON = txToJSON(
                    transaction.transactionHex,
                    BitcoinNetwork.Testnet
                  )

                  expect(txJSON.hash).to.be.equal(
                    data.expectedRedemption.transactionHash.toString()
                  )
                  expect(txJSON.version).to.be.equal(1)

                  // Validate inputs.
                  expect(txJSON.inputs.length).to.be.equal(1)

                  const input = txJSON.inputs[0]

                  expect(input.hash).to.be.equal(
                    data.mainUtxo.transactionHash.toString()
                  )
                  expect(input.index).to.be.equal(data.mainUtxo.outputIndex)
                  // Transaction should be signed but this is SegWit input so the `script`
                  // field should be empty and the `witness` field should be filled instead.
                  expect(input.script.length).to.be.equal(0)
                  expect(input.witness.length).to.be.greaterThan(0)

                  // Validate outputs.
                  expect(txJSON.outputs.length).to.be.equal(5)

                  const p2pkhOutput = txJSON.outputs[0]
                  const p2wpkhOutput = txJSON.outputs[1]
                  const p2shOutput = txJSON.outputs[2]
                  const p2wshOutput = txJSON.outputs[3]
                  const changeOutput = txJSON.outputs[4]

                  // P2PKH output
                  // The output value should be `requestedAmount` - `txFee` - `treasuryFee`
                  // which is 18000 - 1100 - 1000 = 15900
                  expect(p2pkhOutput.value).to.be.equal(15900)
                  // The output script should correspond to:
                  // OP_DUP OP_HASH160 0x14 0x4130879211c54df460e484ddf9aac009cb38ee74
                  // OP_EQUALVERIFY OP_CHECKSIG
                  expect(p2pkhOutput.script).to.be.equal(
                    "76a9144130879211c54df460e484ddf9aac009cb38ee7488ac"
                  )
                  // The output address should be P2PKH
                  expect(p2pkhOutput.address).to.be.equal(
                    "mmTeMR8RKu6QzMGTG4ipA71uewm3EuJng5"
                  )

                  // P2WPKH output
                  // The output value should be `requestedAmount` - `txFee` - `treasuryFee`
                  // which is 13000 - 900 - 800 = 11300
                  expect(p2wpkhOutput.value).to.be.equal(11300)
                  // The output script should correspond to:
                  // OP_0 0x14 0x4130879211c54df460e484ddf9aac009cb38ee74
                  expect(p2wpkhOutput.script).to.be.equal(
                    "00144130879211c54df460e484ddf9aac009cb38ee74"
                  )
                  // The output address should be P2WPKH
                  expect(p2wpkhOutput.address).to.be.equal(
                    "tb1qgycg0ys3c4xlgc8ysnwln2kqp89n3mn5ts7z3l"
                  )

                  // P2SH output
                  // The output value should be `requestedAmount` - `txFee` - `treasuryFee`
                  // which is 12000 - 1000 - 1100 = 9900
                  expect(p2shOutput.value).to.be.equal(9900)
                  // The output script should correspond to:
                  // OP_HASH160 0x14 0x3ec459d0f3c29286ae5df5fcc421e2786024277e OP_EQUAL
                  expect(p2shOutput.script).to.be.equal(
                    "a9143ec459d0f3c29286ae5df5fcc421e2786024277e87"
                  )
                  // The output address should be P2SH
                  expect(p2shOutput.address).to.be.equal(
                    "2Mxy76sc1qAxiJ1fXMXDXqHvVcPLh6Lf12C"
                  )

                  // P2WSH output
                  // The output value should be `requestedAmount` - `txFee` - `treasuryFee`
                  // which is 15000 - 1400 - 700 = 12900
                  expect(p2wshOutput.value).to.be.equal(12900)
                  // The output script should correspond to:
                  // OP_0 0x20 0x86a303cdd2e2eab1d1679f1a813835dc5a1b65321077cdccaf08f98cbf04ca96
                  expect(p2wshOutput.script).to.be.equal(
                    "002086a303cdd2e2eab1d1679f1a813835dc5a1b65321077cdccaf08f98cbf04ca96"
                  )
                  // The output address should be P2WSH
                  expect(p2wshOutput.address).to.be.equal(
                    "tb1qs63s8nwjut4tr5t8nudgzwp4m3dpkefjzpmumn90pruce0cye2tq2jkq0y"
                  )

                  // P2WPKH output (change)
                  // The value of fee should be the sum of fee share of all redeem outputs
                  // which is 1100 + 900 + 1000 + 1400 = 4400
                  // The output value should be main UTXO input value - fee - sum of all
                  // outputs, which is 1375180 = 1429580 - 4400 - (15900 + 11300 + 9900 + 12900)
                  expect(changeOutput.value).to.be.equal(1375180)
                  // The output script should correspond to:
                  // OP_0 0x14 0x8db50eb52063ea9d98b3eac91489a90f738986f6
                  expect(changeOutput.script).to.be.equal(
                    "00148db50eb52063ea9d98b3eac91489a90f738986f6"
                  )
                  // The change output address should be the P2WPKH address of the wallet
                  expect(changeOutput.address).to.be.equal(p2wpkhWalletAddress)
                })

                it("should return the proper transaction hash", async () => {
                  expect(transactionHash).to.be.deep.equal(
                    data.expectedRedemption.transactionHash
                  )
                })

                it("should return the proper new main UTXO", () => {
                  const expectedNewMainUtxo = {
                    transactionHash: data.expectedRedemption.transactionHash,
                    outputIndex: 4,
                    value: BigNumber.from(1375180),
                  }

                  expect(newMainUtxo).to.be.deep.equal(expectedNewMainUtxo)
                })
              })
            })

            describe("when the change output is P2PKH", () => {
              // The only difference between redemption transactions with P2PKH
              // change outputs and P2WPKH change outputs is the output type itself.
              // Therefore the tests for creating transactions with P2PKH are
              // limited to one single test case as more complicated scenarios are
              // covered for P2WPKH change output tests.
              const data: RedemptionTestData =
                singleP2SHRedemptionWithNonWitnessChange

              let transactionHash: BitcoinTxHash
              let newMainUtxo: BitcoinUtxo | undefined
              let transaction: BitcoinRawTx

              beforeEach(async () => {
                const redemptionRequests = data.pendingRedemptions.map(
                  (redemption) => redemption.pendingRedemption
                )

                const walletTx = new WalletTx(
                  tbtcContracts,
                  bitcoinClient,
                  data.witness
                )

                ;({
                  transactionHash,
                  newMainUtxo,
                  rawTransaction: transaction,
                } = await walletTx.redemption.assembleTransaction(
                  BitcoinNetwork.Testnet,
                  walletPrivateKey,
                  data.mainUtxo,
                  redemptionRequests
                ))
              })

              it("should return transaction with proper structure", async () => {
                // Compare HEXes.
                expect(transaction).to.be.eql(
                  data.expectedRedemption.transaction
                )

                // Convert raw transaction to JSON to make detailed comparison.
                const txJSON = txToJSON(
                  transaction.transactionHex,
                  BitcoinNetwork.Testnet
                )

                expect(txJSON.hash).to.be.equal(
                  data.expectedRedemption.transactionHash.toString()
                )
                expect(txJSON.version).to.be.equal(1)

                // Validate inputs.
                expect(txJSON.inputs.length).to.be.equal(1)

                const input = txJSON.inputs[0]

                expect(input.hash).to.be.equal(
                  data.mainUtxo.transactionHash.toString()
                )
                expect(input.index).to.be.equal(data.mainUtxo.outputIndex)
                // Transaction should be signed but this is SegWit input so the `script`
                // field should be empty and the `witness` field should be filled instead.
                expect(input.script.length).to.be.equal(0)
                expect(input.witness.length).to.be.greaterThan(0)

                // Validate outputs.
                expect(txJSON.outputs.length).to.be.equal(2)

                const p2shOutput = txJSON.outputs[0]
                const changeOutput = txJSON.outputs[1]

                // P2SH output
                // The output value should be `requestedAmount` - `txFee` - `treasuryFee`
                // which is 12000 - 1200 - 1000 = 9800
                expect(p2shOutput.value).to.be.equal(9800)
                // The output script should correspond to:
                // OP_HASH160 0x14 0x3ec459d0f3c29286ae5df5fcc421e2786024277e OP_EQUAL
                expect(p2shOutput.script).to.be.equal(
                  "a9143ec459d0f3c29286ae5df5fcc421e2786024277e87"
                )
                // The output address should be P2SH
                expect(p2shOutput.address).to.be.equal(
                  "2Mxy76sc1qAxiJ1fXMXDXqHvVcPLh6Lf12C"
                )

                // P2PKH output (change)
                // The value of fee should be the fee share of the (only) redeem output
                // which is 1200
                // The output value should be main UTXO input value - fee - the value
                // of the redeem output, which is 1364180 = 1375180 - 1200 - 9800
                expect(changeOutput.value).to.be.equal(1364180)
                // The output script should correspond to:
                // OP_DUP OP_HASH160 0x14 0x8db50eb52063ea9d98b3eac91489a90f738986f6
                // OP_EQUALVERIFY OP_CHECKSIG
                expect(changeOutput.script).to.be.equal(
                  "76a9148db50eb52063ea9d98b3eac91489a90f738986f688ac"
                )
                // The change output address should be the P2PKH address of the wallet
                expect(changeOutput.address).to.be.equal(p2pkhWalletAddress)
              })

              it("should return the proper transaction hash", async () => {
                expect(transactionHash).to.be.deep.equal(
                  data.expectedRedemption.transactionHash
                )
              })

              it("should return the proper new main UTXO", () => {
                const expectedNewMainUtxo = {
                  transactionHash: data.expectedRedemption.transactionHash,
                  outputIndex: 1,
                  value: BigNumber.from(1364180),
                }

                expect(newMainUtxo).to.be.deep.equal(expectedNewMainUtxo)
              })
            })
          })

          context("when there is no change UTXO created", () => {
            const data: RedemptionTestData = multipleRedemptionsWithoutChange

            let transactionHash: BitcoinTxHash
            let newMainUtxo: BitcoinUtxo | undefined
            let transaction: BitcoinRawTx

            beforeEach(async () => {
              const redemptionRequests = data.pendingRedemptions.map(
                (redemption) => redemption.pendingRedemption
              )

              const walletTx = new WalletTx(
                tbtcContracts,
                bitcoinClient,
                data.witness
              )

              ;({
                transactionHash,
                newMainUtxo,
                rawTransaction: transaction,
              } = await walletTx.redemption.assembleTransaction(
                BitcoinNetwork.Testnet,
                walletPrivateKey,
                data.mainUtxo,
                redemptionRequests
              ))
            })

            it("should return transaction with proper structure", async () => {
              // Compare HEXes.
              expect(transaction).to.be.eql(data.expectedRedemption.transaction)

              // Convert raw transaction to JSON to make detailed comparison.
              const txJSON = txToJSON(
                transaction.transactionHex,
                BitcoinNetwork.Testnet
              )

              expect(txJSON.hash).to.be.equal(
                data.expectedRedemption.transactionHash.toString()
              )
              expect(txJSON.version).to.be.equal(1)

              // Validate inputs.
              expect(txJSON.inputs.length).to.be.equal(1)

              const input = txJSON.inputs[0]

              expect(input.hash).to.be.equal(
                data.mainUtxo.transactionHash.toString()
              )
              expect(input.index).to.be.equal(data.mainUtxo.outputIndex)
              // Transaction should be signed but this is SegWit input so the `script`
              // field should be empty and the `witness` field should be filled instead.
              expect(input.script.length).to.be.equal(0)
              expect(input.witness.length).to.be.greaterThan(0)

              // Validate outputs.
              expect(txJSON.outputs.length).to.be.equal(2)

              const p2pkhOutput = txJSON.outputs[0]
              const p2wpkhOutput = txJSON.outputs[1]

              // P2PKH output
              // The output value should be `requestedAmount` - `txFee` - `treasuryFee`
              // which is 6000 - 800 - 0 = 5200
              expect(p2pkhOutput.value).to.be.equal(5200)
              // The output script should correspond to:
              // OP_DUP OP_HASH160 0x14 0x4130879211c54df460e484ddf9aac009cb38ee74
              // OP_EQUALVERIFY OP_CHECKSIG
              expect(p2pkhOutput.script).to.be.equal(
                "76a9144130879211c54df460e484ddf9aac009cb38ee7488ac"
              )
              // The output address should be P2PK
              expect(p2pkhOutput.address).to.be.equal(
                "mmTeMR8RKu6QzMGTG4ipA71uewm3EuJng5"
              )

              // P2WPKH output
              // The output value should be `requestedAmount` - `txFee` - `treasuryFee`
              // which is 4000 - 900 - 0 = 3100
              expect(p2wpkhOutput.value).to.be.equal(3100)
              // The output script should correspond to:
              // OP_0 0x14 0x4bf9ffb7ae0f8b0f5a622b154aca829126f6e769
              expect(p2wpkhOutput.script).to.be.equal(
                "00144bf9ffb7ae0f8b0f5a622b154aca829126f6e769"
              )
              // The output address should be P2PKH
              expect(p2wpkhOutput.address).to.be.equal(
                "tb1qf0ulldawp79s7knz9v254j5zjyn0demfx2d0xx"
              )
            })

            it("should return the proper transaction hash", async () => {
              expect(transactionHash).to.be.deep.equal(
                data.expectedRedemption.transactionHash
              )
            })

            it("should not return the new main UTXO", () => {
              expect(newMainUtxo).to.be.undefined
            })
          })
        })

        context("when there are no redemption requests provided", () => {
          const data: RedemptionTestData =
            singleP2PKHRedemptionWithWitnessChange

          it("should revert", async () => {
            const walletTx = new WalletTx(
              tbtcContracts,
              bitcoinClient,
              data.witness
            )

            await expect(
              walletTx.redemption.assembleTransaction(
                BitcoinNetwork.Testnet,
                walletPrivateKey,
                data.mainUtxo,
                [] // empty list of redemption requests
              )
            ).to.be.rejectedWith("There must be at least one request to redeem")
          })
        })
      })
    })
  })

  describe("Spv", () => {
    describe("submitDepositSweepProof", () => {
      let bitcoinClient: MockBitcoinClient
      let tbtcContracts: MockTBTCContracts
      let maintenanceService: MaintenanceService

      beforeEach(async () => {
        bitcoinClient = new MockBitcoinClient()
        tbtcContracts = new MockTBTCContracts()

        maintenanceService = new MaintenanceService(
          tbtcContracts,
          bitcoinClient
        )

        const transactionHash =
          depositSweepProof.bitcoinChainData.transaction.transactionHash
        const transactions = new Map<string, BitcoinTx>()
        transactions.set(
          transactionHash.toString(),
          depositSweepProof.bitcoinChainData.transaction
        )
        bitcoinClient.transactions = transactions

        const rawTransactions = new Map<string, BitcoinRawTx>()
        rawTransactions.set(
          transactionHash.toString(),
          depositSweepProof.bitcoinChainData.rawTransaction
        )

        bitcoinClient.latestHeight =
          depositSweepProof.bitcoinChainData.latestBlockHeight
        bitcoinClient.headersChain =
          depositSweepProof.bitcoinChainData.headersChain

        const txBlockHeight =
          depositSweepProof.bitcoinChainData.latestBlockHeight -
          depositSweepProof.bitcoinChainData.accumulatedTxConfirmations +
          1

        const transactionMerkle = new Map<string, BitcoinTxMerkleBranch>()
        transactionMerkle.set(
          `${transactionHash.toString()}${txBlockHeight.toString(16)}`,
          depositSweepProof.bitcoinChainData.transactionMerkleBranch
        )

        const confirmations = new Map<string, number>()
        confirmations.set(
          transactionHash.toString(),
          depositSweepProof.bitcoinChainData.accumulatedTxConfirmations
        )
        bitcoinClient.confirmations = confirmations

        const coinbaseTxHash = BitcoinTxHash.from(
          BitcoinHashUtils.computeHash256(
            Hex.from(
              depositSweepProof.bitcoinChainData.coinbaseRawTransaction
                .transactionHex
            )
          ).toString()
        )

        const coinbaseHashes = new Map<number, BitcoinTxHash>()
        coinbaseHashes.set(txBlockHeight, coinbaseTxHash)
        bitcoinClient.coinbaseHashes = coinbaseHashes

        rawTransactions.set(
          coinbaseTxHash.toString(),
          depositSweepProof.bitcoinChainData.coinbaseRawTransaction
        )
        bitcoinClient.rawTransactions = rawTransactions

        transactionMerkle.set(
          `${coinbaseTxHash.toString()}${txBlockHeight.toString(16)}`,
          depositSweepProof.bitcoinChainData.coinbaseMerkleBranch
        )
        bitcoinClient.transactionMerkle = transactionMerkle

        await maintenanceService.spv.submitDepositSweepProof(
          transactionHash,
          NO_MAIN_UTXO
        )
      })

      it("should submit deposit sweep proof with correct arguments", () => {
        const bridgeLog = tbtcContracts.bridge.depositSweepProofLog
        expect(bridgeLog.length).to.equal(1)
        expect(bridgeLog[0].mainUtxo).to.equal(NO_MAIN_UTXO)
        expect(bridgeLog[0].sweepTx).to.deep.equal(
          depositSweepProof.expectedSweepProof.sweepTx
        )
        expect(bridgeLog[0].sweepProof.txIndexInBlock).to.deep.equal(
          depositSweepProof.expectedSweepProof.sweepProof.txIndexInBlock
        )
        expect(bridgeLog[0].sweepProof.merkleProof).to.deep.equal(
          depositSweepProof.expectedSweepProof.sweepProof.merkleProof
        )
        expect(bridgeLog[0].sweepProof.bitcoinHeaders).to.deep.equal(
          depositSweepProof.expectedSweepProof.sweepProof.bitcoinHeaders
        )
        expect(bridgeLog[0].sweepProof.coinbasePreimage).to.deep.equal(
          depositSweepProof.expectedSweepProof.sweepProof.coinbasePreimage
        )
        expect(bridgeLog[0].sweepProof.coinbaseProof).to.deep.equal(
          depositSweepProof.expectedSweepProof.sweepProof.coinbaseProof
        )
      })
    })

    describe("submitRedemptionProof", () => {
      const mainUtxo = {
        transactionHash: BitcoinTxHash.from(
          "3d28bb5bf73379da51bc683f4d0ed31d7b024466c619d80ebd9378077d900be3"
        ),
        outputIndex: 1,
        value: BigNumber.from(1429580),
      }

      let bitcoinClient: MockBitcoinClient
      let tbtcContracts: MockTBTCContracts
      let maintenanceService: MaintenanceService

      beforeEach(async () => {
        bitcoinClient = new MockBitcoinClient()
        tbtcContracts = new MockTBTCContracts()

        maintenanceService = new MaintenanceService(
          tbtcContracts,
          bitcoinClient
        )

        const transactionHash =
          redemptionProof.bitcoinChainData.transaction.transactionHash

        const transactions = new Map<string, BitcoinTx>()
        transactions.set(
          transactionHash.toString(),
          redemptionProof.bitcoinChainData.transaction
        )
        bitcoinClient.transactions = transactions

        const rawTransactions = new Map<string, BitcoinRawTx>()
        rawTransactions.set(
          transactionHash.toString(),
          redemptionProof.bitcoinChainData.rawTransaction
        )

        bitcoinClient.latestHeight =
          redemptionProof.bitcoinChainData.latestBlockHeight
        bitcoinClient.headersChain =
          redemptionProof.bitcoinChainData.headersChain

        const txBlockHeight =
          redemptionProof.bitcoinChainData.latestBlockHeight -
          redemptionProof.bitcoinChainData.accumulatedTxConfirmations +
          1

        const transactionMerkle = new Map<string, BitcoinTxMerkleBranch>()
        transactionMerkle.set(
          `${transactionHash.toString()}${txBlockHeight.toString(16)}`,
          redemptionProof.bitcoinChainData.transactionMerkleBranch
        )

        const confirmations = new Map<string, number>()
        confirmations.set(
          transactionHash.toString(),
          redemptionProof.bitcoinChainData.accumulatedTxConfirmations
        )
        bitcoinClient.confirmations = confirmations

        const coinbaseTxHash = BitcoinTxHash.from(
          BitcoinHashUtils.computeHash256(
            Hex.from(
              redemptionProof.bitcoinChainData.coinbaseRawTransaction
                .transactionHex
            )
          ).toString()
        )

        const coinbaseHashes = new Map<number, BitcoinTxHash>()
        coinbaseHashes.set(txBlockHeight, coinbaseTxHash)
        bitcoinClient.coinbaseHashes = coinbaseHashes

        rawTransactions.set(
          coinbaseTxHash.toString(),
          redemptionProof.bitcoinChainData.coinbaseRawTransaction
        )
        bitcoinClient.rawTransactions = rawTransactions

        transactionMerkle.set(
          `${coinbaseTxHash.toString()}${txBlockHeight.toString(16)}`,
          redemptionProof.bitcoinChainData.coinbaseMerkleBranch
        )
        bitcoinClient.transactionMerkle = transactionMerkle

        await maintenanceService.spv.submitRedemptionProof(
          transactionHash,
          mainUtxo,
          walletPublicKey
        )
      })

      it("should submit redemption proof with correct arguments", () => {
        const bridgeLog = tbtcContracts.bridge.redemptionProofLog
        expect(bridgeLog.length).to.equal(1)
        expect(bridgeLog[0].mainUtxo).to.equal(mainUtxo)
        expect(bridgeLog[0].walletPublicKey).to.deep.equal(
          redemptionProof.expectedRedemptionProof.walletPublicKey
        )
        expect(bridgeLog[0].redemptionTx).to.deep.equal(
          redemptionProof.expectedRedemptionProof.redemptionTx
        )
        expect(bridgeLog[0].redemptionProof.txIndexInBlock).to.deep.equal(
          redemptionProof.expectedRedemptionProof.redemptionProof.txIndexInBlock
        )
        expect(bridgeLog[0].redemptionProof.merkleProof).to.deep.equal(
          redemptionProof.expectedRedemptionProof.redemptionProof.merkleProof
        )
        expect(bridgeLog[0].redemptionProof.bitcoinHeaders).to.deep.equal(
          redemptionProof.expectedRedemptionProof.redemptionProof.bitcoinHeaders
        )
        expect(bridgeLog[0].redemptionProof.coinbasePreimage).to.deep.equal(
          redemptionProof.expectedRedemptionProof.redemptionProof
            .coinbasePreimage
        )
        expect(bridgeLog[0].redemptionProof.coinbaseProof).to.deep.equal(
          redemptionProof.expectedRedemptionProof.redemptionProof.coinbaseProof
        )
      })
    })
  })
})
