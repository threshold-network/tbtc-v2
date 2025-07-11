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

describe("RebateStaking", () => {
  let governance: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let t: Contract
  let rebateStaking: RebateStaking
  let deployer: SignerWithAddress
  let thirdParty: SignerWithAddress

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
            ).to.be.revertedWith("Rolling window cannot be zero")
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
            .applyForRebate(thirdParty.address, treasuryFee)
        ).to.be.revertedWith("Caller is not the bridge")
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
        const stakeAmount = to1e18(450000)
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
        ).to.be.revertedWith("Caller is not the bridge")
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
        const stakeAmount = to1e18(450000)
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

    context("when user didn't have previous stake", () => {
      const stakeAmount = to1e18(450000)
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
      const stakeAmount1 = to1e18(4500000)
      const stakeAmount2 = to1e18(1800000)
      const stakeAmount = stakeAmount1.add(stakeAmount2)
      const rebateCap = to1e18(14)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await t.connect(deployer).mint(thirdParty.address, stakeAmount)
        await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
        await rebateStaking.connect(thirdParty).stake(stakeAmount1)
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
  })

  describe("startUnstaking", () => {
    const stakeAmount = to1e18(4500000)

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
        ).to.be.revertedWith("Amount cannot be 0")
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
        ).to.be.revertedWith("Amount is too big")
      })
    })

    context("when user didn't have previous stake", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking.connect(governance).startUnstaking(stakeAmount)
        ).to.be.revertedWith("Amount is too big")
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
        ).to.be.revertedWith("Unstaking already started")
      })
    })

    context("when user unstakes part of the stake", () => {
      const unstakeAmount = to1e18(1800000)
      const rebateCap = to1e18(10)
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

      it("should keep rebate cap", async () => {
        expect(
          await rebateStaking.getRebateCap(thirdParty.address)
        ).to.be.equal(rebateCap)
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

    context("when there is no stake", () => {
      it("should revert", async () => {
        await expect(
          rebateStaking.connect(governance).finalizeUnstaking()
        ).to.be.revertedWith("No unstaking process")
      })
    })

    context("when unstaking is not finished", () => {
      const stakeAmount = to1e18(450000)
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
          rebateStaking.connect(thirdParty).finalizeUnstaking()
        ).to.be.revertedWith("No finished unstaking process")
      })
    })

    context("when user finishes unstaking process", () => {
      const stakeAmount = to1e18(4500000)
      const unstakeAmount = to1e18(1350000)
      const expectedStake = stakeAmount.sub(unstakeAmount)
      const rebateCap = to1e18(7)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await t.connect(deployer).mint(thirdParty.address, stakeAmount)
        await t.connect(thirdParty).approve(rebateStaking.address, stakeAmount)
        await rebateStaking.connect(thirdParty).stake(stakeAmount)
        await rebateStaking.connect(thirdParty).startUnstaking(unstakeAmount)

        const unstakingPeriod = await rebateStaking.unstakingPeriod()
        await increaseTime(unstakingPeriod)
        tx = await rebateStaking.connect(thirdParty).finalizeUnstaking()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer tokens to the user", async () => {
        expect(await t.balanceOf(thirdParty.address)).to.be.equal(unstakeAmount)
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
  })
})
