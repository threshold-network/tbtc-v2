import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { ContractTransactionResponse } from "ethers"
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

const SATOSHI_MULTIPLIER = 10n ** 10n

function satsToTbtc(sats: number | bigint): bigint {
  return BigInt(sats)* SATOSHI_MULTIPLIER
}

const fixture = async () => {
  const [deployer, account1, account2] = await ethers.getSigners()

  const bridge = await createMock<IReservationBridge>("IReservationBridge")

  const Bank = await ethers.getContractFactory("Bank")
  const bank = await Bank.deploy()
  await bank.waitForDeployment()

  await bank.connect(deployer).updateBridge(bridge.address)

  const TBTC = await ethers.getContractFactory("TBTC")
  const tbtc = await TBTC.deploy()
  await tbtc.waitForDeployment()

  const TBTCVault = await ethers.getContractFactory("TBTCVault")
  const tbtcVault = await TBTCVault.deploy(
    bank.target,
    tbtc.target,
    bridge.address
  )
  await tbtcVault.waitForDeployment()

  // The TBTC Vault is the only minter/burner of TBTC.
  await tbtc.connect(deployer).transferOwnership(tbtcVault.target)

  const ReservationVault = await ethers.getContractFactory("ReservationVault")
  const vault = await ReservationVault.deploy(
    bank.target,
    tbtcVault.target,
    bridge.address
  )
  await vault.waitForDeployment()

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
  let account1: HardhatEthersSigner
  let account2: HardhatEthersSigner
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
  async function impersonateBank(): Promise<HardhatEthersSigner> {
    await ethers.provider.send("hardhat_impersonateAccount", [bank.target])
    await ethers.provider.send("hardhat_setBalance", [
      bank.target,
      "0x56BC75E2D63100000", // 100 ETH
    ])
    return ethers.getSigner(bank.target as string)
  }

  describe("constructor", () => {
    it("should revert when bank is the zero address", async () => {
      const ReservationVault = await ethers.getContractFactory(
        "ReservationVault"
      )
      await expect(
        ReservationVault.deploy(
          ethers.ZeroAddress,
          tbtcVault.target,
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
          bank.target,
          ethers.ZeroAddress,
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
          bank.target,
          tbtcVault.target,
          ethers.ZeroAddress
        )
      ).to.be.revertedWith("Bridge can not be the zero address")
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
            .increaseBalanceAndCall(vault.target, [], [])
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
      let tx: ContractTransactionResponse
      let fee: bigint
      let net: bigint

      before(async () => {
        await createSnapshot()

        const initiationFeeBps = await vault.initiationFeeBps()
        const gross = satsToTbtc(depositedAmountSat)
        fee = gross* initiationFeeBps / 10000n
        net = gross- fee

        tx = await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.target,
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
        expect(await tbtc.balanceOf(vault.target)).to.equal(fee)
      })

      it("should leave no residual Bank balance for the vault or depositor", async () => {
        expect(await bank.balanceOf(vault.target)).to.equal(0)
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
      let tx: ContractTransactionResponse
      let fees: bigint[]
      let nets: bigint[]

      before(async () => {
        await createSnapshot()

        const initiationFeeBps = await vault.initiationFeeBps()
        fees = depositedAmounts.map((amount) =>
          satsToTbtc(amount)* initiationFeeBps / 10000n
        )
        nets = depositedAmounts.map((amount, i) =>
          satsToTbtc(amount) - fees[i]
        )

        tx = await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.target,
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
        expect(await tbtc.balanceOf(vault.target)).to.equal(
          fees[0] + fees[1]
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
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should succeed as a no-op", async () => {
        await expect(vault.connect(bridge.wallet).financeInKindFee(0)).to.not.be
          .reverted
      })

      it("should not change the vault's TBTC balance or debt", async () => {
        const balanceBefore = await tbtc.balanceOf(vault.target)
        const debtBefore = await vault.inKindFeeDebtSat()

        await vault.connect(bridge.wallet).financeInKindFee(0)

        expect(await tbtc.balanceOf(vault.target)).to.equal(balanceBefore)
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
            vault.target,
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
        const balanceBefore = await tbtc.balanceOf(vault.target)
        await vault.connect(bridge.wallet).financeInKindFee(feeSat)
        const balanceAfter = await tbtc.balanceOf(vault.target)
        expect(balanceBefore- balanceAfter).to.equal(satsToTbtc(feeSat))
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
        const balanceBefore = await tbtc.balanceOf(vault.target)
        await vault.connect(bridge.wallet).financeInKindFee(feeSat)
        expect(await tbtc.balanceOf(vault.target)).to.equal(balanceBefore)
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
      let coverableSat: bigint
      let shortfallSat: bigint

      before(async () => {
        await createSnapshot()

        const initiationFeeBps = await vault.initiationFeeBps()
        const reserveTbtc =
          (satsToTbtc(reserveDepositSat) * initiationFeeBps) / 10000n
        coverableSat = reserveTbtc / SATOSHI_MULTIPLIER
        shortfallSat = BigInt(feeSat)- coverableSat

        await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.target,
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
        const balanceBefore = await tbtc.balanceOf(vault.target)
        await vault.connect(bridge.wallet).financeInKindFee(feeSat)
        const balanceAfter = await tbtc.balanceOf(vault.target)
        expect(balanceBefore- balanceAfter).to.equal(
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
            vault.target,
            [account1.address],
            [fundDepositSat]
          )

        await tbtc
          .connect(account1)
          .approve(vault.target, ethers.MaxUint256)
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
          balanceBefore - (await tbtc.balanceOf(account1.address))
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
          balanceBefore - (await tbtc.balanceOf(account1.address))
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
      const newTarget = ethers.parseEther("1")
      await expect(vault.updateFeeReserveTarget(newTarget))
        .to.emit(vault, "FeeReserveTargetUpdated")
        .withArgs(newTarget)

      expect(await vault.feeReserveTarget()).to.equal(newTarget)
    })

    it("should allow setting the target equal to the current balance, after which sweepFees is a no-op", async () => {
      await bank
        .connect(bridge.wallet)
        .increaseBalanceAndCall(vault.target, [account1.address], [100_000])

      const currentBalance = await tbtc.balanceOf(vault.target)
      await vault.updateFeeReserveTarget(currentBalance)

      await expect(vault.sweepFees(account1.address)).to.not.be.reverted
      expect(await tbtc.balanceOf(vault.target)).to.equal(currentBalance)
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
        vault.sweepFees(ethers.ZeroAddress)
      ).to.be.revertedWith("Recipient must not be zero")
    })

    it("should be a no-op when balance is not above the reserve target", async () => {
      await vault.updateFeeReserveTarget(ethers.parseEther("1"))
      const balanceBefore = await tbtc.balanceOf(vault.target)

      await expect(vault.sweepFees(account1.address)).to.not.be.reverted

      expect(await tbtc.balanceOf(vault.target)).to.equal(balanceBefore)
    })

    context("happy path (zero outstanding debt)", () => {
      const reserveTargetSat = 1_000_000
      const extraSat = 500_000

      before(async () => {
        await createSnapshot()

        const initiationFeeBps = await vault.initiationFeeBps()
        const totalFeeSat = reserveTargetSat + extraSat
        const depositSat = Math.ceil((totalFeeSat * 10000) / Number(initiationFeeBps))

        await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.target,
            [account2.address],
            [depositSat]
          )

        const currentBalance = await tbtc.balanceOf(vault.target)
        await vault.updateFeeReserveTarget(
          currentBalance - satsToTbtc(extraSat)
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

        expect(await tbtc.balanceOf(vault.target)).to.equal(target)
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
        const depositSat = Math.ceil((totalFeeSat * 10000) / Number(initiationFeeBps))

        await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.target,
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
        expect(await tbtc.balanceOf(vault.target)).to.equal(
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
          .withArgs(vault.target, debtSat)
        await expect(tx)
          .to.emit(vault, "FeesSwept")
          .withArgs(account1.address, satsToTbtc(extraSat))
      })
    })

    context("when the vault balance covers only part of the debt", () => {
      // The repaid part must not divide the debt evenly: then a full
      // repayment and a partial one leave different remainders.
      const debtSat = 500_000
      const availableFeeSat = 200_000

      before(async () => {
        await createSnapshot()

        await vault.connect(bridge.wallet).financeInKindFee(debtSat)

        const initiationFeeBps = await vault.initiationFeeBps()
        const depositSat = Math.ceil(
          (availableFeeSat * 10000) / Number(initiationFeeBps)
        )
        await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(vault.target, [account2.address], [depositSat])
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should reduce the debt by exactly the repaid amount", async () => {
        const repaidSat =
          (await tbtc.balanceOf(vault.target)) / satsToTbtc(1)
        expect(repaidSat).to.be.greaterThan(0n)
        expect(repaidSat).to.be.lessThan(BigInt(debtSat))

        const tx = await vault.sweepFees(account1.address)

        expect(await vault.inKindFeeDebtSat()).to.equal(
          BigInt(debtSat) - repaidSat
        )
        await expect(tx)
          .to.emit(vault, "InKindFeeDebtRepaid")
          .withArgs(vault.target, repaidSat)
      })
    })

    context("when debt is outstanding and nothing remains to sweep", () => {
      const debtSat = 500_000
      const reserveTargetSat = 1_000_000

      before(async () => {
        await createSnapshot()

        // Create debt against an empty reserve.
        await vault.connect(bridge.wallet).financeInKindFee(debtSat)

        // Fund the vault so the retained fee covers exactly debt + target,
        // leaving nothing above the reserve target after debt repayment.
        const initiationFeeBps = await vault.initiationFeeBps()
        const totalFeeSat = debtSat + reserveTargetSat
        const depositSat = Math.ceil((totalFeeSat * 10000) / Number(initiationFeeBps))

        await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.target,
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

      it("should still repay the debt even though there is nothing to sweep", async () => {
        await expect(vault.sweepFees(account1.address)).to.not.be.reverted

        expect(await vault.inKindFeeDebtSat()).to.equal(0)
        expect(await tbtc.balanceOf(vault.target)).to.equal(
          satsToTbtc(reserveTargetSat)
        )
        expect(await tbtc.balanceOf(account1.address)).to.equal(0)
      })

      it("should emit InKindFeeDebtRepaid but not FeesSwept", async () => {
        const tx = await vault.sweepFees(account1.address)

        await expect(tx)
          .to.emit(vault, "InKindFeeDebtRepaid")
          .withArgs(vault.target, debtSat)
        await expect(tx).to.not.emit(vault, "FeesSwept")
      })
    })
  })

  describe("updateInitiationFee", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert when called by a non-owner", async () => {
      await expect(
        vault.connect(account1).updateInitiationFee(40)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should succeed when called by the owner with a valid fee and emit the event", async () => {
      await expect(vault.updateInitiationFee(50))
        .to.emit(vault, "FeesUpdated")
        .withArgs(50)

      expect(await vault.initiationFeeBps()).to.equal(50)
    })

    it("should revert when the fee exceeds MAX_FEE_BASIS_POINTS", async () => {
      await expect(vault.updateInitiationFee(501)).to.be.revertedWith(
        "Fee exceeds the maximum"
      )
    })

    it("should allow setting the fee to exactly MAX_FEE_BASIS_POINTS", async () => {
      const max = await vault.MAX_FEE_BASIS_POINTS()
      await expect(vault.updateInitiationFee(max))
        .to.emit(vault, "FeesUpdated")
        .withArgs(max)

      expect(await vault.initiationFeeBps()).to.equal(max)
    })
  })

  describe("receiveBalanceApproval", () => {
    it("should always revert", async () => {
      await expect(
        vault.receiveBalanceApproval(account1.address, 100, "0x")
      ).to.be.revertedWith("Balance approvals not supported")
    })
  })
})
