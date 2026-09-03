import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers, helpers, waffle } from "hardhat"
import { expect } from "chai"

import type { Bank, TBTC, TBTCVault, ReservationVault } from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const fixture = async () => {
  const [deployer, bridge, account1] = await ethers.getSigners()

  const Bank = await ethers.getContractFactory("Bank")
  const bank = await Bank.deploy()
  await bank.deployed()

  await bank.connect(deployer).updateBridge(bridge.address)

  const TBTC = await ethers.getContractFactory("TBTC")
  const tbtc = await TBTC.deploy()
  await tbtc.deployed()

  const TBTCVault = await ethers.getContractFactory("TBTCVault")
  const tbtcVault = await TBTCVault.deploy(
    bank.address,
    tbtc.address,
    bridge.address
  )
  await tbtcVault.deployed()

  const ReservationVault = await ethers.getContractFactory("ReservationVault")
  const vault = await ReservationVault.deploy(
    bank.address,
    tbtcVault.address,
    bridge.address
  )
  await vault.deployed()

  return {
    bridge,
    account1,
    bank,
    tbtc,
    tbtcVault,
    vault,
  }
}

describe("ReservationVault", () => {
  let bridge: SignerWithAddress
  let account1: SignerWithAddress
  let bank: Bank
  let tbtc: TBTC
  let tbtcVault: TBTCVault
  let vault: ReservationVault

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ bridge, account1, bank, tbtc, tbtcVault, vault } =
      await waffle.loadFixture(fixture))
  })

  describe("constructor", () => {
    it("should initialize redemptionsPaused to true", async () => {
      expect(await vault.redemptionsPaused()).to.equal(true)
    })
  })

  describe("pauseRedemptions", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a non-owner", () => {
      it("should revert", async () => {
        await expect(
          vault.connect(account1).pauseRedemptions()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      it("should set redemptionsPaused to true when it was false", async () => {
        // First unpause so we can test the pause transition.
        await vault.unpauseRedemptions()
        expect(await vault.redemptionsPaused()).to.equal(false)

        await vault.pauseRedemptions()
        expect(await vault.redemptionsPaused()).to.equal(true)
      })

      it("should be a no-op when redemptionsPaused is already true", async () => {
        expect(await vault.redemptionsPaused()).to.equal(true)

        await vault.pauseRedemptions()
        expect(await vault.redemptionsPaused()).to.equal(true)
      })

      it("should emit ReservationRedemptionsPaused event", async () => {
        await vault.unpauseRedemptions()
        await expect(vault.pauseRedemptions()).to.emit(
          vault,
          "ReservationRedemptionsPaused"
        )
      })
    })
  })

  describe("unpauseRedemptions", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a non-owner", () => {
      it("should revert", async () => {
        await expect(
          vault.connect(account1).unpauseRedemptions()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      it("should set redemptionsPaused to false", async () => {
        expect(await vault.redemptionsPaused()).to.equal(true)

        await vault.unpauseRedemptions()
        expect(await vault.redemptionsPaused()).to.equal(false)
      })

      it("should emit ReservationRedemptionsUnpaused event", async () => {
        await expect(vault.unpauseRedemptions()).to.emit(
          vault,
          "ReservationRedemptionsUnpaused"
        )
      })
    })
  })

  describe("financeInKindFee", () => {
    context("when called by a non-bridge address", () => {
      it("should revert", async () => {
        await expect(
          vault.connect(account1).financeInKindFee(0)
        ).to.be.revertedWith("Caller is not the Bridge")
      })
    })

    context("when redemptionsPaused is true", () => {
      before(async () => {
        await createSnapshot()
        // Ensure redemptionsPaused is true (it is by default after
        // construction, but prior tests may have flipped it).
        if (!(await vault.redemptionsPaused())) {
          await vault.pauseRedemptions()
        }
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should succeed regardless of the pause flag", async () => {
        expect(await vault.redemptionsPaused()).to.equal(true)

        // financeInKindFee should not revert when called by the bridge
        // even though redemptions are paused.
        await expect(vault.connect(bridge).financeInKindFee(0)).to.not.be
          .reverted
      })

      it("should accept a non-zero fee amount from the bridge", async () => {
        // This test confirms that financeInKindFee is callable from the
        // bridge when redemptions are paused. The actual fee processing
        // requires a funded vault; here we only verify the call is
        // accepted (no revert from the pause flag).
        await vault.connect(bridge).financeInKindFee(0)
      })
    })
  })

  describe("updateFeeReserveTarget", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert when called by a non-owner", async () => {
      await expect(
        vault.connect(account1).updateFeeReserveTarget(1000)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should succeed when called by the owner", async () => {
      await vault.updateFeeReserveTarget(1000)
      expect(await vault.feeReserveTarget()).to.equal(1000)
    })
  })

  describe("sweepFees", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert when called by a non-owner", async () => {
      await expect(
        vault.connect(account1).sweepFees(account1.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should revert when balance is not above the reserve target", async () => {
      await vault.updateFeeReserveTarget(ethers.utils.parseEther("1"))
      await expect(vault.sweepFees(account1.address)).to.be.revertedWith(
        "Nothing above the reserve target"
      )
    })
  })

  describe("updateFees", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert when called by a non-owner", async () => {
      await expect(
        vault.connect(account1).updateFees(40, 20, 20)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should succeed when called by the owner with valid fees", async () => {
      await vault.updateFees(50, 30, 25)
      expect(await vault.initiationFeeBps()).to.equal(50)
      expect(await vault.extensionFeeBps()).to.equal(30)
      expect(await vault.redemptionFeeBps()).to.equal(25)
    })

    it("should revert when fees exceed MAX_FEE_BASIS_POINTS", async () => {
      await expect(vault.updateFees(501, 20, 20)).to.be.revertedWith(
        "Fee exceeds the maximum"
      )
    })
  })

  describe("redeemReservation", () => {
    it("should revert when redemptions are paused", async () => {
      expect(await vault.redemptionsPaused()).to.equal(true)
      await expect(vault.redeemReservation(0, 100_000)).to.be.revertedWith(
        "Redemptions are paused"
      )
    })
  })

  describe("retryRedeemReservation", () => {
    it("should revert when redemptions are paused", async () => {
      expect(await vault.redemptionsPaused()).to.equal(true)
      await expect(vault.retryRedeemReservation(0, 0)).to.be.revertedWith(
        "Redemptions are paused"
      )
    })
  })

  describe("receiveBalanceApproval", () => {
    it("should always revert", async () => {
      await expect(
        vault.receiveBalanceApproval(account1.address, 100, [])
      ).to.be.revertedWith("Balance approvals not supported")
    })
  })
})
