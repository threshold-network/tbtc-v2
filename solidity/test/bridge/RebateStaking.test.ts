import { helpers, waffle, ethers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import {
  BigNumber,
  BigNumberish,
  BytesLike,
  Contract,
  ContractTransaction,
} from "ethers"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  RebateStaking,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"

const { impersonateAccount } = helpers.account
const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

describe("RebateStaking", () => {
  let governance: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let t: Contract
  let rebateStaking: RebateStaking
  let deployer: SignerWithAddress

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, governance, bridge, bridgeGovernance, t, rebateStaking } =
      await waffle.loadFixture(bridgeFixture))

    await bridgeGovernance
      .connect(governance)
      .setRebateStaking(rebateStaking.address)
  })

  describe("updateWatchtowerParameters", () => {
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

    context("when called by the watchtower manager", () => {
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
})
