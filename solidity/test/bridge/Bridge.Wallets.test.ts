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
  IBridgeLifecycleRouter,
  IWalletRegistry,
} from "../../typechain"
import { NO_MAIN_UTXO } from "../data/deposit-sweep"
import { ecdsaWalletTestData } from "../data/ecdsa"
import { constants, walletState } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

describe("Bridge - Wallets", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress

  let walletRegistry: FakeContract<IWalletRegistry>
  let lifecycleRouter: FakeContract<IBridgeLifecycleRouter>
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, walletRegistry, bridge, bridgeGovernance } =
      await waffle.loadFixture(bridgeFixture))

    lifecycleRouter = await smock.fake<IBridgeLifecycleRouter>(
      "IBridgeLifecycleRouter"
    )
    await bridgeGovernance
      .connect(governance)
      .setLifecycleRouter(lifecycleRouter.address)
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
      context("when FROST registry is not wired", () => {
        context("when active wallet is not set", () => {
          // D-2: scheme=Ecdsa dispatch unconditionally reverts.
          // The previous "should emit + should call registry"
          // pair has been collapsed into a single revert
          // assertion since neither downstream effect can
          // happen.
          it("should revert (FROST registry unwired post-slice-3)", async () => {
            await expect(
              bridge.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO)
            ).to.be.reverted // D-2.2 slice 3: FrostWalletRegistryNotSet
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            expect(walletRegistry.requestNewWallet).to.not.have.been.called
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
                    })

                    after(async () => {
                      walletRegistry.requestNewWallet.reset()

                      await restoreSnapshot()
                    })

                    // D-2: scheme=Ecdsa dispatch unconditionally
                    // reverts; the prior emit + registry-call
                    // assertions collapsed into a single revert
                    // pin.
                    it("should revert (FROST registry unwired post-slice-3)", async () => {
                      await expect(
                        bridge.requestNewWallet({
                          txHash:
                            "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                          txOutputIndex: 1,
                          txOutputValue: constants.walletCreationMinBtcBalance,
                        })
                      ).to.be.reverted // D-2.2 slice 3: FrostWalletRegistryNotSet
                      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                      expect(walletRegistry.requestNewWallet).to.not.have.been
                        .called
                    })
                  }
                )

                context(
                  "when active wallet is not old enough but its balance is greater or equal the maximum BTC balance threshold",
                  () => {
                    before(async () => {
                      await createSnapshot()

                      // Simulate the wallet has a BTC balance equal to the
                      // maximum BTC amount threshold by preparing the wallet's
                      // main UTXO accordingly.
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
                    })

                    after(async () => {
                      walletRegistry.requestNewWallet.reset()

                      await restoreSnapshot()
                    })

                    it("should revert (FROST registry unwired post-slice-3)", async () => {
                      await expect(
                        bridge.requestNewWallet({
                          txHash:
                            "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                          txOutputIndex: 1,
                          txOutputValue: constants.walletCreationMaxBtcBalance,
                        })
                      ).to.be.reverted // D-2.2 slice 3: FrostWalletRegistryNotSet
                      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                      expect(walletRegistry.requestNewWallet).to.not.have.been
                        .called
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
                })

                after(async () => {
                  walletRegistry.requestNewWallet.reset()

                  await restoreSnapshot()
                })

                it("should revert (FROST registry unwired post-slice-3)", async () => {
                  await expect(bridge.requestNewWallet(NO_MAIN_UTXO)).to.be
                    .reverted // D-2.2 slice 3: FrostWalletRegistryNotSet
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  expect(walletRegistry.requestNewWallet).to.not.have.been
                    .called
                })
              })
            })
          })
        })
      })
    })
  })

  // D-2 removed `__ecdsaWalletCreatedCallback` from Bridge.
  // Tests that previously exercised the callback now route
  // through the `BridgeStub.__ecdsaWalletCreatedCallbackForTest`
  // helper, which mirrors the body of the pre-removal callback
  // minus the `msg.sender == ecdsaWalletRegistry` access check
  // (no longer relevant — the production callback is gone).
  // The "called by a third party should revert" case is no
  // longer applicable: calling a removed selector reverts with
  // no data at the EVM dispatcher; there is no
  // registry-vs-third-party distinction to assert.
  describe("__ecdsaWalletCreatedCallback (test-stub helper)", () => {
    context("when called with a valid ECDSA Wallet details", async () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridge.__ecdsaWalletCreatedCallbackForTest(
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

      it("should emit NewWalletRegisteredV2 event", async () => {
        const expectedWalletID = ethers.utils.hexZeroPad(
          ecdsaWalletTestData.pubKeyHash160,
          32
        )

        await expect(tx)
          .to.emit(bridge, "NewWalletRegisteredV2")
          .withArgs(
            expectedWalletID,
            ecdsaWalletTestData.walletID,
            ecdsaWalletTestData.pubKeyHash160
          )
      })

      it("should expose canonical wallet ID mapping", async () => {
        const expectedWalletID = ethers.utils.hexZeroPad(
          ecdsaWalletTestData.pubKeyHash160,
          32
        )

        expect(
          await bridge.walletPubKeyHashForWalletID(expectedWalletID)
        ).to.equal(ecdsaWalletTestData.pubKeyHash160)

        const walletByID = await bridge.walletsByWalletID(expectedWalletID)
        const walletByPKH = await bridge.wallets(
          ecdsaWalletTestData.pubKeyHash160
        )

        expect(walletByID.ecdsaWalletID).to.equal(walletByPKH.ecdsaWalletID)
        expect(walletByID.state).to.equal(walletByPKH.state)
        expect(walletByID.createdAt).to.equal(walletByPKH.createdAt)
      })

      it("should expose active wallet canonical ID", async () => {
        const expectedWalletID = ethers.utils.hexZeroPad(
          ecdsaWalletTestData.pubKeyHash160,
          32
        )

        expect(await bridge.activeWalletID()).to.equal(expectedWalletID)
        expect(
          await bridge.walletID(ecdsaWalletTestData.pubKeyHash160)
        ).to.equal(expectedWalletID)
      })

      it("should increase the live wallets counter", async () => {
        expect(await bridge.liveWalletsCount()).to.be.equal(1)
      })
    })

    context(
      "when registry reports a non-legacy 32-byte wallet identifier",
      async () => {
        const registryWalletID =
          "0x1234123412341234123412341234123412341234123412341234123412341234"
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await bridge.__ecdsaWalletCreatedCallbackForTest(
            registryWalletID,
            ecdsaWalletTestData.publicKeyX,
            ecdsaWalletTestData.publicKeyY
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should store the registry ID only as the ECDSA wallet reference", async () => {
          expect(
            (await bridge.wallets(ecdsaWalletTestData.pubKeyHash160))
              .ecdsaWalletID
          ).equals(registryWalletID)
        })

        it("should emit canonical wallet ID derived from the ECDSA public key hash", async () => {
          const expectedWalletID = ethers.utils.hexZeroPad(
            ecdsaWalletTestData.pubKeyHash160,
            32
          )

          await expect(tx)
            .to.emit(bridge, "NewWalletRegisteredV2")
            .withArgs(
              expectedWalletID,
              registryWalletID,
              ecdsaWalletTestData.pubKeyHash160
            )
        })

        it("should not activate the registry ID as a canonical wallet ID", async () => {
          const expectedWalletID = ethers.utils.hexZeroPad(
            ecdsaWalletTestData.pubKeyHash160,
            32
          )

          expect(await bridge.activeWalletID()).to.equal(expectedWalletID)
          expect(await bridge.activeWalletID()).to.not.equal(registryWalletID)
          expect(
            await bridge.walletPubKeyHashForWalletID(registryWalletID)
          ).to.equal(ethers.constants.AddressZero)
        })
      }
    )

    context(
      "when called with the ECDSA Wallet already registered",
      async () => {
        before(async () => {
          await createSnapshot()

          await bridge.__ecdsaWalletCreatedCallbackForTest(
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
                const tx: Promise<ContractTransaction> =
                  bridge.__ecdsaWalletCreatedCallbackForTest(
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

  describe("activeWalletID", () => {
    context("when active wallet has a stored canonical ID", () => {
      const nonLegacyWalletID =
        "0x1234123412341234123412341234123412341234123412341234123412341234"

      before(async () => {
        await createSnapshot()

        await bridge.setActiveWalletWithID(
          ecdsaWalletTestData.pubKeyHash160,
          nonLegacyWalletID
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return stored canonical wallet ID", async () => {
        expect(await bridge.activeWalletID()).to.equal(nonLegacyWalletID)
      })
    })

    context("when active wallet has no stored canonical ID", () => {
      before(async () => {
        await createSnapshot()

        await bridge.setActiveWalletWithID(
          ecdsaWalletTestData.pubKeyHash160,
          ethers.constants.HashZero
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should derive legacy canonical wallet ID from wallet public key hash", async () => {
        const expectedWalletID = ethers.utils.hexZeroPad(
          ecdsaWalletTestData.pubKeyHash160,
          32
        )

        expect(await bridge.activeWalletID()).to.equal(expectedWalletID)
      })
    })

    context(
      "when migrated legacy wallet has no stored canonical ID mapping",
      () => {
        let expectedWalletID: string

        before(async () => {
          await createSnapshot()

          expectedWalletID = ethers.utils.hexZeroPad(
            ecdsaWalletTestData.pubKeyHash160,
            32
          )

          await bridge.setActiveWalletWithID(
            ecdsaWalletTestData.pubKeyHash160,
            ethers.constants.HashZero
          )
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

        it("should resolve wallet public key hash from legacy canonical wallet ID", async () => {
          expect(
            await bridge.walletPubKeyHashForWalletID(expectedWalletID)
          ).to.equal(ecdsaWalletTestData.pubKeyHash160)
        })

        it("should expose the migrated wallet through walletsByWalletID", async () => {
          const walletByID = await bridge.walletsByWalletID(expectedWalletID)

          expect(walletByID.ecdsaWalletID).to.equal(
            ecdsaWalletTestData.walletID
          )
          expect(walletByID.state).to.equal(walletState.Live)
        })

        it("should keep activeWalletID round-trippable through wallet ID views", async () => {
          const activeWalletID = await bridge.activeWalletID()

          expect(activeWalletID).to.equal(expectedWalletID)
          expect(
            await bridge.walletPubKeyHashForWalletID(activeWalletID)
          ).to.equal(ecdsaWalletTestData.pubKeyHash160)
        })
      }
    )
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
          closingStartedAt: await lastBlockTime(),
          state: walletState.Closing,
        })
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
          await lifecycleRouter.closeWallet.reset()

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

        it("should call the lifecycle router's closeWallet function", async () => {
          expect(lifecycleRouter.closeWallet).to.have.been.calledOnceWith(
            ecdsaWalletTestData.pubKeyHash160
          )
        })
      })

      context("when closing period has not elapsed yet", () => {
        before(async () => {
          await createSnapshot()

          await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
            ...walletDraft,
            closingStartedAt: (await lastBlockTime()) + 1,
            state: walletState.Closing,
          })

          await increaseTime(
            (await bridge.walletParameters()).walletClosingPeriod - 2
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
