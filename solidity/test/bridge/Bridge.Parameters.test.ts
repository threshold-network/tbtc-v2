import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { ContractTransaction } from "ethers"
import type { Bridge, BridgeStub, BridgeGovernance } from "../../typechain"
import { constants } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const ZERO_ADDRESS = ethers.constants.AddressZero

describe("Bridge - Parameters", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, bridge, bridgeGovernance } =
      await waffle.loadFixture(bridgeFixture))
  })

  describe("updateDepositParameters", () => {
    context("when caller is the contract guvnor", () => {
      context("when all new parameter values are correct", () => {
        const newDepositDustThreshold = constants.depositDustThreshold * 2
        const newDepositTreasuryFeeDivisor =
          constants.depositTreasuryFeeDivisor * 2
        const newDepositTxMaxFee = constants.depositTxMaxFee * 3
        const newDepositRevealAheadPeriod =
          constants.depositRevealAheadPeriod * 2

        let tx1: ContractTransaction
        let tx2: ContractTransaction
        let tx3: ContractTransaction
        let tx4: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginDepositDustThresholdUpdate(newDepositDustThreshold)

          await bridgeGovernance
            .connect(governance)
            .beginDepositTreasuryFeeDivisorUpdate(newDepositTreasuryFeeDivisor)

          await bridgeGovernance
            .connect(governance)
            .beginDepositTxMaxFeeUpdate(newDepositTxMaxFee)

          await bridgeGovernance
            .connect(governance)
            .beginDepositRevealAheadPeriodUpdate(newDepositRevealAheadPeriod)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx1 = await bridgeGovernance
            .connect(governance)
            .finalizeDepositDustThresholdUpdate()

          tx2 = await bridgeGovernance
            .connect(governance)
            .finalizeDepositTreasuryFeeDivisorUpdate()

          tx3 = await bridgeGovernance
            .connect(governance)
            .finalizeDepositTxMaxFeeUpdate()

          tx4 = await bridgeGovernance
            .connect(governance)
            .finalizeDepositRevealAheadPeriodUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set correct values", async () => {
          const params = await bridge.depositParameters()

          expect(params.depositDustThreshold).to.be.equal(
            newDepositDustThreshold
          )
          expect(params.depositTreasuryFeeDivisor).to.be.equal(
            newDepositTreasuryFeeDivisor
          )
          expect(params.depositTxMaxFee).to.be.equal(newDepositTxMaxFee)
          expect(params.depositRevealAheadPeriod).to.be.equal(
            newDepositRevealAheadPeriod
          )
        })

        it("should emit DepositParametersUpdated event", async () => {
          await expect(tx1)
            .to.emit(bridge, "DepositParametersUpdated")
            .withArgs(
              newDepositDustThreshold,
              constants.depositTreasuryFeeDivisor,
              constants.depositTxMaxFee,
              constants.depositRevealAheadPeriod
            )
        })

        it("should emit DepositParametersUpdated event", async () => {
          await expect(tx2)
            .to.emit(bridge, "DepositParametersUpdated")
            .withArgs(
              newDepositDustThreshold,
              newDepositTreasuryFeeDivisor,
              constants.depositTxMaxFee,
              constants.depositRevealAheadPeriod
            )
        })

        it("should emit DepositParametersUpdated event", async () => {
          await expect(tx3)
            .to.emit(bridge, "DepositParametersUpdated")
            .withArgs(
              newDepositDustThreshold,
              newDepositTreasuryFeeDivisor,
              newDepositTxMaxFee,
              constants.depositRevealAheadPeriod
            )
        })

        it("should emit DepositParametersUpdated event", async () => {
          await expect(tx4)
            .to.emit(bridge, "DepositParametersUpdated")
            .withArgs(
              newDepositDustThreshold,
              newDepositTreasuryFeeDivisor,
              newDepositTxMaxFee,
              newDepositRevealAheadPeriod
            )
        })
      })

      context("when new deposit dust threshold is zero", () => {
        it("should revert", async () => {
          await bridgeGovernance
            .connect(governance)
            .beginDepositDustThresholdUpdate(0)

          await helpers.time.increaseTime(constants.governanceDelay)

          await expect(
            bridgeGovernance
              .connect(governance)
              .finalizeDepositDustThresholdUpdate()
          ).to.be.revertedWith(
            "Deposit dust threshold must be greater than zero"
          )
        })
      })

      context(
        "when new deposit dust threshold is same as deposit TX max fee",
        () => {
          it("should revert", async () => {
            await bridgeGovernance
              .connect(governance)
              .beginDepositDustThresholdUpdate(constants.depositTxMaxFee)

            await helpers.time.increaseTime(constants.governanceDelay)

            await expect(
              bridgeGovernance
                .connect(governance)
                .finalizeDepositDustThresholdUpdate()
            ).to.be.revertedWith(
              "Deposit dust threshold must be greater than deposit TX max fee"
            )
          })
        }
      )

      context(
        "when new deposit dust threshold is lower than deposit TX max fee",
        () => {
          it("should revert", async () => {
            await bridgeGovernance
              .connect(governance)
              .beginDepositDustThresholdUpdate(constants.depositTxMaxFee - 1)

            await helpers.time.increaseTime(constants.governanceDelay)

            await expect(
              bridgeGovernance
                .connect(governance)
                .finalizeDepositDustThresholdUpdate()
            ).to.be.revertedWith(
              "Deposit dust threshold must be greater than deposit TX max fee"
            )
          })
        }
      )

      context("when new deposit transaction max fee is zero", () => {
        it("should revert", async () => {
          await bridgeGovernance
            .connect(governance)
            .beginDepositTxMaxFeeUpdate(0)

          await helpers.time.increaseTime(constants.governanceDelay)

          await expect(
            bridgeGovernance.connect(governance).finalizeDepositTxMaxFeeUpdate()
          ).to.be.revertedWith(
            "Deposit transaction max fee must be greater than zero"
          )
        })
      })
    })

    context("when caller is not the contract guvnor", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginDepositDustThresholdUpdate(constants.depositDustThreshold)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginDepositTreasuryFeeDivisorUpdate(
              constants.depositTreasuryFeeDivisor
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginDepositTxMaxFeeUpdate(constants.depositTxMaxFee)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginDepositRevealAheadPeriodUpdate(
              constants.depositRevealAheadPeriod
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })
  })

  describe("updateRedemptionParameters", () => {
    context("when caller is the contract guvnor", () => {
      context("when all new parameter values are correct", () => {
        const newRedemptionDustThreshold = constants.redemptionDustThreshold * 2
        const newRedemptionTreasuryFeeDivisor =
          constants.redemptionTreasuryFeeDivisor / 2
        const newRedemptionTxMaxFee = constants.redemptionTxMaxFee * 3
        const newRedemptionTxMaxTotalFee = constants.redemptionTxMaxTotalFee * 3
        const newRedemptionTimeout = constants.redemptionTimeout * 4
        const newRedemptionTimeoutSlashingAmount =
          constants.redemptionTimeoutSlashingAmount.mul(2)
        const newRedemptionTimeoutNotifierRewardMultiplier =
          constants.redemptionTimeoutNotifierRewardMultiplier / 4

        let tx1: ContractTransaction
        let tx2: ContractTransaction
        let tx3: ContractTransaction
        let tx4: ContractTransaction
        let tx5: ContractTransaction
        let tx6: ContractTransaction
        let tx7: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionDustThresholdUpdate(newRedemptionDustThreshold)

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTreasuryFeeDivisorUpdate(
              newRedemptionTreasuryFeeDivisor
            )

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTxMaxFeeUpdate(newRedemptionTxMaxFee)

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTxMaxTotalFeeUpdate(newRedemptionTxMaxTotalFee)

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTimeoutUpdate(newRedemptionTimeout)

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTimeoutSlashingAmountUpdate(
              newRedemptionTimeoutSlashingAmount
            )

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTimeoutNotifierRewardMultiplierUpdate(
              newRedemptionTimeoutNotifierRewardMultiplier
            )

          await helpers.time.increaseTime(constants.governanceDelay)

          tx1 = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionDustThresholdUpdate()

          tx2 = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTreasuryFeeDivisorUpdate()

          tx3 = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTxMaxFeeUpdate()

          tx4 = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTxMaxTotalFeeUpdate()

          tx5 = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTimeoutUpdate()

          tx6 = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTimeoutSlashingAmountUpdate()

          tx7 = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTimeoutNotifierRewardMultiplierUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set correct values", async () => {
          const params = await bridge.redemptionParameters()

          expect(params.redemptionDustThreshold).to.be.equal(
            newRedemptionDustThreshold
          )
          expect(params.redemptionTreasuryFeeDivisor).to.be.equal(
            newRedemptionTreasuryFeeDivisor
          )
          expect(params.redemptionTxMaxFee).to.be.equal(newRedemptionTxMaxFee)
          expect(params.redemptionTxMaxTotalFee).to.be.equal(
            newRedemptionTxMaxTotalFee
          )
          expect(params.redemptionTimeout).to.be.equal(newRedemptionTimeout)
          expect(params.redemptionTimeoutSlashingAmount).to.be.equal(
            newRedemptionTimeoutSlashingAmount
          )
          expect(params.redemptionTimeoutNotifierRewardMultiplier).to.be.equal(
            newRedemptionTimeoutNotifierRewardMultiplier
          )
        })

        it("should emit RedemptionParametersUpdated event", async () => {
          await expect(tx1)
            .to.emit(bridge, "RedemptionParametersUpdated")
            .withArgs(
              newRedemptionDustThreshold,
              constants.redemptionTreasuryFeeDivisor,
              constants.redemptionTxMaxFee,
              constants.redemptionTxMaxTotalFee,
              constants.redemptionTimeout,
              constants.redemptionTimeoutSlashingAmount,
              constants.redemptionTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit RedemptionParametersUpdated event", async () => {
          await expect(tx2)
            .to.emit(bridge, "RedemptionParametersUpdated")
            .withArgs(
              newRedemptionDustThreshold,
              newRedemptionTreasuryFeeDivisor,
              constants.redemptionTxMaxFee,
              constants.redemptionTxMaxTotalFee,
              constants.redemptionTimeout,
              constants.redemptionTimeoutSlashingAmount,
              constants.redemptionTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit RedemptionParametersUpdated event", async () => {
          await expect(tx3)
            .to.emit(bridge, "RedemptionParametersUpdated")
            .withArgs(
              newRedemptionDustThreshold,
              newRedemptionTreasuryFeeDivisor,
              newRedemptionTxMaxFee,
              constants.redemptionTxMaxTotalFee,
              constants.redemptionTimeout,
              constants.redemptionTimeoutSlashingAmount,
              constants.redemptionTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit RedemptionParametersUpdated event", async () => {
          await expect(tx4)
            .to.emit(bridge, "RedemptionParametersUpdated")
            .withArgs(
              newRedemptionDustThreshold,
              newRedemptionTreasuryFeeDivisor,
              newRedemptionTxMaxFee,
              newRedemptionTxMaxTotalFee,
              constants.redemptionTimeout,
              constants.redemptionTimeoutSlashingAmount,
              constants.redemptionTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit RedemptionParametersUpdated event", async () => {
          await expect(tx5)
            .to.emit(bridge, "RedemptionParametersUpdated")
            .withArgs(
              newRedemptionDustThreshold,
              newRedemptionTreasuryFeeDivisor,
              newRedemptionTxMaxFee,
              newRedemptionTxMaxTotalFee,
              newRedemptionTimeout,
              constants.redemptionTimeoutSlashingAmount,
              constants.redemptionTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit RedemptionParametersUpdated event", async () => {
          await expect(tx6)
            .to.emit(bridge, "RedemptionParametersUpdated")
            .withArgs(
              newRedemptionDustThreshold,
              newRedemptionTreasuryFeeDivisor,
              newRedemptionTxMaxFee,
              newRedemptionTxMaxTotalFee,
              newRedemptionTimeout,
              newRedemptionTimeoutSlashingAmount,
              constants.redemptionTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit RedemptionParametersUpdated event", async () => {
          await expect(tx7)
            .to.emit(bridge, "RedemptionParametersUpdated")
            .withArgs(
              newRedemptionDustThreshold,
              newRedemptionTreasuryFeeDivisor,
              newRedemptionTxMaxFee,
              newRedemptionTxMaxTotalFee,
              newRedemptionTimeout,
              newRedemptionTimeoutSlashingAmount,
              newRedemptionTimeoutNotifierRewardMultiplier
            )
        })
      })

      context(
        "when new redemption dust threshold is not greater than moving funds dust threshold",
        () => {
          // Use the current value of `movingFundsDustThreshold` as the new value
          // of `redemptionDustThreshold`.
          it("should revert", async () => {
            await bridgeGovernance
              .connect(governance)
              .beginRedemptionDustThresholdUpdate(
                (
                  await bridge.movingFundsParameters()
                ).movingFundsDustThreshold
              )

            await helpers.time.increaseTime(constants.governanceDelay)

            await expect(
              bridgeGovernance
                .connect(governance)
                .finalizeRedemptionDustThresholdUpdate()
            ).to.be.revertedWith(
              "Redemption dust threshold must be greater than moving funds dust threshold"
            )
          })
        }
      )

      context(
        "when new redemption dust threshold is same as redemption tx max fee",
        () => {
          before(async () => {
            await createSnapshot()

            await bridgeGovernance
              .connect(governance)
              .beginMovingFundsDustThresholdUpdate(
                constants.redemptionTxMaxFee - 1
              )

            await helpers.time.increaseTime(constants.governanceDelay)

            await bridgeGovernance
              .connect(governance)
              .finalizeMovingFundsDustThresholdUpdate()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await bridgeGovernance
              .connect(governance)
              .beginRedemptionDustThresholdUpdate(constants.redemptionTxMaxFee)

            await helpers.time.increaseTime(constants.governanceDelay)

            await expect(
              bridgeGovernance
                .connect(governance)
                .finalizeRedemptionDustThresholdUpdate()
            ).to.be.revertedWith(
              "Redemption dust threshold must be greater than redemption TX max fee"
            )
          })
        }
      )

      context(
        "when new redemption dust threshold is lower than redemption tx max fee",
        () => {
          before(async () => {
            await createSnapshot()

            await bridgeGovernance
              .connect(governance)
              .beginMovingFundsDustThresholdUpdate(
                constants.redemptionTxMaxFee - 2
              )

            await helpers.time.increaseTime(constants.governanceDelay)

            await bridgeGovernance
              .connect(governance)
              .finalizeMovingFundsDustThresholdUpdate()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await bridgeGovernance
              .connect(governance)
              .beginRedemptionDustThresholdUpdate(
                constants.redemptionTxMaxFee - 1
              )

            await helpers.time.increaseTime(constants.governanceDelay)

            await expect(
              bridgeGovernance
                .connect(governance)
                .finalizeRedemptionDustThresholdUpdate()
            ).to.be.revertedWith(
              "Redemption dust threshold must be greater than redemption TX max fee"
            )
          })
        }
      )

      context("when new redemption transaction max fee is zero", () => {
        it("should revert", async () => {
          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTxMaxFeeUpdate(0)

          await helpers.time.increaseTime(constants.governanceDelay)

          await expect(
            bridgeGovernance
              .connect(governance)
              .finalizeRedemptionTxMaxFeeUpdate()
          ).to.be.revertedWith(
            "Redemption transaction max fee must be greater than zero"
          )
        })
      })

      context(
        "when new redemption transaction max total fee is lesser than the redemption transaction per-request max fee",
        () => {
          it("should revert", async () => {
            await bridgeGovernance
              .connect(governance)
              .beginRedemptionTxMaxTotalFeeUpdate(
                constants.redemptionTxMaxFee - 1
              )

            await helpers.time.increaseTime(constants.governanceDelay)

            await expect(
              bridgeGovernance
                .connect(governance)
                .finalizeRedemptionTxMaxTotalFeeUpdate()
            ).to.be.revertedWith(
              "Redemption transaction max total fee must be greater than or equal to the redemption transaction per-request max fee"
            )
          })
        }
      )

      context("when new redemption timeout is zero", () => {
        it("should revert", async () => {
          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTimeoutUpdate(0)

          await helpers.time.increaseTime(constants.governanceDelay)

          await expect(
            bridgeGovernance
              .connect(governance)
              .finalizeRedemptionTimeoutUpdate()
          ).to.be.revertedWith("Redemption timeout must be greater than zero")
        })
      })

      context(
        "when new redemption timeout notifier reward multiplier is greater than 100",
        () => {
          it("should revert", async () => {
            await bridgeGovernance
              .connect(governance)
              .beginRedemptionTimeoutNotifierRewardMultiplierUpdate(101)

            await helpers.time.increaseTime(constants.governanceDelay)

            await expect(
              bridgeGovernance
                .connect(governance)
                .finalizeRedemptionTimeoutNotifierRewardMultiplierUpdate()
            ).to.be.revertedWith(
              "Redemption timeout notifier reward multiplier must be in the range [0, 100]"
            )
          })
        }
      )
    })

    context("when caller is not the contract guvnor", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginRedemptionDustThresholdUpdate(
              constants.redemptionDustThreshold
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginRedemptionTreasuryFeeDivisorUpdate(
              constants.redemptionTreasuryFeeDivisor
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginRedemptionTxMaxFeeUpdate(constants.redemptionTxMaxFee)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginRedemptionTxMaxTotalFeeUpdate(
              constants.redemptionTxMaxTotalFee
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginRedemptionTimeoutUpdate(constants.redemptionTimeout)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginRedemptionTimeoutSlashingAmountUpdate(
              constants.redemptionTimeoutSlashingAmount
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginRedemptionTimeoutNotifierRewardMultiplierUpdate(
              constants.redemptionTimeoutNotifierRewardMultiplier
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })
  })

  describe("updateMovingFundsParameters", () => {
    context("when caller is the contract guvnor", () => {
      context("when all new parameter values are correct", () => {
        const newMovingFundsTxMaxTotalFee =
          constants.movingFundsTxMaxTotalFee / 2
        const newMovingFundsDustThreshold =
          constants.movingFundsDustThreshold * 2
        const newMovingFundsTimeoutResetDelay =
          constants.movingFundsTimeoutResetDelay * 2
        const newMovingFundsTimeout = constants.movingFundsTimeout * 2
        const newMovingFundsTimeoutSlashingAmount =
          constants.movingFundsTimeoutSlashingAmount.mul(3)
        const newMovingFundsTimeoutNotifierRewardMultiplier =
          constants.movingFundsTimeoutNotifierRewardMultiplier / 2
        const newMovingFundsCommitmentGasOffset =
          constants.movingFundsCommitmentGasOffset / 2
        const newMovedFundsSweepTxMaxTotalFee =
          constants.movedFundsSweepTxMaxTotalFee * 2
        const newMovedFundsSweepTimeout = constants.movedFundsSweepTimeout * 4
        const newMovedFundsSweepTimeoutSlashingAmount =
          constants.movedFundsSweepTimeoutSlashingAmount.mul(6)
        const newMovedFundsSweepTimeoutNotifierRewardMultiplier =
          constants.movedFundsSweepTimeoutNotifierRewardMultiplier / 4

        let tx1: ContractTransaction
        let tx2: ContractTransaction
        let tx3: ContractTransaction
        let tx4: ContractTransaction
        let tx5: ContractTransaction
        let tx6: ContractTransaction
        let tx7: ContractTransaction
        let tx8: ContractTransaction
        let tx9: ContractTransaction
        let tx10: ContractTransaction
        let tx11: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsTxMaxTotalFeeUpdate(newMovingFundsTxMaxTotalFee)

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsDustThresholdUpdate(newMovingFundsDustThreshold)

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsTimeoutResetDelayUpdate(
              newMovingFundsTimeoutResetDelay
            )

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsTimeoutUpdate(newMovingFundsTimeout)

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsTimeoutSlashingAmountUpdate(
              newMovingFundsTimeoutSlashingAmount
            )

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsTimeoutNotifierRewardMultiplierUpdate(
              newMovingFundsTimeoutNotifierRewardMultiplier
            )

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsCommitmentGasOffsetUpdate(
              newMovingFundsCommitmentGasOffset
            )

          await bridgeGovernance
            .connect(governance)
            .beginMovedFundsSweepTxMaxTotalFeeUpdate(
              newMovedFundsSweepTxMaxTotalFee
            )

          await bridgeGovernance
            .connect(governance)
            .beginMovedFundsSweepTimeoutUpdate(newMovedFundsSweepTimeout)

          await bridgeGovernance
            .connect(governance)
            .beginMovedFundsSweepTimeoutSlashingAmountUpdate(
              newMovedFundsSweepTimeoutSlashingAmount
            )

          await bridgeGovernance
            .connect(governance)
            .beginMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate(
              newMovedFundsSweepTimeoutNotifierRewardMultiplier
            )

          await helpers.time.increaseTime(constants.governanceDelay)

          tx1 = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTxMaxTotalFeeUpdate()

          tx2 = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsDustThresholdUpdate()

          tx3 = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutUpdate()

          tx4 = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutResetDelayUpdate()

          tx5 = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutSlashingAmountUpdate()

          tx6 = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutNotifierRewardMultiplierUpdate()

          tx7 = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsCommitmentGasOffsetUpdate()

          tx8 = await bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTxMaxTotalFeeUpdate()

          tx9 = await bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTimeoutUpdate()

          tx10 = await bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTimeoutSlashingAmountUpdate()

          tx11 = await bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set correct values", async () => {
          const params = await bridge.movingFundsParameters()

          expect(params.movingFundsTxMaxTotalFee).to.be.equal(
            newMovingFundsTxMaxTotalFee
          )
          expect(params.movingFundsDustThreshold).to.be.equal(
            newMovingFundsDustThreshold
          )
          expect(params.movingFundsTimeoutResetDelay).to.be.equal(
            newMovingFundsTimeoutResetDelay
          )
          expect(params.movingFundsTimeout).to.be.equal(newMovingFundsTimeout)
          expect(params.movingFundsTimeoutSlashingAmount).to.be.equal(
            newMovingFundsTimeoutSlashingAmount
          )
          expect(params.movingFundsTimeoutNotifierRewardMultiplier).to.be.equal(
            newMovingFundsTimeoutNotifierRewardMultiplier
          )
          expect(params.movingFundsCommitmentGasOffset).to.be.equal(
            newMovingFundsCommitmentGasOffset
          )
          expect(params.movedFundsSweepTxMaxTotalFee).to.be.equal(
            newMovedFundsSweepTxMaxTotalFee
          )
          expect(params.movedFundsSweepTimeout).to.be.equal(
            newMovedFundsSweepTimeout
          )
          expect(params.movedFundsSweepTimeoutSlashingAmount).to.be.equal(
            newMovedFundsSweepTimeoutSlashingAmount
          )
          expect(
            params.movedFundsSweepTimeoutNotifierRewardMultiplier
          ).to.be.equal(newMovedFundsSweepTimeoutNotifierRewardMultiplier)
        })

        // fix events
        it("should emit MovingFundsParametersUpdated event", async () => {
          await expect(tx1)
            .to.emit(bridge, "MovingFundsParametersUpdated")
            .withArgs(
              newMovingFundsTxMaxTotalFee,
              constants.movingFundsDustThreshold,
              constants.movingFundsTimeoutResetDelay,
              constants.movingFundsTimeout,
              constants.movingFundsTimeoutSlashingAmount,
              constants.movingFundsTimeoutNotifierRewardMultiplier,
              constants.movingFundsCommitmentGasOffset,
              constants.movedFundsSweepTxMaxTotalFee,
              constants.movedFundsSweepTimeout,
              constants.movedFundsSweepTimeoutSlashingAmount,
              constants.movedFundsSweepTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit MovingFundsParametersUpdated event", async () => {
          await expect(tx2)
            .to.emit(bridge, "MovingFundsParametersUpdated")
            .withArgs(
              newMovingFundsTxMaxTotalFee,
              newMovingFundsDustThreshold,
              constants.movingFundsTimeoutResetDelay,
              constants.movingFundsTimeout,
              constants.movingFundsTimeoutSlashingAmount,
              constants.movingFundsTimeoutNotifierRewardMultiplier,
              constants.movingFundsCommitmentGasOffset,
              constants.movedFundsSweepTxMaxTotalFee,
              constants.movedFundsSweepTimeout,
              constants.movedFundsSweepTimeoutSlashingAmount,
              constants.movedFundsSweepTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit MovingFundsParametersUpdated event", async () => {
          await expect(tx3)
            .to.emit(bridge, "MovingFundsParametersUpdated")
            .withArgs(
              newMovingFundsTxMaxTotalFee,
              newMovingFundsDustThreshold,
              constants.movingFundsTimeoutResetDelay,
              newMovingFundsTimeout,
              constants.movingFundsTimeoutSlashingAmount,
              constants.movingFundsTimeoutNotifierRewardMultiplier,
              constants.movingFundsCommitmentGasOffset,
              constants.movedFundsSweepTxMaxTotalFee,
              constants.movedFundsSweepTimeout,
              constants.movedFundsSweepTimeoutSlashingAmount,
              constants.movedFundsSweepTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit MovingFundsParametersUpdated event", async () => {
          await expect(tx4)
            .to.emit(bridge, "MovingFundsParametersUpdated")
            .withArgs(
              newMovingFundsTxMaxTotalFee,
              newMovingFundsDustThreshold,
              newMovingFundsTimeoutResetDelay,
              newMovingFundsTimeout,
              constants.movingFundsTimeoutSlashingAmount,
              constants.movingFundsTimeoutNotifierRewardMultiplier,
              constants.movingFundsCommitmentGasOffset,
              constants.movedFundsSweepTxMaxTotalFee,
              constants.movedFundsSweepTimeout,
              constants.movedFundsSweepTimeoutSlashingAmount,
              constants.movedFundsSweepTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit MovingFundsParametersUpdated event", async () => {
          await expect(tx5)
            .to.emit(bridge, "MovingFundsParametersUpdated")
            .withArgs(
              newMovingFundsTxMaxTotalFee,
              newMovingFundsDustThreshold,
              newMovingFundsTimeoutResetDelay,
              newMovingFundsTimeout,
              newMovingFundsTimeoutSlashingAmount,
              constants.movingFundsTimeoutNotifierRewardMultiplier,
              constants.movingFundsCommitmentGasOffset,
              constants.movedFundsSweepTxMaxTotalFee,
              constants.movedFundsSweepTimeout,
              constants.movedFundsSweepTimeoutSlashingAmount,
              constants.movedFundsSweepTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit MovingFundsParametersUpdated event", async () => {
          await expect(tx6)
            .to.emit(bridge, "MovingFundsParametersUpdated")
            .withArgs(
              newMovingFundsTxMaxTotalFee,
              newMovingFundsDustThreshold,
              newMovingFundsTimeoutResetDelay,
              newMovingFundsTimeout,
              newMovingFundsTimeoutSlashingAmount,
              newMovingFundsTimeoutNotifierRewardMultiplier,
              constants.movingFundsCommitmentGasOffset,
              constants.movedFundsSweepTxMaxTotalFee,
              constants.movedFundsSweepTimeout,
              constants.movedFundsSweepTimeoutSlashingAmount,
              constants.movedFundsSweepTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit MovingFundsParametersUpdated event", async () => {
          await expect(tx7)
            .to.emit(bridge, "MovingFundsParametersUpdated")
            .withArgs(
              newMovingFundsTxMaxTotalFee,
              newMovingFundsDustThreshold,
              newMovingFundsTimeoutResetDelay,
              newMovingFundsTimeout,
              newMovingFundsTimeoutSlashingAmount,
              newMovingFundsTimeoutNotifierRewardMultiplier,
              newMovingFundsCommitmentGasOffset,
              constants.movedFundsSweepTxMaxTotalFee,
              constants.movedFundsSweepTimeout,
              constants.movedFundsSweepTimeoutSlashingAmount,
              constants.movedFundsSweepTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit MovingFundsParametersUpdated event", async () => {
          await expect(tx8)
            .to.emit(bridge, "MovingFundsParametersUpdated")
            .withArgs(
              newMovingFundsTxMaxTotalFee,
              newMovingFundsDustThreshold,
              newMovingFundsTimeoutResetDelay,
              newMovingFundsTimeout,
              newMovingFundsTimeoutSlashingAmount,
              newMovingFundsTimeoutNotifierRewardMultiplier,
              newMovingFundsCommitmentGasOffset,
              newMovedFundsSweepTxMaxTotalFee,
              constants.movedFundsSweepTimeout,
              constants.movedFundsSweepTimeoutSlashingAmount,
              constants.movedFundsSweepTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit MovingFundsParametersUpdated event", async () => {
          await expect(tx9)
            .to.emit(bridge, "MovingFundsParametersUpdated")
            .withArgs(
              newMovingFundsTxMaxTotalFee,
              newMovingFundsDustThreshold,
              newMovingFundsTimeoutResetDelay,
              newMovingFundsTimeout,
              newMovingFundsTimeoutSlashingAmount,
              newMovingFundsTimeoutNotifierRewardMultiplier,
              newMovingFundsCommitmentGasOffset,
              newMovedFundsSweepTxMaxTotalFee,
              newMovedFundsSweepTimeout,
              constants.movedFundsSweepTimeoutSlashingAmount,
              constants.movedFundsSweepTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit MovingFundsParametersUpdated event", async () => {
          await expect(tx10)
            .to.emit(bridge, "MovingFundsParametersUpdated")
            .withArgs(
              newMovingFundsTxMaxTotalFee,
              newMovingFundsDustThreshold,
              newMovingFundsTimeoutResetDelay,
              newMovingFundsTimeout,
              newMovingFundsTimeoutSlashingAmount,
              newMovingFundsTimeoutNotifierRewardMultiplier,
              newMovingFundsCommitmentGasOffset,
              newMovedFundsSweepTxMaxTotalFee,
              newMovedFundsSweepTimeout,
              newMovedFundsSweepTimeoutSlashingAmount,
              constants.movedFundsSweepTimeoutNotifierRewardMultiplier
            )
        })

        it("should emit MovingFundsParametersUpdated event", async () => {
          await expect(tx11)
            .to.emit(bridge, "MovingFundsParametersUpdated")
            .withArgs(
              newMovingFundsTxMaxTotalFee,
              newMovingFundsDustThreshold,
              newMovingFundsTimeoutResetDelay,
              newMovingFundsTimeout,
              newMovingFundsTimeoutSlashingAmount,
              newMovingFundsTimeoutNotifierRewardMultiplier,
              newMovingFundsCommitmentGasOffset,
              newMovedFundsSweepTxMaxTotalFee,
              newMovedFundsSweepTimeout,
              newMovedFundsSweepTimeoutSlashingAmount,
              newMovedFundsSweepTimeoutNotifierRewardMultiplier
            )
        })
      })

      context("when new moving funds transaction max total fee is zero", () => {
        it("should revert", async () => {
          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsTxMaxTotalFeeUpdate(0)

          await helpers.time.increaseTime(constants.governanceDelay)

          await expect(
            bridgeGovernance
              .connect(governance)
              .finalizeMovingFundsTxMaxTotalFeeUpdate()
          ).to.be.revertedWith(
            "Moving funds transaction max total fee must be greater than zero"
          )
        })
      })

      context("when new moving funds dust threshold is zero", () => {
        it("should revert", async () => {
          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsDustThresholdUpdate(0)

          await helpers.time.increaseTime(constants.governanceDelay)

          await expect(
            bridgeGovernance
              .connect(governance)
              .finalizeMovingFundsDustThresholdUpdate()
          ).to.be.revertedWith(
            "Moving funds dust threshold must be greater than zero and lower than redemption dust threshold"
          )
        })
      })

      context(
        "when new moving funds dust threshold is not lower than redemption dust threshold",
        () => {
          // Use the current value of `redemptionDustThreshold` as the new value
          // of `movingFundsDustThreshold`.
          it("should revert", async () => {
            await bridgeGovernance
              .connect(governance)
              .beginMovingFundsDustThresholdUpdate(
                (
                  await bridge.redemptionParameters()
                ).redemptionDustThreshold
              )

            await helpers.time.increaseTime(constants.governanceDelay)

            await expect(
              bridgeGovernance
                .connect(governance)
                .finalizeMovingFundsDustThresholdUpdate()
            ).to.be.revertedWith(
              "Moving funds dust threshold must be greater than zero and lower than redemption dust threshold"
            )
          })
        }
      )

      context("when new moving funds timeout reset delay is zero", () => {
        it("should revert", async () => {
          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsTimeoutResetDelayUpdate(0)

          await helpers.time.increaseTime(constants.governanceDelay)

          await expect(
            bridgeGovernance
              .connect(governance)
              .finalizeMovingFundsTimeoutResetDelayUpdate()
          ).to.be.revertedWith(
            "Moving funds timeout reset delay must be greater than zero"
          )
        })
      })

      context(
        "when new moving funds timeout is not greater than its reset delay",
        () => {
          it("should revert", async () => {
            await bridgeGovernance
              .connect(governance)
              .beginMovingFundsTimeoutUpdate(
                constants.movingFundsTimeoutResetDelay
              )

            await helpers.time.increaseTime(constants.governanceDelay)

            await expect(
              bridgeGovernance
                .connect(governance)
                .finalizeMovingFundsTimeoutUpdate()
            ).to.be.revertedWith(
              "Moving funds timeout must be greater than its reset delay"
            )
          })
        }
      )

      context("when new moved funds sweep timeout is zero", () => {
        it("should revert", async () => {
          await bridgeGovernance
            .connect(governance)
            .beginMovedFundsSweepTimeoutUpdate(0)

          await helpers.time.increaseTime(constants.governanceDelay)

          await expect(
            bridgeGovernance
              .connect(governance)
              .finalizeMovedFundsSweepTimeoutUpdate()
          ).to.be.revertedWith(
            "Moved funds sweep timeout must be greater than zero"
          )
        })
      })

      context(
        "when new moved funds sweep timeout notifier reward multiplier is greater than 100",
        () => {
          it("should revert", async () => {
            await bridgeGovernance
              .connect(governance)
              .beginMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate(101)

            await helpers.time.increaseTime(constants.governanceDelay)

            await expect(
              bridgeGovernance
                .connect(governance)
                .finalizeMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate()
            ).to.be.revertedWith(
              "Moved funds sweep timeout notifier reward multiplier must be in the range [0, 100]"
            )
          })
        }
      )
    })

    context("when caller is not the contract guvnor", () => {
      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .updateMovingFundsParameters(
              constants.movingFundsTxMaxTotalFee,
              constants.movingFundsDustThreshold,
              constants.movingFundsTimeoutResetDelay,
              constants.movingFundsTimeout,
              constants.movingFundsTimeoutSlashingAmount,
              constants.movingFundsTimeoutNotifierRewardMultiplier,
              constants.movingFundsCommitmentGasOffset,
              constants.movedFundsSweepTxMaxTotalFee,
              constants.movedFundsSweepTimeout,
              constants.movedFundsSweepTimeoutSlashingAmount,
              constants.movedFundsSweepTimeoutNotifierRewardMultiplier
            )
        ).to.be.revertedWith("Caller is not the governance")
      })
    })
  })

  describe("updateWalletParameters", () => {
    context("when caller is the contract guvnor", () => {
      context("when all new parameter values are correct", () => {
        const newWalletCreationPeriod = constants.walletCreationPeriod * 2
        const newWalletCreationMinBtcBalance =
          constants.walletCreationMinBtcBalance.add(1000)
        const newWalletCreationMaxBtcBalance =
          constants.walletCreationMaxBtcBalance.add(2000)
        const newWalletClosureMinBtcBalance =
          constants.walletClosureMinBtcBalance.add(3000)
        const newWalletMaxAge = constants.walletMaxAge * 2
        const newWalletMaxBtcTransfer = constants.walletMaxBtcTransfer.add(1000)
        const newWalletClosingPeriod = constants.walletClosingPeriod * 2

        let tx1: ContractTransaction
        let tx2: ContractTransaction
        let tx3: ContractTransaction
        let tx4: ContractTransaction
        let tx5: ContractTransaction
        let tx6: ContractTransaction
        let tx7: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginWalletCreationPeriodUpdate(newWalletCreationPeriod)

          await bridgeGovernance
            .connect(governance)
            .beginWalletCreationMinBtcBalanceUpdate(
              newWalletCreationMinBtcBalance
            )

          await bridgeGovernance
            .connect(governance)
            .beginWalletCreationMaxBtcBalanceUpdate(
              newWalletCreationMaxBtcBalance
            )

          await bridgeGovernance
            .connect(governance)
            .beginWalletClosureMinBtcBalanceUpdate(
              newWalletClosureMinBtcBalance
            )

          await bridgeGovernance
            .connect(governance)
            .beginWalletMaxAgeUpdate(newWalletMaxAge)

          await bridgeGovernance
            .connect(governance)
            .beginWalletMaxBtcTransferUpdate(newWalletMaxBtcTransfer)

          await bridgeGovernance
            .connect(governance)
            .beginWalletClosingPeriodUpdate(newWalletClosingPeriod)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx1 = await bridgeGovernance
            .connect(governance)
            .finalizeWalletCreationPeriodUpdate()

          tx2 = await bridgeGovernance
            .connect(governance)
            .finalizeWalletCreationMinBtcBalanceUpdate()

          tx3 = await bridgeGovernance
            .connect(governance)
            .finalizeWalletCreationMaxBtcBalanceUpdate()

          tx4 = await bridgeGovernance
            .connect(governance)
            .finalizeWalletClosureMinBtcBalanceUpdate()

          tx5 = await bridgeGovernance
            .connect(governance)
            .finalizeWalletMaxAgeUpdate()

          tx6 = await bridgeGovernance
            .connect(governance)
            .finalizeWalletMaxBtcTransferUpdate()

          tx7 = await bridgeGovernance
            .connect(governance)
            .finalizeWalletClosingPeriodUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set correct values", async () => {
          const params = await bridge.walletParameters()

          expect(params.walletCreationPeriod).to.be.equal(
            newWalletCreationPeriod
          )
          expect(params.walletCreationMinBtcBalance).to.be.equal(
            newWalletCreationMinBtcBalance
          )
          expect(params.walletCreationMaxBtcBalance).to.be.equal(
            newWalletCreationMaxBtcBalance
          )
          expect(params.walletClosureMinBtcBalance).to.be.equal(
            newWalletClosureMinBtcBalance
          )
          expect(params.walletMaxAge).to.be.equal(newWalletMaxAge)
          expect(params.walletMaxBtcTransfer).to.be.equal(
            newWalletMaxBtcTransfer
          )
          expect(params.walletClosingPeriod).to.be.equal(newWalletClosingPeriod)
        })

        it("should emit WalletParametersUpdated event", async () => {
          await expect(tx1)
            .to.emit(bridge, "WalletParametersUpdated")
            .withArgs(
              newWalletCreationPeriod,
              constants.walletCreationMinBtcBalance,
              constants.walletCreationMaxBtcBalance,
              constants.walletClosureMinBtcBalance,
              constants.walletMaxAge,
              constants.walletMaxBtcTransfer,
              constants.walletClosingPeriod
            )
        })

        it("should emit WalletParametersUpdated event", async () => {
          await expect(tx2)
            .to.emit(bridge, "WalletParametersUpdated")
            .withArgs(
              newWalletCreationPeriod,
              newWalletCreationMinBtcBalance,
              constants.walletCreationMaxBtcBalance,
              constants.walletClosureMinBtcBalance,
              constants.walletMaxAge,
              constants.walletMaxBtcTransfer,
              constants.walletClosingPeriod
            )
        })

        it("should emit WalletParametersUpdated event", async () => {
          await expect(tx3)
            .to.emit(bridge, "WalletParametersUpdated")
            .withArgs(
              newWalletCreationPeriod,
              newWalletCreationMinBtcBalance,
              newWalletCreationMaxBtcBalance,
              constants.walletClosureMinBtcBalance,
              constants.walletMaxAge,
              constants.walletMaxBtcTransfer,
              constants.walletClosingPeriod
            )
        })

        it("should emit WalletParametersUpdated event", async () => {
          await expect(tx4)
            .to.emit(bridge, "WalletParametersUpdated")
            .withArgs(
              newWalletCreationPeriod,
              newWalletCreationMinBtcBalance,
              newWalletCreationMaxBtcBalance,
              newWalletClosureMinBtcBalance,
              constants.walletMaxAge,
              constants.walletMaxBtcTransfer,
              constants.walletClosingPeriod
            )
        })

        it("should emit WalletParametersUpdated event", async () => {
          await expect(tx5)
            .to.emit(bridge, "WalletParametersUpdated")
            .withArgs(
              newWalletCreationPeriod,
              newWalletCreationMinBtcBalance,
              newWalletCreationMaxBtcBalance,
              newWalletClosureMinBtcBalance,
              newWalletMaxAge,
              constants.walletMaxBtcTransfer,
              constants.walletClosingPeriod
            )
        })

        it("should emit WalletParametersUpdated event", async () => {
          await expect(tx6)
            .to.emit(bridge, "WalletParametersUpdated")
            .withArgs(
              newWalletCreationPeriod,
              newWalletCreationMinBtcBalance,
              newWalletCreationMaxBtcBalance,
              newWalletClosureMinBtcBalance,
              newWalletMaxAge,
              newWalletMaxBtcTransfer,
              constants.walletClosingPeriod
            )
        })

        it("should emit WalletParametersUpdated event", async () => {
          await expect(tx7)
            .to.emit(bridge, "WalletParametersUpdated")
            .withArgs(
              newWalletCreationPeriod,
              newWalletCreationMinBtcBalance,
              newWalletCreationMaxBtcBalance,
              newWalletClosureMinBtcBalance,
              newWalletMaxAge,
              newWalletMaxBtcTransfer,
              newWalletClosingPeriod
            )
        })
      })

      context(
        "when new creation maximum BTC balance is not greater than the creation minimum BTC balance",
        () => {
          it("should revert", async () => {
            await bridgeGovernance
              .connect(governance)
              .beginWalletCreationMaxBtcBalanceUpdate(
                constants.walletCreationMinBtcBalance
              )

            await helpers.time.increaseTime(constants.governanceDelay)

            await expect(
              bridgeGovernance
                .connect(governance)
                .finalizeWalletCreationMaxBtcBalanceUpdate()
            ).to.be.revertedWith(
              "Wallet creation maximum BTC balance must be greater than the creation minimum BTC balance"
            )
          })
        }
      )

      context("when new maximum BTC transfer is zero", () => {
        it("should revert", async () => {
          await bridgeGovernance
            .connect(governance)
            .beginWalletMaxBtcTransferUpdate(0)

          await helpers.time.increaseTime(constants.governanceDelay)

          await expect(
            bridgeGovernance
              .connect(governance)
              .finalizeWalletMaxBtcTransferUpdate()
          ).to.be.revertedWith(
            "Wallet maximum BTC transfer must be greater than zero"
          )
        })
      })

      context("when new closing period is zero", () => {
        it("should revert", async () => {
          await bridgeGovernance
            .connect(governance)
            .beginWalletClosingPeriodUpdate(0)

          await helpers.time.increaseTime(constants.governanceDelay)

          await expect(
            bridgeGovernance
              .connect(governance)
              .finalizeWalletClosingPeriodUpdate()
          ).to.be.revertedWith(
            "Wallet closing period must be greater than zero"
          )
        })
      })
    })

    context("when caller is not the contract guvnor", () => {
      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .updateWalletParameters(
              constants.walletCreationPeriod,
              constants.walletCreationMinBtcBalance,
              constants.walletCreationMaxBtcBalance,
              constants.walletClosureMinBtcBalance,
              constants.walletMaxAge,
              constants.walletMaxBtcTransfer,
              constants.walletClosingPeriod
            )
        ).to.be.revertedWith("Caller is not the governance")
      })
    })
  })

  describe("updateFraudParameters", () => {
    context("when caller is the contract guvnor", () => {
      context("when all new parameter values are correct", () => {
        const newFraudChallengeDepositAmount =
          constants.fraudChallengeDepositAmount.mul(4)
        const newFraudChallengeDefeatTimeout =
          constants.fraudChallengeDefeatTimeout * 3
        const newFraudSlashingAmount = constants.fraudSlashingAmount.mul(2)
        const newFraudNotifierRewardMultiplier =
          constants.fraudNotifierRewardMultiplier / 4

        let tx1: ContractTransaction
        let tx2: ContractTransaction
        let tx3: ContractTransaction
        let tx4: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginFraudChallengeDepositAmountUpdate(
              newFraudChallengeDepositAmount
            )

          await bridgeGovernance
            .connect(governance)
            .beginFraudChallengeDefeatTimeoutUpdate(
              newFraudChallengeDefeatTimeout
            )

          await bridgeGovernance
            .connect(governance)
            .beginFraudSlashingAmountUpdate(newFraudSlashingAmount)

          await bridgeGovernance
            .connect(governance)
            .beginFraudNotifierRewardMultiplierUpdate(
              newFraudNotifierRewardMultiplier
            )

          await helpers.time.increaseTime(constants.governanceDelay)

          tx1 = await bridgeGovernance
            .connect(governance)
            .finalizeFraudChallengeDepositAmountUpdate()

          tx2 = await bridgeGovernance
            .connect(governance)
            .finalizeFraudChallengeDefeatTimeoutUpdate()

          tx3 = await bridgeGovernance
            .connect(governance)
            .finalizeFraudSlashingAmountUpdate()

          tx4 = await bridgeGovernance
            .connect(governance)
            .finalizeFraudNotifierRewardMultiplierUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set correct values", async () => {
          const params = await bridge.fraudParameters()

          expect(params.fraudChallengeDepositAmount).to.be.equal(
            newFraudChallengeDepositAmount
          )
          expect(params.fraudChallengeDefeatTimeout).to.be.equal(
            newFraudChallengeDefeatTimeout
          )
          expect(params.fraudSlashingAmount).to.be.equal(newFraudSlashingAmount)
          expect(params.fraudNotifierRewardMultiplier).to.be.equal(
            newFraudNotifierRewardMultiplier
          )
        })

        it("should emit FraudParametersUpdated event", async () => {
          await expect(tx1)
            .to.emit(bridge, "FraudParametersUpdated")
            .withArgs(
              newFraudChallengeDepositAmount,
              constants.fraudChallengeDefeatTimeout,
              constants.fraudSlashingAmount,
              constants.fraudNotifierRewardMultiplier
            )
        })

        it("should emit FraudParametersUpdated event", async () => {
          await expect(tx2)
            .to.emit(bridge, "FraudParametersUpdated")
            .withArgs(
              newFraudChallengeDepositAmount,
              newFraudChallengeDefeatTimeout,
              constants.fraudSlashingAmount,
              constants.fraudNotifierRewardMultiplier
            )
        })

        it("should emit FraudParametersUpdated event", async () => {
          await expect(tx3)
            .to.emit(bridge, "FraudParametersUpdated")
            .withArgs(
              newFraudChallengeDepositAmount,
              newFraudChallengeDefeatTimeout,
              newFraudSlashingAmount,
              constants.fraudNotifierRewardMultiplier
            )
        })

        it("should emit FraudParametersUpdated event", async () => {
          await expect(tx4)
            .to.emit(bridge, "FraudParametersUpdated")
            .withArgs(
              newFraudChallengeDepositAmount,
              newFraudChallengeDefeatTimeout,
              newFraudSlashingAmount,
              newFraudNotifierRewardMultiplier
            )
        })
      })

      context("when new fraud challenge defeat timeout is zero", () => {
        it("should revert", async () => {
          await bridgeGovernance
            .connect(governance)
            .beginFraudChallengeDefeatTimeoutUpdate(0)

          await helpers.time.increaseTime(constants.governanceDelay)

          await expect(
            bridgeGovernance
              .connect(governance)
              .finalizeFraudChallengeDefeatTimeoutUpdate()
          ).to.be.revertedWith(
            "Fraud challenge defeat timeout must be greater than zero"
          )
        })
      })

      context(
        "when new fraud notifier reward multiplier is greater than 100",
        () => {
          it("should revert", async () => {
            await bridgeGovernance
              .connect(governance)
              .beginFraudNotifierRewardMultiplierUpdate(101)

            await helpers.time.increaseTime(constants.governanceDelay)

            await expect(
              bridgeGovernance
                .connect(governance)
                .finalizeFraudNotifierRewardMultiplierUpdate()
            ).to.be.revertedWith(
              "Fraud notifier reward multiplier must be in the range [0, 100]"
            )
          })
        }
      )
    })

    context("when caller is not the contract guvnor", () => {
      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .updateFraudParameters(
              constants.fraudChallengeDepositAmount,
              constants.fraudChallengeDefeatTimeout,
              constants.fraudSlashingAmount,
              constants.fraudNotifierRewardMultiplier
            )
        ).to.be.revertedWith("Caller is not the governance")
      })
    })
  })

  describe("updateTreasury", () => {
    const newTreasury = "0x4EDCe37af1c6e2CDfe086D7940C5a8AAde9c72e3"

    context("when caller is the contract guvnor", () => {
      before(async () => {
        await createSnapshot()

        // We transfer the ownership of the Bridge governance from the
        // BridgeGovernance contract to a simple address. This allows testing
        // the Bridge contract directly, without going through the
        // BridgeGovernance contract.
        await bridgeGovernance
          .connect(governance)
          .beginBridgeGovernanceTransfer(governance.address)
        await helpers.time.increaseTime(constants.governanceDelay)
        await bridgeGovernance
          .connect(governance)
          .finalizeBridgeGovernanceTransfer()
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the new treasury address is non-zero", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await bridge.connect(governance).updateTreasury(newTreasury)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set the new treasury address", async () => {
          expect(await bridge.treasury()).to.equal(newTreasury)
        })

        it("should emit TreasuryUpdated event", async () => {
          await expect(tx)
            .to.emit(bridge, "TreasuryUpdated")
            .withArgs(newTreasury)
        })
      })

      context("when the new treasury address is zero", () => {
        it("should revert", async () => {
          await expect(
            bridge.connect(governance).updateTreasury(ZERO_ADDRESS)
          ).to.be.revertedWith("Treasury address must not be 0x0")
        })
      })
    })

    context("when caller is not the contract guvnor", () => {
      it("should revert", async () => {
        await expect(
          bridge.connect(thirdParty).updateTreasury(newTreasury)
        ).to.be.revertedWith("Caller is not the governance")
      })
    })
  })

  describe("setRedemptionWatchtower", () => {
    const watchtower = "0xE8ebaEc51bAeeaBff71707dE2AD028C7fB642A3F"

    context("when caller is not the contract guvnor", () => {
      it("should revert", async () => {
        await expect(
          bridge.connect(thirdParty).setRedemptionWatchtower(watchtower)
        ).to.be.revertedWith("Caller is not the governance")
      })
    })

    context("when caller is the contract guvnor", () => {
      before(async () => {
        await createSnapshot()

        // We transfer the ownership of the Bridge governance from the
        // BridgeGovernance contract to a simple address. This allows testing
        // the Bridge contract directly, without going through the
        // BridgeGovernance contract.
        await bridgeGovernance
          .connect(governance)
          .beginBridgeGovernanceTransfer(governance.address)
        await helpers.time.increaseTime(constants.governanceDelay)
        await bridgeGovernance
          .connect(governance)
          .finalizeBridgeGovernanceTransfer()
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the watchtower address is already set", () => {
        before(async () => {
          await createSnapshot()

          await bridge.connect(governance).setRedemptionWatchtower(watchtower)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(governance)
              .setRedemptionWatchtower(thirdParty.address)
          ).to.be.revertedWith("Redemption watchtower already set")
        })
      })

      context("when the watchtower address is not set yet", () => {
        context("when the watchtower address is zero", () => {
          it("should revert", async () => {
            await expect(
              bridge.connect(governance).setRedemptionWatchtower(ZERO_ADDRESS)
            ).to.be.revertedWith(
              "Redemption watchtower address must not be 0x0"
            )
          })
        })

        context("when the watchtower address is non-zero", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            tx = await bridge
              .connect(governance)
              .setRedemptionWatchtower(watchtower)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should set the watchtower address", async () => {
            expect(await bridge.getRedemptionWatchtower()).to.equal(watchtower)
          })

          it("should emit RedemptionWatchtowerSet event", async () => {
            await expect(tx)
              .to.emit(bridge, "RedemptionWatchtowerSet")
              .withArgs(watchtower)
          })
        })
      })
    })
  })

  describe("setRebateStaking", () => {
    const rebateStakingAddr = "0xE41d2489571d322189246DaFA5ebDe1F4699F498"

    context("when caller is not the contract guvnor", () => {
      it("should revert", async () => {
        await expect(
          bridge.connect(thirdParty).setRebateStaking(rebateStakingAddr)
        ).to.be.revertedWith("Caller is not the governance")
      })
    })

    context("when caller is the contract guvnor", () => {
      before(async () => {
        await createSnapshot()

        // We transfer the ownership of the Bridge governance from the
        // BridgeGovernance contract to a simple address. This allows testing
        // the Bridge contract directly, without going through the
        // BridgeGovernance contract.
        await bridgeGovernance
          .connect(governance)
          .beginBridgeGovernanceTransfer(governance.address)
        await helpers.time.increaseTime(constants.governanceDelay)
        await bridgeGovernance
          .connect(governance)
          .finalizeBridgeGovernanceTransfer()
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the rebate staking address is already set", () => {
        before(async () => {
          await createSnapshot()

          await bridge.connect(governance).setRebateStaking(rebateStakingAddr)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge.connect(governance).setRebateStaking(thirdParty.address)
          ).to.be.revertedWith("Rebate staking already set")
        })
      })

      context("when the rebate staking address is not set yet", () => {
        context("when the rebate staking address is zero", () => {
          it("should revert", async () => {
            await expect(
              bridge.connect(governance).setRebateStaking(ZERO_ADDRESS)
            ).to.be.revertedWith("Rebate staking address must not be 0x0")
          })
        })

        context("when the rebate staking address is non-zero", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            tx = await bridge
              .connect(governance)
              .setRebateStaking(rebateStakingAddr)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should set the rebate staking address", async () => {
            expect(await bridge.getRebateStaking()).to.equal(rebateStakingAddr)
          })

          it("should emit RebateStakingSet event", async () => {
            await expect(tx)
              .to.emit(bridge, "RebateStakingSet")
              .withArgs(rebateStakingAddr)
          })
        })
      })
    })
  })
})
