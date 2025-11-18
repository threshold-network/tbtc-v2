import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { ContractTransaction } from "ethers"
import type { BridgeGovernance, Bridge, Bank } from "../../typechain"
import { constants } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"
import { to1e18 } from "../helpers/contract-test-helpers"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Bridge - Governance", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let bridgeGovernance: BridgeGovernance
  let bridge: Bridge
  let guardians: SignerWithAddress[]
  let bank: Bank

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, bridgeGovernance, bridge, guardians, bank } =
      await waffle.loadFixture(bridgeFixture))
  })

  describe("beginGovernanceDelayUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).beginGovernanceDelayUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginGovernanceDelayUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the governance delay", async () => {
        expect(await bridgeGovernance.governanceDelays(0)).to.be.equal(
          constants.governanceDelay
        )
      })
    })
  })

  describe("finalizeGovernanceDelayUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).finalizeGovernanceDelayUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(governance).finalizeGovernanceDelayUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginGovernanceDelayUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(governance).finalizeGovernanceDelayUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginGovernanceDelayUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeGovernanceDelayUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the governance delay", async () => {
          expect(await bridgeGovernance.governanceDelays(0)).to.be.equal(7331)
        })

        it("should reset the governance delay timer", async () => {
          expect(await bridgeGovernance.governanceDelays(2)).to.be.equal(0)
        })
      }
    )
  })

  describe("setAuthorizedBalanceIncreaser", () => {
    const increaser = () => thirdParty.address

    context("when caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .setAuthorizedBalanceIncreaser(increaser(), true)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when increaser address is zero", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .setAuthorizedBalanceIncreaser(ethers.constants.AddressZero, true)
        ).to.be.revertedWith("Increaser address must not be 0x0")
      })
    })

    context("when called by the governance with a valid address", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await bridgeGovernance
          .connect(governance)
          .setAuthorizedBalanceIncreaser(increaser(), true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update increaser authorization", async () => {
        expect(await bridge.authorizedBalanceIncreasers(increaser())).to.be.true
      })

      it("should emit AuthorizedBalanceIncreaserUpdated event", async () => {
        await expect(tx)
          .to.emit(bridge, "AuthorizedBalanceIncreaserUpdated")
          .withArgs(increaser(), true)
      })
    })
  })

  describe("controllerIncreaseBalance", () => {
    const recipient = () => guardians[0].address
    const amount = to1e18(1)

    context("when caller is not authorized", () => {
      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .controllerIncreaseBalance(recipient(), amount)
        ).to.be.revertedWith("Caller is not an authorized increaser")
      })
    })

    context("when caller is authorized", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        await bridgeGovernance
          .connect(governance)
          .setAuthorizedBalanceIncreaser(thirdParty.address, true)
        tx = await bridge
          .connect(thirdParty)
          .controllerIncreaseBalance(recipient(), amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should increase recipient balance in the bank", async () => {
        expect(await bank.balanceOf(recipient())).to.equal(amount)
      })

      it("should emit BalanceIncreased event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceIncreased")
          .withArgs(recipient(), amount)
      })

      it("should emit ControllerBalanceIncreased event", async () => {
        await expect(tx)
          .to.emit(bridge, "ControllerBalanceIncreased")
          .withArgs(thirdParty.address, recipient(), amount)
      })
    })
  })

  describe("controllerIncreaseBalances", () => {
    const recipients = () => guardians.map((guardian) => guardian.address)
    const amounts = [to1e18(1), to1e18(2), to1e18(3)]

    context("when caller is not authorized", () => {
      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .controllerIncreaseBalances(recipients(), amounts)
        ).to.be.revertedWith("Caller is not an authorized increaser")
      })
    })

    context("when caller is authorized", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        await bridgeGovernance
          .connect(governance)
          .setAuthorizedBalanceIncreaser(thirdParty.address, true)
        tx = await bridge
          .connect(thirdParty)
          .controllerIncreaseBalances(recipients(), amounts)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should increase all recipients balances in the bank", async () => {
        const balances = await Promise.all(
          recipients().map((addr) => bank.balanceOf(addr))
        )
        balances.forEach((balance, index) =>
          expect(balance).to.equal(amounts[index])
        )
      })

      it("should emit BalanceIncreased events", async () => {
        await Promise.all(
          recipients().map((addr, index) =>
            expect(tx)
              .to.emit(bank, "BalanceIncreased")
              .withArgs(addr, amounts[index])
          )
        )
      })

      it("should emit ControllerBalancesIncreased event", async () => {
        await expect(tx)
          .to.emit(bridge, "ControllerBalancesIncreased")
          .withArgs(thirdParty.address, recipients(), amounts)
      })
    })
  })

  describe("controller minting circuit breaker", () => {
    const recipient = () => guardians[0].address
    const amount = to1e18(1)

    context("when controller minting is paused", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .setAuthorizedBalanceIncreaser(thirdParty.address, true)

        await bridgeGovernance
          .connect(governance)
          .setControllerMintingPaused(true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should report controller minting as paused", async () => {
        expect(await bridge.controllerMintingPaused()).to.be.true
      })

      it("should revert controllerIncreaseBalance", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .controllerIncreaseBalance(recipient(), amount)
        ).to.be.revertedWith("Controller minting is paused")
      })

      it("should revert controllerIncreaseBalances", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .controllerIncreaseBalances([recipient()], [amount])
        ).to.be.revertedWith("Controller minting is paused")
      })
    })

    context("when controller minting is unpaused again", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .setAuthorizedBalanceIncreaser(thirdParty.address, true)

        await bridgeGovernance
          .connect(governance)
          .setControllerMintingPaused(true)

        await bridgeGovernance
          .connect(governance)
          .setControllerMintingPaused(false)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should report controller minting as not paused", async () => {
        expect(await bridge.controllerMintingPaused()).to.be.false
      })

      it("should allow controllerIncreaseBalance", async () => {
        await bridge
          .connect(thirdParty)
          .controllerIncreaseBalance(recipient(), amount)

        expect(await bank.balanceOf(recipient())).to.equal(amount)
      })
    })
  })

  describe("controller minting lifetime caps", () => {
    const recipient = () => guardians[0].address
    const unit = to1e18(1)
    const lifetimeCap = unit.mul(2)

    context("when caller is authorized and under the cap", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .setAuthorizedBalanceIncreaser(thirdParty.address, true)

        await bridgeGovernance
          .connect(governance)
          .updateControllerMintingConfig(thirdParty.address, lifetimeCap, 0)

        await bridge
          .connect(thirdParty)
          .controllerIncreaseBalance(recipient(), unit)

        await bridge
          .connect(thirdParty)
          .controllerIncreaseBalance(recipient(), unit)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should allow minting up to the lifetime cap", async () => {
        expect(await bank.balanceOf(recipient())).to.equal(lifetimeCap)
      })
    })

    context("when caller attempts to exceed the lifetime cap", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .setAuthorizedBalanceIncreaser(thirdParty.address, true)

        await bridgeGovernance
          .connect(governance)
          .updateControllerMintingConfig(thirdParty.address, lifetimeCap, 0)

        await bridge
          .connect(thirdParty)
          .controllerIncreaseBalance(recipient(), unit.mul(2))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert further minting attempts", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .controllerIncreaseBalance(recipient(), unit)
        ).to.be.revertedWith("Controller minting lifetime cap exceeded")
      })
    })
  })

  describe("controller minting window caps", () => {
    const recipient = () => guardians[0].address
    const unit = to1e18(1)
    const windowCap = unit.mul(2)
    const windowDuration = 60 // 60 seconds

    context("when caller attempts to exceed window cap", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .setAuthorizedBalanceIncreaser(thirdParty.address, true)

        await bridgeGovernance
          .connect(governance)
          .setControllerMintingWindowDuration(windowDuration)

        await bridgeGovernance
          .connect(governance)
          .updateControllerMintingConfig(thirdParty.address, 0, windowCap)

        await bridge
          .connect(thirdParty)
          .controllerIncreaseBalance(recipient(), unit)

        await bridge
          .connect(thirdParty)
          .controllerIncreaseBalance(recipient(), unit)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert minting beyond the window cap", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .controllerIncreaseBalance(recipient(), unit)
        ).to.be.revertedWith("Controller minting window cap exceeded")
      })
    })

    context("when the window has elapsed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .setAuthorizedBalanceIncreaser(thirdParty.address, true)

        await bridgeGovernance
          .connect(governance)
          .setControllerMintingWindowDuration(windowDuration)

        await bridgeGovernance
          .connect(governance)
          .updateControllerMintingConfig(thirdParty.address, 0, windowCap)

        await bridge
          .connect(thirdParty)
          .controllerIncreaseBalance(recipient(), unit.mul(2))

        await helpers.time.increaseTime(windowDuration + 1)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should allow minting again in a new window", async () => {
        await bridge
          .connect(thirdParty)
          .controllerIncreaseBalance(recipient(), unit)

        expect(await bank.balanceOf(recipient())).to.equal(unit.mul(3))
      })
    })
  })

  describe("beginBridgeGovernanceTransfer", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginBridgeGovernanceTransfer(thirdParty.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginBridgeGovernanceTransfer(thirdParty.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the bridge governance", async () => {
        expect(await bridge.governance()).to.be.equal(bridgeGovernance.address)
      })

      it("should not update the bridge governance owner", async () => {
        expect(await bridgeGovernance.owner()).to.be.equal(governance.address)
      })

      it("should emit BridgeGovernanceTransferStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "BridgeGovernanceTransferStarted")
          .withArgs(thirdParty.address, blockTimestamp)
      })
    })
  })

  describe("finalizeBridgeGovernanceTransfer", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeBridgeGovernanceTransfer()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeBridgeGovernanceTransfer()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginBridgeGovernanceTransfer(thirdParty.address)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeBridgeGovernanceTransfer()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginBridgeGovernanceTransfer(thirdParty.address)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeBridgeGovernanceTransfer()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the bridge governance", async () => {
          expect(await bridge.governance()).to.be.equal(thirdParty.address)
        })

        it("should not update the bridgeGovernance owner", async () => {
          expect(await bridgeGovernance.owner()).to.be.equal(governance.address)
        })
      }
    )
  })

  describe("beginDepositDustThresholdUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginDepositDustThresholdUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginDepositDustThresholdUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the deposit dust threshold", async () => {
        const { depositDustThreshold } = await bridge.depositParameters()
        expect(depositDustThreshold).to.be.equal(constants.depositDustThreshold)
      })

      it("should emit DepositDustThresholdUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "DepositDustThresholdUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeDepositDustThresholdUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeDepositDustThresholdUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeDepositDustThresholdUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginDepositDustThresholdUpdate(constants.depositTxMaxFee + 1)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeDepositDustThresholdUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginDepositDustThresholdUpdate(constants.depositTxMaxFee + 1)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeDepositDustThresholdUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the deposit dust threshold", async () => {
          const { depositDustThreshold } = await bridge.depositParameters()
          expect(depositDustThreshold).to.be.equal(
            constants.depositTxMaxFee + 1
          )
        })

        it("should emit DepositDustThresholdUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "DepositDustThresholdUpdated")
            .withArgs(constants.depositTxMaxFee + 1)
        })
      }
    )
  })

  describe("beginDepositTreasuryFeeDivisorUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginDepositTreasuryFeeDivisorUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginDepositTreasuryFeeDivisorUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the deposit treasury fee divisor", async () => {
        const { depositTreasuryFeeDivisor } = await bridge.depositParameters()
        expect(depositTreasuryFeeDivisor).to.be.equal(
          constants.depositTreasuryFeeDivisor
        )
      })

      it("should emit DepositTreasuryFeeDivisorUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "DepositTreasuryFeeDivisorUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeDepositTreasuryFeeDivisorUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeDepositTreasuryFeeDivisorUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeDepositTreasuryFeeDivisorUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginDepositTreasuryFeeDivisorUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeDepositTreasuryFeeDivisorUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginDepositTreasuryFeeDivisorUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeDepositTreasuryFeeDivisorUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the deposit treasury fee divisor", async () => {
          const { depositTreasuryFeeDivisor } = await bridge.depositParameters()
          expect(depositTreasuryFeeDivisor).to.be.equal(7331)
        })

        it("should emit DepositTreasuryFeeDivisorUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "DepositTreasuryFeeDivisorUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginDepositTxMaxFeeUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).beginDepositTxMaxFeeUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginDepositTxMaxFeeUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the deposit tx max fee", async () => {
        const { depositTxMaxFee } = await bridge.depositParameters()
        expect(depositTxMaxFee).to.be.equal(constants.depositTxMaxFee)
      })

      it("should emit DepositTxMaxFeeUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "DepositTxMaxFeeUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeDepositTxMaxFeeUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).finalizeDepositTxMaxFeeUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(governance).finalizeDepositTxMaxFeeUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginDepositTxMaxFeeUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(governance).finalizeDepositTxMaxFeeUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginDepositTxMaxFeeUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeDepositTxMaxFeeUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the deposit tx max fee", async () => {
          const { depositTxMaxFee } = await bridge.depositParameters()
          expect(depositTxMaxFee).to.be.equal(7331)
        })

        it("should emit DepositTxMaxFeeUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "DepositTxMaxFeeUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginDepositRevealAheadPeriodUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginDepositRevealAheadPeriodUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginDepositRevealAheadPeriodUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the deposit reveal ahead period", async () => {
        const { depositRevealAheadPeriod } = await bridge.depositParameters()
        expect(depositRevealAheadPeriod).to.be.equal(
          constants.depositRevealAheadPeriod
        )
      })

      it("should emit DepositRevealAheadPeriodUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "DepositRevealAheadPeriodUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeDepositRevealAheadPeriodUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeDepositRevealAheadPeriodUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeDepositRevealAheadPeriodUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginDepositRevealAheadPeriodUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeDepositRevealAheadPeriodUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginDepositRevealAheadPeriodUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeDepositRevealAheadPeriodUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the deposit reveal ahead period", async () => {
          const { depositRevealAheadPeriod } = await bridge.depositParameters()
          expect(depositRevealAheadPeriod).to.be.equal(7331)
        })

        it("should emit DepositRevealAheadPeriodUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "DepositRevealAheadPeriodUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginRedemptionDustThresholdUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginRedemptionDustThresholdUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginRedemptionDustThresholdUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the redemption dust threshold", async () => {
        const { redemptionDustThreshold } = await bridge.redemptionParameters()
        expect(redemptionDustThreshold).to.be.equal(
          constants.redemptionDustThreshold
        )
      })

      it("should emit RedemptionDustThresholdUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "RedemptionDustThresholdUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeRedemptionDustThresholdUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeRedemptionDustThresholdUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeRedemptionDustThresholdUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginRedemptionDustThresholdUpdate(
            constants.redemptionDustThreshold + 1
          )

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeRedemptionDustThresholdUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionDustThresholdUpdate(
              constants.depositDustThreshold + 1
            )

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionDustThresholdUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the redemption dust threshold", async () => {
          const { redemptionDustThreshold } =
            await bridge.redemptionParameters()
          expect(redemptionDustThreshold).to.be.equal(
            constants.depositDustThreshold + 1
          )
        })

        it("should emit RedemptionDustThresholdUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "RedemptionDustThresholdUpdated")
            .withArgs(constants.depositDustThreshold + 1)
        })
      }
    )
  })

  describe("beginRedemptionTreasuryFeeDivisorUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginRedemptionTreasuryFeeDivisorUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginRedemptionTreasuryFeeDivisorUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the redemption treasury fee divisor", async () => {
        const { redemptionTreasuryFeeDivisor } =
          await bridge.redemptionParameters()
        expect(redemptionTreasuryFeeDivisor).to.be.equal(
          constants.redemptionTreasuryFeeDivisor
        )
      })

      it("should emit RedemptionTreasuryFeeDivisorUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(
            bridgeGovernance,
            "RedemptionTreasuryFeeDivisorUpdateStarted"
          )
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeRedemptionTreasuryFeeDivisorUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeRedemptionTreasuryFeeDivisorUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTreasuryFeeDivisorUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginRedemptionTreasuryFeeDivisorUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTreasuryFeeDivisorUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTreasuryFeeDivisorUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTreasuryFeeDivisorUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the redemption treasury fee divisor", async () => {
          const { redemptionTreasuryFeeDivisor } =
            await bridge.redemptionParameters()
          expect(redemptionTreasuryFeeDivisor).to.be.equal(7331)
        })

        it("should emit RedemptionTreasuryFeeDivisorUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "RedemptionTreasuryFeeDivisorUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginRedemptionTxMaxTotalFeeUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginRedemptionTxMaxTotalFeeUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginRedemptionTxMaxTotalFeeUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the redemption tx max total fee", async () => {
        const { redemptionTxMaxTotalFee } = await bridge.redemptionParameters()
        expect(redemptionTxMaxTotalFee).to.be.equal(
          constants.redemptionTxMaxTotalFee
        )
      })

      it("should emit RedemptionTxMaxTotalFeeUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "RedemptionTxMaxTotalFeeUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeRedemptionTxMaxTotalFeeUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeRedemptionTxMaxTotalFeeUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        // If the update was not initialized, the transaction will fail because
        // the new value of the parameter is 0 and that value is not
        // greater than the redemption transaction per-deposit max fee
        // parameter. The initialization check is done after that.
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTxMaxTotalFeeUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginRedemptionTxMaxTotalFeeUpdate(
            constants.redemptionTxMaxTotalFee * 3
          )

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTxMaxTotalFeeUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTxMaxTotalFeeUpdate(
              constants.redemptionTxMaxTotalFee * 3
            )

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTxMaxTotalFeeUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the redemption tx max total fee", async () => {
          const { redemptionTxMaxTotalFee } =
            await bridge.redemptionParameters()
          expect(redemptionTxMaxTotalFee).to.be.equal(
            constants.redemptionTxMaxTotalFee * 3
          )
        })

        it("should emit RedemptionTxMaxTotalFeeUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "RedemptionTxMaxTotalFeeUpdated")
            .withArgs(constants.redemptionTxMaxTotalFee * 3)
        })
      }
    )
  })

  describe("beginRedemptionTimeoutUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).beginRedemptionTimeoutUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginRedemptionTimeoutUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the redemption timeout", async () => {
        const { redemptionTimeout } = await bridge.redemptionParameters()
        expect(redemptionTimeout).to.be.equal(constants.redemptionTimeout)
      })

      it("should emit RedemptionTimeoutUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "RedemptionTimeoutUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeRedemptionTimeoutUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).finalizeRedemptionTimeoutUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(governance).finalizeRedemptionTimeoutUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginRedemptionTimeoutUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(governance).finalizeRedemptionTimeoutUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTimeoutUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTimeoutUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the redemption timeout", async () => {
          const { redemptionTimeout } = await bridge.redemptionParameters()
          expect(redemptionTimeout).to.be.equal(7331)
        })

        it("should emit RedemptionTimeoutUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "RedemptionTimeoutUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginRedemptionTimeoutSlashingAmountUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginRedemptionTimeoutSlashingAmountUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginRedemptionTimeoutSlashingAmountUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the redemption timeout slashing amount", async () => {
        const { redemptionTimeoutSlashingAmount } =
          await bridge.redemptionParameters()
        expect(redemptionTimeoutSlashingAmount).to.be.equal(
          constants.redemptionTimeoutSlashingAmount
        )
      })

      it("should emit RedemptionTimeoutSlashingAmountUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(
            bridgeGovernance,
            "RedemptionTimeoutSlashingAmountUpdateStarted"
          )
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeRedemptionTimeoutSlashingAmountUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeRedemptionTimeoutSlashingAmountUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTimeoutSlashingAmountUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginRedemptionTimeoutSlashingAmountUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTimeoutSlashingAmountUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTimeoutSlashingAmountUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTimeoutSlashingAmountUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the redemption timeout slashing amount", async () => {
          const { redemptionTimeoutSlashingAmount } =
            await bridge.redemptionParameters()
          expect(redemptionTimeoutSlashingAmount).to.be.equal(7331)
        })

        it("should emit RedemptionTimeoutSlashingAmountUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "RedemptionTimeoutSlashingAmountUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginRedemptionTimeoutNotifierRewardMultiplierUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginRedemptionTimeoutNotifierRewardMultiplierUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginRedemptionTimeoutNotifierRewardMultiplierUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the redemption timeout notifier reward multiplier", async () => {
        const { redemptionTimeoutNotifierRewardMultiplier } =
          await bridge.redemptionParameters()
        expect(redemptionTimeoutNotifierRewardMultiplier).to.be.equal(
          constants.redemptionTimeoutNotifierRewardMultiplier
        )
      })

      it("should emit RedemptionTimeoutNotifierRewardMultiplierUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(
            bridgeGovernance,
            "RedemptionTimeoutNotifierRewardMultiplierUpdateStarted"
          )
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeRedemptionTimeoutNotifierRewardMultiplierUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeRedemptionTimeoutNotifierRewardMultiplierUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTimeoutNotifierRewardMultiplierUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginRedemptionTimeoutNotifierRewardMultiplierUpdate(42)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTimeoutNotifierRewardMultiplierUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginRedemptionTimeoutNotifierRewardMultiplierUpdate(42)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeRedemptionTimeoutNotifierRewardMultiplierUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the redemption timeout notifier reward multiplier", async () => {
          const { redemptionTimeoutNotifierRewardMultiplier } =
            await bridge.redemptionParameters()
          expect(redemptionTimeoutNotifierRewardMultiplier).to.be.equal(42)
        })

        it("should emit RedemptionTimeoutNotifierRewardMultiplierUpdated event", async () => {
          await expect(tx)
            .to.emit(
              bridgeGovernance,
              "RedemptionTimeoutNotifierRewardMultiplierUpdated"
            )
            .withArgs(42)
        })
      }
    )
  })

  describe("beginMovingFundsTxMaxTotalFeeUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginMovingFundsTxMaxTotalFeeUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginMovingFundsTxMaxTotalFeeUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the moving funds tx max total fee", async () => {
        const { movingFundsTxMaxTotalFee } =
          await bridge.movingFundsParameters()
        expect(movingFundsTxMaxTotalFee).to.be.equal(
          constants.movingFundsTxMaxTotalFee
        )
      })

      it("should emit MovingFundsTxMaxTotalFeeUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "MovingFundsTxMaxTotalFeeUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeMovingFundsTxMaxTotalFeeUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeMovingFundsTxMaxTotalFeeUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTxMaxTotalFeeUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginMovingFundsTxMaxTotalFeeUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTxMaxTotalFeeUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsTxMaxTotalFeeUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTxMaxTotalFeeUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the moving funds tx max total fee", async () => {
          const { movingFundsTxMaxTotalFee } =
            await bridge.movingFundsParameters()
          expect(movingFundsTxMaxTotalFee).to.be.equal(7331)
        })

        it("should emit MovingFundsTxMaxTotalFeeUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "MovingFundsTxMaxTotalFeeUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginMovingFundsDustThresholdUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginMovingFundsDustThresholdUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginMovingFundsDustThresholdUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the moving funds dust threshold", async () => {
        const { movingFundsDustThreshold } =
          await bridge.movingFundsParameters()
        expect(movingFundsDustThreshold).to.be.equal(
          constants.movingFundsDustThreshold
        )
      })

      it("should emit MovingFundsDustThresholdUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "MovingFundsDustThresholdUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeMovingFundsDustThresholdUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeMovingFundsDustThresholdUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsDustThresholdUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginMovingFundsDustThresholdUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsDustThresholdUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsDustThresholdUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsDustThresholdUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the moving funds dust threshold", async () => {
          const { movingFundsDustThreshold } =
            await bridge.movingFundsParameters()
          expect(movingFundsDustThreshold).to.be.equal(7331)
        })

        it("should emit MovingFundsDustThresholdUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "MovingFundsDustThresholdUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginMovingFundsTimeoutResetDelayUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginMovingFundsTimeoutResetDelayUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginMovingFundsTimeoutResetDelayUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the moving funds timeout reset delay", async () => {
        const { movingFundsTimeoutResetDelay } =
          await bridge.movingFundsParameters()
        expect(movingFundsTimeoutResetDelay).to.be.equal(
          constants.movingFundsTimeoutResetDelay
        )
      })

      it("should emit MovingFundsTimeoutResetDelayUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(
            bridgeGovernance,
            "MovingFundsTimeoutResetDelayUpdateStarted"
          )
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeMovingFundsTimeoutResetDelayUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeMovingFundsTimeoutResetDelayUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutResetDelayUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginMovingFundsTimeoutResetDelayUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutResetDelayUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsTimeoutResetDelayUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutResetDelayUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the moving funds timeout reset delay", async () => {
          const { movingFundsTimeoutResetDelay } =
            await bridge.movingFundsParameters()
          expect(movingFundsTimeoutResetDelay).to.be.equal(7331)
        })

        it("should emit MovingFundsTimeoutResetDelayUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "MovingFundsTimeoutResetDelayUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginMovingFundsTimeoutUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).beginMovingFundsTimeoutUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginMovingFundsTimeoutUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the moving funds timeout", async () => {
        const { movingFundsTimeout } = await bridge.movingFundsParameters()
        expect(movingFundsTimeout).to.be.equal(constants.movingFundsTimeout)
      })

      it("should emit MovingFundsTimeoutUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "MovingFundsTimeoutUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeMovingFundsTimeoutUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeMovingFundsTimeoutUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginMovingFundsTimeoutUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsTimeoutUpdate(constants.movingFundsTimeout + 1)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the moving funds timeout", async () => {
          const { movingFundsTimeout } = await bridge.movingFundsParameters()
          expect(movingFundsTimeout).to.be.equal(
            constants.movingFundsTimeout + 1
          )
        })

        it("should emit MovingFundsTimeoutUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "MovingFundsTimeoutUpdated")
            .withArgs(constants.movingFundsTimeout + 1)
        })
      }
    )
  })

  describe("beginMovingFundsTimeoutSlashingAmountUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginMovingFundsTimeoutSlashingAmountUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginMovingFundsTimeoutSlashingAmountUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the moving funds timeout slashing amount", async () => {
        const { movingFundsTimeoutSlashingAmount } =
          await bridge.movingFundsParameters()
        expect(movingFundsTimeoutSlashingAmount).to.be.equal(
          constants.movingFundsTimeoutSlashingAmount
        )
      })

      it("should emit MovingFundsTimeoutSlashingAmountUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(
            bridgeGovernance,
            "MovingFundsTimeoutSlashingAmountUpdateStarted"
          )
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeMovingFundsTimeoutSlashingAmountUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeMovingFundsTimeoutSlashingAmountUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutSlashingAmountUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginMovingFundsTimeoutSlashingAmountUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutSlashingAmountUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsTimeoutSlashingAmountUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutSlashingAmountUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the moving funds timeout slashing amount", async () => {
          const { movingFundsTimeoutSlashingAmount } =
            await bridge.movingFundsParameters()
          expect(movingFundsTimeoutSlashingAmount).to.be.equal(7331)
        })

        it("should emit MovingFundsTimeoutSlashingAmountUpdated event", async () => {
          await expect(tx)
            .to.emit(
              bridgeGovernance,
              "MovingFundsTimeoutSlashingAmountUpdated"
            )
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginMovingFundsTimeoutNotifierRewardMultiplierUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginMovingFundsTimeoutNotifierRewardMultiplierUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginMovingFundsTimeoutNotifierRewardMultiplierUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the moving funds timeout notifier reward multiplier", async () => {
        const { movingFundsTimeoutNotifierRewardMultiplier } =
          await bridge.movingFundsParameters()
        expect(movingFundsTimeoutNotifierRewardMultiplier).to.be.equal(
          constants.movingFundsTimeoutNotifierRewardMultiplier
        )
      })

      it("should emit MovingFundsTimeoutNotifierRewardMultiplierUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(
            bridgeGovernance,
            "MovingFundsTimeoutNotifierRewardMultiplierUpdateStarted"
          )
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeMovingFundsTimeoutNotifierRewardMultiplierUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeMovingFundsTimeoutNotifierRewardMultiplierUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutNotifierRewardMultiplierUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginMovingFundsTimeoutNotifierRewardMultiplierUpdate(42)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutNotifierRewardMultiplierUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsTimeoutNotifierRewardMultiplierUpdate(42)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsTimeoutNotifierRewardMultiplierUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the moving funds timeout notifier reward multiplier", async () => {
          const { movingFundsTimeoutNotifierRewardMultiplier } =
            await bridge.movingFundsParameters()
          expect(movingFundsTimeoutNotifierRewardMultiplier).to.be.equal(42)
        })

        it("should emit MovingFundsTimeoutNotifierRewardMultiplierUpdated event", async () => {
          await expect(tx)
            .to.emit(
              bridgeGovernance,
              "MovingFundsTimeoutNotifierRewardMultiplierUpdated"
            )
            .withArgs(42)
        })
      }
    )
  })

  describe("beginMovingFundsCommitmentGasOffsetUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginMovingFundsCommitmentGasOffsetUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginMovingFundsCommitmentGasOffsetUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the moving funds commitment gas offset", async () => {
        const { movingFundsCommitmentGasOffset } =
          await bridge.movingFundsParameters()
        expect(movingFundsCommitmentGasOffset).to.be.equal(
          constants.movingFundsCommitmentGasOffset
        )
      })

      it("should emit MovingFundsCommitmentGasOffsetUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(
            bridgeGovernance,
            "MovingFundsCommitmentGasOffsetUpdateStarted"
          )
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeMovingFundsCommitmentGasOffsetUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeMovingFundsCommitmentGasOffsetUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsCommitmentGasOffsetUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginMovingFundsCommitmentGasOffsetUpdate(20000)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsCommitmentGasOffsetUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginMovingFundsCommitmentGasOffsetUpdate(20122)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeMovingFundsCommitmentGasOffsetUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the moving funds commitment gas offset", async () => {
          const { movingFundsCommitmentGasOffset } =
            await bridge.movingFundsParameters()
          expect(movingFundsCommitmentGasOffset).to.be.equal(20122)
        })

        it("should emit MovingFundsCommitmentGasOffsetUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "MovingFundsCommitmentGasOffsetUpdated")
            .withArgs(20122)
        })
      }
    )
  })

  describe("beginMovedFundsSweepTxMaxTotalFeeUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginMovedFundsSweepTxMaxTotalFeeUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginMovedFundsSweepTxMaxTotalFeeUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the moved funds sweep tx max total fee", async () => {
        const { movedFundsSweepTxMaxTotalFee } =
          await bridge.movingFundsParameters()
        expect(movedFundsSweepTxMaxTotalFee).to.be.equal(
          constants.movedFundsSweepTxMaxTotalFee
        )
      })

      it("should emit MovedFundsSweepTxMaxTotalFeeUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(
            bridgeGovernance,
            "MovedFundsSweepTxMaxTotalFeeUpdateStarted"
          )
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeMovedFundsSweepTxMaxTotalFeeUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeMovedFundsSweepTxMaxTotalFeeUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTxMaxTotalFeeUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginMovedFundsSweepTxMaxTotalFeeUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTxMaxTotalFeeUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginMovedFundsSweepTxMaxTotalFeeUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTxMaxTotalFeeUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the moved funds sweep tx max total fee", async () => {
          const { movedFundsSweepTxMaxTotalFee } =
            await bridge.movingFundsParameters()
          expect(movedFundsSweepTxMaxTotalFee).to.be.equal(7331)
        })

        it("should emit MovedFundsSweepTxMaxTotalFeeUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "MovedFundsSweepTxMaxTotalFeeUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginMovedFundsSweepTimeoutUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginMovedFundsSweepTimeoutUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginMovedFundsSweepTimeoutUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the moved funds sweep timeout", async () => {
        const { movedFundsSweepTimeout } = await bridge.movingFundsParameters()
        expect(movedFundsSweepTimeout).to.be.equal(
          constants.movedFundsSweepTimeout
        )
      })

      it("should emit MovedFundsSweepTimeoutUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "MovedFundsSweepTimeoutUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeMovedFundsSweepTimeoutUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeMovedFundsSweepTimeoutUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTimeoutUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginMovedFundsSweepTimeoutUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTimeoutUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginMovedFundsSweepTimeoutUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTimeoutUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the moved funds sweep timeout", async () => {
          const { movedFundsSweepTimeout } =
            await bridge.movingFundsParameters()
          expect(movedFundsSweepTimeout).to.be.equal(7331)
        })

        it("should emit MovedFundsSweepTimeoutUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "MovedFundsSweepTimeoutUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginMovedFundsSweepTimeoutSlashingAmountUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginMovedFundsSweepTimeoutSlashingAmountUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginMovedFundsSweepTimeoutSlashingAmountUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the moved funds sweep timeout slashing amount", async () => {
        const { movedFundsSweepTimeoutSlashingAmount } =
          await bridge.movingFundsParameters()
        expect(movedFundsSweepTimeoutSlashingAmount).to.be.equal(
          constants.movedFundsSweepTimeoutSlashingAmount
        )
      })

      it("should emit MovedFundsSweepTimeoutSlashingAmountUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(
            bridgeGovernance,
            "MovedFundsSweepTimeoutSlashingAmountUpdateStarted"
          )
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeMovedFundsSweepTimeoutSlashingAmountUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeMovedFundsSweepTimeoutSlashingAmountUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTimeoutSlashingAmountUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginMovedFundsSweepTimeoutSlashingAmountUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTimeoutSlashingAmountUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginMovedFundsSweepTimeoutSlashingAmountUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTimeoutSlashingAmountUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the moved funds sweep timeout slashing amount", async () => {
          const { movedFundsSweepTimeoutSlashingAmount } =
            await bridge.movingFundsParameters()
          expect(movedFundsSweepTimeoutSlashingAmount).to.be.equal(7331)
        })

        it("should emit MovedFundsSweepTimeoutSlashingAmountUpdated event", async () => {
          await expect(tx)
            .to.emit(
              bridgeGovernance,
              "MovedFundsSweepTimeoutSlashingAmountUpdated"
            )
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate(42)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the moved funds sweep timeout notifier reward multiplier", async () => {
        const { movedFundsSweepTimeoutNotifierRewardMultiplier } =
          await bridge.movingFundsParameters()
        expect(movedFundsSweepTimeoutNotifierRewardMultiplier).to.be.equal(
          constants.movedFundsSweepTimeoutNotifierRewardMultiplier
        )
      })

      it("should emit MovedFundsSweepTimeoutNotifierRewardMultiplierUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(
            bridgeGovernance,
            "MovedFundsSweepTimeoutNotifierRewardMultiplierUpdateStarted"
          )
          .withArgs(42, blockTimestamp)
      })
    })
  })

  describe("finalizeMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate(42)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate(42)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the moved funds sweep timeout notifier reward multiplier", async () => {
          const { movedFundsSweepTimeoutNotifierRewardMultiplier } =
            await bridge.movingFundsParameters()
          expect(movedFundsSweepTimeoutNotifierRewardMultiplier).to.be.equal(42)
        })

        it("should emit MovedFundsSweepTimeoutNotifierRewardMultiplierUpdated event", async () => {
          await expect(tx)
            .to.emit(
              bridgeGovernance,
              "MovedFundsSweepTimeoutNotifierRewardMultiplierUpdated"
            )
            .withArgs(42)
        })
      }
    )
  })

  describe("beginWalletCreationPeriodUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginWalletCreationPeriodUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginWalletCreationPeriodUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the wallet creation period", async () => {
        const { walletCreationPeriod } = await bridge.walletParameters()
        expect(walletCreationPeriod).to.be.equal(constants.walletCreationPeriod)
      })

      it("should emit WalletCreationPeriodUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "WalletCreationPeriodUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeWalletCreationPeriodUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeWalletCreationPeriodUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeWalletCreationPeriodUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginWalletCreationPeriodUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeWalletCreationPeriodUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginWalletCreationPeriodUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeWalletCreationPeriodUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the wallet creation period", async () => {
          const { walletCreationPeriod } = await bridge.walletParameters()
          expect(walletCreationPeriod).to.be.equal(7331)
        })

        it("should emit WalletCreationPeriodUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "WalletCreationPeriodUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginWalletCreationMinBtcBalanceUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginWalletCreationMinBtcBalanceUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginWalletCreationMinBtcBalanceUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the wallet creation min btc balance", async () => {
        const { walletCreationMinBtcBalance } = await bridge.walletParameters()
        expect(walletCreationMinBtcBalance).to.be.equal(
          constants.walletCreationMinBtcBalance
        )
      })

      it("should emit WalletCreationMinBtcBalanceUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "WalletCreationMinBtcBalanceUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeWalletCreationMinBtcBalanceUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeWalletCreationMinBtcBalanceUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeWalletCreationMinBtcBalanceUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginWalletCreationMinBtcBalanceUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeWalletCreationMinBtcBalanceUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginWalletCreationMinBtcBalanceUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeWalletCreationMinBtcBalanceUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the wallet creation min btc balance", async () => {
          const { walletCreationMinBtcBalance } =
            await bridge.walletParameters()
          expect(walletCreationMinBtcBalance).to.be.equal(7331)
        })

        it("should emit WalletCreationMinBtcBalanceUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "WalletCreationMinBtcBalanceUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginWalletCreationMaxBtcBalanceUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginWalletCreationMaxBtcBalanceUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginWalletCreationMaxBtcBalanceUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the wallet creation max btc balance", async () => {
        const { walletCreationMaxBtcBalance } = await bridge.walletParameters()
        expect(walletCreationMaxBtcBalance).to.be.equal(
          constants.walletCreationMaxBtcBalance
        )
      })

      it("should emit WalletCreationMaxBtcBalanceUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "WalletCreationMaxBtcBalanceUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeWalletCreationMaxBtcBalanceUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeWalletCreationMaxBtcBalanceUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeWalletCreationMaxBtcBalanceUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginWalletCreationMaxBtcBalanceUpdate(
            constants.walletCreationMinBtcBalance.add(1)
          )

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeWalletCreationMaxBtcBalanceUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginWalletCreationMaxBtcBalanceUpdate(
              constants.walletCreationMinBtcBalance.add(1)
            )

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeWalletCreationMaxBtcBalanceUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the wallet creation max btc balance", async () => {
          const { walletCreationMaxBtcBalance } =
            await bridge.walletParameters()
          expect(walletCreationMaxBtcBalance).to.be.equal(
            constants.walletCreationMinBtcBalance.add(1)
          )
        })

        it("should emit WalletCreationMaxBtcBalanceUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "WalletCreationMaxBtcBalanceUpdated")
            .withArgs(constants.walletCreationMinBtcBalance.add(1))
        })
      }
    )
  })

  describe("beginWalletClosureMinBtcBalanceUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginWalletClosureMinBtcBalanceUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginWalletClosureMinBtcBalanceUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the wallet closure min btc balance", async () => {
        const { walletClosureMinBtcBalance } = await bridge.walletParameters()
        expect(walletClosureMinBtcBalance).to.be.equal(
          constants.walletClosureMinBtcBalance
        )
      })

      it("should emit WalletClosureMinBtcBalanceUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "WalletClosureMinBtcBalanceUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeWalletClosureMinBtcBalanceUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeWalletClosureMinBtcBalanceUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeWalletClosureMinBtcBalanceUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginWalletClosureMinBtcBalanceUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeWalletClosureMinBtcBalanceUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginWalletClosureMinBtcBalanceUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeWalletClosureMinBtcBalanceUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the wallet closure min btc balance", async () => {
          const { walletClosureMinBtcBalance } = await bridge.walletParameters()
          expect(walletClosureMinBtcBalance).to.be.equal(7331)
        })

        it("should emit WalletClosureMinBtcBalanceUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "WalletClosureMinBtcBalanceUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginWalletMaxAgeUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).beginWalletMaxAgeUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginWalletMaxAgeUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the wallet max age", async () => {
        const { walletMaxAge } = await bridge.walletParameters()
        expect(walletMaxAge).to.be.equal(constants.walletMaxAge)
      })

      it("should emit WalletMaxAgeUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "WalletMaxAgeUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeWalletMaxAgeUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).finalizeWalletMaxAgeUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(governance).finalizeWalletMaxAgeUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance.connect(governance).beginWalletMaxAgeUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(governance).finalizeWalletMaxAgeUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginWalletMaxAgeUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeWalletMaxAgeUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the wallet max age", async () => {
          const { walletMaxAge } = await bridge.walletParameters()
          expect(walletMaxAge).to.be.equal(7331)
        })

        it("should emit WalletMaxAgeUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "WalletMaxAgeUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginWalletMaxBtcTransferUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginWalletMaxBtcTransferUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginWalletMaxBtcTransferUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the wallet max btc transfer", async () => {
        const { walletMaxBtcTransfer } = await bridge.walletParameters()
        expect(walletMaxBtcTransfer).to.be.equal(constants.walletMaxBtcTransfer)
      })

      it("should emit WalletMaxBtcTransferUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "WalletMaxBtcTransferUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeWalletMaxBtcTransferUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeWalletMaxBtcTransferUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeWalletMaxBtcTransferUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginWalletMaxBtcTransferUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeWalletMaxBtcTransferUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginWalletMaxBtcTransferUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeWalletMaxBtcTransferUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the wallet max btc transfer", async () => {
          const { walletMaxBtcTransfer } = await bridge.walletParameters()
          expect(walletMaxBtcTransfer).to.be.equal(7331)
        })

        it("should emit WalletMaxBtcTransferUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "WalletMaxBtcTransferUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginWalletClosingPeriodUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).beginWalletClosingPeriodUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginWalletClosingPeriodUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the wallet closing period", async () => {
        const { walletClosingPeriod } = await bridge.walletParameters()
        expect(walletClosingPeriod).to.be.equal(constants.walletClosingPeriod)
      })

      it("should emit WalletClosingPeriodUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "WalletClosingPeriodUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeWalletClosingPeriodUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeWalletClosingPeriodUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeWalletClosingPeriodUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginWalletClosingPeriodUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeWalletClosingPeriodUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginWalletClosingPeriodUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeWalletClosingPeriodUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the wallet closing period", async () => {
          const { walletClosingPeriod } = await bridge.walletParameters()
          expect(walletClosingPeriod).to.be.equal(7331)
        })

        it("should emit WalletClosingPeriodUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "WalletClosingPeriodUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginFraudChallengeDepositAmountUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginFraudChallengeDepositAmountUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginFraudChallengeDepositAmountUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the fraud challenge deposit amount", async () => {
        const { fraudChallengeDepositAmount } = await bridge.fraudParameters()
        expect(fraudChallengeDepositAmount).to.be.equal(
          constants.fraudChallengeDepositAmount
        )
      })

      it("should emit FraudChallengeDepositAmountUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "FraudChallengeDepositAmountUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeFraudChallengeDepositAmountUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeFraudChallengeDepositAmountUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeFraudChallengeDepositAmountUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginFraudChallengeDepositAmountUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeFraudChallengeDepositAmountUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginFraudChallengeDepositAmountUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeFraudChallengeDepositAmountUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the fraud challenge deposit amount", async () => {
          const { fraudChallengeDepositAmount } = await bridge.fraudParameters()
          expect(fraudChallengeDepositAmount).to.be.equal(7331)
        })

        it("should emit FraudChallengeDepositAmountUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "FraudChallengeDepositAmountUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginFraudChallengeDefeatTimeoutUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginFraudChallengeDefeatTimeoutUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginFraudChallengeDefeatTimeoutUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the fraud challenge defeat timeout", async () => {
        const { fraudChallengeDefeatTimeout } = await bridge.fraudParameters()
        expect(fraudChallengeDefeatTimeout).to.be.equal(
          constants.fraudChallengeDefeatTimeout
        )
      })

      it("should emit FraudChallengeDefeatTimeoutUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "FraudChallengeDefeatTimeoutUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeFraudChallengeDefeatTimeoutUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeFraudChallengeDefeatTimeoutUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeFraudChallengeDefeatTimeoutUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginFraudChallengeDefeatTimeoutUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeFraudChallengeDefeatTimeoutUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginFraudChallengeDefeatTimeoutUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeFraudChallengeDefeatTimeoutUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the fraud challenge defeat timeout", async () => {
          const { fraudChallengeDefeatTimeout } = await bridge.fraudParameters()
          expect(fraudChallengeDefeatTimeout).to.be.equal(7331)
        })

        it("should emit FraudChallengeDefeatTimeoutUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "FraudChallengeDefeatTimeoutUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginFraudSlashingAmountUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).beginFraudSlashingAmountUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginFraudSlashingAmountUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the fraud slashing amount", async () => {
        const { fraudSlashingAmount } = await bridge.fraudParameters()
        expect(fraudSlashingAmount).to.be.equal(constants.fraudSlashingAmount)
      })

      it("should emit FraudSlashingAmountUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "FraudSlashingAmountUpdateStarted")
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeFraudSlashingAmountUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeFraudSlashingAmountUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeFraudSlashingAmountUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginFraudSlashingAmountUpdate(7331)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeFraudSlashingAmountUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginFraudSlashingAmountUpdate(7331)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeFraudSlashingAmountUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the fraud slashing amount", async () => {
          const { fraudSlashingAmount } = await bridge.fraudParameters()
          expect(fraudSlashingAmount).to.be.equal(7331)
        })

        it("should emit FraudSlashingAmountUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "FraudSlashingAmountUpdated")
            .withArgs(7331)
        })
      }
    )
  })

  describe("beginFraudNotifierRewardMultiplierUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginFraudNotifierRewardMultiplierUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .beginFraudNotifierRewardMultiplierUpdate(1337)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the fraud notifier reward multiplier", async () => {
        const { fraudNotifierRewardMultiplier } = await bridge.fraudParameters()
        expect(fraudNotifierRewardMultiplier).to.be.equal(
          constants.fraudNotifierRewardMultiplier
        )
      })

      it("should emit FraudNotifierRewardMultiplierUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(
            bridgeGovernance,
            "FraudNotifierRewardMultiplierUpdateStarted"
          )
          .withArgs(1337, blockTimestamp)
      })
    })
  })

  describe("finalizeFraudNotifierRewardMultiplierUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeFraudNotifierRewardMultiplierUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeFraudNotifierRewardMultiplierUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginFraudNotifierRewardMultiplierUpdate(42)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeFraudNotifierRewardMultiplierUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginFraudNotifierRewardMultiplierUpdate(42)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeFraudNotifierRewardMultiplierUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the fraud notifier reward multiplier", async () => {
          const { fraudNotifierRewardMultiplier } =
            await bridge.fraudParameters()
          expect(fraudNotifierRewardMultiplier).to.be.equal(42)
        })

        it("should emit FraudNotifierRewardMultiplierUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "FraudNotifierRewardMultiplierUpdated")
            .withArgs(42)
        })
      }
    )
  })

  describe("beginTreasuryUpdate", () => {
    const newTreasury = "0x8A71228c19A3531384FC203F56290D3aF01B16bD"

    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).beginTreasuryUpdate(newTreasury)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let oldTreasury: string
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        oldTreasury = await bridge.treasury()

        tx = await bridgeGovernance
          .connect(governance)
          .beginTreasuryUpdate(newTreasury)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the treasury address", async () => {
        expect(await bridge.treasury()).to.be.equal(oldTreasury)
      })

      it("should emit TreasuryUpdateStarted event", async () => {
        const blockTimestamp = await helpers.time.lastBlockTime()
        await expect(tx)
          .to.emit(bridgeGovernance, "TreasuryUpdateStarted")
          .withArgs(newTreasury, blockTimestamp)
      })
    })
  })

  describe("finalizeTreasuryUpdate", () => {
    const newTreasury = "0x8A71228c19A3531384FC203F56290D3aF01B16bD"

    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).finalizeTreasuryUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(governance).finalizeTreasuryUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginTreasuryUpdate(newTreasury)

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(governance).finalizeTreasuryUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .beginTreasuryUpdate(newTreasury)

          await helpers.time.increaseTime(constants.governanceDelay)

          tx = await bridgeGovernance
            .connect(governance)
            .finalizeTreasuryUpdate()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the treasury address", async () => {
          expect(await bridge.treasury()).to.be.equal(newTreasury)
        })

        it("should emit TreasuryUpdated event", async () => {
          await expect(tx)
            .to.emit(bridgeGovernance, "TreasuryUpdated")
            .withArgs(newTreasury)
        })
      }
    )
  })

  describe("setVaultStatus", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .setVaultStatus(thirdParty.address, true)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bridgeGovernance
          .connect(governance)
          .setVaultStatus(thirdParty.address, true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should mark the vault as trusted", async () => {
        await expect(await bridge.isVaultTrusted(thirdParty.address)).to.be.true
      })

      it("should emit VaultStatusUpdated event", async () => {
        await expect(tx)
          .to.emit(bridge, "VaultStatusUpdated")
          .withArgs(thirdParty.address, true)
      })
    })
  })

  describe("setRedemptionWatchtower", () => {
    const watchtower = "0xE8ebaEc51bAeeaBff71707dE2AD028C7fB642A3F"

    context("when caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .setRedemptionWatchtower(watchtower)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when caller is the owner", () => {
      let tx: Promise<ContractTransaction>

      before(async () => {
        await createSnapshot()

        tx = bridgeGovernance
          .connect(governance)
          .setRedemptionWatchtower(watchtower)
      })

      after(async () => {
        await restoreSnapshot()
      })

      // Detailed tests covering the `bridge.setRedemptionWatchtower` call
      // can be found in the `Bridge.Parameters.test.ts` file. Here we just
      // ensure correctness of the BridgeGovernance's ACL.
      it("should not revert", async () => {
        await expect(tx).to.not.be.reverted
      })
    })
  })
})
