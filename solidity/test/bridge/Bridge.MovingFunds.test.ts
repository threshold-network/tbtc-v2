/* eslint-disable no-underscore-dangle */
import { ethers, helpers, waffle } from "hardhat"
import chai, { assert, expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, Contract, ContractTransaction } from "ethers"
import { Deployment } from "hardhat-deploy/types"
import type { Mock } from "../helpers/mock"
import type {
  Bridge,
  BridgeStub,
  IRelay,
  IWalletRegistry,
  BridgeGovernance,
  ReimbursementPool,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import {
  constants,
  movedFundsSweepRequestState,
  walletState,
} from "../fixtures"
import {
  MovedFundsSweepMultipleOutputs,
  MovedFundsSweepP2SHOutput,
  MovedFundsSweepProvablyUnspendableOutput,
  MovedFundsSweepTestData,
  MovedFundsSweepWithMainUtxo,
  MovedFundsSweepWithoutMainUtxo,
  MovingFundsTestData,
  MultipleInputs,
  MultipleTargetWalletsAndDivisibleAmount,
  MultipleTargetWalletsAndIndivisibleAmount,
  MultipleTargetWalletsButAmountDistributedUnevenly,
  SingleProvablyUnspendable,
  SingleTargetWallet,
  SingleTargetWalletButP2SH,
} from "../data/moving-funds"
import { ecdsaWalletTestData } from "../data/ecdsa"
import { NO_MAIN_UTXO } from "../data/deposit-sweep"
import { to1ePrecision } from "../helpers/contract-test-helpers"
import { expectCalledOnceWith } from "../helpers/mock"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

describe("Bridge - Moving funds", () => {
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let spvMaintainer: SignerWithAddress

  let relay: Mock<IRelay>
  let walletRegistry: Mock<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let reimbursementPool: ReimbursementPool
  let deployBridge: (
    txProofDifficultyFactor: number
  ) => Promise<[Contract, Deployment]>

  let movingFundsTimeoutResetDelay: number
  let movingFundsTimeout: number
  let movingFundsTimeoutSlashingAmount: BigNumber
  let movingFundsTimeoutNotifierRewardMultiplier: number
  let movedFundsSweepTimeout: number
  let movedFundsSweepTimeoutSlashingAmount: BigNumber
  let movedFundsSweepTimeoutNotifierRewardMultiplier: number

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      thirdParty,
      spvMaintainer,
      relay,
      walletRegistry,
      bridge,
      bridgeGovernance,
      reimbursementPool,
      deployBridge,
    } = await bridgeFixture())
    ;({
      movingFundsTimeoutResetDelay,
      movingFundsTimeout,
      movingFundsTimeoutSlashingAmount,
      movingFundsTimeoutNotifierRewardMultiplier,
      movedFundsSweepTimeout,
      movedFundsSweepTimeoutSlashingAmount,
      movedFundsSweepTimeoutNotifierRewardMultiplier,
    } = await bridge.movingFundsParameters())
  })

  describe("submitMovingFundsCommitment", () => {
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

    context("when source wallet is in the MovingFunds state", () => {
      before(async () => {
        await createSnapshot()

        await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
          ...walletDraft,
          state: walletState.MovingFunds,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when source wallet has no pending redemptions", () => {
        // The wallet created using the `walletDraft` has no pending redemptions
        // by default. No need to do anything here.

        context(
          "when source wallet has no pending moved funds sweep requests",
          () => {
            // The wallet created using the `walletDraft` has no pending moved
            // funds sweep requests by default. No need to do anything here.

            context("when the commitment was not submitted yet", () => {
              // The wallet created using the `walletDraft` has no commitment
              // submitted by default. No need to do anything here.

              context(
                "when the caller is a member of the source wallet",
                () => {
                  const walletMembersIDs = [1, 2, 3, 4, 5]
                  const walletMemberIndex = 2

                  let caller: SignerWithAddress

                  before(async () => {
                    await createSnapshot()

                    caller = thirdParty

                    await walletRegistry.isWalletMember
                      .whenCalledWith(
                        ecdsaWalletTestData.walletID,
                        walletMembersIDs,
                        caller.address,
                        walletMemberIndex
                      )
                      .returns(true)
                  })

                  after(async () => {
                    await walletRegistry.isWalletMember.reset()

                    await restoreSnapshot()
                  })

                  context("when passed wallet main UTXO is valid", () => {
                    context("when wallet balance is greater than zero", () => {
                      // Just an arbitrary main UTXO with value of 26 BTC.
                      const mainUtxo = {
                        txHash:
                          "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                        txOutputIndex: 0,
                        txOutputValue: to1ePrecision(26, 8),
                      }

                      before(async () => {
                        await createSnapshot()

                        // Set up a main UTXO for the source wallet.
                        await bridge.setWalletMainUtxo(
                          ecdsaWalletTestData.pubKeyHash160,
                          mainUtxo
                        )
                      })

                      after(async () => {
                        await restoreSnapshot()
                      })

                      context(
                        "when the expected target wallets count is greater than zero",
                        () => {
                          // Just some arbitrary 20-byte hashes to simulate live
                          // wallets PKHs. They are ordered in the expected way, i.e.
                          // the hashes represented as numbers form a strictly
                          // increasing sequence.
                          const liveWallets = [
                            "0x4b440cb29c80c3f256212d8fdd4f2125366f3c91",
                            "0x888f01315e0268bfa05d5e522f8d63f6824d9a96",
                            "0xb2a89e53a4227dbe530a52a1c419040735fa636c",
                            "0xbf198e8fff0f90af01024153701da99b9bc08dc5",
                            "0xffb9e05013f5cd126915bc03d340cc5c1be81862",
                          ]

                          before(async () => {
                            await createSnapshot()

                            for (let i = 0; i < liveWallets.length; i++) {
                              // eslint-disable-next-line no-await-in-loop
                              await bridge.setWallet(liveWallets[i], {
                                ...walletDraft,
                                state: walletState.Live,
                              })
                            }
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          context(
                            "when the submitted target wallets count is same as the expected",
                            () => {
                              // The source wallet has a main UTXO with value of 26 BTC,
                              // the max BTC transfer is 10 BTC by default (see
                              // `constants.walletMaxBtcTransfer`) and the count of
                              // live wallets is `5`. We compute the expected target
                              // wallets count as:
                              // `N = min(liveWalletsCount, ceil(walletBtcBalance / walletMaxBtcTransfer))`
                              // so we have `N = min(5, 26 / 10) = min(5, 3) = 3`
                              const expectedTargetWalletsCount = 3

                              context(
                                "when all target wallets are different than the source wallet",
                                () => {
                                  context(
                                    "when all target wallets follow the expected order",
                                    () => {
                                      context(
                                        "when all target wallets are in the Live state",
                                        () => {
                                          let tx: ContractTransaction

                                          const targetWallets =
                                            liveWallets.slice(
                                              0,
                                              expectedTargetWalletsCount
                                            )

                                          const { provider } = waffle

                                          let initialCallerBalance: BigNumber

                                          before(async () => {
                                            await createSnapshot()

                                            await deployer.sendTransaction({
                                              to: reimbursementPool.address,
                                              value:
                                                ethers.utils.parseEther("100"),
                                            })

                                            initialCallerBalance =
                                              await provider.getBalance(
                                                caller.address
                                              )

                                            tx = await bridge
                                              .connect(caller)
                                              .submitMovingFundsCommitment(
                                                ecdsaWalletTestData.pubKeyHash160,
                                                mainUtxo,
                                                walletMembersIDs,
                                                walletMemberIndex,
                                                targetWallets
                                              )
                                          })

                                          after(async () => {
                                            await restoreSnapshot()
                                          })

                                          it("should store the target wallets commitment for the given wallet", async () => {
                                            expect(
                                              (
                                                await bridge.wallets(
                                                  ecdsaWalletTestData.pubKeyHash160
                                                )
                                              )
                                                .movingFundsTargetWalletsCommitmentHash
                                            ).to.be.equal(
                                              ethers.utils.solidityKeccak256(
                                                ["bytes20[]"],
                                                [targetWallets]
                                              )
                                            )
                                          })

                                          it("should emit the MovingFundsCommitmentSubmitted event", async () => {
                                            await expect(tx)
                                              .to.emit(
                                                bridge,
                                                "MovingFundsCommitmentSubmitted"
                                              )
                                              .withArgs(
                                                ecdsaWalletTestData.pubKeyHash160,
                                                targetWallets,
                                                caller.address
                                              )
                                          })

                                          it("should refund ETH", async () => {
                                            const postCallerBalance =
                                              await provider.getBalance(
                                                caller.address
                                              )
                                            const diff =
                                              postCallerBalance.sub(
                                                initialCallerBalance
                                              )

                                            expect(diff).to.be.gt(0)
                                            expect(diff).to.be.lt(
                                              ethers.utils.parseUnits(
                                                "1000000",
                                                "gwei"
                                              ) // 0,001 ETH
                                            )
                                          })
                                        }
                                      )

                                      context(
                                        "when one of the target wallets is not in the Live state",
                                        () => {
                                          it("should revert", async () => {
                                            // Put an Unknown wallet into the mix.
                                            const targetWallets = [
                                              "0x2313e29d08e6b5e0d3cda040ed7f664ce9c840c4",
                                              liveWallets[0],
                                              liveWallets[1],
                                            ]

                                            await expect(
                                              bridge
                                                .connect(caller)
                                                .submitMovingFundsCommitment(
                                                  ecdsaWalletTestData.pubKeyHash160,
                                                  mainUtxo,
                                                  walletMembersIDs,
                                                  walletMemberIndex,
                                                  targetWallets
                                                )
                                            ).to.be.revertedWith(
                                              "Submitted target wallet must be in Live state"
                                            )
                                          })
                                        }
                                      )
                                    }
                                  )

                                  context(
                                    "when one of the target wallets break the expected order",
                                    () => {
                                      it("should revert", async () => {
                                        const targetWallets = [
                                          liveWallets[0],
                                          liveWallets[1],
                                          liveWallets[1],
                                        ]

                                        await expect(
                                          bridge
                                            .connect(caller)
                                            .submitMovingFundsCommitment(
                                              ecdsaWalletTestData.pubKeyHash160,
                                              mainUtxo,
                                              walletMembersIDs,
                                              walletMemberIndex,
                                              targetWallets
                                            )
                                        ).to.be.revertedWith(
                                          "Submitted target wallet breaks the expected order"
                                        )
                                      })
                                    }
                                  )
                                }
                              )

                              context(
                                "when one of the target wallets is same as the source wallet",
                                () => {
                                  it("should revert", async () => {
                                    const targetWallets = [
                                      liveWallets[0],
                                      ecdsaWalletTestData.pubKeyHash160,
                                      liveWallets[1],
                                    ]

                                    await expect(
                                      bridge
                                        .connect(caller)
                                        .submitMovingFundsCommitment(
                                          ecdsaWalletTestData.pubKeyHash160,
                                          mainUtxo,
                                          walletMembersIDs,
                                          walletMemberIndex,
                                          targetWallets
                                        )
                                    ).to.be.revertedWith(
                                      "Submitted target wallet cannot be equal to the source wallet"
                                    )
                                  })
                                }
                              )
                            }
                          )

                          context(
                            "when the submitted target wallets count is other than the expected",
                            () => {
                              it("should revert", async () => {
                                await expect(
                                  bridge
                                    .connect(caller)
                                    .submitMovingFundsCommitment(
                                      ecdsaWalletTestData.pubKeyHash160,
                                      mainUtxo,
                                      walletMembersIDs,
                                      walletMemberIndex,
                                      [liveWallets[0], liveWallets[1]]
                                    )
                                ).to.be.revertedWith(
                                  "Submitted target wallets count is other than expected"
                                )
                              })
                            }
                          )
                        }
                      )

                      context(
                        "when the expected target wallets count is zero",
                        () => {
                          it("should revert", async () => {
                            await expect(
                              // The last parameter doesn't matter in this scenario.
                              bridge
                                .connect(caller)
                                .submitMovingFundsCommitment(
                                  ecdsaWalletTestData.pubKeyHash160,
                                  mainUtxo,
                                  walletMembersIDs,
                                  walletMemberIndex,
                                  []
                                )
                            ).to.be.revertedWith("No target wallets available")
                          })
                        }
                      )
                    })

                    context("when wallet balance is zero", () => {
                      it("should revert", async () => {
                        await expect(
                          // The last parameter doesn't matter in this scenario.
                          bridge.connect(caller).submitMovingFundsCommitment(
                            ecdsaWalletTestData.pubKeyHash160,
                            NO_MAIN_UTXO, // That makes the balance to be 0 BTC.
                            walletMembersIDs,
                            walletMemberIndex,
                            []
                          )
                        ).to.be.revertedWith("Wallet BTC balance is zero")
                      })
                    })
                  })

                  context("when passed wallet main UTXO is invalid", () => {
                    const mainUtxo = {
                      txHash:
                        "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                      txOutputIndex: 0,
                      txOutputValue: to1ePrecision(26, 8), // 26 BTC
                    }

                    before(async () => {
                      await createSnapshot()

                      await bridge.setWalletMainUtxo(
                        ecdsaWalletTestData.pubKeyHash160,
                        mainUtxo
                      )
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should revert", async () => {
                      // Changing the `txOutputValue` to a value other than `0` will
                      // make that scenario happen.
                      const corruptedMainUtxo = {
                        ...mainUtxo,
                        txOutputValue: 1,
                      }

                      await expect(
                        // The last parameter doesn't matter in this scenario.
                        bridge
                          .connect(caller)
                          .submitMovingFundsCommitment(
                            ecdsaWalletTestData.pubKeyHash160,
                            corruptedMainUtxo,
                            walletMembersIDs,
                            walletMemberIndex,
                            []
                          )
                      ).to.be.revertedWith("Invalid wallet main UTXO data")
                    })
                  })
                }
              )

              context(
                "when the caller is not a member of the source wallet",
                () => {
                  const walletMembersIDs = [1, 2, 3, 4, 5]
                  const walletMemberIndex = 2

                  before(async () => {
                    await createSnapshot()

                    // That's the default behavior, but we just make it explicit.
                    await walletRegistry.isWalletMember.returns(false)
                  })

                  after(async () => {
                    await walletRegistry.isWalletMember.reset()

                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      // The last parameter doesn't matter in this scenario.
                      bridge
                        .connect(thirdParty)
                        .submitMovingFundsCommitment(
                          ecdsaWalletTestData.pubKeyHash160,
                          NO_MAIN_UTXO,
                          walletMembersIDs,
                          walletMemberIndex,
                          []
                        )
                    ).to.be.revertedWith(
                      "Caller is not a member of the source wallet"
                    )
                  })
                }
              )
            })

            context("when the commitment was already submitted", () => {
              before(async () => {
                await createSnapshot()

                await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
                  ...walletDraft,
                  state: walletState.MovingFunds,
                  // Set a non-zero commitment to make this scenario work.
                  movingFundsTargetWalletsCommitmentHash:
                    "0x959e95e0bd83d34878f77ead61cb4e955bf5e3bdc9e16cdfbd51c4c20ab7e6b4",
                })
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should revert", async () => {
                await expect(
                  // Parameters others than the first doesn't matter in this scenario.
                  bridge.submitMovingFundsCommitment(
                    ecdsaWalletTestData.pubKeyHash160,
                    NO_MAIN_UTXO,
                    [],
                    0,
                    []
                  )
                ).to.be.revertedWith(
                  "Target wallets commitment already submitted"
                )
              })
            })
          }
        )

        context(
          "when source wallet has pending moved funds sweep requests",
          () => {
            before(async () => {
              await createSnapshot()

              await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
                ...walletDraft,
                state: walletState.MovingFunds,
                // Set non-zero pending requests count to make this scenario work.
                pendingMovedFundsSweepRequestsCount: 1,
              })
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                // Parameters others than the first doesn't matter in this scenario.
                bridge.submitMovingFundsCommitment(
                  ecdsaWalletTestData.pubKeyHash160,
                  NO_MAIN_UTXO,
                  [],
                  0,
                  []
                )
              ).to.be.revertedWith(
                "Source wallet must handle all pending moved funds sweep requests first"
              )
            })
          }
        )
      })

      context("when source wallet has pending redemptions", () => {
        before(async () => {
          await createSnapshot()

          await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
            ...walletDraft,
            state: walletState.MovingFunds,
            // Set non-zero pending redemptions value to make this scenario work.
            pendingRedemptionsValue: 10000,
          })
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            // Parameters others than the first doesn't matter in this scenario.
            bridge.submitMovingFundsCommitment(
              ecdsaWalletTestData.pubKeyHash160,
              NO_MAIN_UTXO,
              [],
              0,
              []
            )
          ).to.be.revertedWith(
            "Source wallet must handle all pending redemptions first"
          )
        })
      })
    })

    context("when source wallet is not in the MovingFunds state", () => {
      const testData: {
        testName: string
        state: number
      }[] = [
        {
          testName: "when the source wallet is in the Unknown state",
          state: walletState.Unknown,
        },
        {
          testName: "when the source wallet is in the Live state",
          state: walletState.Live,
        },
        {
          testName: "when the source wallet is in the Closing state",
          state: walletState.Closing,
        },
        {
          testName: "when the source wallet is in the Closed state",
          state: walletState.Closed,
        },
        {
          testName: "when the source wallet is in the Terminated state",
          state: walletState.Terminated,
        },
      ]

      testData.forEach((test) => {
        context(test.testName, () => {
          before(async () => {
            await createSnapshot()

            await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
              ...walletDraft,
              state: test.state,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              // Parameters other than the first doesn't matter in this scenario.
              bridge.submitMovingFundsCommitment(
                ecdsaWalletTestData.pubKeyHash160,
                NO_MAIN_UTXO,
                [],
                0,
                []
              )
            ).to.be.revertedWith("Source wallet must be in MovingFunds state")
          })
        })
      })
    })
  })

  describe("resetMovingFundsTimeout", () => {
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

    context("when the wallet is in the MovingFunds state", () => {
      before(async () => {
        await createSnapshot()

        await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
          ...walletDraft,
          state: walletState.MovingFunds,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the wallet's commitment is not submitted yet", () => {
        context("when Live wallets count is zero", () => {
          // No need to do any specific setup. There is only one MovingFunds
          // wallet in the system and its commitment is not yet submitted.
          // Those preconditions are met by default.

          context("when reset delay has elapsed", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // One second ahead of the `setWallet` block, which reuses its
              // parent's timestamp under `allowBlocksWithSameTimestamp`.
              await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
                ...(await bridge.wallets(ecdsaWalletTestData.pubKeyHash160)),
                movingFundsRequestedAt: (await lastBlockTime()) + 1,
              })

              await increaseTime(movingFundsTimeoutResetDelay + 2)

              tx = await bridge.resetMovingFundsTimeout(
                ecdsaWalletTestData.pubKeyHash160
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should reset the moving funds timeout", async () => {
              expect(
                (await bridge.wallets(ecdsaWalletTestData.pubKeyHash160))
                  .movingFundsRequestedAt
              ).to.be.equal(await lastBlockTime())
            })

            it("should emit MovingFundsTimeoutReset event", async () => {
              await expect(tx)
                .to.emit(bridge, "MovingFundsTimeoutReset")
                .withArgs(ecdsaWalletTestData.pubKeyHash160)
            })
          })

          context("when reset delay has not elapsed yet", () => {
            before(async () => {
              await createSnapshot()

              // Set the timestamp of the block that contains the `setWallet` tx.
              await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
                ...(await bridge.wallets(ecdsaWalletTestData.pubKeyHash160)),
                movingFundsRequestedAt: (await lastBlockTime()) + 1,
              })

              await increaseTime(movingFundsTimeoutResetDelay - 1)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge.resetMovingFundsTimeout(
                  ecdsaWalletTestData.pubKeyHash160
                )
              ).to.be.revertedWith("Moving funds timeout cannot be reset yet")
            })
          })

          context(
            "when one reset occurred and the reset delay has elapsed again",
            () => {
              let tx: ContractTransaction

              before(async () => {
                await createSnapshot()

                // One second ahead of the `setWallet` block, which reuses its
                // parent's timestamp under `allowBlocksWithSameTimestamp`.
                await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
                  ...(await bridge.wallets(ecdsaWalletTestData.pubKeyHash160)),
                  movingFundsRequestedAt: (await lastBlockTime()) + 1,
                })

                await increaseTime(movingFundsTimeoutResetDelay + 2)

                // Reset for the first time.
                await bridge.resetMovingFundsTimeout(
                  ecdsaWalletTestData.pubKeyHash160
                )

                // The reset delay elapses again.
                await increaseTime(movingFundsTimeoutResetDelay + 1)

                // The next reset.
                tx = await bridge.resetMovingFundsTimeout(
                  ecdsaWalletTestData.pubKeyHash160
                )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should reset the moving funds timeout", async () => {
                expect(
                  (await bridge.wallets(ecdsaWalletTestData.pubKeyHash160))
                    .movingFundsRequestedAt
                ).to.be.equal(await lastBlockTime())
              })

              it("should emit MovingFundsTimeoutReset event", async () => {
                await expect(tx)
                  .to.emit(bridge, "MovingFundsTimeoutReset")
                  .withArgs(ecdsaWalletTestData.pubKeyHash160)
              })
            }
          )

          context(
            "when one reset occurred and the reset delay has not elapsed yet",
            () => {
              before(async () => {
                await createSnapshot()

                // One second ahead of the `setWallet` block, which reuses its
                // parent's timestamp under `allowBlocksWithSameTimestamp`.
                await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
                  ...(await bridge.wallets(ecdsaWalletTestData.pubKeyHash160)),
                  movingFundsRequestedAt: (await lastBlockTime()) + 1,
                })

                await increaseTime(movingFundsTimeoutResetDelay + 2)

                // Reset for the first time.
                await bridge.resetMovingFundsTimeout(
                  ecdsaWalletTestData.pubKeyHash160
                )

                // The reset delay has not elapsed again yet.
                await increaseTime(movingFundsTimeoutResetDelay - 1)
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should revert", async () => {
                await expect(
                  bridge.resetMovingFundsTimeout(
                    ecdsaWalletTestData.pubKeyHash160
                  )
                ).to.be.revertedWith("Moving funds timeout cannot be reset yet")
              })
            }
          )
        })

        context("when Live wallets count is not zero", () => {
          before(async () => {
            await createSnapshot()

            // This call will add one Live wallet and increase the Live wallet
            // counter accordingly. Note that the wallet's public key hash
            // must be different from the PKH of the tested wallet.
            await bridge.setWallet(
              "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
              {
                ...walletDraft,
                state: walletState.Live,
              }
            )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge.resetMovingFundsTimeout(ecdsaWalletTestData.pubKeyHash160)
            ).to.be.revertedWith("Live wallets count must be zero")
          })
        })
      })

      context("when the wallet's commitment is already submitted", () => {
        before(async () => {
          await createSnapshot()

          // Set an arbitrary non-zero commitment.
          await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
            ...(await bridge.wallets(ecdsaWalletTestData.pubKeyHash160)),
            movingFundsTargetWalletsCommitmentHash:
              ethers.utils.solidityKeccak256(
                ["bytes20"],
                ["0xc214a5e9ec1b7792af9894e8f9ff0dd9bf427d79"]
              ),
          })
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge.resetMovingFundsTimeout(ecdsaWalletTestData.pubKeyHash160)
          ).to.be.revertedWith("Target wallets commitment already submitted")
        })
      })
    })

    context("when the wallet is not in the MovingFunds state", () => {
      const testData = [
        {
          testName: "when the wallet is in the Unknown state",
          walletState: walletState.Unknown,
        },
        {
          testName: "when the wallet is in the Live state",
          walletState: walletState.Live,
        },
        {
          testName: "when the wallet is in the Closing state",
          walletState: walletState.Closing,
        },
        {
          testName: "when the wallet is in the Closed state",
          walletState: walletState.Closed,
        },
        {
          testName: "when the wallet is in the Terminated state",
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
              bridge.resetMovingFundsTimeout(ecdsaWalletTestData.pubKeyHash160)
            ).to.be.revertedWith("Wallet must be in MovingFunds state")
          })
        })
      })
    })
  })

  describe("submitMovingFundsProof", () => {
    context("when transaction proof is valid", () => {
      context("when there is a main UTXO for the given wallet", () => {
        context("when main UTXO data are valid", () => {
          context("when there is only one input", () => {
            context(
              "when the single input points to the wallet's main UTXO",
              () => {
                context(
                  "when the output vector references only 20-byte hashes",
                  () => {
                    context(
                      "when the output vector has only P2PKH and P2WPKH outputs",
                      () => {
                        context(
                          "when transaction amount is distributed evenly",
                          () => {
                            context(
                              "when transaction fee is not too high",
                              () => {
                                context(
                                  "when source wallet is in the MovingFunds state",
                                  () => {
                                    context(
                                      "when target wallets commitment is submitted",
                                      () => {
                                        context(
                                          "when actual target wallets correspond to the commitment",
                                          () => {
                                            const testData: {
                                              testName: string
                                              data: MovingFundsTestData
                                            }[] = [
                                              {
                                                testName:
                                                  "when there is a single target wallet",
                                                data: SingleTargetWallet,
                                              },
                                              {
                                                testName:
                                                  "when there are multiple target wallets and the amount is indivisible",
                                                data: MultipleTargetWalletsAndIndivisibleAmount,
                                              },
                                              {
                                                testName:
                                                  "when there are multiple target wallets and the amount is divisible",
                                                data: MultipleTargetWalletsAndDivisibleAmount,
                                              },
                                            ]

                                            testData.forEach((test) => {
                                              context(test.testName, () => {
                                                let tx: ContractTransaction

                                                before(async () => {
                                                  await createSnapshot()

                                                  tx =
                                                    await runMovingFundsScenario(
                                                      test.data
                                                    )
                                                })

                                                after(async () => {
                                                  await restoreSnapshot()
                                                })

                                                it("should mark the main UTXO as correctly spent", async () => {
                                                  const key =
                                                    ethers.utils.solidityKeccak256(
                                                      ["bytes32", "uint32"],
                                                      [
                                                        test.data.mainUtxo
                                                          .txHash,
                                                        test.data.mainUtxo
                                                          .txOutputIndex,
                                                      ]
                                                    )

                                                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                                                  expect(
                                                    await bridge.spentMainUTXOs(
                                                      key
                                                    )
                                                  ).to.be.true
                                                })

                                                it("should unset the main UTXO for the source wallet", async () => {
                                                  expect(
                                                    (
                                                      await bridge.wallets(
                                                        test.data.wallet
                                                          .pubKeyHash
                                                      )
                                                    ).mainUtxoHash
                                                  ).to.be.equal(
                                                    ethers.constants.HashZero
                                                  )
                                                })

                                                it("should put the source wallet in the Closing state", async () => {
                                                  expect(
                                                    (
                                                      await bridge.wallets(
                                                        test.data.wallet
                                                          .pubKeyHash
                                                      )
                                                    ).state
                                                  ).to.be.equal(
                                                    walletState.Closing
                                                  )
                                                })

                                                it("should set the closing started timestamp", async () => {
                                                  expect(
                                                    (
                                                      await bridge.wallets(
                                                        test.data.wallet
                                                          .pubKeyHash
                                                      )
                                                    ).closingStartedAt
                                                  ).to.be.equal(
                                                    await lastBlockTime()
                                                  )
                                                })

                                                it("should emit the WalletClosing event", async () => {
                                                  await expect(tx)
                                                    .to.emit(
                                                      bridge,
                                                      "WalletClosing"
                                                    )
                                                    .withArgs(
                                                      test.data.wallet
                                                        .ecdsaWalletID,
                                                      test.data.wallet
                                                        .pubKeyHash
                                                    )
                                                })

                                                it("should emit the MovingFundsCompleted event", async () => {
                                                  await expect(tx)
                                                    .to.emit(
                                                      bridge,
                                                      "MovingFundsCompleted"
                                                    )
                                                    .withArgs(
                                                      test.data.wallet
                                                        .pubKeyHash,
                                                      test.data.movingFundsTx
                                                        .hash
                                                    )
                                                })

                                                it("should create appropriate moved funds sweep requests", async () => {
                                                  for (
                                                    let i = 0;
                                                    i <
                                                    test.data
                                                      .expectedMovedFundsSweepRequests
                                                      .length;
                                                    i++
                                                  ) {
                                                    const expectedMovedFundsSweepRequest =
                                                      test.data
                                                        .expectedMovedFundsSweepRequests[
                                                        i
                                                      ]

                                                    const requestKey =
                                                      ethers.utils.solidityKeccak256(
                                                        ["bytes32", "uint32"],
                                                        [
                                                          expectedMovedFundsSweepRequest.txHash,
                                                          expectedMovedFundsSweepRequest.txOutputIndex,
                                                        ]
                                                      )

                                                    const actualMovedFundsSweepRequest =
                                                      // eslint-disable-next-line no-await-in-loop
                                                      await bridge.movedFundsSweepRequests(
                                                        requestKey
                                                      )

                                                    expect(
                                                      actualMovedFundsSweepRequest.walletPubKeyHash
                                                    ).to.be.equal(
                                                      expectedMovedFundsSweepRequest.walletPubKeyHash,
                                                      `Unexpected wallet for sweep request ${i}`
                                                    )

                                                    expect(
                                                      actualMovedFundsSweepRequest.value
                                                    ).to.be.equal(
                                                      expectedMovedFundsSweepRequest.txOutputValue,
                                                      `Unexpected value for sweep request ${i}`
                                                    )

                                                    expect(
                                                      actualMovedFundsSweepRequest.createdAt
                                                    ).to.be.equal(
                                                      // eslint-disable-next-line no-await-in-loop
                                                      await lastBlockTime(),
                                                      `Unexpected created timestamp for sweep request ${i}`
                                                    )

                                                    expect(
                                                      actualMovedFundsSweepRequest.state
                                                    ).to.be.equal(
                                                      movedFundsSweepRequestState.Pending,
                                                      `Unexpected state for sweep request ${i}`
                                                    )

                                                    /* eslint-disable no-await-in-loop */
                                                    expect(
                                                      (
                                                        await bridge.wallets(
                                                          expectedMovedFundsSweepRequest.walletPubKeyHash
                                                        )
                                                      )
                                                        .pendingMovedFundsSweepRequestsCount
                                                    ).to.be.equal(1)
                                                    /* eslint-enable no-await-in-loop */
                                                  }
                                                })
                                              })
                                            })
                                          }
                                        )

                                        context(
                                          "when actual target wallets does not correspond to the commitment",
                                          () => {
                                            // The below test data send funds to
                                            // three wallets with the following
                                            // 20-byte PKHs (in this order):
                                            // - 0x2cd680318747b720d67bf4246eb7403b476adb34
                                            // - 0x8900de8fc6e4cd1db4c7ab0759d28503b4cb0ab1
                                            // - 0xaf7a841e055fc19bf31acf4cbed5ef548a2cc453
                                            // If the commitment is not exactly
                                            // this list, the moving funds proof
                                            // will revert.
                                            const data: MovingFundsTestData =
                                              MultipleTargetWalletsAndIndivisibleAmount

                                            const testData: {
                                              testName: string
                                              modifyData: (
                                                data: MovingFundsTestData
                                              ) => MovingFundsTestData
                                            }[] = [
                                              {
                                                testName:
                                                  "when funds were sent to more wallets than submitted in the commitment",
                                                modifyData: (
                                                  dataCopy: MovingFundsTestData
                                                ) =>
                                                  // Simulate that the commitment
                                                  // contains only the two first
                                                  // wallets used in the transaction.
                                                  ({
                                                    ...dataCopy,
                                                    targetWalletsCommitment: [
                                                      dataCopy
                                                        .targetWalletsCommitment[0],
                                                      dataCopy
                                                        .targetWalletsCommitment[1],
                                                    ],
                                                  }),
                                              },
                                              {
                                                testName:
                                                  "when funds were sent to less wallets than submitted in the commitment",
                                                modifyData: (
                                                  dataCopy: MovingFundsTestData
                                                ) =>
                                                  // Simulate that the commitment
                                                  // contains an additional wallet apart
                                                  // from all wallets used in the transaction.
                                                  ({
                                                    ...dataCopy,
                                                    targetWalletsCommitment: [
                                                      dataCopy
                                                        .targetWalletsCommitment[0],
                                                      dataCopy
                                                        .targetWalletsCommitment[1],
                                                      dataCopy
                                                        .targetWalletsCommitment[2],
                                                      "0xe04f5dbeafea147699fce4e0e12027aa0bc12e78",
                                                    ],
                                                  }),
                                              },
                                              {
                                                testName:
                                                  "when funds were sent to completely different wallets than submitted in the commitment",
                                                modifyData: (
                                                  dataCopy: MovingFundsTestData
                                                ) =>
                                                  // Simulate that the commitment
                                                  // contains three different wallets
                                                  // than the wallets used in the
                                                  // transaction.
                                                  ({
                                                    ...dataCopy,
                                                    targetWalletsCommitment: [
                                                      "0x1e445df2d9136831193d90c5e2c6b7ea8a0882fb",
                                                      "0x9d134f065a6566bcc2f99fffe21856e129638526",
                                                      "0x4f524b05f817bd8f3be613ff5bc5ef87f0b68b46",
                                                    ],
                                                  }),
                                              },
                                              {
                                                testName:
                                                  "when funds were sent to the wallets submitted in the commitment but with a wrong order",
                                                modifyData: (
                                                  dataCopy: MovingFundsTestData
                                                ) =>
                                                  // Simulate that the commitment
                                                  // contains three different wallets
                                                  // than the wallets used in the
                                                  // transaction.
                                                  ({
                                                    ...dataCopy,
                                                    targetWalletsCommitment: [
                                                      dataCopy
                                                        .targetWalletsCommitment[2],
                                                      dataCopy
                                                        .targetWalletsCommitment[1],
                                                      dataCopy
                                                        .targetWalletsCommitment[0],
                                                    ],
                                                  }),
                                              },
                                            ]

                                            testData.forEach((test) => {
                                              context(test.testName, () => {
                                                let tx: Promise<ContractTransaction>

                                                before(async () => {
                                                  await createSnapshot()

                                                  // Pass a copy of the original data.
                                                  const modifiedData =
                                                    test.modifyData(
                                                      JSON.parse(
                                                        JSON.stringify(data)
                                                      )
                                                    )

                                                  tx =
                                                    runMovingFundsScenario(
                                                      modifiedData
                                                    )
                                                })

                                                after(async () => {
                                                  await restoreSnapshot()
                                                })

                                                it("should revert", async () => {
                                                  await expect(
                                                    tx
                                                  ).to.be.revertedWith(
                                                    "Target wallets don't correspond to the commitment"
                                                  )
                                                })
                                              })
                                            })
                                          }
                                        )
                                      }
                                    )

                                    context(
                                      "when target wallets commitment is not submitted",
                                      () => {
                                        const data: MovingFundsTestData =
                                          JSON.parse(
                                            JSON.stringify(SingleTargetWallet)
                                          )

                                        let tx: Promise<ContractTransaction>

                                        before(async () => {
                                          await createSnapshot()

                                          tx = runMovingFundsScenario({
                                            ...data,
                                            targetWalletsCommitment: [],
                                          })
                                        })

                                        after(async () => {
                                          await restoreSnapshot()
                                        })

                                        it("should revert", async () => {
                                          await expect(tx).to.be.revertedWith(
                                            "Target wallets commitment not submitted yet"
                                          )
                                        })
                                      }
                                    )
                                  }
                                )

                                context(
                                  "when source wallet is not in the MovingFunds state",
                                  () => {
                                    const testData: {
                                      testName: string
                                      state: number
                                    }[] = [
                                      {
                                        testName:
                                          "when wallet state is Unknown",
                                        state: walletState.Unknown,
                                      },
                                      {
                                        testName: "when wallet state is Live",
                                        state: walletState.Live,
                                      },
                                      {
                                        testName:
                                          "when wallet state is Closing",
                                        state: walletState.Closing,
                                      },
                                      {
                                        testName: "when wallet state is Closed",
                                        state: walletState.Closed,
                                      },
                                      {
                                        testName:
                                          "when wallet state is Terminated",
                                        state: walletState.Terminated,
                                      },
                                    ]

                                    testData.forEach((test) => {
                                      context(test.testName, () => {
                                        const data: MovingFundsTestData =
                                          JSON.parse(
                                            JSON.stringify(SingleTargetWallet)
                                          )

                                        let tx: Promise<ContractTransaction>

                                        before(async () => {
                                          await createSnapshot()

                                          data.wallet.state = test.state

                                          tx = runMovingFundsScenario(data)
                                        })

                                        after(async () => {
                                          await restoreSnapshot()
                                        })

                                        it("should revert", async () => {
                                          await expect(tx).to.be.revertedWith(
                                            "Wallet must be in MovingFunds state"
                                          )
                                        })
                                      })
                                    })
                                  }
                                )
                              }
                            )

                            context("when transaction fee is too high", () => {
                              const data: MovingFundsTestData =
                                SingleTargetWallet

                              let tx: Promise<ContractTransaction>

                              before(async () => {
                                await createSnapshot()

                                const beforeProofActions = async () => {
                                  // The transaction used by this scenario's
                                  // test data has a fee of 9000 satoshis. Lowering
                                  // the max fee in the Bridge by one should
                                  // cause the expected failure.
                                  await bridgeGovernance
                                    .connect(governance)
                                    .beginMovingFundsTxMaxTotalFeeUpdate(8999)
                                  await increaseTime(
                                    await bridgeGovernance.governanceDelays(0)
                                  )
                                  await bridgeGovernance
                                    .connect(governance)
                                    .finalizeMovingFundsTxMaxTotalFeeUpdate()
                                }

                                tx = runMovingFundsScenario(
                                  data,
                                  beforeProofActions
                                )
                              })

                              after(async () => {
                                await restoreSnapshot()
                              })

                              it("should revert", async () => {
                                await expect(tx).to.be.revertedWith(
                                  "Transaction fee is too high"
                                )
                              })
                            })
                          }
                        )

                        context(
                          "when transaction amount is not distributed evenly",
                          () => {
                            const data: MovingFundsTestData =
                              MultipleTargetWalletsButAmountDistributedUnevenly

                            let tx: Promise<ContractTransaction>

                            before(async () => {
                              await createSnapshot()

                              tx = runMovingFundsScenario(data)
                            })

                            after(async () => {
                              await restoreSnapshot()
                            })

                            it("should revert", async () => {
                              await expect(tx).to.be.revertedWith(
                                "Transaction amount is not distributed evenly"
                              )
                            })
                          }
                        )
                      }
                    )

                    context(
                      "when the output vector contains P2SH output",
                      () => {
                        // The only possible case is P2SH which contains the
                        // 20-byte payload, just like P2PKH and P2WPKH.
                        // No need to check P2WSH as it uses a 32-byte payload
                        // so it would fail earlier, at the payload length
                        // assertion.
                        const data: MovingFundsTestData =
                          SingleTargetWalletButP2SH

                        let tx: Promise<ContractTransaction>

                        before(async () => {
                          await createSnapshot()

                          tx = runMovingFundsScenario(data)
                        })

                        after(async () => {
                          await restoreSnapshot()
                        })

                        it("should revert", async () => {
                          await expect(tx).to.be.revertedWith(
                            "Output must be P2PKH or P2WPKH"
                          )
                        })
                      }
                    )
                  }
                )

                context(
                  "when the output vector does not only reference 20-byte hashes",
                  () => {
                    // Use a provably unspendable output whose payload length
                    // is zero so it should cause a failure upon the assertion
                    // that makes sure the output payload is 20-byte.
                    const data: MovingFundsTestData = SingleProvablyUnspendable

                    let tx: Promise<ContractTransaction>

                    before(async () => {
                      await createSnapshot()

                      tx = runMovingFundsScenario(data)
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should revert", async () => {
                      await expect(tx).to.be.revertedWith(
                        "Output's public key hash must have 20 bytes"
                      )
                    })
                  }
                )
              }
            )

            context(
              "when the single input doesn't point to the wallet's main UTXO",
              () => {
                const data: MovingFundsTestData = JSON.parse(
                  JSON.stringify(SingleTargetWallet)
                )

                let tx: Promise<ContractTransaction>

                before(async () => {
                  await createSnapshot()

                  // Corrupt the wallet's main UTXO that is injected to
                  // the Bridge state by the test runner in order to make it
                  // different than the input used by the actual Bitcoin
                  // transaction thus make the tested scenario happen. The
                  // proper value of `txOutputIndex` is `1` so any other value
                  // will do the trick.
                  data.mainUtxo.txOutputIndex = 0

                  tx = runMovingFundsScenario(data)
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  await expect(tx).to.be.revertedWith(
                    "Outbound transaction input must point to the wallet's main UTXO"
                  )
                })
              }
            )
          })

          context("when input count is other than one", () => {
            const data: MovingFundsTestData = MultipleInputs

            let tx: Promise<ContractTransaction>

            before(async () => {
              await createSnapshot()

              tx = runMovingFundsScenario(data)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(tx).to.be.revertedWith(
                "Outbound transaction must have a single input"
              )
            })
          })
        })

        context("when main UTXO data are invalid", () => {
          const data: MovingFundsTestData = SingleTargetWallet

          before(async () => {
            await createSnapshot()

            // Required for a successful SPV proof.
            await relay.getPrevEpochDifficulty.returns(data.chainDifficulty)
            await relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)

            // Wallet main UTXO must be set on the Bridge side to make
            // that scenario happen.
            await bridge.setWalletMainUtxo(
              data.wallet.pubKeyHash,
              data.mainUtxo
            )
          })

          after(async () => {
            await relay.getPrevEpochDifficulty.reset()
            await relay.getCurrentEpochDifficulty.reset()

            await restoreSnapshot()
          })

          it("should revert", async () => {
            // Corrupt the main UTXO parameter passed during
            // `submitMovingFundsProof` call. The proper value of
            // `txOutputIndex` for this test data set is `1` so any other
            // value will make this test scenario happen.
            const corruptedMainUtxo = {
              ...data.mainUtxo,
              txOutputIndex: 0,
            }

            await expect(
              bridge
                .connect(spvMaintainer)
                .submitMovingFundsProof(
                  data.movingFundsTx,
                  data.movingFundsProof,
                  corruptedMainUtxo,
                  data.wallet.pubKeyHash
                )
            ).to.be.revertedWith("Invalid main UTXO data")
          })
        })
      })

      context("when there is no main UTXO for the given wallet", () => {
        const data: MovingFundsTestData = SingleTargetWallet

        before(async () => {
          await createSnapshot()

          // Required for a successful SPV proof.
          await relay.getPrevEpochDifficulty.returns(data.chainDifficulty)
          await relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
        })

        after(async () => {
          await relay.getPrevEpochDifficulty.reset()
          await relay.getCurrentEpochDifficulty.reset()

          await restoreSnapshot()
        })

        it("should revert", async () => {
          // There was no preparations before `submitMovingFundsProof` call
          // so no main UTXO is set for the given wallet.
          await expect(
            bridge
              .connect(spvMaintainer)
              .submitMovingFundsProof(
                data.movingFundsTx,
                data.movingFundsProof,
                data.mainUtxo,
                data.wallet.pubKeyHash
              )
          ).to.be.revertedWith("No main UTXO for given wallet")
        })
      })
    })

    context("when transaction proof is not valid", () => {
      context("when input vector is not valid", () => {
        const data: MovingFundsTestData = JSON.parse(
          JSON.stringify(SingleTargetWallet)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the input vector by setting a compactSize uint claiming
          // there is no inputs at all.
          data.movingFundsTx.inputVector =
            "0x00b69a2869840aa6fdfd143136ff4514ca46ea2d876855040892ad74ab" +
            "8c5274220100000000ffffffff"

          await expect(runMovingFundsScenario(data)).to.be.revertedWith(
            "Invalid input vector provided"
          )
        })
      })

      context("when output vector is not valid", () => {
        const data: MovingFundsTestData = JSON.parse(
          JSON.stringify(SingleTargetWallet)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the output vector by setting a compactSize uint claiming
          // there is no outputs at all.
          data.movingFundsTx.outputVector =
            "0x005cf511000000000017a91486884e6be1525dab5ae0b451bd2c72cee6" +
            "7dcf4187"

          await expect(runMovingFundsScenario(data)).to.be.revertedWith(
            "Invalid output vector provided"
          )
        })
      })

      context(
        "when transaction is not on same level of merkle tree as coinbase",
        () => {
          const data: MovingFundsTestData = JSON.parse(
            JSON.stringify(SingleTargetWallet)
          )

          before(async () => {
            await createSnapshot()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            // Simulate that the proven transaction is deeper in the merkle tree
            // than the coinbase. This is achieved by appending additional
            // hashes to the merkle proof.
            data.movingFundsProof.merkleProof +=
              ethers.utils.sha256("0x01").substring(2) +
              ethers.utils.sha256("0x02").substring(2)

            await expect(runMovingFundsScenario(data)).to.be.revertedWith(
              "Tx not on same level of merkle tree as coinbase"
            )
          })
        }
      )

      context("when merkle proof is not valid", () => {
        const data: MovingFundsTestData = JSON.parse(
          JSON.stringify(SingleTargetWallet)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the merkle proof by changing tx index in block to an
          // invalid one. The proper one is 1 so any other will do the trick.
          data.movingFundsProof.txIndexInBlock = 30

          await expect(runMovingFundsScenario(data)).to.be.revertedWith(
            "Tx merkle proof is not valid for provided header and tx hash"
          )
        })
      })

      context("when coinbase merkle proof is not valid", () => {
        const data: MovingFundsTestData = JSON.parse(
          JSON.stringify(SingleTargetWallet)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the coinbase preimage.
          data.movingFundsProof.coinbasePreimage = ethers.utils.sha256(
            data.movingFundsProof.coinbasePreimage
          )

          await expect(runMovingFundsScenario(data)).to.be.revertedWith(
            "Coinbase merkle proof is not valid for provided header and hash"
          )
        })
      })

      context("when proof difficulty is not current nor previous", () => {
        const data: MovingFundsTestData = JSON.parse(
          JSON.stringify(SingleTargetWallet)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // To pass the proof validation, the difficulty returned by the relay
          // must be 21461933 for test data used in this scenario. Setting
          // a different value will cause difficulty comparison failure.
          data.chainDifficulty = 2

          await expect(runMovingFundsScenario(data)).to.be.revertedWith(
            "Not at current or previous difficulty"
          )
        })
      })

      context("when headers chain length is not valid", () => {
        const data: MovingFundsTestData = JSON.parse(
          JSON.stringify(SingleTargetWallet)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the bitcoin headers length in the moving funds proof. The
          // proper value is length divisible by 80 so any length violating
          // this rule will cause failure. In this case, we just remove the
          // last byte from proper headers chain.
          const properHeaders = data.movingFundsProof.bitcoinHeaders.toString()
          data.movingFundsProof.bitcoinHeaders = properHeaders.substring(
            0,
            properHeaders.length - 2
          )

          await expect(runMovingFundsScenario(data)).to.be.revertedWith(
            "Invalid length of the headers chain"
          )
        })
      })

      context("when headers chain is not valid", () => {
        const data: MovingFundsTestData = JSON.parse(
          JSON.stringify(SingleTargetWallet)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Bitcoin headers must form a chain to pass the proof validation.
          // That means the `previous block hash` encoded in the given block
          // header must match the actual previous header's hash. To test
          // that scenario, we corrupt the `previous block hash` of the
          // second header. Each header is 80 bytes length. First 4 bytes
          // of each header is `version` and 32 subsequent bytes is
          // `previous block hash`. Changing byte 85 of the whole chain will
          // do the work.
          const properHeaders = data.movingFundsProof.bitcoinHeaders.toString()
          data.movingFundsProof.bitcoinHeaders = `${properHeaders.substring(
            0,
            170
          )}ff${properHeaders.substring(172)}`

          await expect(runMovingFundsScenario(data)).to.be.revertedWith(
            "Invalid headers chain"
          )
        })
      })

      context("when the work in the header is insufficient", () => {
        const data: MovingFundsTestData = JSON.parse(
          JSON.stringify(SingleTargetWallet)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Each header encodes a `difficulty target` field in bytes 72-76.
          // The given header's hash (interpreted as uint) must be bigger than
          // the `difficulty target`. To test this scenario, we change the
          // last byte of the last header in such a way their hash becomes
          // lower than their `difficulty target`.
          const properHeaders = data.movingFundsProof.bitcoinHeaders.toString()
          data.movingFundsProof.bitcoinHeaders = `${properHeaders.substring(
            0,
            properHeaders.length - 2
          )}ff`

          await expect(runMovingFundsScenario(data)).to.be.revertedWith(
            "Insufficient work in a header"
          )
        })
      })

      context(
        "when accumulated difficulty in headers chain is insufficient",
        () => {
          let otherBridge: BridgeStub
          const data: MovingFundsTestData = JSON.parse(
            JSON.stringify(SingleTargetWallet)
          )

          before(async () => {
            await createSnapshot()

            // Necessary to pass the first part of proof validation.
            await relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
            await relay.getPrevEpochDifficulty.returns(data.chainDifficulty)

            // Deploy another bridge which has higher `txProofDifficultyFactor`
            // than the original bridge. That means it will need 12 confirmations
            // to deem transaction proof validity. This scenario uses test
            // data which has only 6 confirmations. That should force the
            // failure we expect within this scenario.
            otherBridge = (await deployBridge(12))[0] as BridgeStub
            await otherBridge.setSpvMaintainerStatus(
              spvMaintainer.address,
              true
            )
          })

          after(async () => {
            await relay.getCurrentEpochDifficulty.reset()
            await relay.getPrevEpochDifficulty.reset()

            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              otherBridge
                .connect(spvMaintainer)
                .submitMovingFundsProof(
                  data.movingFundsTx,
                  data.movingFundsProof,
                  data.mainUtxo,
                  data.wallet.pubKeyHash
                )
            ).to.be.revertedWith(
              "Insufficient accumulated difficulty in header chain"
            )
          })
        }
      )

      context("when transaction data is limited to 64 bytes", () => {
        // This test proves it is impossible to construct a valid proof if
        // the transaction data (version, locktime, inputs, outputs)
        // length is 64 bytes or less.

        const data: MovingFundsTestData = JSON.parse(
          JSON.stringify(SingleTargetWallet)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Modify the `movingFundsTx` part of test data in such a way so it
          // is only 64 bytes in length and correctly passes as many SPV proof
          // checks as possible.
          data.movingFundsTx.version = "0x01000000" // 4 bytes
          data.movingFundsTx.locktime = "0x00000000" // 4 bytes

          // 42 bytes at minimum to pass input formatting validation (1 byte
          // for inputs length, 32 bytes for tx hash, 4 bytes for tx index,
          // 1 byte for script sig length, 4 bytes for sequence number).
          data.movingFundsTx.inputVector =
            "0x01aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
            "aaaaaa1111111100ffffffff"

          // 32 bytes at minimum to pass output formatting validation and the
          // output script check (1 byte for outputs length, 8 bytes for
          // output amount, 23 bytes for length-prefixed output script -
          // `submitMovingFundsProof` checks that the output contains
          // a 23-byte or 26-byte long script). Since 50 bytes has already been
          // used on version, locktime and inputs, the output must be shortened
          // to 14 bytes, so that the total transaction length is 64 bytes.
          data.movingFundsTx.outputVector = "0x01aaaaaaaaaaaaaaaa160014bbbb"

          await expect(runMovingFundsScenario(data)).to.be.revertedWith(
            "Invalid output vector provided"
          )
        })
      })
    })
  })

  describe("notifyMovingFundsTimeout", () => {
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

    context("when source wallet is in the MovingFunds state", () => {
      before(async () => {
        await createSnapshot()

        await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
          ...walletDraft,
          state: walletState.Live,
        })

        // Wallet must have funds to be not closed immediately by
        // the following `__ecdsaWalletHeartbeatFailedCallback` call.
        await bridge.setWalletMainUtxo(ecdsaWalletTestData.pubKeyHash160, {
          txHash: ethers.constants.HashZero,
          txOutputIndex: 0,
          txOutputValue: to1ePrecision(10, 8),
        })

        // Switches the wallet to moving funds.
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

      context("when the moving funds process has timed out", () => {
        let tx: ContractTransaction
        const walletMembersIDs = [1, 2, 3, 4, 5]

        before(async () => {
          await createSnapshot()

          await walletRegistry.closeWallet.reset()
          await walletRegistry.seize.reset()

          await increaseTime(movingFundsTimeout + 1)

          tx = await bridge
            .connect(thirdParty)
            .notifyMovingFundsTimeout(
              ecdsaWalletTestData.pubKeyHash160,
              walletMembersIDs
            )
        })

        after(async () => {
          await walletRegistry.closeWallet.reset()
          await walletRegistry.seize.reset()

          await restoreSnapshot()
        })

        it("should switch the wallet to Terminated state", async () => {
          expect(
            (await bridge.wallets(ecdsaWalletTestData.pubKeyHash160)).state
          ).to.be.equal(walletState.Terminated)
        })

        it("should emit WalletTerminated event", async () => {
          await expect(tx)
            .to.emit(bridge, "WalletTerminated")
            .withArgs(
              ecdsaWalletTestData.walletID,
              ecdsaWalletTestData.pubKeyHash160
            )
        })

        it("should call ECDSA Wallet Registry's closeWallet function", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          await expectCalledOnceWith(walletRegistry.closeWallet, [
            ecdsaWalletTestData.walletID,
          ])
        })

        it("should call the ECDSA wallet registry's seize function", async () => {
          await expectCalledOnceWith(walletRegistry.seize, [
            movingFundsTimeoutSlashingAmount,
            movingFundsTimeoutNotifierRewardMultiplier,
            await thirdParty.getAddress(),
            ecdsaWalletTestData.walletID,
            walletMembersIDs,
          ])
        })

        it("should emit MovingFundsTimedOut event", async () => {
          await expect(tx)
            .to.emit(bridge, "MovingFundsTimedOut")
            .withArgs(ecdsaWalletTestData.pubKeyHash160)
        })
      })

      context("when the moving funds process has not timed out", () => {
        before(async () => {
          await createSnapshot()

          await increaseTime(movingFundsTimeout - 1)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge.notifyMovingFundsTimeout(
              ecdsaWalletTestData.pubKeyHash160,
              []
            )
          ).to.be.revertedWith("Moving funds has not timed out yet")
        })
      })
    })

    context("when source wallet is not in the MovingFunds state", () => {
      const testData: {
        testName: string
        state: number
      }[] = [
        {
          testName: "when the source wallet is in the Unknown state",
          state: walletState.Unknown,
        },
        {
          testName: "when the source wallet is in the Live state",
          state: walletState.Live,
        },
        {
          testName: "when the source wallet is in the Closing state",
          state: walletState.Closing,
        },
        {
          testName: "when the source wallet is in the Closed state",
          state: walletState.Closed,
        },
        {
          testName: "when the source wallet is in the Terminated state",
          state: walletState.Terminated,
        },
      ]

      testData.forEach((test) => {
        context(test.testName, () => {
          before(async () => {
            await createSnapshot()

            await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
              ...walletDraft,
              state: test.state,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge.notifyMovingFundsTimeout(
                ecdsaWalletTestData.pubKeyHash160,
                []
              )
            ).to.be.revertedWith("Wallet must be in MovingFunds state")
          })
        })
      })
    })
  })

  describe("notifyMovingFundsBelowDust", () => {
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

    context("when the wallet is in the MovingFunds state", () => {
      before(async () => {
        await createSnapshot()

        await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
          ...walletDraft,
          state: walletState.MovingFunds,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the main UTXO parameter is valid", () => {
        context("when the balance is below the dust threshold", () => {
          const mainUtxo = {
            txHash: ethers.constants.HashZero,
            txOutputIndex: 0,
            txOutputValue: constants.movingFundsDustThreshold - 1,
          }

          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await bridge.setWalletMainUtxo(
              ecdsaWalletTestData.pubKeyHash160,
              mainUtxo
            )

            tx = await bridge.notifyMovingFundsBelowDust(
              ecdsaWalletTestData.pubKeyHash160,
              mainUtxo
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
                walletDraft.ecdsaWalletID,
                ecdsaWalletTestData.pubKeyHash160
              )
          })

          it("should emit MovingFundsBelowDustReported event", async () => {
            await expect(tx)
              .to.emit(bridge, "MovingFundsBelowDustReported")
              .withArgs(ecdsaWalletTestData.pubKeyHash160)
          })
        })

        context("when the balance is not below the dust threshold", () => {
          const mainUtxo = {
            txHash: ethers.constants.HashZero,
            txOutputIndex: 0,
            txOutputValue: constants.movingFundsDustThreshold,
          }

          before(async () => {
            await createSnapshot()

            await bridge.setWalletMainUtxo(
              ecdsaWalletTestData.pubKeyHash160,
              mainUtxo
            )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge.notifyMovingFundsBelowDust(
                ecdsaWalletTestData.pubKeyHash160,
                mainUtxo
              )
            ).to.be.revertedWith(
              "Wallet BTC balance must be below the moving funds dust threshold"
            )
          })
        })
      })

      context("when the main UTXO parameter is invalid", () => {
        const mainUtxo = {
          txHash: ethers.constants.HashZero,
          txOutputIndex: 0,
          txOutputValue: to1ePrecision(1, 8),
        }

        before(async () => {
          await createSnapshot()

          await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
            ...walletDraft,
            state: walletState.MovingFunds,
          })

          await bridge.setWalletMainUtxo(
            ecdsaWalletTestData.pubKeyHash160,
            mainUtxo
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          const corruptedMainUtxo = {
            ...mainUtxo,
            txOutputIndex: 1,
          }

          await expect(
            bridge.notifyMovingFundsBelowDust(
              ecdsaWalletTestData.pubKeyHash160,
              corruptedMainUtxo
            )
          ).to.be.revertedWith("Invalid wallet main UTXO data")
        })
      })
    })

    context("when the wallet is not in the MovingFunds state", () => {
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
              ...walletDraft,
              state: test.walletState,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge.notifyMovingFundsBelowDust(
                ecdsaWalletTestData.pubKeyHash160,
                NO_MAIN_UTXO
              )
            ).to.be.revertedWith("Wallet must be in MovingFunds state")
          })
        })
      })
    })
  })

  describe("submitMovedFundsSweepProof", () => {
    context("when transaction proof is valid", () => {
      context("when there is only one output", () => {
        context("when the single output is 20-byte", () => {
          context("when single output is either P2PKH or P2WPKH", () => {
            context(
              "when sweeping wallet is either in the Live or MovingFunds state",
              () => {
                context("when sweeping wallet is in the Live state", () => {
                  context("when main UTXO data are valid", () => {
                    context(
                      "when transaction fee does not exceed the sweep transaction maximum fee",
                      () => {
                        context(
                          "when the sweeping wallet has no main UTXO set",
                          () => {
                            context(
                              "when there is a single input referring to a Pending sweep request",
                              () => {
                                const data: MovedFundsSweepTestData =
                                  MovedFundsSweepWithoutMainUtxo

                                let tx: ContractTransaction

                                before(async () => {
                                  await createSnapshot()

                                  tx = await runMovedFundsSweepScenario(data)
                                })

                                after(async () => {
                                  await restoreSnapshot()
                                })

                                it("should mark the sweep request as processed", async () => {
                                  const key = ethers.utils.solidityKeccak256(
                                    ["bytes32", "uint32"],
                                    [
                                      data.movedFundsSweepRequest.txHash,
                                      data.movedFundsSweepRequest.txOutputIndex,
                                    ]
                                  )

                                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                                  expect(
                                    (await bridge.movedFundsSweepRequests(key))
                                      .state
                                  ).to.be.equal(
                                    movedFundsSweepRequestState.Processed
                                  )
                                })

                                it("should decrease the sweeping wallet's pending requests count", async () => {
                                  // The `setPendingMovedFundsSweepRequest` call
                                  // made as part of `runMovedFundsSweepScenario`
                                  // set this counter to 1. Eventually, it
                                  // should be decreased back to 0.
                                  expect(
                                    (
                                      await bridge.wallets(
                                        data.wallet.pubKeyHash
                                      )
                                    ).pendingMovedFundsSweepRequestsCount
                                  ).to.be.equal(0)
                                })

                                it("should set the transaction output as new sweeping wallet main UTXO", async () => {
                                  // Amount can be checked by opening the sweep tx
                                  // in a Bitcoin testnet explorer. In this case,
                                  // the output  value is 16500.
                                  const expectedMainUtxoHash =
                                    ethers.utils.solidityKeccak256(
                                      ["bytes32", "uint32", "uint64"],
                                      [data.sweepTx.hash, 0, 16500]
                                    )

                                  expect(
                                    (
                                      await bridge.wallets(
                                        data.wallet.pubKeyHash
                                      )
                                    ).mainUtxoHash
                                  ).to.be.equal(expectedMainUtxoHash)
                                })

                                it("should emit the MovedFundsSwept event", async () => {
                                  await expect(tx)
                                    .to.emit(bridge, "MovedFundsSwept")
                                    .withArgs(
                                      data.wallet.pubKeyHash,
                                      data.sweepTx.hash
                                    )
                                })
                              }
                            )

                            context(
                              "when the single input does not refer to a Pending sweep request",
                              () => {
                                context(
                                  "when the single input refers to an Unknown sweep request",
                                  () => {
                                    const data: MovedFundsSweepTestData =
                                      MovedFundsSweepWithoutMainUtxo

                                    before(async () => {
                                      await createSnapshot()
                                    })

                                    after(async () => {
                                      await restoreSnapshot()
                                    })

                                    it("should revert", async () => {
                                      // Getting rid of the `movedFundsSweepRequest`
                                      // allows running that scenario because
                                      // the sweep request will not exist in the system.
                                      await expect(
                                        runMovedFundsSweepScenario({
                                          ...data,
                                          movedFundsSweepRequest: null,
                                        })
                                      ).to.be.revertedWith(
                                        "Sweep request must be in Pending state"
                                      )
                                    })
                                  }
                                )

                                context(
                                  "when the single input refers to a Processed sweep request",
                                  () => {
                                    const data: MovedFundsSweepTestData =
                                      MovedFundsSweepWithoutMainUtxo

                                    let tx: Promise<ContractTransaction>

                                    before(async () => {
                                      await createSnapshot()

                                      const beforeProofActions = async () => {
                                        await bridge.processPendingMovedFundsSweepRequest(
                                          data.movedFundsSweepRequest
                                            .walletPubKeyHash,
                                          data.movedFundsSweepRequest
                                        )
                                      }

                                      tx = runMovedFundsSweepScenario(
                                        data,
                                        beforeProofActions
                                      )
                                    })

                                    after(async () => {
                                      await restoreSnapshot()
                                    })

                                    it("should revert", async () => {
                                      await expect(tx).to.be.revertedWith(
                                        "Sweep request must be in Pending state"
                                      )
                                    })
                                  }
                                )

                                context(
                                  "when the single input refers to a TimedOut sweep request",
                                  () => {
                                    const data: MovedFundsSweepTestData =
                                      MovedFundsSweepWithoutMainUtxo

                                    let tx: Promise<ContractTransaction>

                                    before(async () => {
                                      await createSnapshot()

                                      const beforeProofActions = async () => {
                                        await bridge.timeoutPendingMovedFundsSweepRequest(
                                          data.movedFundsSweepRequest
                                            .walletPubKeyHash,
                                          data.movedFundsSweepRequest
                                        )
                                      }

                                      tx = runMovedFundsSweepScenario(
                                        data,
                                        beforeProofActions
                                      )
                                    })

                                    after(async () => {
                                      await restoreSnapshot()
                                    })

                                    it("should revert", async () => {
                                      await expect(tx).to.be.revertedWith(
                                        "Sweep request must be in Pending state"
                                      )
                                    })
                                  }
                                )
                              }
                            )

                            context(
                              "when the single input does refer to a Pending sweep request that belongs to another wallet",
                              () => {
                                const data: MovedFundsSweepTestData =
                                  MovedFundsSweepWithoutMainUtxo

                                before(async () => {
                                  await createSnapshot()
                                })

                                after(async () => {
                                  await restoreSnapshot()
                                })

                                it("should revert", async () => {
                                  // To make this scenario happen, we just
                                  // change the wallet in the test data' sweep
                                  // request.
                                  await expect(
                                    runMovedFundsSweepScenario({
                                      ...data,
                                      movedFundsSweepRequest: {
                                        ...data.movedFundsSweepRequest,
                                        walletPubKeyHash:
                                          "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
                                      },
                                    })
                                  ).to.be.revertedWith(
                                    "Sweep request belongs to another wallet"
                                  )
                                })
                              }
                            )

                            context(
                              "when the number of inputs is other than one",
                              () => {
                                // Use a test data that contains a two-input
                                // transaction.
                                const data: MovedFundsSweepTestData =
                                  MovedFundsSweepWithMainUtxo

                                before(async () => {
                                  await createSnapshot()
                                })

                                after(async () => {
                                  await restoreSnapshot()
                                })

                                it("should revert", async () => {
                                  // However, do not set wallet main UTXO. In
                                  // that case, the system will expect a
                                  // sweep transaction with a single input.
                                  await expect(
                                    runMovedFundsSweepScenario({
                                      ...data,
                                      mainUtxo: NO_MAIN_UTXO,
                                    })
                                  ).to.be.revertedWith(
                                    "Moved funds sweep transaction must have a proper inputs count"
                                  )
                                })
                              }
                            )
                          }
                        )

                        context(
                          "when the sweeping wallet has a main UTXO set",
                          () => {
                            context(
                              "when the first input refers to a Pending sweep request and the second input refers to the sweeping wallet main UTXO",
                              () => {
                                const data: MovedFundsSweepTestData =
                                  MovedFundsSweepWithMainUtxo

                                let tx: ContractTransaction

                                before(async () => {
                                  await createSnapshot()

                                  tx = await runMovedFundsSweepScenario(data)
                                })

                                after(async () => {
                                  await restoreSnapshot()
                                })

                                it("should mark the sweep request as processed", async () => {
                                  const key = ethers.utils.solidityKeccak256(
                                    ["bytes32", "uint32"],
                                    [
                                      data.movedFundsSweepRequest.txHash,
                                      data.movedFundsSweepRequest.txOutputIndex,
                                    ]
                                  )

                                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                                  expect(
                                    (await bridge.movedFundsSweepRequests(key))
                                      .state
                                  ).to.be.equal(
                                    movedFundsSweepRequestState.Processed
                                  )
                                })

                                it("should decrease the sweeping wallet's pending requests count", async () => {
                                  // The `setPendingMovedFundsSweepRequest` call
                                  // made as part of `runMovedFundsSweepScenario`
                                  // set this counter to 1. Eventually, it
                                  // should be decreased back to 0.
                                  expect(
                                    (
                                      await bridge.wallets(
                                        data.wallet.pubKeyHash
                                      )
                                    ).pendingMovedFundsSweepRequestsCount
                                  ).to.be.equal(0)
                                })

                                it("should set the transaction output as new sweeping wallet main UTXO", async () => {
                                  // Amount can be checked by opening the sweep tx
                                  // in a Bitcoin testnet explorer. In this case,
                                  // the output  value is 2612530.
                                  const expectedMainUtxoHash =
                                    ethers.utils.solidityKeccak256(
                                      ["bytes32", "uint32", "uint64"],
                                      [data.sweepTx.hash, 0, 2612530]
                                    )

                                  expect(
                                    (
                                      await bridge.wallets(
                                        data.wallet.pubKeyHash
                                      )
                                    ).mainUtxoHash
                                  ).to.be.equal(expectedMainUtxoHash)
                                })

                                it("should emit the MovedFundsSwept event", async () => {
                                  await expect(tx)
                                    .to.emit(bridge, "MovedFundsSwept")
                                    .withArgs(
                                      data.wallet.pubKeyHash,
                                      data.sweepTx.hash
                                    )
                                })

                                it("should mark the current sweeping wallet main UTXO as correctly spent", async () => {
                                  const key = ethers.utils.solidityKeccak256(
                                    ["bytes32", "uint32"],
                                    [
                                      data.mainUtxo.txHash,
                                      data.mainUtxo.txOutputIndex,
                                    ]
                                  )

                                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                                  expect(await bridge.spentMainUTXOs(key)).to.be
                                    .true
                                })
                              }
                            )

                            context(
                              "when the first input refers to the sweeping wallet main UTXO and the second input refers to a Pending sweep request",
                              () => {
                                // The sweep transaction used by this test data
                                // has two inputs. The first input is registered
                                // as a sweep request (i.e. it is referred by
                                // `movedFundsSweepRequest`) and the second one
                                // is meant to be the main UTXO (i.e. it is
                                // referred by `mainUtxo`).
                                const data: MovedFundsSweepTestData =
                                  MovedFundsSweepWithMainUtxo

                                before(async () => {
                                  await createSnapshot()
                                })

                                after(async () => {
                                  await restoreSnapshot()
                                })

                                it("should revert", async () => {
                                  // To make that scenario happen, we just
                                  // let the test runner to register the first
                                  // input as the main UTXO and the second
                                  // one as the sweep request.
                                  const movedFundsSweepRequest = {
                                    ...data.mainUtxo,
                                    walletPubKeyHash:
                                      data.movedFundsSweepRequest
                                        .walletPubKeyHash,
                                  }

                                  const mainUtxo = {
                                    ...data.movedFundsSweepRequest,
                                  }

                                  await expect(
                                    runMovedFundsSweepScenario({
                                      ...data,
                                      movedFundsSweepRequest,
                                      mainUtxo,
                                    })
                                  ).to.be.revertedWith(
                                    "Sweep request must be in Pending state"
                                  )
                                })
                              }
                            )

                            context(
                              "when the first input does not refer to a Pending sweep request and the second input refers to the sweeping wallet main UTXO",
                              () => {
                                context(
                                  "when the first input refers to an Unknown sweep request",
                                  () => {
                                    const data: MovedFundsSweepTestData =
                                      MovedFundsSweepWithMainUtxo

                                    before(async () => {
                                      await createSnapshot()
                                    })

                                    after(async () => {
                                      await restoreSnapshot()
                                    })

                                    it("should revert", async () => {
                                      // Getting rid of the `movedFundsSweepRequest`
                                      // allows running that scenario because
                                      // the sweep request will not exist in the system.
                                      await expect(
                                        runMovedFundsSweepScenario({
                                          ...data,
                                          movedFundsSweepRequest: null,
                                        })
                                      ).to.be.revertedWith(
                                        "Sweep request must be in Pending state"
                                      )
                                    })
                                  }
                                )

                                context(
                                  "when the first input refers to a Processed sweep request",
                                  () => {
                                    const data: MovedFundsSweepTestData =
                                      MovedFundsSweepWithMainUtxo

                                    let tx: Promise<ContractTransaction>

                                    before(async () => {
                                      await createSnapshot()

                                      const beforeProofActions = async () => {
                                        await bridge.processPendingMovedFundsSweepRequest(
                                          data.movedFundsSweepRequest
                                            .walletPubKeyHash,
                                          data.movedFundsSweepRequest
                                        )
                                      }

                                      tx = runMovedFundsSweepScenario(
                                        data,
                                        beforeProofActions
                                      )
                                    })

                                    after(async () => {
                                      await restoreSnapshot()
                                    })

                                    it("should revert", async () => {
                                      await expect(tx).to.be.revertedWith(
                                        "Sweep request must be in Pending state"
                                      )
                                    })
                                  }
                                )

                                context(
                                  "when the first input refers to a TimedOut sweep request",
                                  () => {
                                    const data: MovedFundsSweepTestData =
                                      MovedFundsSweepWithMainUtxo

                                    let tx: Promise<ContractTransaction>

                                    before(async () => {
                                      await createSnapshot()

                                      const beforeProofActions = async () => {
                                        await bridge.timeoutPendingMovedFundsSweepRequest(
                                          data.movedFundsSweepRequest
                                            .walletPubKeyHash,
                                          data.movedFundsSweepRequest
                                        )
                                      }

                                      tx = runMovedFundsSweepScenario(
                                        data,
                                        beforeProofActions
                                      )
                                    })

                                    after(async () => {
                                      await restoreSnapshot()
                                    })

                                    it("should revert", async () => {
                                      await expect(tx).to.be.revertedWith(
                                        "Sweep request must be in Pending state"
                                      )
                                    })
                                  }
                                )
                              }
                            )

                            context(
                              "when the first input refers to a Pending sweep request that belongs to another wallet and the second input refers to the sweeping wallet main UTXO",
                              () => {
                                const data: MovedFundsSweepTestData =
                                  MovedFundsSweepWithMainUtxo

                                before(async () => {
                                  await createSnapshot()
                                })

                                after(async () => {
                                  await restoreSnapshot()
                                })

                                it("should revert", async () => {
                                  // To make this scenario happen, we just
                                  // change the wallet in the test data' sweep
                                  // request.
                                  await expect(
                                    runMovedFundsSweepScenario({
                                      ...data,
                                      movedFundsSweepRequest: {
                                        ...data.movedFundsSweepRequest,
                                        walletPubKeyHash:
                                          "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                                      },
                                    })
                                  ).to.be.revertedWith(
                                    "Sweep request belongs to another wallet"
                                  )
                                })
                              }
                            )

                            context(
                              "when the first input refers to a Pending sweep request and the second input does not refer to the sweeping wallet main UTXO",
                              () => {
                                const data: MovedFundsSweepTestData =
                                  MovedFundsSweepWithMainUtxo

                                before(async () => {
                                  await createSnapshot()
                                })

                                after(async () => {
                                  await restoreSnapshot()
                                })

                                it("should revert", async () => {
                                  // To make this scenario happen, we just need
                                  // to simulate that the sweeping wallet has
                                  // a different main UTXO than the one used
                                  // by the second transaction input.
                                  await expect(
                                    runMovedFundsSweepScenario({
                                      ...data,
                                      mainUtxo: {
                                        ...data.mainUtxo,
                                        txOutputIndex: 2,
                                      },
                                    })
                                  ).to.be.revertedWith(
                                    "Second input must point to the wallet's main UTXO"
                                  )
                                })
                              }
                            )

                            context(
                              "when the number of inputs is other than two",
                              () => {
                                // Use a test data with a one-input transaction.
                                const data: MovedFundsSweepTestData =
                                  MovedFundsSweepWithoutMainUtxo

                                before(async () => {
                                  await createSnapshot()
                                })

                                after(async () => {
                                  await restoreSnapshot()
                                })

                                it("should revert", async () => {
                                  // However, register a main UTXO for the
                                  // sweeping wallet in order to force the
                                  // system to expect a two-input transaction
                                  // for that sweeping wallet.
                                  await expect(
                                    runMovedFundsSweepScenario({
                                      ...data,
                                      // Just an arbitrary main UTXO
                                      mainUtxo: {
                                        txHash:
                                          "0x7d5f7d4ae705d6adb8a402e5cd7f25f839a3f3ed243a8961c8ac5887d5aaf528",
                                        txOutputIndex: 0,
                                        txOutputValue: 873510,
                                      },
                                    })
                                  ).to.be.revertedWith(
                                    "Moved funds sweep transaction must have a proper inputs count"
                                  )
                                })
                              }
                            )
                          }
                        )
                      }
                    )

                    context(
                      "when transaction fee exceeds the sweep transaction maximum fee",
                      () => {
                        // Use a test data where the sweep transaction has
                        // a fee of 2000 satoshi.
                        const data: MovedFundsSweepTestData =
                          MovedFundsSweepWithoutMainUtxo

                        before(async () => {
                          await createSnapshot()

                          // Set the max fee to one satoshi less than the fee
                          // used by the transaction.
                          await bridge.setMovedFundsSweepTxMaxTotalFee(1999)
                        })

                        after(async () => {
                          await restoreSnapshot()
                        })

                        it("should revert", async () => {
                          await expect(
                            runMovedFundsSweepScenario(data)
                          ).to.be.revertedWith("Transaction fee is too high")
                        })
                      }
                    )
                  })

                  context("when main UTXO data are invalid", () => {
                    const data: MovedFundsSweepTestData =
                      MovedFundsSweepWithMainUtxo

                    let tx: Promise<ContractTransaction>

                    before(async () => {
                      await createSnapshot()

                      const beforeProofAction = async () => {
                        // Swap the main UTXO just before the proof to make
                        // this scenario happen.
                        await bridge.setWalletMainUtxo(data.wallet.pubKeyHash, {
                          ...data.mainUtxo,
                          txOutputIndex: 2,
                        })
                      }

                      tx = runMovedFundsSweepScenario(data, beforeProofAction)
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should revert", async () => {
                      await expect(tx).to.be.revertedWith(
                        "Invalid main UTXO data"
                      )
                    })
                  })
                })

                context(
                  "when sweeping wallet is in the MovingFunds state",
                  () => {
                    const data: MovedFundsSweepTestData =
                      MovedFundsSweepWithoutMainUtxo

                    let tx: Promise<ContractTransaction>

                    before(async () => {
                      await createSnapshot()

                      tx = runMovedFundsSweepScenario({
                        ...data,
                        wallet: {
                          ...data.wallet,
                          state: walletState.MovingFunds,
                        },
                      })
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should succeed", async () => {
                      // The assertions were already performed for Live wallet
                      // scenarios. Here we just make sure the transaction
                      // succeeds for a MovingFunds wallet.
                      await expect(tx).to.not.be.reverted
                    })
                  }
                )
              }
            )

            context(
              "when sweeping wallet is neither in the Live nor MovingFunds state",
              () => {
                const testData = [
                  {
                    testName: "when sweeping wallet is in the Unknown state",
                    walletState: walletState.Unknown,
                  },
                  {
                    testName: "when sweeping wallet is in the Closing state",
                    walletState: walletState.Closing,
                  },
                  {
                    testName: "when sweeping wallet is in the Closed state",
                    walletState: walletState.Closed,
                  },
                  {
                    testName: "when sweeping wallet is in the Terminated state",
                    walletState: walletState.Terminated,
                  },
                ]

                testData.forEach((test) => {
                  context(test.testName, () => {
                    const data: MovedFundsSweepTestData =
                      MovedFundsSweepWithoutMainUtxo

                    let tx: Promise<ContractTransaction>

                    before(async () => {
                      await createSnapshot()

                      tx = runMovedFundsSweepScenario({
                        ...data,
                        wallet: {
                          ...data.wallet,
                          state: test.walletState,
                        },
                      })
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should revert", async () => {
                      await expect(tx).to.be.revertedWith(
                        "Wallet must be in Live or MovingFunds state"
                      )
                    })
                  })
                })
              }
            )
          })

          context("when single output is neither P2PKH nor P2WPKH", () => {
            const data: MovedFundsSweepTestData = MovedFundsSweepP2SHOutput

            before(async () => {
              await createSnapshot()
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
                "Output must be P2PKH or P2WPKH"
              )
            })
          })
        })

        context("when the single output is not 20-byte", () => {
          const data: MovedFundsSweepTestData =
            MovedFundsSweepProvablyUnspendableOutput

          before(async () => {
            await createSnapshot()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
              "Output's public key hash must have 20 bytes"
            )
          })
        })
      })

      context("when output count is other than one", () => {
        const data: MovedFundsSweepTestData = MovedFundsSweepMultipleOutputs

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
            "Moved funds sweep transaction must have a single output"
          )
        })
      })
    })

    context("when transaction proof is not valid", () => {
      context("when input vector is not valid", () => {
        const data: MovedFundsSweepTestData = JSON.parse(
          JSON.stringify(MovedFundsSweepWithoutMainUtxo)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the input vector by setting a compactSize uint claiming
          // there are no inputs at all.
          data.sweepTx.inputVector =
            "0x00b69a2869840aa6fdfd143136ff4514ca46ea2d876855040892ad74ab" +
            "8c5274220100000000ffffffff"

          await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
            "Invalid input vector provided"
          )
        })
      })

      context("when output vector is not valid", () => {
        const data: MovedFundsSweepTestData = JSON.parse(
          JSON.stringify(MovedFundsSweepWithoutMainUtxo)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the output vector by setting a compactSize uint claiming
          // there is no outputs at all.
          data.sweepTx.outputVector =
            "0x005cf511000000000017a91486884e6be1525dab5ae0b451bd2c72cee6" +
            "7dcf4187"

          await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
            "Invalid output vector provided"
          )
        })
      })

      context(
        "when transaction is not on same level of merkle tree as coinbase",
        () => {
          const data: MovedFundsSweepTestData = JSON.parse(
            JSON.stringify(MovedFundsSweepWithoutMainUtxo)
          )

          before(async () => {
            await createSnapshot()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            // Simulate that the proven transaction is deeper in the merkle tree
            // than the coinbase. This is achieved by appending additional
            // hashes to the merkle proof.
            data.sweepProof.merkleProof +=
              ethers.utils.sha256("0x01").substring(2) +
              ethers.utils.sha256("0x02").substring(2)

            await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
              "Tx not on same level of merkle tree as coinbase"
            )
          })
        }
      )

      context("when merkle proof is not valid", () => {
        const data: MovedFundsSweepTestData = JSON.parse(
          JSON.stringify(MovedFundsSweepWithoutMainUtxo)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the merkle proof by changing tx index in block to an
          // invalid one. The proper one is 12 so any other will do the trick.
          data.sweepProof.txIndexInBlock = 30

          await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
            "Tx merkle proof is not valid for provided header and tx hash"
          )
        })
      })

      context("when coinbase merkle proof is not valid", () => {
        const data: MovedFundsSweepTestData = JSON.parse(
          JSON.stringify(MovedFundsSweepWithoutMainUtxo)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the coinbase preimage.
          data.sweepProof.coinbasePreimage = ethers.utils.sha256(
            data.sweepProof.coinbasePreimage
          )

          await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
            "Coinbase merkle proof is not valid for provided header and hash"
          )
        })
      })

      context("when proof difficulty is not current nor previous", () => {
        const data: MovedFundsSweepTestData = JSON.parse(
          JSON.stringify(MovedFundsSweepWithoutMainUtxo)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // To pass the proof validation, the difficulty returned by the relay
          // must be 1 for test data used in this scenario. Setting
          // a different value will cause difficulty comparison failure.
          data.chainDifficulty = 2

          await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
            "Not at current or previous difficulty"
          )
        })
      })

      context("when headers chain length is not valid", () => {
        const data: MovedFundsSweepTestData = JSON.parse(
          JSON.stringify(MovedFundsSweepWithoutMainUtxo)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the bitcoin headers length in the moving funds proof. The
          // proper value is length divisible by 80 so any length violating
          // this rule will cause failure. In this case, we just remove the
          // last byte from proper headers chain.
          const properHeaders = data.sweepProof.bitcoinHeaders.toString()
          data.sweepProof.bitcoinHeaders = properHeaders.substring(
            0,
            properHeaders.length - 2
          )

          await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
            "Invalid length of the headers chain"
          )
        })
      })

      context("when headers chain is not valid", () => {
        const data: MovedFundsSweepTestData = JSON.parse(
          JSON.stringify(MovedFundsSweepWithoutMainUtxo)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Bitcoin headers must form a chain to pass the proof validation.
          // That means the `previous block hash` encoded in the given block
          // header must match the actual previous header's hash. To test
          // that scenario, we corrupt the `previous block hash` of the
          // second header. Each header is 80 bytes length. First 4 bytes
          // of each header is `version` and 32 subsequent bytes is
          // `previous block hash`. Changing byte 85 of the whole chain will
          // do the work.
          const properHeaders = data.sweepProof.bitcoinHeaders.toString()
          data.sweepProof.bitcoinHeaders = `${properHeaders.substring(
            0,
            170
          )}ff${properHeaders.substring(172)}`

          await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
            "Invalid headers chain"
          )
        })
      })

      context("when the work in the header is insufficient", () => {
        const data: MovedFundsSweepTestData = JSON.parse(
          JSON.stringify(MovedFundsSweepWithoutMainUtxo)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Each header encodes a `difficulty target` field in bytes 72-76.
          // The given header's hash (interpreted as uint) must be bigger than
          // the `difficulty target`. To test this scenario, we change the
          // last byte of the last header in such a way their hash becomes
          // lower than their `difficulty target`.
          const properHeaders = data.sweepProof.bitcoinHeaders.toString()
          data.sweepProof.bitcoinHeaders = `${properHeaders.substring(
            0,
            properHeaders.length - 2
          )}ff`

          await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
            "Insufficient work in a header"
          )
        })
      })

      context(
        "when accumulated difficulty in headers chain is insufficient",
        () => {
          let otherBridge: Bridge
          const data: MovedFundsSweepTestData = JSON.parse(
            JSON.stringify(MovedFundsSweepWithMainUtxo)
          )

          before(async () => {
            await createSnapshot()

            // Necessary to pass the first part of proof validation.
            await relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
            await relay.getPrevEpochDifficulty.returns(data.chainDifficulty)

            // Deploy another bridge which has higher `txProofDifficultyFactor`
            // than the original bridge. That means it will need 12 confirmations
            // to deem transaction proof validity. This scenario uses test
            // data which has only 6 confirmations. That should force the
            // failure we expect within this scenario.
            otherBridge = (await deployBridge(12))[0] as BridgeStub
            await otherBridge.setSpvMaintainerStatus(
              spvMaintainer.address,
              true
            )
          })

          after(async () => {
            await relay.getCurrentEpochDifficulty.reset()
            await relay.getPrevEpochDifficulty.reset()

            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              otherBridge
                .connect(spvMaintainer)
                .submitMovedFundsSweepProof(
                  data.sweepTx,
                  data.sweepProof,
                  data.mainUtxo
                )
            ).to.be.revertedWith(
              "Insufficient accumulated difficulty in header chain"
            )
          })
        }
      )

      context("when transaction data is limited to 64 bytes", () => {
        // This test proves it is impossible to construct a valid proof if
        // the transaction data (version, locktime, inputs, outputs)
        // length is 64 bytes or less.

        const data: MovedFundsSweepTestData = JSON.parse(
          JSON.stringify(MovedFundsSweepWithoutMainUtxo)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Modify the `sweepTx` part of test data in such a way so it is only
          // 64 bytes in length and correctly passes as many SPV proof checks as
          // possible.
          data.sweepTx.version = "0x01000000" // 4 bytes
          data.sweepTx.locktime = "0x00000000" // 4 bytes

          // 42 bytes at minimum to pass input formatting validation (1 byte
          // for inputs length, 32 bytes for tx hash, 4 bytes for tx index,
          // 1 byte for script sig length, 4 bytes for sequence number).
          data.sweepTx.inputVector =
            "0x01aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
            "aaaaaa1111111100ffffffff"

          // 32 bytes at minimum to pass output formatting validation and the
          // output script check (1 byte for outputs length, 8 bytes for
          // output amount, 23 bytes for length-prefixed output script -
          // `submitMovedFundsSweepProof` checks that the output contains
          // a 23-byte or 26-byte long script). Since 50 bytes has already been
          // used on version, locktime and inputs, the output must be shortened
          // to 14 bytes, so that the total transaction length is 64 bytes.
          data.sweepTx.outputVector = "0x01aaaaaaaaaaaaaaaa14bbbbbbbb"

          await expect(runMovedFundsSweepScenario(data)).to.be.revertedWith(
            "Invalid output vector provided"
          )
        })
      })
    })
  })

  describe("notifyMovedFundsSweepTimeout", () => {
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

    const walletMembersIDs = [1, 2, 3, 4, 5]

    // Just an arbitrary request for test purposes.
    const movedFundsSweepRequest = {
      walletPubKeyHash: ecdsaWalletTestData.pubKeyHash160,
      txHash:
        "0x7d5f7d4ae705d6adb8a402e5cd7f25f839a3f3ed243a8961c8ac5887d5aaf528",
      txOutputIndex: 1,
      txOutputValue: 1747020,
    }

    context("when moved funds sweep request is in the Pending state", () => {
      before(async () => {
        await createSnapshot()

        await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, walletDraft)

        await bridge.setPendingMovedFundsSweepRequest(
          movedFundsSweepRequest.walletPubKeyHash,
          movedFundsSweepRequest
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when moved funds sweep request has timed out", () => {
        before(async () => {
          await createSnapshot()

          await increaseTime(movedFundsSweepTimeout + 1)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context(
          "when the wallet is either in the Live or MovingFunds state",
          () => {
            const testData: {
              testName: string
              walletState: number
              additionalSetup?: () => Promise<void>
              additionalAssertions?: () => Promise<void>
            }[] = [
              {
                testName:
                  "when the wallet is in the Live state but the wallet is not the active one",
                walletState: walletState.Live,
                additionalSetup: async () => {
                  // The active wallet is a different wallet than the tested one
                  await bridge.setActiveWallet(
                    "0x0b9f85c224b0e018a5865392927b3f9e16cf5e79"
                  )
                },
                additionalAssertions: async () => {
                  it("should decrease the live wallets count", async () => {
                    expect(await bridge.liveWalletsCount()).to.be.equal(0)
                  })

                  it("should not unset the active wallet", async () => {
                    expect(
                      await bridge.activeWalletPubKeyHash()
                    ).to.be.not.equal(
                      "0x0000000000000000000000000000000000000000"
                    )
                  })
                },
              },
              {
                testName:
                  "when the wallet is in the Live state and the wallet is the active one",
                walletState: walletState.Live,
                additionalSetup: async () => {
                  await bridge.setActiveWallet(
                    movedFundsSweepRequest.walletPubKeyHash
                  )
                },
                additionalAssertions: async () => {
                  it("should decrease the live wallets count", async () => {
                    expect(await bridge.liveWalletsCount()).to.be.equal(0)
                  })

                  it("should unset the active wallet", async () => {
                    expect(await bridge.activeWalletPubKeyHash()).to.be.equal(
                      "0x0000000000000000000000000000000000000000"
                    )
                  })
                },
              },
              {
                testName: "when the wallet is in the MovingFunds state",
                walletState: walletState.MovingFunds,
                additionalSetup: async () => {},
                additionalAssertions: async () => {},
              },
            ]

            testData.forEach((test) => {
              context(test.testName, async () => {
                let tx: ContractTransaction

                before(async () => {
                  await createSnapshot()

                  // We change the wallet state while preserving other fields.
                  // We don't have an update function in the stub so we just use
                  // the getter to get wallet fields and set them through the
                  // setter with state field overwritten.
                  await bridge.setWallet(
                    movedFundsSweepRequest.walletPubKeyHash,
                    {
                      ...(await bridge.wallets(
                        movedFundsSweepRequest.walletPubKeyHash
                      )),
                      state: test.walletState,
                    }
                  )

                  await test.additionalSetup()

                  tx = await bridge
                    .connect(thirdParty)
                    .notifyMovedFundsSweepTimeout(
                      movedFundsSweepRequest.txHash,
                      movedFundsSweepRequest.txOutputIndex,
                      walletMembersIDs
                    )
                })

                after(async () => {
                  await walletRegistry.closeWallet.reset()
                  await walletRegistry.seize.reset()

                  await restoreSnapshot()
                })

                it("should switch the moved funds sweep request to the TimedOut state", async () => {
                  const requestKey = ethers.utils.solidityKeccak256(
                    ["bytes32", "uint32"],
                    [
                      movedFundsSweepRequest.txHash,
                      movedFundsSweepRequest.txOutputIndex,
                    ]
                  )

                  expect(
                    (await bridge.movedFundsSweepRequests(requestKey)).state
                  ).to.be.equal(movedFundsSweepRequestState.TimedOut)
                })

                it("should decrease the number of pending moved funds sweep requests for the given wallet", async () =>
                  expect(
                    (
                      await bridge.wallets(
                        movedFundsSweepRequest.walletPubKeyHash
                      )
                    ).pendingMovedFundsSweepRequestsCount
                  ).to.be.equal(0))

                it("should switch the wallet to Terminated state", async () => {
                  expect(
                    (
                      await bridge.wallets(
                        movedFundsSweepRequest.walletPubKeyHash
                      )
                    ).state
                  ).to.be.equal(walletState.Terminated)
                })

                it("should emit WalletTerminated event", async () => {
                  await expect(tx)
                    .to.emit(bridge, "WalletTerminated")
                    .withArgs(
                      walletDraft.ecdsaWalletID,
                      movedFundsSweepRequest.walletPubKeyHash
                    )
                })

                it("should call ECDSA Wallet Registry's closeWallet function", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  await expectCalledOnceWith(walletRegistry.closeWallet, [
                    walletDraft.ecdsaWalletID,
                  ])
                })

                it("should call the ECDSA wallet registry's seize function", async () => {
                  await expectCalledOnceWith(walletRegistry.seize, [
                    movedFundsSweepTimeoutSlashingAmount,
                    movedFundsSweepTimeoutNotifierRewardMultiplier,
                    await thirdParty.getAddress(),
                    walletDraft.ecdsaWalletID,
                    walletMembersIDs,
                  ])
                })

                it("should emit MovedFundsSweepTimedOut event", async () => {
                  await expect(tx)
                    .to.emit(bridge, "MovedFundsSweepTimedOut")
                    .withArgs(
                      movedFundsSweepRequest.walletPubKeyHash,
                      movedFundsSweepRequest.txHash,
                      movedFundsSweepRequest.txOutputIndex
                    )
                })

                await test.additionalAssertions()
              })
            })
          }
        )

        context("when the wallet is in the Terminated state", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await bridge.setWallet(movedFundsSweepRequest.walletPubKeyHash, {
              ...(await bridge.wallets(
                movedFundsSweepRequest.walletPubKeyHash
              )),
              state: walletState.Terminated,
            })

            tx = await bridge
              .connect(thirdParty)
              .notifyMovedFundsSweepTimeout(
                movedFundsSweepRequest.txHash,
                movedFundsSweepRequest.txOutputIndex,
                walletMembersIDs
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should switch the moved funds sweep request to the TimedOut state", async () => {
            const requestKey = ethers.utils.solidityKeccak256(
              ["bytes32", "uint32"],
              [
                movedFundsSweepRequest.txHash,
                movedFundsSweepRequest.txOutputIndex,
              ]
            )

            expect(
              (await bridge.movedFundsSweepRequests(requestKey)).state
            ).to.be.equal(movedFundsSweepRequestState.TimedOut)
          })

          it("should decrease the number of pending moved funds sweep requests for the given wallet", async () =>
            expect(
              (await bridge.wallets(movedFundsSweepRequest.walletPubKeyHash))
                .pendingMovedFundsSweepRequestsCount
            ).to.be.equal(0))

          it("should not change the wallet state", async () => {
            expect(
              (await bridge.wallets(movedFundsSweepRequest.walletPubKeyHash))
                .state
            ).to.be.equal(walletState.Terminated)
          })
        })

        context(
          "when the wallet is neither in the Live nor MovingFunds nor Terminated state",
          () => {
            const testData = [
              {
                testName: "when the wallet is in the Unknown state",
                walletState: walletState.Unknown,
              },
              {
                testName: "when the wallet is in the Closing state",
                walletState: walletState.Closing,
              },
              {
                testName: "when the wallet is in the Closed state",
                walletState: walletState.Closed,
              },
            ]

            testData.forEach((test) => {
              context(test.testName, async () => {
                before(async () => {
                  await createSnapshot()

                  await bridge.setWallet(
                    movedFundsSweepRequest.walletPubKeyHash,
                    {
                      ...(await bridge.wallets(
                        movedFundsSweepRequest.walletPubKeyHash
                      )),
                      state: test.walletState,
                    }
                  )
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  await expect(
                    bridge.notifyMovedFundsSweepTimeout(
                      movedFundsSweepRequest.txHash,
                      movedFundsSweepRequest.txOutputIndex,
                      walletMembersIDs
                    )
                  ).to.be.revertedWith(
                    "Wallet must be in Live or MovingFunds or Terminated state"
                  )
                })
              })
            })
          }
        )
      })

      context("when moved funds sweep request has not timed out yet", () => {
        before(async () => {
          await createSnapshot()

          await increaseTime(movedFundsSweepTimeout - 1)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge.notifyMovedFundsSweepTimeout(
              movedFundsSweepRequest.txHash,
              movedFundsSweepRequest.txOutputIndex,
              walletMembersIDs
            )
          ).to.be.revertedWith("Sweep request has not timed out yet")
        })
      })
    })

    context(
      "when moved funds sweep request is not in the Pending state",
      () => {
        context(
          "when moved funds sweep request is in the Unknown state",
          () => {
            before(async () => {
              await createSnapshot()
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge.notifyMovedFundsSweepTimeout(
                  movedFundsSweepRequest.txHash,
                  movedFundsSweepRequest.txOutputIndex,
                  walletMembersIDs
                )
              ).to.be.revertedWith("Sweep request must be in Pending state")
            })
          }
        )

        context(
          "when moved funds sweep request is in the Processed state",
          () => {
            before(async () => {
              await createSnapshot()

              await bridge.setWallet(
                ecdsaWalletTestData.pubKeyHash160,
                walletDraft
              )

              await bridge.setPendingMovedFundsSweepRequest(
                movedFundsSweepRequest.walletPubKeyHash,
                movedFundsSweepRequest
              )

              await bridge.processPendingMovedFundsSweepRequest(
                movedFundsSweepRequest.walletPubKeyHash,
                movedFundsSweepRequest
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge.notifyMovedFundsSweepTimeout(
                  movedFundsSweepRequest.txHash,
                  movedFundsSweepRequest.txOutputIndex,
                  walletMembersIDs
                )
              ).to.be.revertedWith("Sweep request must be in Pending state")
            })
          }
        )

        context(
          "when moved funds sweep request is in the TimedOut state",
          () => {
            before(async () => {
              await createSnapshot()

              await bridge.setWallet(
                ecdsaWalletTestData.pubKeyHash160,
                walletDraft
              )

              await bridge.setPendingMovedFundsSweepRequest(
                movedFundsSweepRequest.walletPubKeyHash,
                movedFundsSweepRequest
              )

              await bridge.timeoutPendingMovedFundsSweepRequest(
                movedFundsSweepRequest.walletPubKeyHash,
                movedFundsSweepRequest
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge.notifyMovedFundsSweepTimeout(
                  movedFundsSweepRequest.txHash,
                  movedFundsSweepRequest.txOutputIndex,
                  walletMembersIDs
                )
              ).to.be.revertedWith("Sweep request must be in Pending state")
            })
          }
        )
      }
    )
  })

  async function runMovingFundsScenario(
    data: MovingFundsTestData,
    beforeProofActions?: () => Promise<void>
  ): Promise<ContractTransaction> {
    await relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
    await relay.getPrevEpochDifficulty.returns(data.chainDifficulty)

    // Simulate the wallet is a registered one.
    await bridge.setWallet(data.wallet.pubKeyHash, {
      ecdsaWalletID: data.wallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: await lastBlockTime(),
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: data.wallet.state,
      movingFundsTargetWalletsCommitmentHash:
        data.targetWalletsCommitment.length > 0
          ? ethers.utils.solidityKeccak256(
              ["bytes20[]"],
              [data.targetWalletsCommitment]
            )
          : ethers.constants.HashZero,
    })
    // Simulate the prepared main UTXO belongs to the wallet.
    await bridge.setWalletMainUtxo(data.wallet.pubKeyHash, data.mainUtxo)

    if (beforeProofActions) {
      await beforeProofActions()
    }

    const tx = await bridge
      .connect(spvMaintainer)
      .submitMovingFundsProof(
        data.movingFundsTx,
        data.movingFundsProof,
        data.mainUtxo,
        data.wallet.pubKeyHash
      )

    await relay.getCurrentEpochDifficulty.reset()
    await relay.getPrevEpochDifficulty.reset()

    return tx
  }

  async function runMovedFundsSweepScenario(
    data: MovedFundsSweepTestData,
    beforeProofActions?: () => Promise<void>
  ): Promise<ContractTransaction> {
    await relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
    await relay.getPrevEpochDifficulty.returns(data.chainDifficulty)

    // Simulate the wallet is a registered one.
    await bridge.setWallet(data.wallet.pubKeyHash, {
      ecdsaWalletID: data.wallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: data.wallet.state,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })

    if (data.mainUtxo.txHash !== ethers.constants.HashZero) {
      // Simulate the prepared main UTXO belongs to the wallet.
      await bridge.setWalletMainUtxo(data.wallet.pubKeyHash, data.mainUtxo)
    }

    if (data.movedFundsSweepRequest) {
      await bridge.setPendingMovedFundsSweepRequest(
        data.movedFundsSweepRequest.walletPubKeyHash,
        data.movedFundsSweepRequest
      )
      // Just make sure the stub function `setPendingMovedFundsSweepRequest`
      // initialized the counter properly.
      assert(
        (await bridge.wallets(data.movedFundsSweepRequest.walletPubKeyHash))
          .pendingMovedFundsSweepRequestsCount === 1,
        "Pending moved funds request counter for the sweeping wallet should be set up to 1"
      )
    }

    if (beforeProofActions) {
      await beforeProofActions()
    }

    const tx = await bridge
      .connect(spvMaintainer)
      .submitMovedFundsSweepProof(data.sweepTx, data.sweepProof, data.mainUtxo)

    await relay.getCurrentEpochDifficulty.reset()
    await relay.getPrevEpochDifficulty.reset()

    return tx
  }
})
