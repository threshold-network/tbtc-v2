import { helpers, waffle, ethers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { Contract, ContractTransaction } from "ethers"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  RebateStaking,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { to1e18 } from "../helpers/contract-test-helpers"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time
const rebateTreasuryFeeMode = {
  both: 0,
  depositOnly: 1,
  redemptionOnly: 2,
}

const ZERO_ADDRESS = ethers.constants.AddressZero

describe("RebateStaking", () => {
  let governance: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let t: Contract
  let rebateStaking: RebateStaking
  let deployer: SignerWithAddress
  let thirdParty: SignerWithAddress
  const defaultStakeAmount = to1e18(100000000)

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      thirdParty,
      bridge,
      bridgeGovernance,
      t,
      rebateStaking,
    } = await waffle.loadFixture(bridgeFixture))

    await bridgeGovernance
      .connect(governance)
      .setRebateStaking(rebateStaking.address)
  })

  describe("updateParameters", () => {
    let rollingWindow: number
    let unstakingPeriod: number
    let rebatePerToken: number

    before(async () => {
      await createSnapshot()

      rollingWindow = (await rebateStaking.rollingWindow()).toNumber() * 2
      unstakingPeriod = (await rebateStaking.unstakingPeriod()).toNumber() * 2
      rebatePerToken = (await rebateStaking.rebatePerToken()).toNumber() * 2
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking.connect(governance).updateRollingWindow(rollingWindow)
        ).to.be.revertedWith("Ownable: caller is not the owne")
        await expect(
          rebateStaking
            .connect(governance)
            .updateUnstakingPeriod(unstakingPeriod)
        ).to.be.revertedWith("Ownable: caller is not the owne")
        await expect(
          rebateStaking.connect(governance).updateRebatePerToken(rebatePerToken)
        ).to.be.revertedWith("Ownable: caller is not the owne")
      })
    })

    context("when called by the owner", () => {
      context("when new parameters are invalid", () => {
        context("when the rolling window is zero", () => {
          it("should revert", async () => {
            await expect(
              rebateStaking.connect(deployer).updateRollingWindow(0)
            ).to.be.revertedWith("RollingWindowCannotBeZero")
          })
        })
      })

      context("when all new parameters are valid", () => {
        let tx: ContractTransaction
        context("when updating rolling window", () => {
          it("should update parameter", async () => {
            tx = await rebateStaking
              .connect(deployer)
              .updateRollingWindow(rollingWindow)
            expect(await rebateStaking.rollingWindow()).to.be.equal(
              rollingWindow
            )
            await expect(tx)
              .to.emit(rebateStaking, "RollingWindowUpdated")
              .withArgs(rollingWindow)
          })
        })
        context("when updating unstaking period", () => {
          it("should update parameter", async () => {
            tx = await rebateStaking
              .connect(deployer)
              .updateUnstakingPeriod(unstakingPeriod)
            expect(await rebateStaking.unstakingPeriod()).to.be.equal(
              unstakingPeriod
            )
            await expect(tx)
              .to.emit(rebateStaking, "UnstakingPeriodUpdated")
              .withArgs(unstakingPeriod)
          })
        })
        context("when updating rebate per token", () => {
          it("should update parameter", async () => {
            tx = await rebateStaking
              .connect(deployer)
              .updateRebatePerToken(rebatePerToken)
            expect(await rebateStaking.rebatePerToken()).to.be.equal(
              rebatePerToken
            )
            await expect(tx)
              .to.emit(rebateStaking, "RebatePerTokenUpdated")
              .withArgs(rebatePerToken)
          })
        })
      })
    })
  })

  describe("setRebateTreasuryFeeMode", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should use both modes by default", async () => {
      expect(
        await rebateStaking.getRebateTreasuryFeeMode(thirdParty.address)
      ).to.equal(rebateTreasuryFeeMode.both)
    })

    it("should revert for invalid mode", async () => {
      await expect(
        rebateStaking.connect(thirdParty).setRebateTreasuryFeeMode(3)
      ).to.be.reverted
    })

    it("should set mode for caller only", async () => {
      const tx = await rebateStaking
        .connect(thirdParty)
        .setRebateTreasuryFeeMode(rebateTreasuryFeeMode.redemptionOnly)

      expect(
        await rebateStaking.getRebateTreasuryFeeMode(thirdParty.address)
      ).to.equal(rebateTreasuryFeeMode.redemptionOnly)
      expect(
        await rebateStaking.getRebateTreasuryFeeMode(governance.address)
      ).to.equal(rebateTreasuryFeeMode.both)

      await expect(tx)
        .to.emit(rebateStaking, "RebateTreasuryFeeModeUpdated")
        .withArgs(thirdParty.address, rebateTreasuryFeeMode.redemptionOnly)
    })

    it("should allow switching back to both mode", async () => {
      await rebateStaking
        .connect(thirdParty)
        .setRebateTreasuryFeeMode(rebateTreasuryFeeMode.depositOnly)

      const tx = await rebateStaking
        .connect(thirdParty)
        .setRebateTreasuryFeeMode(rebateTreasuryFeeMode.both)

      expect(
        await rebateStaking.getRebateTreasuryFeeMode(thirdParty.address)
      ).to.equal(rebateTreasuryFeeMode.both)

      await expect(tx)
        .to.emit(rebateStaking, "RebateTreasuryFeeModeUpdated")
        .withArgs(thirdParty.address, rebateTreasuryFeeMode.both)
    })
  })

  describe("setDelegatee", () => {
    const stakeAmount = defaultStakeAmount
    let tx: ContractTransaction

    before(async () => {
      await createSnapshot()

      await t.connect(deployer).mint(thirdParty.address, stakeAmount)
      await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
      await rebateStaking.connect(thirdParty).stake(stakeAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert when called not by a staker", async () => {
      await expect(
        rebateStaking.connect(governance).setDelegatee(thirdParty.address)
      ).to.be.revertedWith("NotAStaker")
    })

    context("when trying to delegate to another staker", () => {
      before(async () => {
        await createSnapshot()

        await t.connect(deployer).mint(governance.address, defaultStakeAmount)
        await t
          .connect(governance)
          .approve(rebateStaking.address, defaultStakeAmount)
        await rebateStaking.connect(governance).stake(defaultStakeAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          rebateStaking.connect(governance).setDelegatee(thirdParty.address)
        ).to.be.revertedWith("WrongDelegatee")
      })
    })

    context("when trying to delegate to already used delegatee", () => {
      before(async () => {
        await createSnapshot()
        await t.connect(deployer).mint(governance.address, defaultStakeAmount)
        await t
          .connect(governance)
          .approve(rebateStaking.address, defaultStakeAmount)
        await rebateStaking.connect(governance).stake(defaultStakeAmount)
        await rebateStaking.connect(governance).setDelegatee(deployer.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          rebateStaking.connect(thirdParty).setDelegatee(deployer.address)
        ).to.be.revertedWith("WrongDelegatee")
      })
    })

    context("when user sets first time delegatee", () => {
      before(async () => {
        await createSnapshot()

        tx = await rebateStaking
          .connect(thirdParty)
          .setDelegatee(deployer.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set delegatee <-> delegate relationship", async () => {
        expect(await rebateStaking.delegates(deployer.address)).to.be.equal(
          thirdParty.address
        )
        expect(
          await rebateStaking.getDelegatee(thirdParty.address)
        ).to.be.equal(deployer.address)
      })

      it("should emit event", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "DelegateeSet")
          .withArgs(thirdParty.address, deployer.address)
      })
    })

    context("when user changes delegatee", () => {
      before(async () => {
        await createSnapshot()

        await rebateStaking.connect(thirdParty).setDelegatee(governance.address)
        tx = await rebateStaking
          .connect(thirdParty)
          .setDelegatee(deployer.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set delegatee <-> delegate relationship", async () => {
        expect(await rebateStaking.delegates(deployer.address)).to.be.equal(
          thirdParty.address
        )
        expect(
          await rebateStaking.getDelegatee(thirdParty.address)
        ).to.be.equal(deployer.address)
      })

      it("should emit event", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "DelegateeSet")
          .withArgs(thirdParty.address, deployer.address)
      })
    })

    context("when user resets delegatee", () => {
      before(async () => {
        await createSnapshot()

        await rebateStaking.connect(thirdParty).setDelegatee(deployer.address)
        tx = await rebateStaking.connect(thirdParty).setDelegatee(ZERO_ADDRESS)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set delegatee <-> delegate relationship", async () => {
        expect(await rebateStaking.delegates(deployer.address)).to.be.equal(
          ZERO_ADDRESS
        )
        expect(
          await rebateStaking.getDelegatee(thirdParty.address)
        ).to.be.equal(ZERO_ADDRESS)
      })

      it("should emit event", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "DelegateeSet")
          .withArgs(thirdParty.address, thirdParty.address)
      })
    })
  })

  describe("applyForRebate", () => {
    const treasuryFee = ethers.BigNumber.from(950)

    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the bridge", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking
            .connect(governance)
            .applyForRebate(thirdParty.address, treasuryFee, 0)
        ).to.be.revertedWith("CallerNotBridge")
      })
    })

    context("when called by the bridge", () => {
      context("when user doesn't have a stake", () => {
        before(async () => {
          await createSnapshot()

          await bridge.applyForRebate(thirdParty.address, treasuryFee)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should return fee without change", async () => {
          expect(await bridge.lastTreasuryFee()).to.be.equal(treasuryFee)
        })

        it("should not update any parameters for user", async () => {
          expect(
            await rebateStaking.getRebateCap(thirdParty.address)
          ).to.be.equal(0)
          expect(
            await rebateStaking.getAvailableRebate(thirdParty.address)
          ).to.be.equal(0)
          expect(
            await rebateStaking.getRebateLength(thirdParty.address)
          ).to.be.equal(0)
        })
      })

      context("when user has a stake", () => {
        const stakeAmount = defaultStakeAmount
        const rebateCap = to1e18(1)
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await t.connect(deployer).mint(thirdParty.address, stakeAmount)
          await t
            .connect(thirdParty)
            .approve(rebateStaking.address, stakeAmount)
          await rebateStaking.connect(thirdParty).stake(stakeAmount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when user opts in to redemption-only rebates", () => {
          before(async () => {
            await createSnapshot()

            await rebateStaking
              .connect(thirdParty)
              .setRebateTreasuryFeeMode(rebateTreasuryFeeMode.redemptionOnly)

            tx = await bridge.applyForRebate(thirdParty.address, treasuryFee)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should return fee without change", async () => {
            expect(await bridge.lastTreasuryFee()).to.be.equal(treasuryFee)
          })

          it("should not consume rebate", async () => {
            expect(
              await rebateStaking.getAvailableRebate(thirdParty.address)
            ).to.be.equal(rebateCap)
            expect(
              await rebateStaking.getRebateLength(thirdParty.address)
            ).to.be.equal(0)
          })

          it("should not emit rebate event", async () => {
            await expect(tx).to.not.emit(rebateStaking, "RebateReceived")
          })
        })

        context(
          "when user opts in to deposit-only rebates for redemption fee type",
          () => {
            before(async () => {
              await createSnapshot()

              await rebateStaking
                .connect(thirdParty)
                .setRebateTreasuryFeeMode(rebateTreasuryFeeMode.depositOnly)

              tx = await bridge.applyForRedemptionRebate(
                thirdParty.address,
                treasuryFee
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should return fee without change", async () => {
              expect(await bridge.lastTreasuryFee()).to.be.equal(treasuryFee)
            })

            it("should not consume rebate", async () => {
              expect(
                await rebateStaking.getAvailableRebate(thirdParty.address)
              ).to.be.equal(rebateCap)
              expect(
                await rebateStaking.getRebateLength(thirdParty.address)
              ).to.be.equal(0)
            })

            it("should not emit rebate event", async () => {
              await expect(tx).to.not.emit(rebateStaking, "RebateReceived")
            })
          }
        )

        context("when user has sufficient stake to cover fees", () => {
          before(async () => {
            await createSnapshot()

            tx = await bridge.applyForRebate(thirdParty.address, treasuryFee)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should return zero fees", async () => {
            expect(await bridge.lastTreasuryFee()).to.be.equal(0)
          })

          it("should decrease available rebate for user", async () => {
            expect(
              await rebateStaking.getRebateCap(thirdParty.address)
            ).to.be.equal(rebateCap)
            expect(
              await rebateStaking.getAvailableRebate(thirdParty.address)
            ).to.be.equal(rebateCap.sub(treasuryFee))
          })

          it("should add rebate to the array", async () => {
            expect(
              await rebateStaking.getRebateLength(thirdParty.address)
            ).to.be.equal(1)
            const [timestamp, rebateAmount] = await rebateStaking.getRebate(
              thirdParty.address,
              0
            )
            expect(timestamp).to.be.equal(await lastBlockTime())
            expect(rebateAmount).to.be.equal(treasuryFee)
          })

          it("should emit event", async () => {
            await expect(tx)
              .to.emit(rebateStaking, "RebateReceived")
              .withArgs(thirdParty.address, treasuryFee)
          })
        })

        context(
          "when user has sufficient stake to cover only part of fees",
          () => {
            const fee = rebateCap.sub(treasuryFee.div(3))
            const expectedRebate = rebateCap.sub(fee)

            before(async () => {
              await createSnapshot()

              await bridge.applyForRebate(thirdParty.address, fee)

              tx = await bridge.applyForRebate(thirdParty.address, treasuryFee)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should return decreased fees", async () => {
              expect(await bridge.lastTreasuryFee()).to.be.equal(
                treasuryFee.sub(expectedRebate)
              )
            })

            it("should decrease available rebate for user", async () => {
              expect(
                await rebateStaking.getRebateCap(thirdParty.address)
              ).to.be.equal(rebateCap)
              expect(
                await rebateStaking.getAvailableRebate(thirdParty.address)
              ).to.be.equal(0)
            })

            it("should add rebate to the array", async () => {
              expect(
                await rebateStaking.getRebateLength(thirdParty.address)
              ).to.be.equal(2)
              const [, rebateAmount1] = await rebateStaking.getRebate(
                thirdParty.address,
                0
              )
              expect(rebateAmount1).to.be.equal(fee)
              const [timestamp2, rebateAmount2] = await rebateStaking.getRebate(
                thirdParty.address,
                1
              )
              expect(timestamp2).to.be.equal(await lastBlockTime())
              expect(rebateAmount2).to.be.equal(expectedRebate)
            })

            it("should emit event", async () => {
              await expect(tx)
                .to.emit(rebateStaking, "RebateReceived")
                .withArgs(thirdParty.address, expectedRebate)
            })
          }
        )

        context("when user waits rolling window to shift", () => {
          const fee1 = rebateCap.div(3)
          const fee2 = rebateCap.mul(2).div(3)

          before(async () => {
            await createSnapshot()
            const rollingWindow = (
              await rebateStaking.rollingWindow()
            ).toNumber()

            await bridge.applyForRebate(thirdParty.address, fee1)

            await increaseTime(rollingWindow / 3)

            await bridge.applyForRebate(thirdParty.address, fee2)

            await increaseTime((rollingWindow * 2) / 3)

            tx = await bridge.applyForRebate(thirdParty.address, treasuryFee)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should return zero fees", async () => {
            expect(await bridge.lastTreasuryFee()).to.be.equal(0)
          })

          it("should update available rebate for user", async () => {
            expect(
              await rebateStaking.getRebateCap(thirdParty.address)
            ).to.be.equal(rebateCap)
            expect(
              await rebateStaking.getAvailableRebate(thirdParty.address)
            ).to.be.equal(rebateCap.sub(fee2).sub(treasuryFee))
          })

          it("should add rebate to the array", async () => {
            expect(
              await rebateStaking.getRebateLength(thirdParty.address)
            ).to.be.equal(3)
            const [timestamp, rebateAmount] = await rebateStaking.getRebate(
              thirdParty.address,
              2
            )
            expect(timestamp).to.be.equal(await lastBlockTime())
            expect(rebateAmount).to.be.equal(treasuryFee)
          })

          it("should emit event", async () => {
            await expect(tx)
              .to.emit(rebateStaking, "RebateReceived")
              .withArgs(thirdParty.address, treasuryFee)
          })
        })

        context("when user delegates rebate", () => {
          before(async () => {
            await createSnapshot()
            await rebateStaking
              .connect(thirdParty)
              .setDelegatee(deployer.address)
            tx = await bridge.applyForRebate(deployer.address, treasuryFee)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should return zero fees", async () => {
            expect(await bridge.lastTreasuryFee()).to.be.equal(0)
          })

          it("should update available rebate for user", async () => {
            expect(
              await rebateStaking.getAvailableRebate(thirdParty.address)
            ).to.be.equal(rebateCap.sub(treasuryFee))
          })

          it("should add rebate to the array", async () => {
            expect(
              await rebateStaking.getRebateLength(thirdParty.address)
            ).to.be.equal(1)
            const [timestamp, rebateAmount] = await rebateStaking.getRebate(
              thirdParty.address,
              0
            )
            expect(timestamp).to.be.equal(await lastBlockTime())
            expect(rebateAmount).to.be.equal(treasuryFee)
            expect(
              await rebateStaking.getRebateLength(deployer.address)
            ).to.be.equal(0)
          })

          it("should emit event", async () => {
            await expect(tx)
              .to.emit(rebateStaking, "RebateReceived")
              .withArgs(thirdParty.address, treasuryFee)
          })
        })

        context("when user delegates rebate to existing user", () => {
          before(async () => {
            await createSnapshot()

            await rebateStaking
              .connect(thirdParty)
              .setDelegatee(deployer.address)
            await t.connect(deployer).mint(deployer.address, stakeAmount)
            await t
              .connect(deployer)
              .approve(rebateStaking.address, stakeAmount)
            await rebateStaking.connect(deployer).stake(stakeAmount)

            tx = await bridge.applyForRebate(deployer.address, treasuryFee)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should return zero fees", async () => {
            expect(await bridge.lastTreasuryFee()).to.be.equal(0)
          })

          it("should update available rebate for user", async () => {
            expect(
              await rebateStaking.getAvailableRebate(deployer.address)
            ).to.be.equal(rebateCap.sub(treasuryFee))
          })

          it("should add rebate to the array", async () => {
            expect(
              await rebateStaking.getRebateLength(deployer.address)
            ).to.be.equal(1)
            const [timestamp, rebateAmount] = await rebateStaking.getRebate(
              deployer.address,
              0
            )
            expect(timestamp).to.be.equal(await lastBlockTime())
            expect(rebateAmount).to.be.equal(treasuryFee)
            expect(
              await rebateStaking.getRebateLength(thirdParty.address)
            ).to.be.equal(0)
          })

          it("should emit event", async () => {
            await expect(tx)
              .to.emit(rebateStaking, "RebateReceived")
              .withArgs(deployer.address, treasuryFee)
          })
        })
      })
    })
  })

  describe("cancelRebate", () => {
    const treasuryFee = ethers.BigNumber.from(950)

    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the bridge", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking
            .connect(governance)
            .cancelRebate(thirdParty.address, await lastBlockTime())
        ).to.be.revertedWith("CallerNotBridge")
      })
    })

    context("when called by the bridge", () => {
      context("when user doesn't have a stake", () => {
        before(async () => {
          await createSnapshot()

          await bridge.cancelRebate(thirdParty.address, await lastBlockTime())
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should not update any parameters for user", async () => {
          expect(
            await rebateStaking.getRebateCap(thirdParty.address)
          ).to.be.equal(0)
          expect(
            await rebateStaking.getAvailableRebate(thirdParty.address)
          ).to.be.equal(0)
          expect(
            await rebateStaking.getRebateLength(thirdParty.address)
          ).to.be.equal(0)
        })
      })

      context("when user has a stake", () => {
        const stakeAmount = defaultStakeAmount
        const rebateCap = to1e18(1)
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await t.connect(deployer).mint(thirdParty.address, stakeAmount)
          await t
            .connect(thirdParty)
            .approve(rebateStaking.address, stakeAmount)
          await rebateStaking.connect(thirdParty).stake(stakeAmount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when user doesn't have any rebates", () => {
          before(async () => {
            await createSnapshot()

            await bridge.cancelRebate(thirdParty.address, await lastBlockTime())
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should not update any parameters for user", async () => {
            expect(
              await rebateStaking.getRebateCap(thirdParty.address)
            ).to.be.equal(rebateCap)
            expect(
              await rebateStaking.getAvailableRebate(thirdParty.address)
            ).to.be.equal(rebateCap)
            expect(
              await rebateStaking.getRebateLength(thirdParty.address)
            ).to.be.equal(0)
          })
        })

        context("when user has previous rebates", () => {
          context("when there is no rebate with specified timestamp", () => {
            before(async () => {
              await createSnapshot()

              const timestamp = await lastBlockTime()
              await bridge.applyForRebate(thirdParty.address, treasuryFee)
              await bridge.applyForRebate(thirdParty.address, treasuryFee)
              await bridge.applyForRebate(thirdParty.address, treasuryFee)

              await bridge.cancelRebate(thirdParty.address, timestamp)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should not update any parameters for user", async () => {
              expect(
                await rebateStaking.getRebateCap(thirdParty.address)
              ).to.be.equal(rebateCap)
              expect(
                await rebateStaking.getAvailableRebate(thirdParty.address)
              ).to.be.equal(rebateCap.sub(treasuryFee.mul(3)))
              expect(
                await rebateStaking.getRebateLength(thirdParty.address)
              ).to.be.equal(3)
            })
          })

          context(
            "when rebate with specified timestamp outside rolling window",
            () => {
              before(async () => {
                await createSnapshot()

                const rollingWindow = (
                  await rebateStaking.rollingWindow()
                ).toNumber()

                await bridge.applyForRebate(thirdParty.address, treasuryFee)
                const timestamp = await lastBlockTime()
                await increaseTime(rollingWindow)
                await bridge.applyForRebate(thirdParty.address, treasuryFee)
                await bridge.applyForRebate(thirdParty.address, treasuryFee)

                await bridge.cancelRebate(thirdParty.address, timestamp)
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should not update any parameters for user", async () => {
                expect(
                  await rebateStaking.getRebateCap(thirdParty.address)
                ).to.be.equal(rebateCap)
                expect(
                  await rebateStaking.getAvailableRebate(thirdParty.address)
                ).to.be.equal(rebateCap.sub(treasuryFee.mul(2)))
                expect(
                  await rebateStaking.getRebateLength(thirdParty.address)
                ).to.be.equal(3)
              })
            }
          )

          context("when cancels rebate", () => {
            let timestamp: number
            before(async () => {
              await createSnapshot()

              await bridge.applyForRebate(thirdParty.address, treasuryFee)
              await bridge.applyForRebate(thirdParty.address, treasuryFee)
              await bridge.applyForRebate(thirdParty.address, treasuryFee)

              timestamp = await lastBlockTime()
              tx = await bridge.cancelRebate(thirdParty.address, timestamp)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should update available rebate for user", async () => {
              expect(
                await rebateStaking.getRebateCap(thirdParty.address)
              ).to.be.equal(rebateCap)
              expect(
                await rebateStaking.getAvailableRebate(thirdParty.address)
              ).to.be.equal(rebateCap.sub(treasuryFee.mul(2)))
            })

            it("should delete rebate from the array", async () => {
              expect(
                await rebateStaking.getRebateLength(thirdParty.address)
              ).to.be.equal(3)
              const [time, rebateAmount] = await rebateStaking.getRebate(
                thirdParty.address,
                2
              )
              expect(rebateAmount).to.be.equal(0)
              expect(time).to.be.equal(timestamp)
            })

            it("should emit event", async () => {
              await expect(tx)
                .to.emit(rebateStaking, "RebateCanceled")
                .withArgs(thirdParty.address, timestamp)
            })
          })

          context("when cancels delegate's rebate", () => {
            let timestamp: number
            before(async () => {
              await createSnapshot()
              await rebateStaking
                .connect(thirdParty)
                .setDelegatee(deployer.address)

              await bridge.applyForRebate(thirdParty.address, treasuryFee)
              await bridge.applyForRebate(thirdParty.address, treasuryFee)
              await bridge.applyForRebate(thirdParty.address, treasuryFee)

              timestamp = await lastBlockTime()
              tx = await bridge.cancelRebate(deployer.address, timestamp)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should update available rebate for user", async () => {
              expect(
                await rebateStaking.getRebateCap(thirdParty.address)
              ).to.be.equal(rebateCap)
              expect(
                await rebateStaking.getAvailableRebate(thirdParty.address)
              ).to.be.equal(rebateCap.sub(treasuryFee.mul(2)))
            })

            it("should delete rebate from the array", async () => {
              expect(
                await rebateStaking.getRebateLength(thirdParty.address)
              ).to.be.equal(3)
              const [time, rebateAmount] = await rebateStaking.getRebate(
                thirdParty.address,
                2
              )
              expect(rebateAmount).to.be.equal(0)
              expect(time).to.be.equal(timestamp)
            })

            it("should emit event", async () => {
              await expect(tx)
                .to.emit(rebateStaking, "RebateCanceled")
                .withArgs(thirdParty.address, timestamp)
            })
          })
        })
      })
    })
  })

  describe("stake", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when amount is zero", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking.connect(thirdParty).stake(0)
        ).to.be.revertedWith("AmountCannotBeZero")
      })
    })

    context("when user didn't have previous stake", () => {
      const stakeAmount = defaultStakeAmount
      const rebateCap = to1e18(1)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await t.connect(deployer).mint(thirdParty.address, stakeAmount)
        await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
        tx = await rebateStaking.connect(thirdParty).stake(stakeAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer tokens to the staking contract", async () => {
        expect(await t.balanceOf(thirdParty.address)).to.be.equal(0)
        expect(await t.balanceOf(rebateStaking.address)).to.be.equal(
          stakeAmount
        )
      })

      it("should update staking amount", async () => {
        expect(await rebateStaking.getStake(thirdParty.address)).to.be.equal(
          stakeAmount
        )
      })

      it("should update rebate cap", async () => {
        expect(
          await rebateStaking.getRebateCap(thirdParty.address)
        ).to.be.equal(rebateCap)
      })

      it("should emit event", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "Staked")
          .withArgs(thirdParty.address, stakeAmount)
      })
    })

    context("when user tops-up stake", () => {
      const stakeAmount1 = defaultStakeAmount.mul(10)
      const stakeAmount2 = to1e18(400000000)
      const stakeAmount = stakeAmount1.add(stakeAmount2)
      const rebateCap = to1e18(14)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await t.connect(deployer).mint(thirdParty.address, stakeAmount)
        await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
        await rebateStaking.connect(thirdParty).stake(stakeAmount1)
        await rebateStaking.connect(thirdParty).setDelegatee(deployer.address)

        tx = await rebateStaking.connect(thirdParty).stake(stakeAmount2)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer tokens to the staking contract", async () => {
        expect(await t.balanceOf(thirdParty.address)).to.be.equal(0)
        expect(await t.balanceOf(rebateStaking.address)).to.be.equal(
          stakeAmount
        )
      })

      it("should update staking amount", async () => {
        expect(await rebateStaking.getStake(thirdParty.address)).to.be.equal(
          stakeAmount
        )
      })

      it("should not update delegatee", async () => {
        expect(await rebateStaking.delegates(deployer.address)).to.be.equal(
          thirdParty.address
        )
        expect(
          await rebateStaking.getDelegatee(thirdParty.address)
        ).to.be.equal(deployer.address)
      })

      it("should update rebate cap", async () => {
        expect(
          await rebateStaking.getRebateCap(thirdParty.address)
        ).to.be.equal(rebateCap)
      })

      it("should emit event", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "Staked")
          .withArgs(thirdParty.address, stakeAmount2)
      })
    })

    context("when someone's delegatee create new stake", () => {
      const stakeAmount = defaultStakeAmount
      const rebateCap = to1e18(1)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await t.connect(deployer).mint(deployer.address, stakeAmount)
        await t.connect(deployer).approve(rebateStaking.address, stakeAmount)
        await t.connect(deployer).mint(thirdParty.address, stakeAmount)
        await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
        await rebateStaking.connect(deployer).stake(stakeAmount)
        await rebateStaking.connect(deployer).setDelegatee(thirdParty.address)

        tx = await rebateStaking.connect(thirdParty).stake(stakeAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should reset delegatee for the first staker", async () => {
        expect(await rebateStaking.delegates(deployer.address)).to.be.equal(
          ZERO_ADDRESS
        )
        expect(await rebateStaking.getDelegatee(deployer.address)).to.be.equal(
          ZERO_ADDRESS
        )
        expect(await rebateStaking.delegates(thirdParty.address)).to.be.equal(
          ZERO_ADDRESS
        )
        expect(
          await rebateStaking.getDelegatee(thirdParty.address)
        ).to.be.equal(ZERO_ADDRESS)
      })

      it("should emit events", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "Staked")
          .withArgs(thirdParty.address, stakeAmount)
        await expect(tx)
          .to.emit(rebateStaking, "DelegateeSet")
          .withArgs(deployer.address, deployer.address)
      })
    })
  })

  describe("startUnstaking", () => {
    const stakeAmount = defaultStakeAmount.mul(10)

    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when amount to unstake is 0", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking.connect(governance).startUnstaking(0)
        ).to.be.revertedWith("AmountCannotBeZero")
      })
    })

    context("when user tries to unstake more than stake amount", () => {
      before(async () => {
        await createSnapshot()
        await t.connect(deployer).mint(thirdParty.address, stakeAmount)
        await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
        await rebateStaking.connect(thirdParty).stake(stakeAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          rebateStaking.connect(governance).startUnstaking(stakeAmount.add(1))
        ).to.be.revertedWith("AmountTooBig")
      })
    })

    context("when user didn't have previous stake", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking.connect(governance).startUnstaking(stakeAmount)
        ).to.be.revertedWith("AmountTooBig")
      })
    })

    context("when user tries to unstake again before finalization", () => {
      before(async () => {
        await createSnapshot()
        await t.connect(deployer).mint(thirdParty.address, stakeAmount)
        await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
        await rebateStaking.connect(thirdParty).stake(stakeAmount)
        await rebateStaking.connect(thirdParty).startUnstaking(stakeAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })
      it("should revert", async () => {
        await expect(
          rebateStaking.connect(thirdParty).startUnstaking(1)
        ).to.be.revertedWith("UnstakingAlreadyStarted")
      })
    })

    context("when user unstakes part of the stake", () => {
      const unstakeAmount = to1e18(400000000)
      const rebateCap = to1e18(10)
      const newRebateCap = to1e18(6)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await t.connect(deployer).mint(thirdParty.address, stakeAmount)
        await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
        await rebateStaking.connect(thirdParty).stake(stakeAmount)
        tx = await rebateStaking
          .connect(thirdParty)
          .startUnstaking(unstakeAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should keep tokens at the staking contract before finalization", async () => {
        expect(await t.balanceOf(thirdParty.address)).to.be.equal(0)
        expect(await t.balanceOf(rebateStaking.address)).to.be.equal(
          stakeAmount
        )
      })

      it("should update unstaking amount", async () => {
        expect(await rebateStaking.getStake(thirdParty.address)).to.be.equal(
          stakeAmount
        )
        const [unstakingAmount, unstakingTimestamp] =
          await rebateStaking.getUnstakingAmount(thirdParty.address)
        expect(unstakingAmount).to.be.equal(unstakeAmount)
        expect(unstakingTimestamp).to.be.equal(await lastBlockTime())
      })

      it("should decrease rebate cap", async () => {
        expect(
          await rebateStaking.getRebateCap(thirdParty.address)
        ).to.be.equal(newRebateCap)
      })

      it("should emit event", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "UnstakeStarted")
          .withArgs(thirdParty.address, unstakeAmount)
      })
    })
  })

  describe("finalizeUnstaking", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when receiver is zero address", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking
            .connect(thirdParty)
            .finalizeUnstaking(ethers.constants.AddressZero)
        ).to.be.revertedWith("ZeroAddress")
      })
    })

    context("when there is no stake", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking
            .connect(governance)
            .finalizeUnstaking(governance.address)
        ).to.be.revertedWith("NoUnstakingProcess")
      })
    })

    context("when unstaking is not finished", () => {
      const stakeAmount = defaultStakeAmount
      before(async () => {
        await createSnapshot()
        await t.connect(deployer).mint(thirdParty.address, stakeAmount)
        await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
        await rebateStaking.connect(thirdParty).stake(stakeAmount)
        await rebateStaking.connect(thirdParty).startUnstaking(stakeAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          rebateStaking
            .connect(thirdParty)
            .finalizeUnstaking(thirdParty.address)
        ).to.be.revertedWith("UnstakingNotFinished")
      })
    })

    context("when user finishes partial unstaking process", () => {
      const stakeAmount = defaultStakeAmount.mul(10)
      const unstakeAmount = to1e18(300000000)
      const expectedStake = stakeAmount.sub(unstakeAmount)
      const rebateCap = to1e18(7)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await t.connect(deployer).mint(thirdParty.address, stakeAmount)
        await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
        await rebateStaking.connect(thirdParty).stake(stakeAmount)
        await rebateStaking.connect(thirdParty).startUnstaking(unstakeAmount)
        await rebateStaking.connect(thirdParty).setDelegatee(deployer.address)

        const unstakingPeriod = await rebateStaking.unstakingPeriod()
        await increaseTime(unstakingPeriod)
        tx = await rebateStaking
          .connect(thirdParty)
          .finalizeUnstaking(governance.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer tokens to the user", async () => {
        expect(await t.balanceOf(thirdParty.address)).to.be.equal(0)
        expect(await t.balanceOf(governance.address)).to.be.equal(unstakeAmount)
        expect(await t.balanceOf(rebateStaking.address)).to.be.equal(
          expectedStake
        )
      })

      it("should reset unstaking amount", async () => {
        expect(await rebateStaking.getStake(thirdParty.address)).to.be.equal(
          expectedStake
        )
        const [unstakingAmount, unstakingTimestamp] =
          await rebateStaking.getUnstakingAmount(thirdParty.address)
        expect(unstakingAmount).to.be.equal(0)
        expect(unstakingTimestamp).to.be.equal(0)
      })

      it("should reset delegatee", async () => {
        expect(await rebateStaking.delegates(deployer.address)).to.be.equal(
          thirdParty.address
        )
        expect(
          await rebateStaking.getDelegatee(thirdParty.address)
        ).to.be.equal(deployer.address)
      })

      it("should decrease rebate cap", async () => {
        expect(
          await rebateStaking.getRebateCap(thirdParty.address)
        ).to.be.equal(rebateCap)
      })

      it("should emit event", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "UnstakeFinished")
          .withArgs(thirdParty.address, unstakeAmount)
      })
    })

    context("when user finishes full unstaking process", () => {
      const stakeAmount = defaultStakeAmount.mul(10)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await t.connect(deployer).mint(thirdParty.address, stakeAmount)
        await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
        await rebateStaking.connect(thirdParty).stake(stakeAmount)
        await rebateStaking.connect(thirdParty).startUnstaking(stakeAmount)
        await rebateStaking.connect(thirdParty).setDelegatee(deployer.address)

        const unstakingPeriod = await rebateStaking.unstakingPeriod()
        await increaseTime(unstakingPeriod)
        tx = await rebateStaking
          .connect(thirdParty)
          .finalizeUnstaking(governance.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer tokens to the user", async () => {
        expect(await t.balanceOf(thirdParty.address)).to.be.equal(0)
        expect(await t.balanceOf(governance.address)).to.be.equal(stakeAmount)
        expect(await t.balanceOf(rebateStaking.address)).to.be.equal(0)
      })

      it("should reset unstaking amount", async () => {
        expect(await rebateStaking.getStake(thirdParty.address)).to.be.equal(0)
        const [unstakingAmount, unstakingTimestamp] =
          await rebateStaking.getUnstakingAmount(thirdParty.address)
        expect(unstakingAmount).to.be.equal(0)
        expect(unstakingTimestamp).to.be.equal(0)
      })

      it("should reset delegatee", async () => {
        expect(await rebateStaking.delegates(deployer.address)).to.be.equal(
          ZERO_ADDRESS
        )
        expect(
          await rebateStaking.getDelegatee(thirdParty.address)
        ).to.be.equal(ZERO_ADDRESS)
      })

      it("should decrease rebate cap", async () => {
        expect(
          await rebateStaking.getRebateCap(thirdParty.address)
        ).to.be.equal(0)
      })

      it("should emit event", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "UnstakeFinished")
          .withArgs(thirdParty.address, stakeAmount)
      })
    })
  })

  describe("forceStakeTransfer", () => {
    const stakeAmount = defaultStakeAmount
    const rebateCap = to1e18(1)

    before(async () => {
      await createSnapshot()
      await t.connect(deployer).mint(thirdParty.address, stakeAmount)
      await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
      await rebateStaking.connect(thirdParty).stake(stakeAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking
            .connect(governance)
            .forceStakeTransfer(
              ethers.constants.AddressZero,
              ethers.constants.AddressZero
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when old staker is zero address", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking
            .connect(deployer)
            .forceStakeTransfer(
              ethers.constants.AddressZero,
              governance.address
            )
        ).to.be.revertedWith("ZeroAddress")
      })
    })

    context("when new staker is zero address", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking
            .connect(deployer)
            .forceStakeTransfer(
              thirdParty.address,
              ethers.constants.AddressZero
            )
        ).to.be.revertedWith("ZeroAddress")
      })
    })

    context("when there is no stake", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking
            .connect(deployer)
            .forceStakeTransfer(governance.address, thirdParty.address)
        ).to.be.revertedWith("NotAStaker")
      })
    })

    context("when new address already taken", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking
            .connect(deployer)
            .forceStakeTransfer(thirdParty.address, thirdParty.address)
        ).to.be.revertedWith("AddressAlreadyTaken")
      })
    })

    context("when new staker is an existing delegatee", () => {
      before(async () => {
        await createSnapshot()
        // Set deployer as delegatee for thirdParty
        await rebateStaking.connect(thirdParty).setDelegatee(deployer.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          rebateStaking
            .connect(deployer)
            .forceStakeTransfer(thirdParty.address, deployer.address)
        ).to.be.revertedWith("WrongDelegatee")
      })
    })

    context("when there is no delegatee", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await rebateStaking
          .connect(deployer)
          .forceStakeTransfer(thirdParty.address, governance.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer stake", async () => {
        expect(await rebateStaking.getStake(thirdParty.address)).to.be.equal(0)
        expect(await rebateStaking.getStake(governance.address)).to.be.equal(
          stakeAmount
        )
      })

      it("should update rebate cap", async () => {
        expect(
          await rebateStaking.getRebateCap(thirdParty.address)
        ).to.be.equal(0)
        expect(
          await rebateStaking.getRebateCap(governance.address)
        ).to.be.equal(rebateCap)
      })

      it("should transfer rebateTreasuryFeeMode", async () => {
        // Default mode is Both (0)
        expect(
          await rebateStaking.getRebateTreasuryFeeMode(governance.address)
        ).to.be.equal(0)
        // Old staker should be reset to Both (0)
        expect(
          await rebateStaking.getRebateTreasuryFeeMode(thirdParty.address)
        ).to.be.equal(0)
      })

      it("should emit event", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "TransferFinished")
          .withArgs(thirdParty.address, governance.address)
      })
    })

    context("when rebateTreasuryFeeMode is non-default", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        // Set DepositOnly (1) on old staker
        await rebateStaking.connect(thirdParty).setRebateTreasuryFeeMode(1)

        tx = await rebateStaking
          .connect(deployer)
          .forceStakeTransfer(thirdParty.address, governance.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer non-default rebateTreasuryFeeMode", async () => {
        expect(
          await rebateStaking.getRebateTreasuryFeeMode(governance.address)
        ).to.be.equal(1) // DepositOnly
      })

      it("should reset old staker rebateTreasuryFeeMode to default", async () => {
        expect(
          await rebateStaking.getRebateTreasuryFeeMode(thirdParty.address)
        ).to.be.equal(0) // Both (default)
      })
    })

    context("when unstaking is in progress", () => {
      let unstakingTimestamp: number
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        await rebateStaking.connect(thirdParty).startUnstaking(stakeAmount)
        unstakingTimestamp = await lastBlockTime()
        tx = await rebateStaking
          .connect(deployer)
          .forceStakeTransfer(thirdParty.address, governance.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer unstaking state", async () => {
        const [oldUnstakingAmount, oldUnstakingTimestamp] =
          await rebateStaking.getUnstakingAmount(thirdParty.address)
        expect(oldUnstakingAmount).to.be.equal(0)
        expect(oldUnstakingTimestamp).to.be.equal(0)

        const [newUnstakingAmount, newUnstakingTimestamp] =
          await rebateStaking.getUnstakingAmount(governance.address)
        expect(newUnstakingAmount).to.be.equal(stakeAmount)
        expect(newUnstakingTimestamp).to.be.equal(unstakingTimestamp)
      })

      it("should allow new staker to finalize unstaking", async () => {
        await expect(
          rebateStaking
            .connect(thirdParty)
            .finalizeUnstaking(thirdParty.address)
        ).to.be.revertedWith("NoUnstakingProcess")

        const unstakingPeriod = await rebateStaking.unstakingPeriod()
        await increaseTime(unstakingPeriod)
        await rebateStaking
          .connect(governance)
          .finalizeUnstaking(governance.address)

        expect(await rebateStaking.getStake(governance.address)).to.be.equal(0)
        const [unstakingAmount, unstakingTimestampAfterFinalization] =
          await rebateStaking.getUnstakingAmount(governance.address)
        expect(unstakingAmount).to.be.equal(0)
        expect(unstakingTimestampAfterFinalization).to.be.equal(0)
        expect(await t.balanceOf(governance.address)).to.be.equal(stakeAmount)
      })

      it("should emit transfer event", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "TransferFinished")
          .withArgs(thirdParty.address, governance.address)
      })
    })

    context("when there is delegatee", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await rebateStaking.connect(thirdParty).setDelegatee(deployer.address)

        tx = await rebateStaking
          .connect(deployer)
          .forceStakeTransfer(thirdParty.address, governance.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer stake", async () => {
        expect(await rebateStaking.getStake(thirdParty.address)).to.be.equal(0)
        expect(await rebateStaking.getStake(governance.address)).to.be.equal(
          stakeAmount
        )
      })

      it("should update rebate cap", async () => {
        expect(
          await rebateStaking.getRebateCap(thirdParty.address)
        ).to.be.equal(0)
        expect(
          await rebateStaking.getRebateCap(governance.address)
        ).to.be.equal(rebateCap)
      })

      it("should set delegatee <-> delegate relationship", async () => {
        expect(
          await rebateStaking.getDelegatee(thirdParty.address)
        ).to.be.equal(ZERO_ADDRESS)
        expect(await rebateStaking.delegates(deployer.address)).to.be.equal(
          governance.address
        )
        expect(
          await rebateStaking.getDelegatee(governance.address)
        ).to.be.equal(deployer.address)
      })

      it("should emit DelegateeSet event", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "DelegateeSet")
          .withArgs(governance.address, deployer.address)
      })

      it("should emit TransferFinished event", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "TransferFinished")
          .withArgs(thirdParty.address, governance.address)
      })
    })
  })
})
