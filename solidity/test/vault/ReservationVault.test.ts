import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber, ContractTransaction } from "ethers"
import { loadFixture } from "../helpers/fixture"
import { createMock } from "../helpers/mock"
import type { Mock } from "../helpers/mock"

import type {
  Bank,
  TBTC,
  TBTCVault,
  ReservationVault,
  IReservationBridge,
} from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const SATOSHI_MULTIPLIER = ethers.BigNumber.from(10).pow(10)

function satsToTbtc(sats: number | BigNumber): BigNumber {
  return ethers.BigNumber.from(sats).mul(SATOSHI_MULTIPLIER)
}

/** A zero-valued `Reservation.ReservationRequest` with `owner` overridden. */
function reservationWithOwner(owner: string) {
  return {
    owner,
    mintedAmount: 0,
    acceptedAt: 0,
    walletPubKeyHash: `0x${"00".repeat(20)}`,
    anchorAmount: 0,
    expiresAt: 0,
    anchorTxHash: ethers.constants.HashZero,
    anchorTxOutputIndex: 0,
    state: 0,
    requestNonce: 0,
    retryCredit: false,
    dissolutionEligibleAt: 0,
    cumulativeReanchorFee: 0,
    reanchorCooldownUntil: 0,
  }
}

const fixture = async () => {
  const [deployer, account1, account2] = await ethers.getSigners()

  const bridge = await createMock<IReservationBridge>("IReservationBridge")

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

  // The TBTC Vault is the only minter/burner of TBTC.
  await tbtc.connect(deployer).transferOwnership(tbtcVault.address)

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
    account2,
    bank,
    tbtc,
    tbtcVault,
    vault,
  }
}

describe("ReservationVault", () => {
  let bridge: Mock<IReservationBridge>
  let account1: SignerWithAddress
  let account2: SignerWithAddress
  let bank: Bank
  let tbtc: TBTC
  let tbtcVault: TBTCVault
  let vault: ReservationVault

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ bridge, account1, account2, bank, tbtc, tbtcVault, vault } =
      await loadFixture(fixture))
  })

  /** Impersonates the Bank so `onlyBank`-gated functions can be called
   *  directly, bypassing Bank's own array-length check. */
  async function impersonateBank(): Promise<SignerWithAddress> {
    await ethers.provider.send("hardhat_impersonateAccount", [bank.address])
    await ethers.provider.send("hardhat_setBalance", [
      bank.address,
      "0x56BC75E2D63100000", // 100 ETH
    ])
    return ethers.getSigner(bank.address)
  }

  describe("constructor", () => {
    it("should initialize redemptionsPaused to true", async () => {
      expect(await vault.redemptionsPaused()).to.equal(true)
    })

    it("should revert when bank is the zero address", async () => {
      const ReservationVault = await ethers.getContractFactory(
        "ReservationVault"
      )
      await expect(
        ReservationVault.deploy(
          ethers.constants.AddressZero,
          tbtcVault.address,
          bridge.address
        )
      ).to.be.revertedWith("Bank can not be the zero address")
    })

    it("should revert when tbtcVault is the zero address", async () => {
      const ReservationVault = await ethers.getContractFactory(
        "ReservationVault"
      )
      await expect(
        ReservationVault.deploy(
          bank.address,
          ethers.constants.AddressZero,
          bridge.address
        )
      ).to.be.revertedWith("TBTCVault can not be the zero address")
    })

    it("should revert when bridge is the zero address", async () => {
      const ReservationVault = await ethers.getContractFactory(
        "ReservationVault"
      )
      await expect(
        ReservationVault.deploy(
          bank.address,
          tbtcVault.address,
          ethers.constants.AddressZero
        )
      ).to.be.revertedWith("Bridge can not be the zero address")
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

  describe("receiveBalanceIncrease", () => {
    context("when called by a non-bank address", () => {
      it("should revert", async () => {
        await expect(
          vault
            .connect(account1)
            .receiveBalanceIncrease([account1.address], [1000])
        ).to.be.revertedWith("Caller is not the Bank")
      })
    })

    context("when called with no depositors", () => {
      it("should revert", async () => {
        await expect(
          bank
            .connect(bridge.wallet)
            .increaseBalanceAndCall(vault.address, [], [])
        ).to.be.revertedWith("No depositors specified")
      })
    })

    context("when called with mismatched array lengths", () => {
      it("should revert", async () => {
        // Called directly as the Bank (bypassing Bank's own identical
        // check) to prove the vault enforces this invariant itself.
        const bankSigner = await impersonateBank()
        await expect(
          vault
            .connect(bankSigner)
            .receiveBalanceIncrease(
              [account1.address, account2.address],
              [1000]
            )
        ).to.be.revertedWith("Arrays must have the same length")
      })
    })

    context("when called with a single depositor", () => {
      const depositedAmountSat = 100_000
      let tx: ContractTransaction
      let fee: BigNumber
      let net: BigNumber

      before(async () => {
        await createSnapshot()

        const initiationFeeBps = await vault.initiationFeeBps()
        const gross = satsToTbtc(depositedAmountSat)
        fee = gross.mul(initiationFeeBps).div(10000)
        net = gross.sub(fee)

        tx = await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.address,
            [account1.address],
            [depositedAmountSat]
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer the net amount (gross minus fee) to the depositor", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(net)
      })

      it("should retain the fee in the vault", async () => {
        expect(await tbtc.balanceOf(vault.address)).to.equal(fee)
      })

      it("should leave no residual Bank balance for the vault or depositor", async () => {
        expect(await bank.balanceOf(vault.address)).to.equal(0)
        expect(await bank.balanceOf(account1.address)).to.equal(0)
      })

      it("should emit ReservationCreditProcessed with the correct values", async () => {
        await expect(tx)
          .to.emit(vault, "ReservationCreditProcessed")
          .withArgs(account1.address, depositedAmountSat, fee)
      })
    })

    context("when called with multiple depositors", () => {
      const depositedAmounts = [100_000, 250_000]
      let tx: ContractTransaction
      let fees: BigNumber[]
      let nets: BigNumber[]

      before(async () => {
        await createSnapshot()

        const initiationFeeBps = await vault.initiationFeeBps()
        fees = depositedAmounts.map((amount) =>
          satsToTbtc(amount).mul(initiationFeeBps).div(10000)
        )
        nets = depositedAmounts.map((amount, i) =>
          satsToTbtc(amount).sub(fees[i])
        )

        tx = await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.address,
            [account1.address, account2.address],
            depositedAmounts
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer each depositor's net amount", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(nets[0])
        expect(await tbtc.balanceOf(account2.address)).to.equal(nets[1])
      })

      it("should retain the sum of fees in the vault", async () => {
        expect(await tbtc.balanceOf(vault.address)).to.equal(
          fees[0].add(fees[1])
        )
      })

      it("should emit ReservationCreditProcessed for each depositor", async () => {
        await expect(tx)
          .to.emit(vault, "ReservationCreditProcessed")
          .withArgs(account1.address, depositedAmounts[0], fees[0])
        await expect(tx)
          .to.emit(vault, "ReservationCreditProcessed")
          .withArgs(account2.address, depositedAmounts[1], fees[1])
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

    context("when called with a zero fee", () => {
      before(async () => {
        await createSnapshot()
        if (!(await vault.redemptionsPaused())) {
          await vault.pauseRedemptions()
        }
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should succeed as a no-op regardless of the pause flag", async () => {
        expect(await vault.redemptionsPaused()).to.equal(true)
        await expect(vault.connect(bridge.wallet).financeInKindFee(0)).to.not.be
          .reverted
      })

      it("should not change the vault's TBTC balance or debt", async () => {
        const balanceBefore = await tbtc.balanceOf(vault.address)
        const debtBefore = await vault.inKindFeeDebtSat()

        await vault.connect(bridge.wallet).financeInKindFee(0)

        expect(await tbtc.balanceOf(vault.address)).to.equal(balanceBefore)
        expect(await vault.inKindFeeDebtSat()).to.equal(debtBefore)
      })
    })

    context("when the reserve fully covers the fee", () => {
      const reserveDepositSat = 100_000_000
      const feeSat = 100_000

      before(async () => {
        await createSnapshot()

        await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.address,
            [account1.address],
            [reserveDepositSat]
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should burn exactly the fee's worth of TBTC from the reserve", async () => {
        const balanceBefore = await tbtc.balanceOf(vault.address)
        await vault.connect(bridge.wallet).financeInKindFee(feeSat)
        const balanceAfter = await tbtc.balanceOf(vault.address)
        expect(balanceBefore.sub(balanceAfter)).to.equal(satsToTbtc(feeSat))
      })

      it("should not increase inKindFeeDebtSat", async () => {
        await vault.connect(bridge.wallet).financeInKindFee(feeSat)
        expect(await vault.inKindFeeDebtSat()).to.equal(0)
      })

      it("should emit InKindFeeFinanced with zero shortfall", async () => {
        await expect(vault.connect(bridge.wallet).financeInKindFee(feeSat))
          .to.emit(vault, "InKindFeeFinanced")
          .withArgs(feeSat, 0)
      })
    })

    context("when the reserve cannot cover the fee at all", () => {
      const feeSat = 50_000

      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should not burn any TBTC", async () => {
        const balanceBefore = await tbtc.balanceOf(vault.address)
        await vault.connect(bridge.wallet).financeInKindFee(feeSat)
        expect(await tbtc.balanceOf(vault.address)).to.equal(balanceBefore)
      })

      it("should record the entire fee as debt", async () => {
        await vault.connect(bridge.wallet).financeInKindFee(feeSat)
        expect(await vault.inKindFeeDebtSat()).to.equal(feeSat)
      })

      it("should emit InKindFeeFinanced with shortfall equal to the fee", async () => {
        await expect(vault.connect(bridge.wallet).financeInKindFee(feeSat))
          .to.emit(vault, "InKindFeeFinanced")
          .withArgs(feeSat, feeSat)
      })
    })

    context("when the reserve partially covers the fee", () => {
      const reserveDepositSat = 100_000
      const feeSat = 1_000
      let coverableSat: BigNumber
      let shortfallSat: BigNumber

      before(async () => {
        await createSnapshot()

        const initiationFeeBps = await vault.initiationFeeBps()
        const reserveTbtc = satsToTbtc(reserveDepositSat)
          .mul(initiationFeeBps)
          .div(10000)
        coverableSat = reserveTbtc.div(SATOSHI_MULTIPLIER)
        shortfallSat = BigNumber.from(feeSat).sub(coverableSat)

        await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.address,
            [account1.address],
            [reserveDepositSat]
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should burn only the coverable portion", async () => {
        const balanceBefore = await tbtc.balanceOf(vault.address)
        await vault.connect(bridge.wallet).financeInKindFee(feeSat)
        const balanceAfter = await tbtc.balanceOf(vault.address)
        expect(balanceBefore.sub(balanceAfter)).to.equal(
          satsToTbtc(coverableSat)
        )
      })

      it("should record the shortfall as debt", async () => {
        await vault.connect(bridge.wallet).financeInKindFee(feeSat)
        expect(await vault.inKindFeeDebtSat()).to.equal(shortfallSat)
      })

      it("should emit InKindFeeFinanced with the correct shortfall", async () => {
        await expect(vault.connect(bridge.wallet).financeInKindFee(feeSat))
          .to.emit(vault, "InKindFeeFinanced")
          .withArgs(feeSat, shortfallSat)
      })
    })
  })

  describe("repayInKindFeeDebt", () => {
    context("when there is no outstanding debt", () => {
      it("should revert", async () => {
        await expect(
          vault.connect(account1).repayInKindFeeDebt(100)
        ).to.be.revertedWith("No debt to repay")
      })
    })

    context("when debt is outstanding", () => {
      const debtSat = 500_000
      const fundDepositSat = 200_000_000

      before(async () => {
        await createSnapshot()

        // Create debt: finance a fee against an empty reserve.
        await vault.connect(bridge.wallet).financeInKindFee(debtSat)

        // Fund account1 with plenty of TBTC (net of fee) to repay with.
        await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.address,
            [account1.address],
            [fundDepositSat]
          )

        await tbtc
          .connect(account1)
          .approve(vault.address, ethers.constants.MaxUint256)
      })

      after(async () => {
        await restoreSnapshot()
      })

      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should revert when the amount is zero", async () => {
        await expect(
          vault.connect(account1).repayInKindFeeDebt(0)
        ).to.be.revertedWith("Amount must not be zero")
      })

      it("should partially repay the debt and burn the exact TBTC amount", async () => {
        const repayAmount = 200_000
        const balanceBefore = await tbtc.balanceOf(account1.address)

        await vault.connect(account1).repayInKindFeeDebt(repayAmount)

        expect(await vault.inKindFeeDebtSat()).to.equal(debtSat - repayAmount)
        expect(
          balanceBefore.sub(await tbtc.balanceOf(account1.address))
        ).to.equal(satsToTbtc(repayAmount))
      })

      it("should emit InKindFeeDebtRepaid with the repaid amount", async () => {
        const repayAmount = 200_000
        await expect(vault.connect(account1).repayInKindFeeDebt(repayAmount))
          .to.emit(vault, "InKindFeeDebtRepaid")
          .withArgs(account1.address, repayAmount)
      })

      it("should cap an over-repayment at the outstanding debt", async () => {
        const overRepayAmount = debtSat + 300_000
        const balanceBefore = await tbtc.balanceOf(account1.address)

        await vault.connect(account1).repayInKindFeeDebt(overRepayAmount)

        expect(await vault.inKindFeeDebtSat()).to.equal(0)
        expect(
          balanceBefore.sub(await tbtc.balanceOf(account1.address))
        ).to.equal(satsToTbtc(debtSat))
      })

      it("should emit InKindFeeDebtRepaid with the capped amount on over-repayment", async () => {
        const overRepayAmount = debtSat + 300_000
        await expect(
          vault.connect(account1).repayInKindFeeDebt(overRepayAmount)
        )
          .to.emit(vault, "InKindFeeDebtRepaid")
          .withArgs(account1.address, debtSat)
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

    it("should succeed when called by the owner and emit the event", async () => {
      const newTarget = ethers.utils.parseEther("1")
      await expect(vault.updateFeeReserveTarget(newTarget))
        .to.emit(vault, "FeeReserveTargetUpdated")
        .withArgs(newTarget)

      expect(await vault.feeReserveTarget()).to.equal(newTarget)
    })

    it("should allow setting the target equal to the current balance, after which sweepFees reverts", async () => {
      await bank
        .connect(bridge.wallet)
        .increaseBalanceAndCall(vault.address, [account1.address], [100_000])

      const currentBalance = await tbtc.balanceOf(vault.address)
      await vault.updateFeeReserveTarget(currentBalance)

      await expect(vault.sweepFees(account1.address)).to.be.revertedWith(
        "Nothing above the reserve target"
      )
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

    it("should revert when the recipient is the zero address", async () => {
      await expect(
        vault.sweepFees(ethers.constants.AddressZero)
      ).to.be.revertedWith("Recipient must not be zero")
    })

    it("should revert when balance is not above the reserve target", async () => {
      await vault.updateFeeReserveTarget(ethers.utils.parseEther("1"))
      await expect(vault.sweepFees(account1.address)).to.be.revertedWith(
        "Nothing above the reserve target"
      )
    })

    context("happy path (zero outstanding debt)", () => {
      const reserveTargetSat = 1_000_000
      const extraSat = 500_000

      before(async () => {
        await createSnapshot()

        const initiationFeeBps = await vault.initiationFeeBps()
        const totalFeeSat = reserveTargetSat + extraSat
        const depositSat = Math.ceil((totalFeeSat * 10000) / initiationFeeBps)

        await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.address,
            [account2.address],
            [depositSat]
          )

        const currentBalance = await tbtc.balanceOf(vault.address)
        await vault.updateFeeReserveTarget(
          currentBalance.sub(satsToTbtc(extraSat))
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should send the excess to the recipient and leave the vault at the reserve target", async () => {
        const target = await vault.feeReserveTarget()

        await vault.sweepFees(account1.address)

        expect(await tbtc.balanceOf(vault.address)).to.equal(target)
        expect(await tbtc.balanceOf(account1.address)).to.equal(
          satsToTbtc(extraSat)
        )
      })

      it("should emit FeesSwept with the correct values", async () => {
        await expect(vault.sweepFees(account1.address))
          .to.emit(vault, "FeesSwept")
          .withArgs(account1.address, satsToTbtc(extraSat))
      })
    })

    context("when debt is outstanding", () => {
      const debtSat = 500_000
      const reserveTargetSat = 1_000_000
      const extraSat = 500_000

      before(async () => {
        await createSnapshot()

        // Create debt against an empty reserve.
        await vault.connect(bridge.wallet).financeInKindFee(debtSat)

        // Fund the vault so the retained fee covers debt + target + extra.
        const initiationFeeBps = await vault.initiationFeeBps()
        const totalFeeSat = debtSat + reserveTargetSat + extraSat
        const depositSat = Math.ceil((totalFeeSat * 10000) / initiationFeeBps)

        await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.address,
            [account2.address],
            [depositSat]
          )

        await vault.updateFeeReserveTarget(satsToTbtc(reserveTargetSat))
      })

      after(async () => {
        await restoreSnapshot()
      })

      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should repay the debt before sweeping the excess", async () => {
        await vault.sweepFees(account1.address)

        expect(await vault.inKindFeeDebtSat()).to.equal(0)
        expect(await tbtc.balanceOf(vault.address)).to.equal(
          satsToTbtc(reserveTargetSat)
        )
        expect(await tbtc.balanceOf(account1.address)).to.equal(
          satsToTbtc(extraSat)
        )
      })

      it("should emit InKindFeeDebtRepaid for the debt and FeesSwept for the excess", async () => {
        const tx = await vault.sweepFees(account1.address)

        await expect(tx)
          .to.emit(vault, "InKindFeeDebtRepaid")
          .withArgs(vault.address, debtSat)
        await expect(tx)
          .to.emit(vault, "FeesSwept")
          .withArgs(account1.address, satsToTbtc(extraSat))
      })
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

    it("should succeed when called by the owner with valid fees and emit the event", async () => {
      await expect(vault.updateFees(50, 30, 25))
        .to.emit(vault, "FeesUpdated")
        .withArgs(50, 30, 25)

      expect(await vault.initiationFeeBps()).to.equal(50)
      expect(await vault.extensionFeeBps()).to.equal(30)
      expect(await vault.redemptionFeeBps()).to.equal(25)
    })

    it("should revert when fees exceed MAX_FEE_BASIS_POINTS", async () => {
      await expect(vault.updateFees(501, 20, 20)).to.be.revertedWith(
        "Fee exceeds the maximum"
      )
    })

    it("should allow setting fees to exactly MAX_FEE_BASIS_POINTS", async () => {
      const max = await vault.MAX_FEE_BASIS_POINTS()
      await expect(vault.updateFees(max, max, max))
        .to.emit(vault, "FeesUpdated")
        .withArgs(max, max, max)

      expect(await vault.initiationFeeBps()).to.equal(max)
      expect(await vault.extensionFeeBps()).to.equal(max)
      expect(await vault.redemptionFeeBps()).to.equal(max)
    })
  })

  describe("redeemReservation", () => {
    const reservationKey = 42

    context("when called by a non-owner of the reservation", () => {
      it("should revert", async () => {
        await expect(
          vault.connect(account1).redeemReservation(reservationKey, 100_000)
        ).to.be.revertedWith("Caller is not the reservation owner")
      })
    })

    context("when called by the reservation owner", () => {
      before(async () => {
        await createSnapshot()
        await bridge.reservations
          .whenCalledWith(reservationKey)
          .returns(reservationWithOwner(account1.address))
      })

      after(async () => {
        await bridge.reservations.reset()
        await restoreSnapshot()
      })

      it("should revert with the milestone-1 message while redemptions are paused", async () => {
        expect(await vault.redemptionsPaused()).to.equal(true)
        await expect(
          vault.connect(account1).redeemReservation(reservationKey, 100_000)
        ).to.be.revertedWith("Reserved redemption not enabled in milestone 1")
      })

      it("should revert with the milestone-1 message while redemptions are unpaused", async () => {
        await vault.unpauseRedemptions()
        expect(await vault.redemptionsPaused()).to.equal(false)
        await expect(
          vault.connect(account1).redeemReservation(reservationKey, 100_000)
        ).to.be.revertedWith("Reserved redemption not enabled in milestone 1")
      })
    })
  })

  describe("retryRedeemReservation", () => {
    const reservationKey = 43

    context("when called by a non-owner of the reservation", () => {
      it("should revert", async () => {
        await expect(
          vault.connect(account1).retryRedeemReservation(reservationKey, 0)
        ).to.be.revertedWith("Caller is not the reservation owner")
      })
    })

    context("when called by the reservation owner", () => {
      before(async () => {
        await createSnapshot()
        await bridge.reservations
          .whenCalledWith(reservationKey)
          .returns(reservationWithOwner(account1.address))
      })

      after(async () => {
        await bridge.reservations.reset()
        await restoreSnapshot()
      })

      it("should revert with the milestone-1 message while redemptions are paused", async () => {
        expect(await vault.redemptionsPaused()).to.equal(true)
        await expect(
          vault.connect(account1).retryRedeemReservation(reservationKey, 0)
        ).to.be.revertedWith(
          "Reserved redemption retry not enabled in milestone 1"
        )
      })

      it("should revert with the milestone-1 message while redemptions are unpaused", async () => {
        await vault.unpauseRedemptions()
        expect(await vault.redemptionsPaused()).to.equal(false)
        await expect(
          vault.connect(account1).retryRedeemReservation(reservationKey, 0)
        ).to.be.revertedWith(
          "Reserved redemption retry not enabled in milestone 1"
        )
      })
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
