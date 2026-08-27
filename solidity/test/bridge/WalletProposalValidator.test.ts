import crypto from "crypto"
import { ethers, helpers } from "hardhat"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import { BigNumber, BigNumberish, BytesLike } from "ethers"
import type {
  Bridge,
  IRedemptionWatchtower,
  WalletProposalValidator,
} from "../../typechain"
import { walletState, movedFundsSweepRequestState } from "../fixtures"
import { NO_MAIN_UTXO } from "../data/deposit-sweep"

chai.use(smock.matchers)

const { lastBlockTime, increaseTime } = helpers.time
const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { AddressZero, HashZero } = ethers.constants

const day = 86400
const depositLocktime = 30 * day

// Anchor for `createTestRedemptionRequest`'s default `requestedAt`. Captured
// from the chain's own clock (not `Date.now()`) at the start of the
// `validateRedemptionProposal` describe block below, because local-network
// deploy scripts (e.g. `97_set_reservation_parameters.ts`'s governance-delay
// bypass) advance `block.timestamp` via `evm_increaseTime` well past real
// wall-clock time. Relying on `Date.now()` here made every default-timed
// redemption request silently drift out of its safety-margin window
// whenever this file ran after a fixture that had already fast-forwarded
// the chain.
let redemptionRequestDefaultAnchorTime = 0

const emptyDepositExtraInfo = {
  fundingTx: {
    version: "0x00000000",
    inputVector: HashZero,
    outputVector: HashZero,
    locktime: "0x00000000",
  },
  blindingFactor: "0x0000000000000000",
  walletPubKeyHash: AddressZero,
  refundPubKeyHash: AddressZero,
  refundLocktime: "0x00000000",
}

describe("WalletProposalValidator", () => {
  let bridge: FakeContract<Bridge>

  let walletProposalValidator: WalletProposalValidator

  before(async () => {
    const { deployer } = await helpers.signers.getNamedSigners()

    bridge = await smock.fake<Bridge>("Bridge")

    const WalletProposalValidator = await ethers.getContractFactory(
      "WalletProposalValidator"
    )
    walletProposalValidator = await WalletProposalValidator.connect(
      deployer
    ).deploy(bridge.address)
  })

  describe("validateDepositSweepProposal", () => {
    const walletPubKeyHash = "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726"
    const ecdsaWalletID =
      "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863"
    const vault = "0x2553E09f832c9f5C656808bb7A24793818877732"
    const bridgeDepositTxMaxFee = 10000

    before(async () => {
      await createSnapshot()

      bridge.depositParameters.returns([0, 0, bridgeDepositTxMaxFee, 0])
    })

    after(async () => {
      bridge.depositParameters.reset()

      await restoreSnapshot()
    })

    context("when wallet is incorrect state", () => {
      const testData = [
        {
          testName: "when wallet state is Unknown",
          walletState: walletState.Unknown,
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

            bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
              ecdsaWalletID,
              mainUtxoHash: HashZero,
              pendingRedemptionsValue: 0,
              createdAt: 0,
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: test.walletState,
              movingFundsTargetWalletsCommitmentHash: HashZero,
            })
          })

          after(async () => {
            bridge.wallets.reset()

            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              // Only walletPubKeyHash argument is relevant in this scenario.
              walletProposalValidator.validateDepositSweepProposal(
                {
                  walletPubKeyHash,
                  depositsKeys: [],
                  sweepTxFee: 0,
                  depositsRevealBlocks: [],
                },
                []
              )
            ).to.be.revertedWith("Wallet is not in Live or MovingFunds state")
          })
        })
      })
    })

    context("when wallet is correct state", () => {
      const testData = [
        {
          testName: "when wallet state is Live",
          walletState: walletState.Live,
        },
        {
          testName: "when wallet state is MovingFunds",
          walletState: walletState.MovingFunds,
        },
      ]

      testData.forEach((test) => {
        context(test.testName, () => {
          before(async () => {
            await createSnapshot()

            bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
              ecdsaWalletID,
              mainUtxoHash: HashZero,
              pendingRedemptionsValue: 0,
              createdAt: 0,
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: test.walletState,
              movingFundsTargetWalletsCommitmentHash: HashZero,
            })
          })

          after(async () => {
            bridge.wallets.reset()

            await restoreSnapshot()
          })

          context("when sweep is below the min size", () => {
            it("should revert", async () => {
              await expect(
                walletProposalValidator.validateDepositSweepProposal(
                  {
                    walletPubKeyHash,
                    depositsKeys: [], // Set size to 0.
                    sweepTxFee: 0, // Not relevant in this scenario.
                    depositsRevealBlocks: [], // Not relevant in this scenario.
                  },
                  [] // Not relevant in this scenario.
                )
              ).to.be.revertedWith("Sweep below the min size")
            })
          })

          context("when sweep is above the min size", () => {
            context("when sweep exceeds the max size", () => {
              it("should revert", async () => {
                const maxSize =
                  await walletProposalValidator.DEPOSIT_SWEEP_MAX_SIZE()

                // Pick more deposits than allowed.
                const depositsKeys = new Array(maxSize + 1).fill(
                  createTestDeposit(walletPubKeyHash, vault).key
                )

                await expect(
                  walletProposalValidator.validateDepositSweepProposal(
                    {
                      walletPubKeyHash,
                      depositsKeys,
                      sweepTxFee: 0, // Not relevant in this scenario.
                      depositsRevealBlocks: [], // Not relevant in this scenario.
                    },
                    [] // Not relevant in this scenario.
                  )
                ).to.be.revertedWith("Sweep exceeds the max size")
              })
            })

            context("when sweep does not exceed the max size", () => {
              context("when deposit extra info length does not match", () => {
                it("should revert", async () => {
                  // The proposal contains one deposit.
                  const proposal = {
                    walletPubKeyHash,
                    depositsKeys: [
                      createTestDeposit(walletPubKeyHash, vault).key,
                    ],
                    sweepTxFee: 0, // Not relevant in this scenario.
                    depositsRevealBlocks: [], // Not relevant in this scenario.
                  }

                  // The extra info array contains two items.
                  const depositsExtraInfo = [
                    emptyDepositExtraInfo,
                    emptyDepositExtraInfo,
                  ]

                  await expect(
                    walletProposalValidator.validateDepositSweepProposal(
                      proposal,
                      depositsExtraInfo
                    )
                  ).to.be.revertedWith(
                    "Each deposit key must have matching extra info"
                  )
                })
              })

              context("when deposit extra info length matches", () => {
                context("when proposed sweep tx fee is invalid", () => {
                  context("when proposed sweep tx fee is zero", () => {
                    let depositOne
                    let depositTwo

                    before(async () => {
                      await createSnapshot()

                      depositOne = createTestDeposit(
                        walletPubKeyHash,
                        vault,
                        true
                      )
                      depositTwo = createTestDeposit(
                        walletPubKeyHash,
                        vault,
                        false
                      )

                      bridge.deposits
                        .whenCalledWith(
                          depositKey(
                            depositOne.key.fundingTxHash,
                            depositOne.key.fundingOutputIndex
                          )
                        )
                        .returns(depositOne.request)

                      bridge.deposits
                        .whenCalledWith(
                          depositKey(
                            depositTwo.key.fundingTxHash,
                            depositTwo.key.fundingOutputIndex
                          )
                        )
                        .returns(depositTwo.request)
                    })

                    after(async () => {
                      bridge.deposits.reset()

                      await restoreSnapshot()
                    })

                    it("should revert", async () => {
                      const proposal = {
                        walletPubKeyHash,
                        depositsKeys: [depositOne.key, depositTwo.key],
                        sweepTxFee: 0,
                        depositsRevealBlocks: [], // Not relevant in this scenario.
                      }

                      const depositsExtraInfo = [
                        depositOne.extraInfo,
                        depositTwo.extraInfo,
                      ]

                      await expect(
                        walletProposalValidator.validateDepositSweepProposal(
                          proposal,
                          depositsExtraInfo
                        )
                      ).to.be.revertedWith(
                        "Proposed transaction fee cannot be zero"
                      )
                    })
                  })

                  context(
                    "when proposed sweep tx fee is greater than the allowed",
                    () => {
                      let depositOne
                      let depositTwo

                      before(async () => {
                        await createSnapshot()

                        depositOne = createTestDeposit(
                          walletPubKeyHash,
                          vault,
                          true
                        )
                        depositTwo = createTestDeposit(
                          walletPubKeyHash,
                          vault,
                          false
                        )

                        bridge.deposits
                          .whenCalledWith(
                            depositKey(
                              depositOne.key.fundingTxHash,
                              depositOne.key.fundingOutputIndex
                            )
                          )
                          .returns(depositOne.request)

                        bridge.deposits
                          .whenCalledWith(
                            depositKey(
                              depositTwo.key.fundingTxHash,
                              depositTwo.key.fundingOutputIndex
                            )
                          )
                          .returns(depositTwo.request)
                      })

                      after(async () => {
                        bridge.deposits.reset()

                        await restoreSnapshot()
                      })

                      it("should revert", async () => {
                        const proposal = {
                          walletPubKeyHash,
                          depositsKeys: [depositOne.key, depositTwo.key],
                          // Exceed the max per-deposit fee by one.
                          sweepTxFee: bridgeDepositTxMaxFee * 2 + 1,
                          depositsRevealBlocks: [], // Not relevant in this scenario.
                        }

                        const depositsExtraInfo = [
                          depositOne.extraInfo,
                          depositTwo.extraInfo,
                        ]

                        await expect(
                          walletProposalValidator.validateDepositSweepProposal(
                            proposal,
                            depositsExtraInfo
                          )
                        ).to.be.revertedWith(
                          "Proposed transaction fee is too high"
                        )
                      })
                    }
                  )
                })

                context("when proposed sweep tx fee is valid", () => {
                  const sweepTxFee = 5000

                  context("when there is a non-revealed deposit", () => {
                    let depositOne
                    let depositTwo

                    before(async () => {
                      await createSnapshot()

                      depositOne = createTestDeposit(
                        walletPubKeyHash,
                        vault,
                        true
                      )
                      depositTwo = createTestDeposit(
                        walletPubKeyHash,
                        vault,
                        false
                      )

                      // Deposit one is a proper one.
                      bridge.deposits
                        .whenCalledWith(
                          depositKey(
                            depositOne.key.fundingTxHash,
                            depositOne.key.fundingOutputIndex
                          )
                        )
                        .returns(depositOne.request)

                      // Simulate the deposit two is not revealed.
                      bridge.deposits
                        .whenCalledWith(
                          depositKey(
                            depositTwo.key.fundingTxHash,
                            depositTwo.key.fundingOutputIndex
                          )
                        )
                        .returns({
                          ...depositTwo.request,
                          revealedAt: 0,
                        })
                    })

                    after(async () => {
                      bridge.deposits.reset()

                      await restoreSnapshot()
                    })

                    it("should revert", async () => {
                      const proposal = {
                        walletPubKeyHash,
                        depositsKeys: [depositOne.key, depositTwo.key],
                        sweepTxFee,
                        depositsRevealBlocks: [], // Not relevant in this scenario.
                      }

                      const depositsExtraInfo = [
                        depositOne.extraInfo,
                        depositTwo.extraInfo,
                      ]

                      await expect(
                        walletProposalValidator.validateDepositSweepProposal(
                          proposal,
                          depositsExtraInfo
                        )
                      ).to.be.revertedWith("Deposit not revealed")
                    })
                  })

                  context("when all deposits are revealed", () => {
                    context("when there is an immature deposit", () => {
                      let depositOne
                      let depositTwo

                      before(async () => {
                        await createSnapshot()

                        depositOne = createTestDeposit(
                          walletPubKeyHash,
                          vault,
                          true
                        )
                        depositTwo = createTestDeposit(
                          walletPubKeyHash,
                          vault,
                          false
                        )

                        // Deposit one is a proper one.
                        bridge.deposits
                          .whenCalledWith(
                            depositKey(
                              depositOne.key.fundingTxHash,
                              depositOne.key.fundingOutputIndex
                            )
                          )
                          .returns(depositOne.request)

                        // Simulate the deposit two has just been revealed thus not
                        // achieved the min age yet.
                        bridge.deposits
                          .whenCalledWith(
                            depositKey(
                              depositTwo.key.fundingTxHash,
                              depositTwo.key.fundingOutputIndex
                            )
                          )
                          .returns({
                            ...depositTwo.request,
                            revealedAt: await lastBlockTime(),
                          })
                      })

                      after(async () => {
                        bridge.deposits.reset()

                        await restoreSnapshot()
                      })

                      it("should revert", async () => {
                        const proposal = {
                          walletPubKeyHash,
                          depositsKeys: [depositOne.key, depositTwo.key],
                          sweepTxFee,
                          depositsRevealBlocks: [], // Not relevant in this scenario.
                        }

                        const depositsExtraInfo = [
                          depositOne.extraInfo,
                          depositTwo.extraInfo,
                        ]

                        await expect(
                          walletProposalValidator.validateDepositSweepProposal(
                            proposal,
                            depositsExtraInfo
                          )
                        ).to.be.revertedWith("Deposit min age not achieved yet")
                      })
                    })

                    context("when all deposits achieved the min age", () => {
                      context("when there is an already swept deposit", () => {
                        let depositOne
                        let depositTwo

                        before(async () => {
                          await createSnapshot()

                          depositOne = createTestDeposit(
                            walletPubKeyHash,
                            vault,
                            true
                          )
                          depositTwo = createTestDeposit(
                            walletPubKeyHash,
                            vault,
                            false
                          )

                          // Deposit one is a proper one.
                          bridge.deposits
                            .whenCalledWith(
                              depositKey(
                                depositOne.key.fundingTxHash,
                                depositOne.key.fundingOutputIndex
                              )
                            )
                            .returns(depositOne.request)

                          // Simulate the deposit two has already been swept.
                          bridge.deposits
                            .whenCalledWith(
                              depositKey(
                                depositTwo.key.fundingTxHash,
                                depositTwo.key.fundingOutputIndex
                              )
                            )
                            .returns({
                              ...depositTwo.request,
                              sweptAt: await lastBlockTime(),
                            })
                        })

                        after(async () => {
                          bridge.deposits.reset()

                          await restoreSnapshot()
                        })

                        it("should revert", async () => {
                          const proposal = {
                            walletPubKeyHash,
                            depositsKeys: [depositOne.key, depositTwo.key],
                            sweepTxFee,
                            depositsRevealBlocks: [], // Not relevant in this scenario.
                          }

                          const depositsExtraInfo = [
                            depositOne.extraInfo,
                            depositTwo.extraInfo,
                          ]

                          await expect(
                            walletProposalValidator.validateDepositSweepProposal(
                              proposal,
                              depositsExtraInfo
                            )
                          ).to.be.revertedWith("Deposit already swept")
                        })
                      })

                      context("when all deposits are not swept yet", () => {
                        context(
                          "when there is a deposit with invalid extra info",
                          () => {
                            context(
                              "when funding tx hashes don't match",
                              () => {
                                let deposit

                                before(async () => {
                                  await createSnapshot()

                                  deposit = createTestDeposit(
                                    walletPubKeyHash,
                                    vault,
                                    true
                                  )

                                  bridge.deposits
                                    .whenCalledWith(
                                      depositKey(
                                        deposit.key.fundingTxHash,
                                        deposit.key.fundingOutputIndex
                                      )
                                    )
                                    .returns(deposit.request)
                                })

                                after(async () => {
                                  bridge.deposits.reset()

                                  await restoreSnapshot()
                                })

                                it("should revert", async () => {
                                  const proposal = {
                                    walletPubKeyHash,
                                    depositsKeys: [deposit.key],
                                    sweepTxFee,
                                    depositsRevealBlocks: [], // Not relevant in this scenario.
                                  }

                                  // Corrupt the extra info by setting a different
                                  // version than 0x01000000 used to produce the hash.
                                  const depositsExtraInfo = [
                                    {
                                      ...deposit.extraInfo,
                                      fundingTx: {
                                        ...deposit.extraInfo.fundingTx,
                                        version: "0x02000000",
                                      },
                                    },
                                  ]

                                  await expect(
                                    walletProposalValidator.validateDepositSweepProposal(
                                      proposal,
                                      depositsExtraInfo
                                    )
                                  ).to.be.revertedWith(
                                    "Extra info funding tx hash does not match"
                                  )
                                })
                              }
                            )

                            context(
                              "when 20-byte funding output hash does not match",
                              () => {
                                let deposit

                                before(async () => {
                                  await createSnapshot()

                                  deposit = createTestDeposit(
                                    walletPubKeyHash,
                                    vault,
                                    false // Produce a non-witness deposit with 20-byte script
                                  )

                                  bridge.deposits
                                    .whenCalledWith(
                                      depositKey(
                                        deposit.key.fundingTxHash,
                                        deposit.key.fundingOutputIndex
                                      )
                                    )
                                    .returns(deposit.request)
                                })

                                after(async () => {
                                  bridge.deposits.reset()

                                  await restoreSnapshot()
                                })

                                it("should revert", async () => {
                                  const proposal = {
                                    walletPubKeyHash,
                                    depositsKeys: [deposit.key],
                                    sweepTxFee,
                                    depositsRevealBlocks: [], // Not relevant in this scenario.
                                  }

                                  // Corrupt the extra info by reversing the proper
                                  // blinding factor used to produce the script.
                                  const depositsExtraInfo = [
                                    {
                                      ...deposit.extraInfo,
                                      blindingFactor: `0x${Buffer.from(
                                        deposit.extraInfo.blindingFactor.substring(
                                          2
                                        ),
                                        "hex"
                                      )
                                        .reverse()
                                        .toString("hex")}`,
                                    },
                                  ]

                                  await expect(
                                    walletProposalValidator.validateDepositSweepProposal(
                                      proposal,
                                      depositsExtraInfo
                                    )
                                  ).to.be.revertedWith(
                                    "Extra info funding output script does not match"
                                  )
                                })
                              }
                            )

                            context(
                              "when 32-byte funding output hash does not match",
                              () => {
                                let deposit

                                before(async () => {
                                  await createSnapshot()

                                  deposit = createTestDeposit(
                                    walletPubKeyHash,
                                    vault,
                                    true // Produce a witness deposit with 32-byte script
                                  )

                                  bridge.deposits
                                    .whenCalledWith(
                                      depositKey(
                                        deposit.key.fundingTxHash,
                                        deposit.key.fundingOutputIndex
                                      )
                                    )
                                    .returns(deposit.request)
                                })

                                after(async () => {
                                  bridge.deposits.reset()

                                  await restoreSnapshot()
                                })

                                it("should revert", async () => {
                                  const proposal = {
                                    walletPubKeyHash,
                                    depositsKeys: [deposit.key],
                                    sweepTxFee,
                                    depositsRevealBlocks: [], // Not relevant in this scenario.
                                  }

                                  // Corrupt the extra info by reversing the proper
                                  // blinding factor used to produce the script.
                                  const depositsExtraInfo = [
                                    {
                                      ...deposit.extraInfo,
                                      blindingFactor: `0x${Buffer.from(
                                        deposit.extraInfo.blindingFactor.substring(
                                          2
                                        ),
                                        "hex"
                                      )
                                        .reverse()
                                        .toString("hex")}`,
                                    },
                                  ]

                                  await expect(
                                    walletProposalValidator.validateDepositSweepProposal(
                                      proposal,
                                      depositsExtraInfo
                                    )
                                  ).to.be.revertedWith(
                                    "Extra info funding output script does not match"
                                  )
                                })
                              }
                            )
                          }
                        )

                        context(
                          "when all deposits extra info are valid",
                          () => {
                            context(
                              "when there is a deposit that violates the refund safety margin",
                              () => {
                                let depositOne
                                let depositTwo

                                before(async () => {
                                  await createSnapshot()

                                  // Deposit one is a proper one.
                                  depositOne = createTestDeposit(
                                    walletPubKeyHash,
                                    vault,
                                    true
                                  )

                                  // Simulate that deposit two violates the refund.
                                  // In order to do so, we need to use `createTestDeposit`
                                  // with a custom reveal time that will produce
                                  // a refund locktime being closer to the current
                                  // moment than allowed by the refund safety margin.
                                  const safetyMarginViolatedAt =
                                    await lastBlockTime()
                                  const depositRefundableAt =
                                    safetyMarginViolatedAt +
                                    (await walletProposalValidator.DEPOSIT_REFUND_SAFETY_MARGIN())
                                  const depositRevealedAt =
                                    depositRefundableAt - depositLocktime

                                  depositTwo = createTestDeposit(
                                    walletPubKeyHash,
                                    vault,
                                    false,
                                    depositRevealedAt
                                  )

                                  bridge.deposits
                                    .whenCalledWith(
                                      depositKey(
                                        depositOne.key.fundingTxHash,
                                        depositOne.key.fundingOutputIndex
                                      )
                                    )
                                    .returns(depositOne.request)

                                  bridge.deposits
                                    .whenCalledWith(
                                      depositKey(
                                        depositTwo.key.fundingTxHash,
                                        depositTwo.key.fundingOutputIndex
                                      )
                                    )
                                    .returns(depositTwo.request)
                                })

                                after(async () => {
                                  bridge.deposits.reset()

                                  await restoreSnapshot()
                                })

                                it("should revert", async () => {
                                  const proposal = {
                                    walletPubKeyHash,
                                    depositsKeys: [
                                      depositOne.key,
                                      depositTwo.key,
                                    ],
                                    sweepTxFee,
                                    depositsRevealBlocks: [], // Not relevant in this scenario.
                                  }

                                  const depositsExtraInfo = [
                                    depositOne.extraInfo,
                                    depositTwo.extraInfo,
                                  ]

                                  await expect(
                                    walletProposalValidator.validateDepositSweepProposal(
                                      proposal,
                                      depositsExtraInfo
                                    )
                                  ).to.be.revertedWith(
                                    "Deposit refund safety margin is not preserved"
                                  )
                                })
                              }
                            )

                            context(
                              "when all deposits preserve the refund safety margin",
                              () => {
                                context(
                                  "when there is a deposit controlled by a different wallet",
                                  () => {
                                    let depositOne
                                    let depositTwo

                                    before(async () => {
                                      await createSnapshot()

                                      depositOne = createTestDeposit(
                                        walletPubKeyHash,
                                        vault,
                                        true
                                      )

                                      // Deposit two uses a different wallet than deposit
                                      // one.
                                      depositTwo = createTestDeposit(
                                        `0x${Buffer.from(
                                          walletPubKeyHash.substring(2),
                                          "hex"
                                        )
                                          .reverse()
                                          .toString("hex")}`,
                                        vault,
                                        false
                                      )

                                      bridge.deposits
                                        .whenCalledWith(
                                          depositKey(
                                            depositOne.key.fundingTxHash,
                                            depositOne.key.fundingOutputIndex
                                          )
                                        )
                                        .returns(depositOne.request)

                                      bridge.deposits
                                        .whenCalledWith(
                                          depositKey(
                                            depositTwo.key.fundingTxHash,
                                            depositTwo.key.fundingOutputIndex
                                          )
                                        )
                                        .returns(depositTwo.request)
                                    })

                                    after(async () => {
                                      bridge.deposits.reset()

                                      await restoreSnapshot()
                                    })

                                    it("should revert", async () => {
                                      const proposal = {
                                        walletPubKeyHash,
                                        depositsKeys: [
                                          depositOne.key,
                                          depositTwo.key,
                                        ],
                                        sweepTxFee,
                                        depositsRevealBlocks: [], // Not relevant in this scenario.
                                      }

                                      const depositsExtraInfo = [
                                        depositOne.extraInfo,
                                        depositTwo.extraInfo,
                                      ]

                                      await expect(
                                        walletProposalValidator.validateDepositSweepProposal(
                                          proposal,
                                          depositsExtraInfo
                                        )
                                      ).to.be.revertedWith(
                                        "Deposit controlled by different wallet"
                                      )
                                    })
                                  }
                                )

                                context(
                                  "when all deposits are controlled by the same wallet",
                                  () => {
                                    context(
                                      "when there is a deposit targeting a different vault",
                                      () => {
                                        let depositOne
                                        let depositTwo

                                        before(async () => {
                                          await createSnapshot()

                                          depositOne = createTestDeposit(
                                            walletPubKeyHash,
                                            vault,
                                            true
                                          )

                                          // Deposit two uses a different vault than deposit
                                          // one.
                                          depositTwo = createTestDeposit(
                                            walletPubKeyHash,
                                            `0x${Buffer.from(
                                              vault.substring(2),
                                              "hex"
                                            )
                                              .reverse()
                                              .toString("hex")}`,
                                            false
                                          )

                                          bridge.deposits
                                            .whenCalledWith(
                                              depositKey(
                                                depositOne.key.fundingTxHash,
                                                depositOne.key
                                                  .fundingOutputIndex
                                              )
                                            )
                                            .returns(depositOne.request)

                                          bridge.deposits
                                            .whenCalledWith(
                                              depositKey(
                                                depositTwo.key.fundingTxHash,
                                                depositTwo.key
                                                  .fundingOutputIndex
                                              )
                                            )
                                            .returns(depositTwo.request)
                                        })

                                        after(async () => {
                                          bridge.deposits.reset()

                                          await restoreSnapshot()
                                        })

                                        it("should revert", async () => {
                                          const proposal = {
                                            walletPubKeyHash,
                                            depositsKeys: [
                                              depositOne.key,
                                              depositTwo.key,
                                            ],
                                            sweepTxFee,
                                            depositsRevealBlocks: [], // Not relevant in this scenario.
                                          }

                                          const depositsExtraInfo = [
                                            depositOne.extraInfo,
                                            depositTwo.extraInfo,
                                          ]

                                          await expect(
                                            walletProposalValidator.validateDepositSweepProposal(
                                              proposal,
                                              depositsExtraInfo
                                            )
                                          ).to.be.revertedWith(
                                            "Deposit targets different vault"
                                          )
                                        })
                                      }
                                    )

                                    context(
                                      "when all deposits targets the same vault",
                                      () => {
                                        context(
                                          "when there are duplicated deposits",
                                          () => {
                                            let depositOne
                                            let depositTwo
                                            let depositThree

                                            before(async () => {
                                              await createSnapshot()

                                              depositOne = createTestDeposit(
                                                walletPubKeyHash,
                                                vault,
                                                true
                                              )

                                              depositTwo = createTestDeposit(
                                                walletPubKeyHash,
                                                vault,
                                                false
                                              )

                                              depositThree = createTestDeposit(
                                                walletPubKeyHash,
                                                vault,
                                                false
                                              )

                                              bridge.deposits
                                                .whenCalledWith(
                                                  depositKey(
                                                    depositOne.key
                                                      .fundingTxHash,
                                                    depositOne.key
                                                      .fundingOutputIndex
                                                  )
                                                )
                                                .returns(depositOne.request)

                                              bridge.deposits
                                                .whenCalledWith(
                                                  depositKey(
                                                    depositTwo.key
                                                      .fundingTxHash,
                                                    depositTwo.key
                                                      .fundingOutputIndex
                                                  )
                                                )
                                                .returns(depositTwo.request)

                                              bridge.deposits
                                                .whenCalledWith(
                                                  depositKey(
                                                    depositThree.key
                                                      .fundingTxHash,
                                                    depositThree.key
                                                      .fundingOutputIndex
                                                  )
                                                )
                                                .returns(depositThree.request)
                                            })

                                            after(async () => {
                                              bridge.deposits.reset()

                                              await restoreSnapshot()
                                            })

                                            it("should revert", async () => {
                                              const proposal = {
                                                walletPubKeyHash,
                                                depositsKeys: [
                                                  depositOne.key,
                                                  depositTwo.key,
                                                  depositThree.key,
                                                  depositTwo.key, // duplicate
                                                ],
                                                sweepTxFee,
                                                depositsRevealBlocks: [], // Not relevant in this scenario.
                                              }

                                              const depositsExtraInfo = [
                                                depositOne.extraInfo,
                                                depositTwo.extraInfo,
                                                depositThree.extraInfo,
                                                depositTwo.extraInfo, // duplicate
                                              ]

                                              await expect(
                                                walletProposalValidator.validateDepositSweepProposal(
                                                  proposal,
                                                  depositsExtraInfo
                                                )
                                              ).to.be.revertedWith(
                                                "Duplicated deposit"
                                              )
                                            })
                                          }
                                        )

                                        context(
                                          "when all deposits are unique",
                                          () => {
                                            let depositOne
                                            let depositTwo
                                            let depositThree

                                            before(async () => {
                                              await createSnapshot()

                                              depositOne = createTestDeposit(
                                                walletPubKeyHash,
                                                vault,
                                                true
                                              )

                                              depositTwo = createTestDeposit(
                                                walletPubKeyHash,
                                                vault,
                                                false
                                              )

                                              // Use a deposit with embedded 32-byte extra data
                                              // to make sure validation handles them correctly.
                                              depositThree = createTestDeposit(
                                                walletPubKeyHash,
                                                vault,
                                                true,
                                                undefined,
                                                "0xa9b38ea6435c8941d6eda6a46b68e3e2117196995bd154ab55196396b03d9bda"
                                              )

                                              bridge.deposits
                                                .whenCalledWith(
                                                  depositKey(
                                                    depositOne.key
                                                      .fundingTxHash,
                                                    depositOne.key
                                                      .fundingOutputIndex
                                                  )
                                                )
                                                .returns(depositOne.request)

                                              bridge.deposits
                                                .whenCalledWith(
                                                  depositKey(
                                                    depositTwo.key
                                                      .fundingTxHash,
                                                    depositTwo.key
                                                      .fundingOutputIndex
                                                  )
                                                )
                                                .returns(depositTwo.request)

                                              bridge.deposits
                                                .whenCalledWith(
                                                  depositKey(
                                                    depositThree.key
                                                      .fundingTxHash,
                                                    depositThree.key
                                                      .fundingOutputIndex
                                                  )
                                                )
                                                .returns(depositThree.request)
                                            })

                                            after(async () => {
                                              bridge.deposits.reset()

                                              await restoreSnapshot()
                                            })

                                            it("should succeed", async () => {
                                              const proposal = {
                                                walletPubKeyHash,
                                                depositsKeys: [
                                                  depositOne.key,
                                                  depositTwo.key,
                                                  depositThree.key,
                                                ],
                                                sweepTxFee,
                                                depositsRevealBlocks: [], // Not relevant in this scenario.
                                              }

                                              const depositsExtraInfo = [
                                                depositOne.extraInfo,
                                                depositTwo.extraInfo,
                                                depositThree.extraInfo,
                                              ]

                                              const result =
                                                await walletProposalValidator.validateDepositSweepProposal(
                                                  proposal,
                                                  depositsExtraInfo
                                                )

                                              // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                                              expect(result).to.be.true
                                            })
                                          }
                                        )
                                      }
                                    )
                                  }
                                )
                              }
                            )
                          }
                        )
                      })
                    })
                  })
                })
              })
            })
          })
        })
      })
    })
  })

  describe("validateRedemptionProposal", () => {
    const walletPubKeyHash = "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726"
    const ecdsaWalletID =
      "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863"

    const bridgeRedemptionTxMaxTotalFee = 10000
    const bridgeRedemptionTimeout = 5 * 86400 // 5 days

    before(async () => {
      await createSnapshot()

      redemptionRequestDefaultAnchorTime = await lastBlockTime()

      bridge.redemptionParameters.returns([
        0,
        0,
        0,
        bridgeRedemptionTxMaxTotalFee,
        bridgeRedemptionTimeout,
        0,
        0,
      ])
    })

    after(async () => {
      bridge.redemptionParameters.reset()

      await restoreSnapshot()
    })

    context("when wallet is in incorrect state", () => {
      const testData = [
        {
          testName: "when wallet state is Unknown",
          walletState: walletState.Unknown,
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

            bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
              ecdsaWalletID,
              mainUtxoHash: HashZero,
              pendingRedemptionsValue: 0,
              createdAt: 0,
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: test.walletState,
              movingFundsTargetWalletsCommitmentHash: HashZero,
            })
          })

          after(async () => {
            bridge.wallets.reset()

            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              // Only walletPubKeyHash argument is relevant in this scenario.
              walletProposalValidator.validateRedemptionProposal({
                walletPubKeyHash,
                redeemersOutputScripts: [],
                redemptionTxFee: 0,
              })
            ).to.be.revertedWith("Wallet is not in Live or MovingFunds state")
          })
        })
      })
    })

    context("when wallet is in correct state", () => {
      const testData = [
        {
          testName: "when wallet state is Live",
          walletState: walletState.Live,
        },
        {
          testName: "when wallet state is MovingFunds",
          walletState: walletState.MovingFunds,
        },
      ]

      testData.forEach((test) => {
        context(test.testName, () => {
          before(async () => {
            await createSnapshot()

            bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
              ecdsaWalletID,
              mainUtxoHash: HashZero,
              pendingRedemptionsValue: 0,
              createdAt: 0,
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: test.walletState,
              movingFundsTargetWalletsCommitmentHash: HashZero,
            })
          })

          after(async () => {
            bridge.wallets.reset()

            await restoreSnapshot()
          })

          context("when redemption is below the min size", () => {
            it("should revert", async () => {
              await expect(
                walletProposalValidator.validateRedemptionProposal({
                  walletPubKeyHash,
                  redeemersOutputScripts: [], // Set size to 0.
                  redemptionTxFee: 0, // Not relevant in this scenario.
                })
              ).to.be.revertedWith("Redemption below the min size")
            })
          })

          context("when redemption is above the min size", () => {
            context("when redemption exceeds the max size", () => {
              it("should revert", async () => {
                const maxSize =
                  await walletProposalValidator.REDEMPTION_MAX_SIZE()

                // Pick more redemption requests than allowed.
                const redeemersOutputScripts = new Array(maxSize + 1).fill(
                  createTestRedemptionRequest(walletPubKeyHash).key
                    .redeemerOutputScript
                )

                await expect(
                  walletProposalValidator.validateRedemptionProposal({
                    walletPubKeyHash,
                    redeemersOutputScripts,
                    redemptionTxFee: 0, // Not relevant in this scenario.
                  })
                ).to.be.revertedWith("Redemption exceeds the max size")
              })
            })

            context("when redemption does not exceed the max size", () => {
              context("when proposed redemption tx fee is invalid", () => {
                context("when proposed redemption tx fee is zero", () => {
                  it("should revert", async () => {
                    await expect(
                      walletProposalValidator.validateRedemptionProposal({
                        walletPubKeyHash,
                        redeemersOutputScripts: [
                          createTestRedemptionRequest(walletPubKeyHash).key
                            .redeemerOutputScript,
                        ],
                        redemptionTxFee: 0,
                      })
                    ).to.be.revertedWith(
                      "Proposed transaction fee cannot be zero"
                    )
                  })
                })

                context(
                  "when proposed redemption tx fee is greater than the allowed total fee",
                  () => {
                    it("should revert", async () => {
                      await expect(
                        walletProposalValidator.validateRedemptionProposal({
                          walletPubKeyHash,
                          redeemersOutputScripts: [
                            createTestRedemptionRequest(walletPubKeyHash).key
                              .redeemerOutputScript,
                          ],
                          // Exceed the max per-request fee by one.
                          redemptionTxFee: bridgeRedemptionTxMaxTotalFee + 1,
                        })
                      ).to.be.revertedWith(
                        "Proposed transaction fee is too high"
                      )
                    })
                  }
                )

                // The context block covering the per-redemption fee checks is
                // declared at the end of the `validateRedemptionProposal` test suite
                // due to the actual order of checks performed by this function.
                // See: "when there is a request that incurs an unacceptable tx fee share"
              })

              context("when proposed redemption tx fee is valid", () => {
                const redemptionTxFee = 9000

                context("when there is a non-pending request", () => {
                  let requestOne
                  let requestTwo

                  before(async () => {
                    await createSnapshot()

                    requestOne = createTestRedemptionRequest(
                      walletPubKeyHash,
                      5000 // necessary to pass the fee share validation
                    )
                    requestTwo = createTestRedemptionRequest(walletPubKeyHash)

                    // Request one is a proper one.
                    bridge.pendingRedemptions
                      .whenCalledWith(
                        redemptionKey(
                          requestOne.key.walletPubKeyHash,
                          requestOne.key.redeemerOutputScript
                        )
                      )
                      .returns(requestOne.content)

                    // Simulate the request two is non-pending.
                    bridge.pendingRedemptions
                      .whenCalledWith(
                        redemptionKey(
                          requestTwo.key.walletPubKeyHash,
                          requestTwo.key.redeemerOutputScript
                        )
                      )
                      .returns({
                        ...requestTwo.content,
                        requestedAt: 0,
                      })
                  })

                  after(async () => {
                    bridge.pendingRedemptions.reset()

                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    const proposal = {
                      walletPubKeyHash,
                      redeemersOutputScripts: [
                        requestOne.key.redeemerOutputScript,
                        requestTwo.key.redeemerOutputScript,
                      ],
                      redemptionTxFee,
                    }

                    await expect(
                      walletProposalValidator.validateRedemptionProposal(
                        proposal
                      )
                    ).to.be.revertedWith("Not a pending redemption request")
                  })
                })

                context("when all requests are pending", () => {
                  context("when there is an immature request", () => {
                    context(
                      "when immaturity is caused by REDEMPTION_REQUEST_MIN_AGE violation",
                      () => {
                        let requestOne
                        let requestTwo

                        before(async () => {
                          await createSnapshot()

                          requestOne = createTestRedemptionRequest(
                            walletPubKeyHash,
                            5000 // necessary to pass the fee share validation
                          )
                          requestTwo =
                            createTestRedemptionRequest(walletPubKeyHash)

                          // Request one is a proper one.
                          bridge.pendingRedemptions
                            .whenCalledWith(
                              redemptionKey(
                                requestOne.key.walletPubKeyHash,
                                requestOne.key.redeemerOutputScript
                              )
                            )
                            .returns(requestOne.content)

                          // Simulate the request two has just been created thus not
                          // achieved the min age yet.
                          bridge.pendingRedemptions
                            .whenCalledWith(
                              redemptionKey(
                                requestTwo.key.walletPubKeyHash,
                                requestTwo.key.redeemerOutputScript
                              )
                            )
                            .returns({
                              ...requestTwo.content,
                              requestedAt: await lastBlockTime(),
                            })
                        })

                        after(async () => {
                          bridge.pendingRedemptions.reset()

                          await restoreSnapshot()
                        })

                        it("should revert", async () => {
                          const proposal = {
                            walletPubKeyHash,
                            redeemersOutputScripts: [
                              requestOne.key.redeemerOutputScript,
                              requestTwo.key.redeemerOutputScript,
                            ],
                            redemptionTxFee,
                          }

                          await expect(
                            walletProposalValidator.validateRedemptionProposal(
                              proposal
                            )
                          ).to.be.revertedWith(
                            "Redemption request min age not achieved yet"
                          )
                        })
                      }
                    )

                    context(
                      "when immaturity is caused by watchtower's delay violation",
                      () => {
                        let watchtower: FakeContract<IRedemptionWatchtower>
                        let requestOne
                        let requestTwo

                        before(async () => {
                          await createSnapshot()

                          requestOne = createTestRedemptionRequest(
                            walletPubKeyHash,
                            5000, // necessary to pass the fee share validation
                            await lastBlockTime()
                          )
                          requestTwo = createTestRedemptionRequest(
                            walletPubKeyHash,
                            5000, // necessary to pass the fee share validation
                            await lastBlockTime()
                          )

                          // Request one is a proper one.
                          bridge.pendingRedemptions
                            .whenCalledWith(
                              redemptionKey(
                                requestOne.key.walletPubKeyHash,
                                requestOne.key.redeemerOutputScript
                              )
                            )
                            .returns(requestOne.content)

                          // Simulate the request two has just been created thus not
                          // achieved the min age yet.
                          bridge.pendingRedemptions
                            .whenCalledWith(
                              redemptionKey(
                                requestTwo.key.walletPubKeyHash,
                                requestTwo.key.redeemerOutputScript
                              )
                            )
                            .returns(requestTwo.content)

                          watchtower = await smock.fake<IRedemptionWatchtower>(
                            "IRedemptionWatchtower"
                          )
                          bridge.getRedemptionWatchtower.returns(
                            watchtower.address
                          )

                          const redemptionOneDelay = 3600
                          watchtower.getRedemptionDelay
                            .whenCalledWith(
                              buildRedemptionKey(
                                requestOne.key.walletPubKeyHash,
                                requestOne.key.redeemerOutputScript
                              )
                            )
                            .returns(redemptionOneDelay)

                          const redemptionTwoDelay = 7200
                          watchtower.getRedemptionDelay
                            .whenCalledWith(
                              buildRedemptionKey(
                                requestTwo.key.walletPubKeyHash,
                                requestTwo.key.redeemerOutputScript
                              )
                            )
                            .returns(redemptionTwoDelay)

                          // Increase time to a point when delay for redemption
                          // one was elapsed but not for redemption two.
                          await increaseTime(redemptionTwoDelay)
                        })

                        after(async () => {
                          bridge.getRedemptionWatchtower.reset()
                          watchtower.getRedemptionDelay.reset()
                          bridge.pendingRedemptions.reset()

                          await restoreSnapshot()
                        })

                        it("should revert", async () => {
                          const proposal = {
                            walletPubKeyHash,
                            redeemersOutputScripts: [
                              requestOne.key.redeemerOutputScript,
                              requestTwo.key.redeemerOutputScript,
                            ],
                            redemptionTxFee,
                          }

                          await expect(
                            walletProposalValidator.validateRedemptionProposal(
                              proposal
                            )
                          ).to.be.revertedWith(
                            "Redemption request min age not achieved yet"
                          )
                        })
                      }
                    )
                  })

                  context("when all requests achieved the min age", () => {
                    context(
                      "when there is a request that violates the timeout safety margin",
                      () => {
                        let requestOne
                        let requestTwo

                        before(async () => {
                          await createSnapshot()

                          // Request one is a proper one.
                          requestOne = createTestRedemptionRequest(
                            walletPubKeyHash,
                            5000 // necessary to pass the fee share validation
                          )

                          // Simulate that request two violates the timeout safety margin.
                          // In order to do so, we need to use `createTestRedemptionRequest`
                          // with a custom request creation time that will produce
                          // a timeout timestamp being closer to the current
                          // moment than allowed by the refund safety margin.
                          const safetyMarginViolatedAt = await lastBlockTime()
                          const requestTimedOutAt =
                            safetyMarginViolatedAt +
                            (await walletProposalValidator.REDEMPTION_REQUEST_TIMEOUT_SAFETY_MARGIN())
                          const requestCreatedAt =
                            requestTimedOutAt - bridgeRedemptionTimeout

                          requestTwo = createTestRedemptionRequest(
                            walletPubKeyHash,
                            0,
                            requestCreatedAt
                          )

                          bridge.pendingRedemptions
                            .whenCalledWith(
                              redemptionKey(
                                requestOne.key.walletPubKeyHash,
                                requestOne.key.redeemerOutputScript
                              )
                            )
                            .returns(requestOne.content)

                          bridge.pendingRedemptions
                            .whenCalledWith(
                              redemptionKey(
                                requestTwo.key.walletPubKeyHash,
                                requestTwo.key.redeemerOutputScript
                              )
                            )
                            .returns(requestTwo.content)
                        })

                        after(async () => {
                          bridge.pendingRedemptions.reset()

                          await restoreSnapshot()
                        })

                        it("should revert", async () => {
                          const proposal = {
                            walletPubKeyHash,
                            redeemersOutputScripts: [
                              requestOne.key.redeemerOutputScript,
                              requestTwo.key.redeemerOutputScript,
                            ],
                            redemptionTxFee,
                          }

                          await expect(
                            walletProposalValidator.validateRedemptionProposal(
                              proposal
                            )
                          ).to.be.revertedWith(
                            "Redemption request timeout safety margin is not preserved"
                          )
                        })
                      }
                    )

                    context(
                      "when all requests preserve the timeout safety margin",
                      () => {
                        context(
                          "when there is a request that incurs an unacceptable tx fee share",
                          () => {
                            context("when there is no fee remainder", () => {
                              let requestOne
                              let requestTwo

                              before(async () => {
                                await createSnapshot()

                                // Request one is a proper one.
                                requestOne = createTestRedemptionRequest(
                                  walletPubKeyHash,
                                  4500 // necessary to pass the fee share validation
                                )

                                // Simulate that request two takes an unacceptable
                                // tx fee share. Because redemptionTxFee used
                                // in the proposal is 9000, the actual fee share
                                // per-request is 4500. In order to test this case
                                // the second request must allow for 4499 as allowed
                                // fee share at maximum.
                                requestTwo = createTestRedemptionRequest(
                                  walletPubKeyHash,
                                  4499
                                )

                                bridge.pendingRedemptions
                                  .whenCalledWith(
                                    redemptionKey(
                                      requestOne.key.walletPubKeyHash,
                                      requestOne.key.redeemerOutputScript
                                    )
                                  )
                                  .returns(requestOne.content)

                                bridge.pendingRedemptions
                                  .whenCalledWith(
                                    redemptionKey(
                                      requestTwo.key.walletPubKeyHash,
                                      requestTwo.key.redeemerOutputScript
                                    )
                                  )
                                  .returns(requestTwo.content)
                              })

                              after(async () => {
                                bridge.pendingRedemptions.reset()

                                await restoreSnapshot()
                              })

                              it("should revert", async () => {
                                const proposal = {
                                  walletPubKeyHash,
                                  redeemersOutputScripts: [
                                    requestOne.key.redeemerOutputScript,
                                    requestTwo.key.redeemerOutputScript,
                                  ],
                                  redemptionTxFee,
                                }

                                await expect(
                                  walletProposalValidator.validateRedemptionProposal(
                                    proposal
                                  )
                                ).to.be.revertedWith(
                                  "Proposed transaction per-request fee share is too high"
                                )
                              })
                            })

                            context("when there is a fee remainder", () => {
                              let requestOne
                              let requestTwo

                              before(async () => {
                                await createSnapshot()

                                // Request one is a proper one.
                                requestOne = createTestRedemptionRequest(
                                  walletPubKeyHash,
                                  4500 // necessary to pass the fee share validation
                                )

                                // Simulate that request two takes an unacceptable
                                // tx fee share. Because redemptionTxFee used
                                // in the proposal is 9001, the actual fee share
                                // per-request is 4500 and 4501 for the last request
                                // which takes the remainder. In order to test this
                                // case the second (last) request must allow for
                                // 4500 as allowed fee share at maximum.
                                requestTwo = createTestRedemptionRequest(
                                  walletPubKeyHash,
                                  4500
                                )

                                bridge.pendingRedemptions
                                  .whenCalledWith(
                                    redemptionKey(
                                      requestOne.key.walletPubKeyHash,
                                      requestOne.key.redeemerOutputScript
                                    )
                                  )
                                  .returns(requestOne.content)

                                bridge.pendingRedemptions
                                  .whenCalledWith(
                                    redemptionKey(
                                      requestTwo.key.walletPubKeyHash,
                                      requestTwo.key.redeemerOutputScript
                                    )
                                  )
                                  .returns(requestTwo.content)
                              })

                              after(async () => {
                                bridge.pendingRedemptions.reset()

                                await restoreSnapshot()
                              })

                              it("should revert", async () => {
                                const proposal = {
                                  walletPubKeyHash,
                                  redeemersOutputScripts: [
                                    requestOne.key.redeemerOutputScript,
                                    requestTwo.key.redeemerOutputScript,
                                  ],
                                  redemptionTxFee: 9001,
                                }

                                await expect(
                                  walletProposalValidator.validateRedemptionProposal(
                                    proposal
                                  )
                                ).to.be.revertedWith(
                                  "Proposed transaction per-request fee share is too high"
                                )
                              })
                            })
                          }
                        )

                        context(
                          "when all requests incur an acceptable tx fee share",
                          () => {
                            context(
                              "when there are duplicated requests",
                              () => {
                                let requestOne
                                let requestTwo
                                let requestThree

                                before(async () => {
                                  await createSnapshot()

                                  requestOne = createTestRedemptionRequest(
                                    walletPubKeyHash,
                                    2500 // necessary to pass the fee share validation
                                  )

                                  requestTwo = createTestRedemptionRequest(
                                    walletPubKeyHash,
                                    2500 // necessary to pass the fee share validation
                                  )

                                  requestThree = createTestRedemptionRequest(
                                    walletPubKeyHash,
                                    2500 // necessary to pass the fee share validation
                                  )

                                  bridge.pendingRedemptions
                                    .whenCalledWith(
                                      redemptionKey(
                                        requestOne.key.walletPubKeyHash,
                                        requestOne.key.redeemerOutputScript
                                      )
                                    )
                                    .returns(requestOne.content)

                                  bridge.pendingRedemptions
                                    .whenCalledWith(
                                      redemptionKey(
                                        requestTwo.key.walletPubKeyHash,
                                        requestTwo.key.redeemerOutputScript
                                      )
                                    )
                                    .returns(requestTwo.content)

                                  bridge.pendingRedemptions
                                    .whenCalledWith(
                                      redemptionKey(
                                        requestThree.key.walletPubKeyHash,
                                        requestThree.key.redeemerOutputScript
                                      )
                                    )
                                    .returns(requestThree.content)
                                })

                                after(async () => {
                                  bridge.pendingRedemptions.reset()

                                  await restoreSnapshot()
                                })

                                it("should revert", async () => {
                                  const proposal = {
                                    walletPubKeyHash,
                                    redeemersOutputScripts: [
                                      requestOne.key.redeemerOutputScript,
                                      requestTwo.key.redeemerOutputScript,
                                      requestThree.key.redeemerOutputScript,
                                      requestTwo.key.redeemerOutputScript, // duplicate
                                    ],
                                    redemptionTxFee,
                                  }

                                  await expect(
                                    walletProposalValidator.validateRedemptionProposal(
                                      proposal
                                    )
                                  ).to.be.revertedWith("Duplicated request")
                                })
                              }
                            )

                            context("when all requests are unique", () => {
                              const requestTestData: {
                                testName: string
                                watchtower: boolean
                              }[] = [
                                {
                                  testName: "when watchtower is not set",
                                  watchtower: false,
                                },
                                {
                                  testName: "when watchtower is set",
                                  watchtower: true,
                                },
                              ]

                              requestTestData.forEach((requestTest) => {
                                context(requestTest.testName, () => {
                                  let watchtower: FakeContract<IRedemptionWatchtower>
                                  let requestOne
                                  let requestTwo

                                  before(async () => {
                                    await createSnapshot()

                                    requestOne = createTestRedemptionRequest(
                                      walletPubKeyHash,
                                      5000 // necessary to pass the fee share validation
                                    )

                                    requestTwo = createTestRedemptionRequest(
                                      walletPubKeyHash,
                                      5000 // necessary to pass the fee share validation
                                    )

                                    bridge.pendingRedemptions
                                      .whenCalledWith(
                                        redemptionKey(
                                          requestOne.key.walletPubKeyHash,
                                          requestOne.key.redeemerOutputScript
                                        )
                                      )
                                      .returns(requestOne.content)

                                    bridge.pendingRedemptions
                                      .whenCalledWith(
                                        redemptionKey(
                                          requestTwo.key.walletPubKeyHash,
                                          requestTwo.key.redeemerOutputScript
                                        )
                                      )
                                      .returns(requestTwo.content)

                                    if (requestTest.watchtower) {
                                      watchtower =
                                        await smock.fake<IRedemptionWatchtower>(
                                          "IRedemptionWatchtower"
                                        )

                                      bridge.getRedemptionWatchtower.returns(
                                        watchtower.address
                                      )

                                      // All requests created by createTestRedemptionRequest
                                      // are requested at `now - 1 day` by default.
                                      // To test the watchtower delay path, we need
                                      // to use a delay that is greater than
                                      // `REDEMPTION_REQUEST_MIN_AGE` (10 min) and
                                      // ensure that the delay is preserved
                                      // at the moment of the proposal validation.
                                      // A value of 2 hours will be a good fit.
                                      watchtower.getRedemptionDelay.returns(
                                        7200 // 2 hours
                                      )
                                    }
                                  })

                                  after(async () => {
                                    if (requestTest.watchtower) {
                                      bridge.getRedemptionWatchtower.reset()
                                      watchtower.getRedemptionDelay.reset()
                                    }

                                    bridge.pendingRedemptions.reset()

                                    await restoreSnapshot()
                                  })

                                  it("should succeed", async () => {
                                    const proposal = {
                                      walletPubKeyHash,
                                      redeemersOutputScripts: [
                                        requestOne.key.redeemerOutputScript,
                                        requestTwo.key.redeemerOutputScript,
                                      ],
                                      redemptionTxFee,
                                    }

                                    const result =
                                      await walletProposalValidator.validateRedemptionProposal(
                                        proposal
                                      )

                                    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                                    expect(result).to.be.true
                                  })
                                })
                              })
                            })
                          }
                        )
                      }
                    )
                  })
                })
              })
            })
          })
        })
      })
    })
  })

  describe("validateMovingFundsProposal", () => {
    const movingFundsTxMaxTotalFee = 20000
    const movingFundsDustThreshold = 5000
    const walletPubKeyHash = "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726"
    const targetWallets = [
      "0x84a70187011e156686788e0a2bc50944a4721e83",
      "0xf64a45c07e3778b8ce58cb0058477c821c543aad",
      "0xcaea95433d9bfa80bb8dc8819a48e2a9aa96147c",
    ]
    // Hash calculated from the above target wallets.
    const targetWalletsHash =
      "0x16311d424d513a1743fbc9c0e4fea5b70eddefd15f54613503e5cdfab24f8877"
    const walletMainUtxo = {
      txHash:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      txOutputIndex: 0,
      txOutputValue: movingFundsDustThreshold,
    }
    // Hash calculated from the above main UTXO.
    const walletMainUtxoHash =
      "0x4cfb92c890e30ff736656e519167cbfcacb408c730fd21bec415359b45769d20"

    before(async () => {
      await createSnapshot()

      bridge.movingFundsParameters.returns([
        movingFundsTxMaxTotalFee,
        movingFundsDustThreshold,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ])
    })

    after(async () => {
      bridge.movingFundsParameters.reset()

      await restoreSnapshot()
    })

    context("when wallet's state is not MovingFunds", () => {
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

            bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
              ecdsaWalletID: HashZero,
              mainUtxoHash: HashZero,
              pendingRedemptionsValue: 0,
              createdAt: 0,
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: test.walletState,
              movingFundsTargetWalletsCommitmentHash: HashZero,
            })
          })

          after(async () => {
            bridge.wallets.reset()

            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              walletProposalValidator.validateMovingFundsProposal(
                {
                  walletPubKeyHash,
                  movingFundsTxFee: 0,
                  targetWallets: [],
                },
                NO_MAIN_UTXO
              )
            ).to.be.revertedWith("Source wallet is not in MovingFunds state")
          })
        })
      })
    })

    context("when wallet's state is MovingFunds", () => {
      context("when moving funds commitment has not been submitted", () => {
        before(async () => {
          await createSnapshot()

          bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
            ecdsaWalletID: HashZero,
            mainUtxoHash: HashZero,
            pendingRedemptionsValue: 0,
            createdAt: 0,
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            pendingMovedFundsSweepRequestsCount: 0,
            state: walletState.MovingFunds,
            // Indicate the commitment has not been submitted.
            movingFundsTargetWalletsCommitmentHash: HashZero,
          })
        })

        after(async () => {
          bridge.wallets.reset()

          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            walletProposalValidator.validateMovingFundsProposal(
              {
                walletPubKeyHash,
                movingFundsTxFee: 0,
                targetWallets: [],
              },
              NO_MAIN_UTXO
            )
          ).to.be.revertedWith("Target wallets commitment is not submitted")
        })
      })

      context("when moving funds commitment has been submitted", () => {
        context("when commitment hash does not match target wallets", () => {
          before(async () => {
            await createSnapshot()

            bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
              ecdsaWalletID: HashZero,
              mainUtxoHash: HashZero,
              pendingRedemptionsValue: 0,
              createdAt: 0,
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: walletState.MovingFunds,
              // Set a hash that does not match the target wallets.
              movingFundsTargetWalletsCommitmentHash:
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            })
          })

          after(async () => {
            bridge.wallets.reset()

            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              walletProposalValidator.validateMovingFundsProposal(
                {
                  walletPubKeyHash,
                  movingFundsTxFee: 0,
                  targetWallets,
                },
                NO_MAIN_UTXO
              )
            ).to.be.revertedWith(
              "Target wallets do not match target wallets commitment hash"
            )
          })
        })

        context("when commitment hash matches target wallets", () => {
          context("when no main UTXO is passed", () => {
            before(async () => {
              await createSnapshot()

              bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
                ecdsaWalletID: HashZero,
                // Use zero hash so that the wallet's main UTXO is considered
                // not set. This will be interpreted as the wallet having BTC
                // balance of zero.
                mainUtxoHash: HashZero,
                pendingRedemptionsValue: 0,
                createdAt: 0,
                movingFundsRequestedAt: 0,
                closingStartedAt: 0,
                pendingMovedFundsSweepRequestsCount: 0,
                state: walletState.MovingFunds,
                movingFundsTargetWalletsCommitmentHash: targetWalletsHash,
              })
            })

            after(async () => {
              bridge.wallets.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                walletProposalValidator.validateMovingFundsProposal(
                  {
                    walletPubKeyHash,
                    movingFundsTxFee: 0,
                    targetWallets,
                  },
                  NO_MAIN_UTXO
                )
              ).to.be.revertedWith(
                "Source wallet BTC balance is below the moving funds dust threshold"
              )
            })
          })

          context("when the passed main UTXO is incorrect", () => {
            before(async () => {
              await createSnapshot()

              bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
                ecdsaWalletID: HashZero,
                mainUtxoHash:
                  // Use any non-zero hash to indicate the wallet has a main UTXO.
                  "0x1111111111111111111111111111111111111111111111111111111111111111",
                pendingRedemptionsValue: 0,
                createdAt: 0,
                movingFundsRequestedAt: 0,
                closingStartedAt: 0,
                pendingMovedFundsSweepRequestsCount: 0,
                state: walletState.MovingFunds,
                movingFundsTargetWalletsCommitmentHash: targetWalletsHash,
              })
            })

            after(async () => {
              bridge.wallets.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                walletProposalValidator.validateMovingFundsProposal(
                  {
                    walletPubKeyHash,
                    movingFundsTxFee: 0,
                    targetWallets,
                  },
                  {
                    txHash:
                      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    txOutputIndex: 0,
                    txOutputValue: 1000,
                  }
                )
              ).to.be.revertedWith("Invalid wallet main UTXO data")
            })
          })

          context("when the passed main UTXO is correct", () => {
            context(
              "when source wallet BTC balance is below dust threshold",
              () => {
                before(async () => {
                  await createSnapshot()

                  bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
                    ecdsaWalletID: HashZero,
                    mainUtxoHash:
                      "0x757a5ca2a1e5fff2f2a51c073cb88c097603285fcfa52cb58473704647fa7edb",
                    pendingRedemptionsValue: 0,
                    createdAt: 0,
                    movingFundsRequestedAt: 0,
                    closingStartedAt: 0,
                    pendingMovedFundsSweepRequestsCount: 0,
                    state: walletState.MovingFunds,
                    movingFundsTargetWalletsCommitmentHash: targetWalletsHash,
                  })
                })

                after(async () => {
                  bridge.wallets.reset()

                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  await expect(
                    walletProposalValidator.validateMovingFundsProposal(
                      {
                        walletPubKeyHash,
                        movingFundsTxFee: 0,
                        targetWallets,
                      },
                      {
                        txHash:
                          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        txOutputIndex: 0,
                        txOutputValue: movingFundsDustThreshold - 1,
                      }
                    )
                  ).to.be.revertedWith(
                    "Source wallet BTC balance is below the moving funds dust threshold"
                  )
                })
              }
            )

            context(
              "when source wallet BTC balance is equal to or greater that dust threshold",
              () => {
                before(async () => {
                  await createSnapshot()
                  bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
                    ecdsaWalletID: HashZero,
                    mainUtxoHash: walletMainUtxoHash,
                    pendingRedemptionsValue: 0,
                    createdAt: 0,
                    movingFundsRequestedAt: 0,
                    closingStartedAt: 0,
                    pendingMovedFundsSweepRequestsCount: 0,
                    state: walletState.MovingFunds,
                    movingFundsTargetWalletsCommitmentHash: targetWalletsHash,
                  })
                })

                after(async () => {
                  bridge.wallets.reset()

                  await restoreSnapshot()
                })

                context("when transaction fee is zero", () => {
                  it("should revert", async () => {
                    await expect(
                      walletProposalValidator.validateMovingFundsProposal(
                        {
                          walletPubKeyHash,
                          movingFundsTxFee: 0,
                          targetWallets,
                        },
                        walletMainUtxo
                      )
                    ).to.be.revertedWith(
                      "Proposed transaction fee cannot be zero"
                    )
                  })
                })

                context("when transaction fee is too high", () => {
                  it("should revert", async () => {
                    await expect(
                      walletProposalValidator.validateMovingFundsProposal(
                        {
                          walletPubKeyHash,
                          movingFundsTxFee: movingFundsTxMaxTotalFee + 1,
                          targetWallets,
                        },
                        walletMainUtxo
                      )
                    ).to.be.revertedWith("Proposed transaction fee is too high")
                  })
                })

                context("when transaction fee is valid", () => {
                  it("should pass validation", async () => {
                    const result =
                      await walletProposalValidator.validateMovingFundsProposal(
                        {
                          walletPubKeyHash,
                          movingFundsTxFee: movingFundsTxMaxTotalFee,
                          targetWallets,
                        },
                        walletMainUtxo
                      )
                    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                    expect(result).to.be.true
                  })
                })
              }
            )
          })
        })
      })
    })
  })

  describe("validateMovedFundsSweepProposal", () => {
    const movedFundsSweepTxMaxTotalFee = 20000
    const walletPubKeyHash = "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726"

    // Hash and index representing a pending moved funds sweep request.
    const movingFundsTxHash =
      "0xfedaee64895aebdd94d21d932960f96fcdb95d17ca64b25aee0450631a1291a9"
    const movingFundsTxOutputIndex = 0

    before(async () => {
      await createSnapshot()

      bridge.movingFundsParameters.returns([
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        movedFundsSweepTxMaxTotalFee,
        0,
        0,
        0,
      ])
    })

    after(async () => {
      bridge.movingFundsParameters.reset()

      await restoreSnapshot()
    })

    context("when wallet's state is incorrect", () => {
      const testData = [
        {
          testName: "when wallet state is Unknown",
          walletState: walletState.Unknown,
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

            bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
              ecdsaWalletID: HashZero,
              mainUtxoHash: HashZero,
              pendingRedemptionsValue: 0,
              createdAt: 0,
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: test.walletState,
              movingFundsTargetWalletsCommitmentHash: HashZero,
            })
          })

          after(async () => {
            bridge.wallets.reset()

            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              walletProposalValidator.validateMovedFundsSweepProposal({
                walletPubKeyHash,
                movingFundsTxHash,
                movingFundsTxOutputIndex,
                movedFundsSweepTxFee: 0,
              })
            ).to.be.revertedWith(
              "Source wallet is not in Live or MovingFunds state"
            )
          })
        })
      })
    })

    context("when wallet's state is correct", () => {
      const testData = [
        {
          testName: "when wallet state is Live",
          walletState: walletState.Live,
        },
        {
          testName: "when wallet state is MovingFunds",
          walletState: walletState.MovingFunds,
        },
      ]

      testData.forEach((test) => {
        context(test.testName, () => {
          before(async () => {
            await createSnapshot()

            bridge.wallets.whenCalledWith(walletPubKeyHash).returns({
              ecdsaWalletID: HashZero,
              mainUtxoHash: HashZero,
              pendingRedemptionsValue: 0,
              createdAt: 0,
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: test.walletState,
              movingFundsTargetWalletsCommitmentHash: HashZero,
            })
          })

          after(async () => {
            bridge.wallets.reset()

            await restoreSnapshot()
          })

          context(
            "when moved funds sweep request's state is not Pending",
            () => {
              it("should revert", async () => {
                // Use hash and index without setting a sweep request in the Bridge.
                await expect(
                  walletProposalValidator.validateMovedFundsSweepProposal({
                    walletPubKeyHash,
                    movingFundsTxHash,
                    movingFundsTxOutputIndex,
                    movedFundsSweepTxFee: 0,
                  })
                ).to.be.revertedWith("Sweep request is not in Pending state")
              })
            }
          )

          context("when moved funds sweep request's state is Pending", () => {
            context(
              "when moved funds sweep request does not belong to the wallet",
              () => {
                before(async () => {
                  await createSnapshot()

                  const requestKey = movedFundsSweepRequestKey(
                    movingFundsTxHash,
                    movingFundsTxOutputIndex
                  )

                  bridge.movedFundsSweepRequests
                    .whenCalledWith(requestKey)
                    .returns({
                      // Use random wallet public key hash.
                      walletPubKeyHash:
                        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                      value: 0,
                      createdAt: 0,
                      state: movedFundsSweepRequestState.Pending,
                    })
                })

                after(async () => {
                  bridge.movedFundsSweepRequests.reset()

                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  await expect(
                    walletProposalValidator.validateMovedFundsSweepProposal({
                      walletPubKeyHash,
                      movingFundsTxHash,
                      movingFundsTxOutputIndex,
                      movedFundsSweepTxFee: 0,
                    })
                  ).to.be.revertedWith(
                    "Sweep request does not belong to the wallet"
                  )
                })
              }
            )

            context(
              "when moved funds sweep request belongs to the wallet",
              () => {
                before(async () => {
                  await createSnapshot()

                  const requestKey = movedFundsSweepRequestKey(
                    movingFundsTxHash,
                    movingFundsTxOutputIndex
                  )

                  bridge.movedFundsSweepRequests
                    .whenCalledWith(requestKey)
                    .returns({
                      walletPubKeyHash,
                      value: 0,
                      createdAt: 0,
                      state: movedFundsSweepRequestState.Pending,
                    })
                })

                after(async () => {
                  bridge.movedFundsSweepRequests.reset()

                  await restoreSnapshot()
                })

                context("when transaction fee is zero", () => {
                  it("should revert", async () => {
                    await expect(
                      walletProposalValidator.validateMovedFundsSweepProposal({
                        walletPubKeyHash,
                        movingFundsTxHash,
                        movingFundsTxOutputIndex,
                        movedFundsSweepTxFee: 0,
                      })
                    ).to.be.revertedWith(
                      "Proposed transaction fee cannot be zero"
                    )
                  })
                })

                context("when transaction fee is too high", () => {
                  it("should revert", async () => {
                    await expect(
                      walletProposalValidator.validateMovedFundsSweepProposal({
                        walletPubKeyHash,
                        movingFundsTxHash,
                        movingFundsTxOutputIndex,
                        movedFundsSweepTxFee: movedFundsSweepTxMaxTotalFee + 1,
                      })
                    ).to.be.revertedWith("Proposed transaction fee is too high")
                  })
                })

                context("when transaction fee is valid", () => {
                  it("should pass validation", async () => {
                    const result =
                      await walletProposalValidator.validateMovedFundsSweepProposal(
                        {
                          walletPubKeyHash,
                          movingFundsTxHash,
                          movingFundsTxOutputIndex,
                          movedFundsSweepTxFee: movedFundsSweepTxMaxTotalFee,
                        }
                      )
                    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                    expect(result).to.be.true
                  })
                })
              }
            )
          })
        })
      })
    })
  })

  describe("validateHeartbeatProposal", () => {
    context("when message is not valid", () => {
      it("should revert", async () => {
        await expect(
          walletProposalValidator.validateHeartbeatProposal({
            walletPubKeyHash: AddressZero,
            message: "0xfffffffffffffff21111111111111111",
          })
        ).to.be.revertedWith("Not a valid heartbeat message")
      })
    })

    context("when message is valid", () => {
      it("should succeed", async () => {
        const result = await walletProposalValidator.validateHeartbeatProposal({
          walletPubKeyHash: AddressZero,
          message: "0xffffffffffffffff1111111111111111",
        })

        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(result).to.be.true
      })
    })
  })
})

const depositKey = (
  fundingTxHash: BytesLike,
  fundingOutputIndex: BigNumberish
) =>
  ethers.utils.solidityKeccak256(
    ["bytes32", "uint32"],
    [fundingTxHash, fundingOutputIndex]
  )

const createTestDeposit = (
  walletPubKeyHash: string,
  vault: string,
  witness = true,
  revealedAt?: number,
  extraData?: string
) => {
  let resolvedRevealedAt = revealedAt

  if (!resolvedRevealedAt) {
    // If the deposit reveal time is not explicitly set, use `now - 1 day` to
    // ensure deposit minimum age is achieved by default.
    const now = Math.floor(Date.now() / 1000)
    resolvedRevealedAt = now - day
  }

  const refundableAt = resolvedRevealedAt + depositLocktime

  const refundLocktime = `0x${Buffer.from(
    BigNumber.from(refundableAt).toHexString().substring(2),
    "hex"
  )
    .reverse()
    .toString("hex")}`

  if (refundLocktime.substring(2).length !== 8) {
    throw new Error("wrong refund locktime byte length")
  }

  // The depositor, blindingFactor, refundPubKeyHash are not relevant
  // in this test suite so can be random.
  const depositor = `0x${crypto.randomBytes(20).toString("hex")}`
  const blindingFactor = `0x${crypto.randomBytes(8).toString("hex")}`
  const refundPubKeyHash = `0x${crypto.randomBytes(20).toString("hex")}`

  let depositScript

  if (extraData) {
    depositScript =
      `0x14${depositor.substring(2)}75` +
      `20${extraData.substring(2)}75` +
      `08${blindingFactor.substring(2)}75` +
      `76a914${walletPubKeyHash.substring(2)}87` +
      "63ac67" +
      `76a914${refundPubKeyHash.substring(2)}88` +
      `04${refundLocktime.substring(2)}b175` +
      "ac68"
  } else {
    depositScript =
      `0x14${depositor.substring(2)}75` +
      `08${blindingFactor.substring(2)}75` +
      `76a914${walletPubKeyHash.substring(2)}87` +
      "63ac67" +
      `76a914${refundPubKeyHash.substring(2)}88` +
      `04${refundLocktime.substring(2)}b175` +
      "ac68"
  }

  let depositScriptHash
  if (witness) {
    depositScriptHash = `220020${ethers.utils
      .sha256(depositScript)
      .substring(2)}`
  } else {
    const sha256Hash = ethers.utils.sha256(depositScript)
    const ripemd160Hash = ethers.utils.ripemd160(sha256Hash).substring(2)
    depositScriptHash = `17a914${ripemd160Hash}87`
  }

  const fundingTx = {
    version: "0x01000000",
    // Input vector is not relevant in this test suite so can be random.
    inputVector: `0x01${crypto
      .randomBytes(32)
      .toString("hex")}0000000000ffffffff`,
    outputVector: `0x010000000000000000${depositScriptHash}`,
    locktime: "0x00000000",
  }

  const fundingTxHash = ethers.utils.sha256(
    ethers.utils.sha256(
      `0x${fundingTx.version.substring(2)}` +
        `${fundingTx.inputVector.substring(2)}` +
        `${fundingTx.outputVector.substring(2)}` +
        `${fundingTx.locktime.substring(2)}`
    )
  )

  return {
    key: {
      fundingTxHash,
      fundingOutputIndex: 0, // not relevant
    },
    request: {
      depositor,
      amount: 0, // not relevant
      revealedAt: resolvedRevealedAt,
      vault,
      treasuryFee: 0, // not relevant
      sweptAt: 0, // important to pass the validation
      extraData: extraData ?? ethers.constants.HashZero,
    },
    extraInfo: {
      fundingTx,
      blindingFactor,
      walletPubKeyHash,
      refundPubKeyHash,
      refundLocktime,
    },
  }
}

const redemptionKey = (
  walletPubKeyHash: BytesLike,
  redeemerOutputScript: BytesLike
) => {
  const scriptHash = ethers.utils.solidityKeccak256(
    ["bytes"],
    [redeemerOutputScript]
  )

  return ethers.utils.solidityKeccak256(
    ["bytes32", "bytes20"],
    [scriptHash, walletPubKeyHash]
  )
}

const createTestRedemptionRequest = (
  walletPubKeyHash: string,
  txMaxFee?: BigNumberish,
  requestedAt?: number
) => {
  let resolvedRequestedAt = requestedAt

  if (!resolvedRequestedAt) {
    // If the request creation time is not explicitly set, use
    // `chainTime - 1 day` to ensure request minimum age is achieved by
    // default. Anchored to the chain's own clock (captured once per
    // `validateRedemptionProposal` run), not `Date.now()`, since
    // `block.timestamp` can be far ahead of real wall-clock time by the
    // point this file runs.
    resolvedRequestedAt = redemptionRequestDefaultAnchorTime - day
  }

  const redeemer = `0x${crypto.randomBytes(20).toString("hex")}`

  const redeemerOutputScript = `0x${crypto.randomBytes(32).toString("hex")}`

  return {
    key: {
      walletPubKeyHash,
      redeemerOutputScript,
    },
    content: {
      redeemer,
      requestedAmount: 0, // not relevant
      treasuryFee: 0, // not relevant
      txMaxFee: txMaxFee ?? 0,
      requestedAt: resolvedRequestedAt,
    },
  }
}

const movedFundsSweepRequestKey = (
  movingFundsTxHash: BytesLike,
  movingFundsTxOutputIndex: number
) =>
  ethers.utils.solidityKeccak256(
    ["bytes32", "uint32"],
    [movingFundsTxHash, movingFundsTxOutputIndex]
  )

const buildRedemptionKey = (
  walletPubKeyHash: BytesLike,
  redeemerOutputScript: BytesLike
): string =>
  ethers.utils.solidityKeccak256(
    ["bytes32", "bytes20"],
    [
      ethers.utils.solidityKeccak256(["bytes"], [redeemerOutputScript]),
      walletPubKeyHash,
    ]
  )
