/* eslint-disable no-underscore-dangle */
import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import chai, { expect } from "chai"
import { smock } from "@defi-wonderland/smock"
import type { FakeContract } from "@defi-wonderland/smock"
import { ContractTransaction } from "ethers"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  IWalletRegistry,
} from "../../typechain"
import { NO_MAIN_UTXO } from "../data/deposit-sweep"
import { ecdsaWalletTestData } from "../data/ecdsa"
import { constants, ecdsaDkgState, walletState } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

describe("Bridge - Wallets", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress

  let walletRegistry: FakeContract<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, walletRegistry, bridge, bridgeGovernance } =
      await waffle.loadFixture(bridgeFixture))
  })

  describe("requestNewWallet", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      walletRegistry.requestNewWallet.reset()

      await restoreSnapshot()
    })

    context("when called by a third party", async () => {
      context("when wallet creation is not in progress", () => {
        before(async () => {
          await createSnapshot()

          walletRegistry.getWalletCreationState.returns(ecdsaDkgState.IDLE)
        })

        after(async () => {
          walletRegistry.getWalletCreationState.reset()

          await restoreSnapshot()
        })

        context("when active wallet is not set", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            tx = await bridge.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO)
          })

          after(async () => {
            walletRegistry.requestNewWallet.reset()

            await restoreSnapshot()
          })

          it("should emit NewWalletRequested event", async () => {
            await expect(tx).to.emit(bridge, "NewWalletRequested")
          })

          it("should call ECDSA Wallet Registry's requestNewWallet function", async () => {
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            expect(walletRegistry.requestNewWallet).to.have.been.calledOnce
          })
        })

        context("when active wallet is set", () => {
          before(async () => {
            await createSnapshot()

            await bridge.setActiveWallet(ecdsaWalletTestData.pubKeyHash160)

            await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
              ecdsaWalletID: ecdsaWalletTestData.walletID,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          context("when active wallet has a main UTXO set", () => {
            context("when the active wallet main UTXO data are valid", () => {
              context("when wallet creation conditions are met", () => {
                context(
                  "when active wallet is old enough and its balance is greater or equal the minimum BTC balance threshold",
                  () => {
                    let tx: ContractTransaction

                    before(async () => {
                      await createSnapshot()

                      // Make the wallet old enough.
                      await increaseTime(constants.walletCreationPeriod)

                      // Simulate the wallet has a BTC balance equal to the
                      // minimum BTC amount threshold by preparing the wallet's
                      // main UTXO accordingly.
                      const activeWalletMainUtxo = {
                        txHash:
                          "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                        txOutputIndex: 1,
                        txOutputValue: constants.walletCreationMinBtcBalance,
                      }

                      await bridge.setWalletMainUtxo(
                        ecdsaWalletTestData.pubKeyHash160,
                        activeWalletMainUtxo
                      )

                      tx = await bridge.requestNewWallet(activeWalletMainUtxo)
                    })

                    after(async () => {
                      walletRegistry.requestNewWallet.reset()

                      await restoreSnapshot()
                    })

                    it("should emit NewWalletRequested event", async () => {
                      await expect(tx).to.emit(bridge, "NewWalletRequested")
                    })

                    it("should call ECDSA Wallet Registry's requestNewWallet function", async () => {
                      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                      expect(walletRegistry.requestNewWallet).to.have.been
                        .calledOnce
                    })
                  }
                )

                context(
                  "when active wallet is not old enough but its balance is greater or equal the maximum BTC balance threshold",
                  () => {
                    let tx: ContractTransaction

                    before(async () => {
                      await createSnapshot()

                      // Simulate the wallet has a BTC balance equal to the
                      // maximum BTC amount threshold by preparing the wallet's
                      // main UTXO accordingly. Note that the time is not
                      // increased at all so the wallet is not old enough
                      // for sure.
                      const activeWalletMainUtxo = {
                        txHash:
                          "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                        txOutputIndex: 1,
                        txOutputValue: constants.walletCreationMaxBtcBalance,
                      }

                      await bridge.setWalletMainUtxo(
                        ecdsaWalletTestData.pubKeyHash160,
                        activeWalletMainUtxo
                      )

                      tx = await bridge.requestNewWallet(activeWalletMainUtxo)
                    })

                    after(async () => {
                      walletRegistry.requestNewWallet.reset()

                      await restoreSnapshot()
                    })

                    it("should emit NewWalletRequested event", async () => {
                      await expect(tx).to.emit(bridge, "NewWalletRequested")
                    })

                    it("should call ECDSA Wallet Registry's requestNewWallet function", async () => {
                      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                      expect(walletRegistry.requestNewWallet).to.have.been
                        .calledOnce
                    })
                  }
                )
              })

              context(
                "when active wallet is not old enough and its balance is greater or equal the minimum but lesser than the maximum BTC balance threshold",
                () => {
                  let tx: Promise<ContractTransaction>

                  before(async () => {
                    await createSnapshot()

                    // Simulate the wallet has a BTC balance between the minimum
                    // and maximum BTC amount thresholds by preparing the
                    // wallet's main UTXO accordingly. Note that the time is not
                    // increased at all so the wallet is not old enough for sure.
                    const activeWalletMainUtxo = {
                      txHash:
                        "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                      txOutputIndex: 1,
                      txOutputValue:
                        constants.walletCreationMaxBtcBalance.sub(1),
                    }

                    await bridge.setWalletMainUtxo(
                      ecdsaWalletTestData.pubKeyHash160,
                      activeWalletMainUtxo
                    )

                    tx = bridge.requestNewWallet(activeWalletMainUtxo)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(tx).to.be.revertedWith(
                      "Wallet creation conditions are not met"
                    )
                  })
                }
              )

              context(
                "when active wallet is old enough but its balance is lesser than the minimum BTC balance threshold",
                () => {
                  let tx: Promise<ContractTransaction>

                  before(async () => {
                    await createSnapshot()

                    // Make the wallet old enough.
                    await increaseTime(constants.walletCreationPeriod)

                    // Simulate the wallet has a BTC balance below the minimum
                    // BTC amount threshold by preparing the wallet's main
                    // UTXO accordingly.
                    const activeWalletMainUtxo = {
                      txHash:
                        "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                      txOutputIndex: 1,
                      txOutputValue:
                        constants.walletCreationMinBtcBalance.sub(1),
                    }

                    await bridge.setWalletMainUtxo(
                      ecdsaWalletTestData.pubKeyHash160,
                      activeWalletMainUtxo
                    )

                    tx = bridge.requestNewWallet(activeWalletMainUtxo)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(tx).to.be.revertedWith(
                      "Wallet creation conditions are not met"
                    )
                  })
                }
              )
            })

            context("when the active wallet main UTXO data are invalid", () => {
              const activeWalletMainUtxo = {
                txHash:
                  "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                txOutputIndex: 1,
                txOutputValue: constants.walletCreationMaxBtcBalance,
              }

              before(async () => {
                await createSnapshot()

                await bridge.setWalletMainUtxo(
                  ecdsaWalletTestData.pubKeyHash160,
                  activeWalletMainUtxo
                )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should revert", async () => {
                const corruptedActiveWalletMainUtxo = {
                  ...activeWalletMainUtxo,
                  txOutputIndex: 0,
                }

                await expect(
                  bridge.requestNewWallet(corruptedActiveWalletMainUtxo)
                ).to.be.revertedWith("Invalid wallet main UTXO data")
              })
            })
          })

          context("when active wallet has no main UTXO set", () => {
            context(
              "when the minimum BTC balance threshold is non-zero",
              () => {
                before(async () => {
                  await createSnapshot()
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  await expect(
                    bridge.requestNewWallet(NO_MAIN_UTXO)
                  ).to.be.revertedWith("Wallet creation conditions are not met")
                })
              }
            )

            context(
              "when the minimum BTC balance threshold is non-zero",
              () => {
                before(async () => {
                  await createSnapshot()
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  await expect(
                    bridge.requestNewWallet(NO_MAIN_UTXO)
                  ).to.be.revertedWith("Wallet creation conditions are not met")
                })
              }
            )

            context("when the minimum BTC balance threshold is zero", () => {
              context("when wallet creation conditions are met", () => {
                let tx: ContractTransaction

                before(async () => {
                  await createSnapshot()

                  // Set the minimum BTC balance to zero.
                  await bridgeGovernance
                    .connect(governance)
                    .beginWalletCreationMinBtcBalanceUpdate(0)
                  await helpers.time.increaseTime(constants.governanceDelay)
                  await bridgeGovernance
                    .connect(governance)
                    .finalizeWalletCreationMinBtcBalanceUpdate()

                  // Make the wallet old enough. Be absolutely sure - it is
                  // possible that after the governance delay passed, the wallet
                  // is already old enough.
                  await increaseTime(constants.walletCreationPeriod)

                  tx = await bridge.requestNewWallet(NO_MAIN_UTXO)
                })

                after(async () => {
                  walletRegistry.requestNewWallet.reset()

                  await restoreSnapshot()
                })

                it("should emit NewWalletRequested event", async () => {
                  await expect(tx).to.emit(bridge, "NewWalletRequested")
                })

                it("should call ECDSA Wallet Registry's requestNewWallet function", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  expect(walletRegistry.requestNewWallet).to.have.been
                    .calledOnce
                })
              })
            })
          })
        })
      })

      context("when wallet creation is already in progress", () => {
        const testData = [
          {
            testName: "when wallet creation state is AWAITING_SEED",
            walletCreationState: ecdsaDkgState.AWAITING_SEED,
          },
          {
            testName: "when wallet creation state is AWAITING_RESULT",
            walletCreationState: ecdsaDkgState.AWAITING_RESULT,
          },
          {
            testName: "when wallet creation state is CHALLENGE",
            walletCreationState: ecdsaDkgState.CHALLENGE,
          },
        ]

        testData.forEach((test) => {
          context(test.testName, () => {
            before(async () => {
              await createSnapshot()

              walletRegistry.getWalletCreationState.returns(
                test.walletCreationState
              )
            })

            after(async () => {
              walletRegistry.getWalletCreationState.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge.requestNewWallet(NO_MAIN_UTXO)
              ).to.be.revertedWith("Wallet creation already in progress")
            })
          })
        })
      })
    })
  })

  describe("__ecdsaWalletCreatedCallback", () => {
    context("when called by a third party", async () => {
      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .__ecdsaWalletCreatedCallback(
              ecdsaWalletTestData.walletID,
              ecdsaWalletTestData.publicKeyX,
              ecdsaWalletTestData.publicKeyY
            )
        ).to.be.revertedWith("Caller is not the ECDSA Wallet Registry")
      })
    })

    context("when called by the ECDSA Wallet Registry", async () => {
      context("when called with a valid ECDSA Wallet details", async () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await bridge
            .connect(walletRegistry.wallet)
            .__ecdsaWalletCreatedCallback(
              ecdsaWalletTestData.walletID,
              ecdsaWalletTestData.publicKeyX,
              ecdsaWalletTestData.publicKeyY
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should register ECDSA wallet reference", async () => {
          expect(
            (await bridge.wallets(ecdsaWalletTestData.pubKeyHash160))
              .ecdsaWalletID
          ).equals(ecdsaWalletTestData.walletID)
        })

        it("should transition wallet to Live state", async () => {
          expect(
            (await bridge.wallets(ecdsaWalletTestData.pubKeyHash160)).state
          ).equals(walletState.Live)
        })

        it("should set the created at timestamp", async () => {
          expect(
            (await bridge.wallets(ecdsaWalletTestData.pubKeyHash160)).createdAt
          ).equals(await lastBlockTime())
        })

        it("should set the wallet as the active one", async () => {
          expect(await bridge.activeWalletPubKeyHash()).equals(
            ecdsaWalletTestData.pubKeyHash160
          )
        })

        it("should emit NewWalletRegistered event", async () => {
          await expect(tx)
            .to.emit(bridge, "NewWalletRegistered")
            .withArgs(
              ecdsaWalletTestData.walletID,
              ecdsaWalletTestData.pubKeyHash160
            )
        })

        it("should increase the live wallets counter", async () => {
          expect(await bridge.liveWalletsCount()).to.be.equal(1)
        })
      })

      context(
        "when called with the ECDSA Wallet already registered",
        async () => {
          before(async () => {
            await createSnapshot()

            await bridge
              .connect(walletRegistry.wallet)
              .__ecdsaWalletCreatedCallback(
                ecdsaWalletTestData.walletID,
                ecdsaWalletTestData.publicKeyX,
                ecdsaWalletTestData.publicKeyY
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          const testData = [
            {
              testName: "with unique wallet ID and unique public key",
              walletID: ethers.utils.randomBytes(32),
              publicKeyX: ethers.utils.randomBytes(32),
              publicKeyY: ethers.utils.randomBytes(32),
              expectedError: undefined,
            },
            {
              testName: "with duplicated wallet ID and unique public key",
              walletID: ecdsaWalletTestData.walletID,
              publicKeyX: ethers.utils.randomBytes(32),
              publicKeyY: ethers.utils.randomBytes(32),
              expectedError: undefined,
            },
            {
              testName:
                "with unique wallet ID, unique public key X and duplicated public key Y",
              walletID: ethers.utils.randomBytes(32),
              publicKeyX: ethers.utils.randomBytes(32),
              publicKeyY: ecdsaWalletTestData.publicKeyY,
              expectedError: undefined,
            },
            {
              testName:
                "with unique wallet ID, unique public key Y and duplicated public key X",
              walletID: ethers.utils.randomBytes(32),
              publicKeyX: ecdsaWalletTestData.publicKeyY,
              publicKeyY: ethers.utils.randomBytes(32),
              expectedError: undefined,
            },
            {
              testName: "with unique wallet ID and duplicated public key",
              walletID: ethers.utils.randomBytes(32),
              publicKeyX: ecdsaWalletTestData.publicKeyX,
              publicKeyY: ecdsaWalletTestData.publicKeyY,
              expectedError: "ECDSA wallet has been already registered",
            },
            {
              testName: "with duplicated wallet ID and duplicated public key",
              walletID: ecdsaWalletTestData.walletID,
              publicKeyX: ecdsaWalletTestData.publicKeyX,
              publicKeyY: ecdsaWalletTestData.publicKeyY,
              expectedError: "ECDSA wallet has been already registered",
            },
          ]

          testData.forEach((test) => {
            context(test.testName, async () => {
              beforeEach(async () => {
                await createSnapshot()
              })

              afterEach(async () => {
                await restoreSnapshot()
              })

              it(
                test.expectedError ? "should revert" : "should not revert",
                async () => {
                  const tx: Promise<ContractTransaction> = bridge
                    .connect(walletRegistry.wallet)
                    .__ecdsaWalletCreatedCallback(
                      test.walletID,
                      test.publicKeyX,
                      test.publicKeyY
                    )

                  if (test.expectedError) {
                    await expect(tx).to.be.revertedWith(test.expectedError)
                  } else {
                    await expect(tx).not.to.be.reverted
                  }
                }
              )
            })
          })
        }
      )
    })
  })

  describe("__ecdsaWalletHeartbeatFailedCallback", () => {
    context("when called by the ECDSA Wallet Registry", () => {
      context("when wallet is in Live state", () => {
        before(async () => {
          await createSnapshot()

          await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
            ecdsaWalletID: ecdsaWalletTestData.walletID,
            mainUtxoHash: ethers.constants.HashZero,
            pendingRedemptionsValue: 0,
            createdAt: await lastBlockTime(),
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            pendingMovedFundsSweepRequestsCount: 0,
            state: walletState.Live,
            movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
          })
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when wallet balance is zero", () => {
          context("when wallet is the active one", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Set the tested wallet as the active one.
              await bridge.setActiveWallet(ecdsaWalletTestData.pubKeyHash160)

              tx = await bridge
                .connect(walletRegistry.wallet)
                .__ecdsaWalletHeartbeatFailedCallback(
                  ecdsaWalletTestData.walletID,
                  ecdsaWalletTestData.publicKeyX,
                  ecdsaWalletTestData.publicKeyY
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should change wallet's state to Closing", async () => {
              const { state } = await bridge.wallets(
                ecdsaWalletTestData.pubKeyHash160
              )

              expect(state).to.be.equal(walletState.Closing)
            })

            it("should set the wallet's closing started timestamp", async () => {
              const wallet = await bridge.wallets(
                ecdsaWalletTestData.pubKeyHash160
              )
              expect(wallet.closingStartedAt).to.be.equal(await lastBlockTime())
            })

            it("should emit WalletClosing event", async () => {
              await expect(tx)
                .to.emit(bridge, "WalletClosing")
                .withArgs(
                  ecdsaWalletTestData.walletID,
                  ecdsaWalletTestData.pubKeyHash160
                )
            })

            it("should unset the active wallet", async () => {
              expect(await bridge.activeWalletPubKeyHash()).to.be.equal(
                "0x0000000000000000000000000000000000000000"
              )
            })

            it("should decrease the live wallets counter", async () => {
              expect(await bridge.liveWalletsCount()).to.be.equal(0)
            })
          })

          context("when wallet is not the active one", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Set the active wallet to be different than the tested one.
              await bridge.setActiveWallet(
                ethers.utils.ripemd160(ecdsaWalletTestData.pubKeyHash160)
              )

              tx = await bridge
                .connect(walletRegistry.wallet)
                .__ecdsaWalletHeartbeatFailedCallback(
                  ecdsaWalletTestData.walletID,
                  ecdsaWalletTestData.publicKeyX,
                  ecdsaWalletTestData.publicKeyY
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should change wallet's state to Closing", async () => {
              const { state } = await bridge.wallets(
                ecdsaWalletTestData.pubKeyHash160
              )

              expect(state).to.be.equal(walletState.Closing)
            })

            it("should set the wallet's closing started timestamp", async () => {
              const wallet = await bridge.wallets(
                ecdsaWalletTestData.pubKeyHash160
              )
              expect(wallet.closingStartedAt).to.be.equal(await lastBlockTime())
            })

            it("should emit WalletClosing event", async () => {
              await expect(tx)
                .to.emit(bridge, "WalletClosing")
                .withArgs(
                  ecdsaWalletTestData.walletID,
                  ecdsaWalletTestData.pubKeyHash160
                )
            })

            it("should not unset the active wallet", async () => {
              expect(await bridge.activeWalletPubKeyHash()).to.be.equal(
                ethers.utils.ripemd160(ecdsaWalletTestData.pubKeyHash160)
              )
            })

            it("should decrease the live wallets counter", async () => {
              expect(await bridge.liveWalletsCount()).to.be.equal(0)
            })
          })
        })

        context("when wallet balance is greater than zero", () => {
          before(async () => {
            await createSnapshot()

            await bridge.setWalletMainUtxo(ecdsaWalletTestData.pubKeyHash160, {
              txHash:
                "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
              txOutputIndex: 0,
              txOutputValue: 1,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          context("when wallet is the active one", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Set the tested wallet as the active one.
              await bridge.setActiveWallet(ecdsaWalletTestData.pubKeyHash160)

              tx = await bridge
                .connect(walletRegistry.wallet)
                .__ecdsaWalletHeartbeatFailedCallback(
                  ecdsaWalletTestData.walletID,
                  ecdsaWalletTestData.publicKeyX,
                  ecdsaWalletTestData.publicKeyY
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should change wallet's state to MovingFunds", async () => {
              const { state } = await bridge.wallets(
                ecdsaWalletTestData.pubKeyHash160
              )

              expect(state).to.be.equal(walletState.MovingFunds)
            })

            it("should set move funds requested at timestamp", async () => {
              const { movingFundsRequestedAt } = await bridge.wallets(
                ecdsaWalletTestData.pubKeyHash160
              )

              expect(movingFundsRequestedAt).to.be.equal(await lastBlockTime())
            })

            it("should emit WalletMovingFunds event", async () => {
              await expect(tx)
                .to.emit(bridge, "WalletMovingFunds")
                .withArgs(
                  ecdsaWalletTestData.walletID,
                  ecdsaWalletTestData.pubKeyHash160
                )
            })

            it("should unset the active wallet", async () => {
              expect(await bridge.activeWalletPubKeyHash()).to.be.equal(
                "0x0000000000000000000000000000000000000000"
              )
            })

            it("should decrease the live wallets counter", async () => {
              expect(await bridge.liveWalletsCount()).to.be.equal(0)
            })
          })

          context("when wallet is not the active one", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Set the active wallet to be different than the tested one.
              await bridge.setActiveWallet(
                ethers.utils.ripemd160(ecdsaWalletTestData.pubKeyHash160)
              )

              tx = await bridge
                .connect(walletRegistry.wallet)
                .__ecdsaWalletHeartbeatFailedCallback(
                  ecdsaWalletTestData.walletID,
                  ecdsaWalletTestData.publicKeyX,
                  ecdsaWalletTestData.publicKeyY
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should change wallet's state to MovingFunds", async () => {
              const { state } = await bridge.wallets(
                ecdsaWalletTestData.pubKeyHash160
              )

              expect(state).to.be.equal(walletState.MovingFunds)
            })

            it("should set move funds requested at timestamp", async () => {
              const { movingFundsRequestedAt } = await bridge.wallets(
                ecdsaWalletTestData.pubKeyHash160
              )

              expect(movingFundsRequestedAt).to.be.equal(await lastBlockTime())
            })

            it("should emit WalletMovingFunds event", async () => {
              await expect(tx)
                .to.emit(bridge, "WalletMovingFunds")
                .withArgs(
                  ecdsaWalletTestData.walletID,
                  ecdsaWalletTestData.pubKeyHash160
                )
            })

            it("should not unset the active wallet", async () => {
              expect(await bridge.activeWalletPubKeyHash()).to.be.equal(
                ethers.utils.ripemd160(ecdsaWalletTestData.pubKeyHash160)
              )
            })

            it("should decrease the live wallets counter", async () => {
              expect(await bridge.liveWalletsCount()).to.be.equal(0)
            })
          })
        })
      })

      context("when wallet is not in Live state", () => {
        const testData = [
          {
            testName: "when wallet state is Unknown",
            walletState: walletState.Unknown,
          },
          {
            testName: "when wallet state is MovingFunds",
            walletState: walletState.MovingFunds,
          },
          {
            testName: "when wallet state is Closing",
            walletState: walletState.Closing,
          },
          {
            testName: "when wallet state is Closed",
            walletState: walletState.Closed,
          },
          {
            testName: "when wallet state is Terminated",
            walletState: walletState.Terminated,
          },
        ]

        testData.forEach((test) => {
          context(test.testName, () => {
            before(async () => {
              await createSnapshot()

              await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
                ecdsaWalletID: ecdsaWalletTestData.walletID,
                mainUtxoHash: ethers.constants.HashZero,
                pendingRedemptionsValue: 0,
                createdAt: 0,
                movingFundsRequestedAt: 0,
                closingStartedAt: 0,
                pendingMovedFundsSweepRequestsCount: 0,
                state: test.walletState,
                movingFundsTargetWalletsCommitmentHash:
                  ethers.constants.HashZero,
              })
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge
                  .connect(walletRegistry.wallet)
                  .__ecdsaWalletHeartbeatFailedCallback(
                    ecdsaWalletTestData.walletID,
                    ecdsaWalletTestData.publicKeyX,
                    ecdsaWalletTestData.publicKeyY
                  )
              ).to.be.revertedWith("Wallet must be in Live state")
            })
          })
        })
      })
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .__ecdsaWalletHeartbeatFailedCallback(
                ecdsaWalletTestData.walletID,
                ecdsaWalletTestData.publicKeyX,
                ecdsaWalletTestData.publicKeyY
              )
          ).to.be.revertedWith("Caller is not the ECDSA Wallet Registry")
        })
      })
    })
  })

  describe("notifyWalletCloseable", () => {
    context("when the reported wallet is not the active one", () => {
      context("when wallet is in Live state", () => {
        before(async () => {
          await createSnapshot()

          await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
            ecdsaWalletID: ecdsaWalletTestData.walletID,
            mainUtxoHash: ethers.constants.HashZero,
            pendingRedemptionsValue: 0,
            createdAt: await lastBlockTime(),
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            pendingMovedFundsSweepRequestsCount: 0,
            state: walletState.Live,
            movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
          })
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when wallet reached the maximum age", () => {
          before(async () => {
            await createSnapshot()

            await increaseTime((await bridge.walletParameters()).walletMaxAge)
          })

          after(async () => {
            await restoreSnapshot()
          })

          context("when wallet balance is zero", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              tx = await bridge
                .connect(walletRegistry.wallet)
                .notifyWalletCloseable(
                  ecdsaWalletTestData.pubKeyHash160,
                  NO_MAIN_UTXO
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should change wallet's state to Closing", async () => {
              const { state } = await bridge.wallets(
                ecdsaWalletTestData.pubKeyHash160
              )

              expect(state).to.be.equal(walletState.Closing)
            })

            it("should set the wallet's closing started timestamp", async () => {
              const wallet = await bridge.wallets(
                ecdsaWalletTestData.pubKeyHash160
              )
              expect(wallet.closingStartedAt).to.be.equal(await lastBlockTime())
            })

            it("should emit WalletClosing event", async () => {
              await expect(tx)
                .to.emit(bridge, "WalletClosing")
                .withArgs(
                  ecdsaWalletTestData.walletID,
                  ecdsaWalletTestData.pubKeyHash160
                )
            })

            it("should decrease the live wallets counter", async () => {
              expect(await bridge.liveWalletsCount()).to.be.equal(0)
            })
          })

          context("when wallet balance is greater than zero", () => {
            const walletMainUtxo = {
              txHash:
                "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
              txOutputIndex: 0,
              txOutputValue: 1,
            }

            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              await bridge.setWalletMainUtxo(
                ecdsaWalletTestData.pubKeyHash160,
                walletMainUtxo
              )

              tx = await bridge
                .connect(walletRegistry.wallet)
                .notifyWalletCloseable(
                  ecdsaWalletTestData.pubKeyHash160,
                  walletMainUtxo
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should change wallet's state to MovingFunds", async () => {
              const { state } = await bridge.wallets(
                ecdsaWalletTestData.pubKeyHash160
              )

              expect(state).to.be.equal(walletState.MovingFunds)
            })

            it("should set move funds requested at timestamp", async () => {
              const { movingFundsRequestedAt } = await bridge.wallets(
                ecdsaWalletTestData.pubKeyHash160
              )

              expect(movingFundsRequestedAt).to.be.equal(await lastBlockTime())
            })

            it("should emit WalletMovingFunds event", async () => {
              await expect(tx)
                .to.emit(bridge, "WalletMovingFunds")
                .withArgs(
                  ecdsaWalletTestData.walletID,
                  ecdsaWalletTestData.pubKeyHash160
                )
            })

            it("should decrease the live wallets counter", async () => {
              expect(await bridge.liveWalletsCount()).to.be.equal(0)
            })
          })
        })

        context(
          "when wallet did not reach the maximum age but their balance is lesser than the minimum threshold",
          () => {
            context("when wallet balance is zero", () => {
              let tx: ContractTransaction

              before(async () => {
                await createSnapshot()

                tx = await bridge
                  .connect(walletRegistry.wallet)
                  .notifyWalletCloseable(
                    ecdsaWalletTestData.pubKeyHash160,
                    NO_MAIN_UTXO
                  )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should change wallet's state to Closing", async () => {
                const { state } = await bridge.wallets(
                  ecdsaWalletTestData.pubKeyHash160
                )

                expect(state).to.be.equal(walletState.Closing)
              })

              it("should set the wallet's closing started timestamp", async () => {
                const wallet = await bridge.wallets(
                  ecdsaWalletTestData.pubKeyHash160
                )
                expect(wallet.closingStartedAt).to.be.equal(
                  await lastBlockTime()
                )
              })

              it("should emit WalletClosing event", async () => {
                await expect(tx)
                  .to.emit(bridge, "WalletClosing")
                  .withArgs(
                    ecdsaWalletTestData.walletID,
                    ecdsaWalletTestData.pubKeyHash160
                  )
              })

              it("should decrease the live wallets counter", async () => {
                expect(await bridge.liveWalletsCount()).to.be.equal(0)
              })
            })

            context("when wallet balance is greater than zero", () => {
              const walletMainUtxo = {
                txHash:
                  "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                txOutputIndex: 0,
                txOutputValue: constants.walletClosureMinBtcBalance.sub(1),
              }

              let tx: ContractTransaction

              before(async () => {
                await createSnapshot()

                await bridge.setWalletMainUtxo(
                  ecdsaWalletTestData.pubKeyHash160,
                  walletMainUtxo
                )

                tx = await bridge
                  .connect(walletRegistry.wallet)
                  .notifyWalletCloseable(
                    ecdsaWalletTestData.pubKeyHash160,
                    walletMainUtxo
                  )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should change wallet's state to MovingFunds", async () => {
                const { state } = await bridge.wallets(
                  ecdsaWalletTestData.pubKeyHash160
                )

                expect(state).to.be.equal(walletState.MovingFunds)
              })

              it("should set move funds requested at timestamp", async () => {
                const { movingFundsRequestedAt } = await bridge.wallets(
                  ecdsaWalletTestData.pubKeyHash160
                )

                expect(movingFundsRequestedAt).to.be.equal(
                  await lastBlockTime()
                )
              })

              it("should emit WalletMovingFunds event", async () => {
                await expect(tx)
                  .to.emit(bridge, "WalletMovingFunds")
                  .withArgs(
                    ecdsaWalletTestData.walletID,
                    ecdsaWalletTestData.pubKeyHash160
                  )
              })

              it("should decrease the live wallets counter", async () => {
                expect(await bridge.liveWalletsCount()).to.be.equal(0)
              })
            })
          }
        )

        context(
          "when wallet did not reach the maximum age and their balance is greater or equal the minimum threshold",
          () => {
            const walletMainUtxo = {
              txHash:
                "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
              txOutputIndex: 0,
              txOutputValue: constants.walletClosureMinBtcBalance,
            }

            before(async () => {
              await createSnapshot()

              await bridge.setWalletMainUtxo(
                ecdsaWalletTestData.pubKeyHash160,
                walletMainUtxo
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge
                  .connect(walletRegistry.wallet)
                  .notifyWalletCloseable(
                    ecdsaWalletTestData.pubKeyHash160,
                    walletMainUtxo
                  )
              ).to.be.revertedWith(
                "Wallet needs to be old enough or have too few satoshis"
              )
            })
          }
        )

        context(
          "when wallet did not reach the maximum age and invalid main UTXO data is passed",
          () => {
            const walletMainUtxo = {
              txHash:
                "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
              txOutputIndex: 0,
              txOutputValue: constants.walletClosureMinBtcBalance,
            }

            before(async () => {
              await createSnapshot()

              await bridge.setWalletMainUtxo(
                ecdsaWalletTestData.pubKeyHash160,
                walletMainUtxo
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              const corruptedWalletMainUtxo = {
                ...walletMainUtxo,
                txOutputIndex: 1,
              }

              await expect(
                bridge
                  .connect(walletRegistry.wallet)
                  .notifyWalletCloseable(
                    ecdsaWalletTestData.pubKeyHash160,
                    corruptedWalletMainUtxo
                  )
              ).to.be.revertedWith("Invalid wallet main UTXO data")
            })
          }
        )
      })

      context("when wallet is not in Live state", () => {
        const testData = [
          {
            testName: "when wallet state is Unknown",
            walletState: walletState.Unknown,
          },
          {
            testName: "when wallet state is MovingFunds",
            walletState: walletState.MovingFunds,
          },
          {
            testName: "when wallet state is Closing",
            walletState: walletState.Closing,
          },
          {
            testName: "when wallet state is Closed",
            walletState: walletState.Closed,
          },
          {
            testName: "when wallet state is Terminated",
            walletState: walletState.Terminated,
          },
        ]

        testData.forEach((test) => {
          context(test.testName, () => {
            before(async () => {
              await createSnapshot()

              await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
                ecdsaWalletID: ecdsaWalletTestData.walletID,
                mainUtxoHash: ethers.constants.HashZero,
                pendingRedemptionsValue: 0,
                createdAt: 0,
                movingFundsRequestedAt: 0,
                closingStartedAt: 0,
                pendingMovedFundsSweepRequestsCount: 0,
                state: test.walletState,
                movingFundsTargetWalletsCommitmentHash:
                  ethers.constants.HashZero,
              })
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge
                  .connect(walletRegistry.wallet)
                  .notifyWalletCloseable(
                    ecdsaWalletTestData.pubKeyHash160,
                    NO_MAIN_UTXO
                  )
              ).to.be.revertedWith("Wallet must be in Live state")
            })
          })
        })
      })
    })

    context("when the reported wallet is the active one", () => {
      before(async () => {
        await createSnapshot()

        // Set the checked wallet as the active one.
        await bridge.setActiveWallet(ecdsaWalletTestData.pubKeyHash160)

        await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
          ecdsaWalletID: ecdsaWalletTestData.walletID,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: await lastBlockTime(),
          movingFundsRequestedAt: 0,
          closingStartedAt: 0,
          pendingMovedFundsSweepRequestsCount: 0,
          state: walletState.Live,
          movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridge
            .connect(walletRegistry.wallet)
            .notifyWalletCloseable(
              ecdsaWalletTestData.pubKeyHash160,
              NO_MAIN_UTXO
            )
        ).to.be.revertedWith("Active wallet cannot be considered closeable")
      })
    })
  })

  describe("notifyWalletClosingPeriodElapsed", () => {
    const walletDraft = {
      ecdsaWalletID: ecdsaWalletTestData.walletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: 0,
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Unknown,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    }

    context("when the wallet is in the Closing state", () => {
      before(async () => {
        await createSnapshot()

        await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
          ...walletDraft,
          state: walletState.Live,
        })

        // Switches the wallet to Closing state because the wallet has
        // no main UTXO set.
        await bridge
          .connect(walletRegistry.wallet)
          .__ecdsaWalletHeartbeatFailedCallback(
            ecdsaWalletTestData.walletID,
            ecdsaWalletTestData.publicKeyX,
            ecdsaWalletTestData.publicKeyY
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when closing period has elapsed", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await increaseTime(
            (
              await bridge.walletParameters()
            ).walletClosingPeriod
          )

          tx = await bridge.notifyWalletClosingPeriodElapsed(
            ecdsaWalletTestData.pubKeyHash160
          )
        })

        after(async () => {
          await walletRegistry.closeWallet.reset()

          await restoreSnapshot()
        })

        it("should set wallet state to Closed", async () => {
          expect(
            (await bridge.wallets(ecdsaWalletTestData.pubKeyHash160)).state
          ).to.be.equal(walletState.Closed)
        })

        it("should emit WalletClosed event", async () => {
          await expect(tx)
            .to.emit(bridge, "WalletClosed")
            .withArgs(
              walletDraft.ecdsaWalletID,
              ecdsaWalletTestData.pubKeyHash160
            )
        })

        it("should call the ECDSA wallet registry's closeWallet function", async () => {
          expect(walletRegistry.closeWallet).to.have.been.calledOnceWith(
            walletDraft.ecdsaWalletID
          )
        })
      })

      context("when closing period has not elapsed yet", () => {
        before(async () => {
          await createSnapshot()

          await increaseTime(
            (await bridge.walletParameters()).walletClosingPeriod - 1
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge.notifyWalletClosingPeriodElapsed(
              ecdsaWalletTestData.pubKeyHash160
            )
          ).to.be.revertedWith("Closing period has not elapsed yet")
        })
      })
    })

    context("when the wallet is not in the Closing state", () => {
      const testData = [
        {
          testName: "when wallet state is Unknown",
          walletState: walletState.Unknown,
        },
        {
          testName: "when wallet state is Live",
          walletState: walletState.Live,
        },
        {
          testName: "when wallet state is MovingFunds",
          walletState: walletState.MovingFunds,
        },
        {
          testName: "when wallet state is Closed",
          walletState: walletState.Closed,
        },
        {
          testName: "when wallet state is Terminated",
          walletState: walletState.Terminated,
        },
      ]

      testData.forEach((test) => {
        context(test.testName, () => {
          before(async () => {
            await createSnapshot()

            await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
              ...walletDraft,
              state: test.walletState,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge.notifyWalletClosingPeriodElapsed(
                ecdsaWalletTestData.pubKeyHash160
              )
            ).to.be.revertedWith("Wallet must be in Closing state")
          })
        })
      })
    })
  })
})
