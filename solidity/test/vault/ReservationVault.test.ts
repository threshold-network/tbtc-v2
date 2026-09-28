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

  const ReservationState = {
    Active: 1,
    Stranded: 4,
  }

  // Sequential keys, so every position configured on the Bridge mock is
  // answered by its own exact-calldata entry.
  let nextReservationKey = 1

  type AcceptanceCredit = {
    termId?: number
    custodyBps?: number
    enabled?: boolean
    state?: number
  }

  /** The Bridge mock answers each position's key and term id by exact
   *  calldata and every other argument with zeros, so a vault that read the
   *  wrong key or the wrong term id would see custody 0 and the fee
   *  assertions below would fail.
   *
   *  Configures one accepted position on the Bridge mock, then credits it
   *  the way the Bridge does at acceptance: the Bank balance increase first,
   *  then `creditReservation(key)` from the Bridge. */
  async function creditAcceptance(
    owner: string,
    grossSat: number | BigNumber,
    {
      termId = 0,
      custodyBps = 0,
      enabled = true,
      state = ReservationState.Active,
    }: AcceptanceCredit = {}
  ): Promise<{ reservationKey: BigNumber; tx: ContractTransaction }> {
    const reservationKey = BigNumber.from(nextReservationKey)
    nextReservationKey += 1

    await bridge.reservations.whenCalledWith(reservationKey).returns({
      owner,
      mintedAmount: grossSat,
      acceptedAt: 0,
      walletPubKeyHash: `0x${"00".repeat(20)}`,
      anchorAmount: grossSat,
      expiresAt: 0,
      anchorTxHash: ethers.constants.HashZero,
      anchorTxOutputIndex: 0,
      state,
      requestNonce: 1,
      retryCredit: false,
      dissolutionEligibleAt: 0,
      cumulativeReanchorFee: 0,
      reanchorCooldownUntil: 0,
    })
    await bridge.reservationTermId
      .whenCalledWith(reservationKey)
      .returns(termId)
    await bridge.reservationTerm
      .whenCalledWith(termId)
      .returns({ termSeconds: 30 * 86400, custodyBps, enabled })

    await bank.connect(bridge.wallet).increaseBalance(vault.address, grossSat)
    const tx = await vault
      .connect(bridge.wallet)
      .creditReservation(reservationKey)
    return { reservationKey, tx }
  }

  /** Acceptance fee in TBTC units at the given basis points. */
  function feeAt(grossSat: number | BigNumber, bps: number): BigNumber {
    return satsToTbtc(grossSat).mul(bps).div(10000)
  }

  describe("constructor", () => {
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

      before(async () => {
        await createSnapshot()

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

      it("should transfer the gross amount to the depositor, with no reservation fee", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(
          satsToTbtc(depositedAmountSat)
        )
      })

      it("should retain nothing in the vault", async () => {
        expect(await tbtc.balanceOf(vault.address)).to.equal(0)
      })

      it("should mint exactly the gross amount", async () => {
        expect(await tbtc.totalSupply()).to.equal(
          satsToTbtc(depositedAmountSat)
        )
      })

      it("should leave no residual Bank balance for the vault or depositor", async () => {
        expect(await bank.balanceOf(vault.address)).to.equal(0)
        expect(await bank.balanceOf(account1.address)).to.equal(0)
      })

      it("should not emit ReservationCreditProcessed", async () => {
        await expect(tx).to.not.emit(vault, "ReservationCreditProcessed")
      })
    })

    context("when called with multiple depositors", () => {
      const depositedAmounts = [100_000, 250_000]
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

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

      it("should transfer each depositor's gross amount", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(
          satsToTbtc(depositedAmounts[0])
        )
        expect(await tbtc.balanceOf(account2.address)).to.equal(
          satsToTbtc(depositedAmounts[1])
        )
      })

      it("should retain nothing in the vault", async () => {
        expect(await tbtc.balanceOf(vault.address)).to.equal(0)
      })

      it("should not emit ReservationCreditProcessed", async () => {
        await expect(tx).to.not.emit(vault, "ReservationCreditProcessed")
      })
    })
  })

  describe("creditReservation", () => {
    const grossSat = 3_000_000

    // The seeded entries (id: custodyBps) and the acceptance fee each gives
    // at the default 20 bps mint fee.
    const SEEDED = [
      { termId: 1, custodyBps: 20, feeBps: 40 },
      { termId: 2, custodyBps: 2, feeBps: 22 },
      { termId: 3, custodyBps: 5, feeBps: 25 },
    ]

    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    /** Credits one position and checks the whole split: the owner's share,
     *  the vault's fee, the supply minted and the Bank balances. */
    async function expectCreditAt(
      credit: AcceptanceCredit,
      expectedFeeBps: number,
      sat: number = grossSat
    ) {
      const ownerBefore = await tbtc.balanceOf(account1.address)
      const vaultBefore = await tbtc.balanceOf(vault.address)
      const supplyBefore = await tbtc.totalSupply()

      const { tx } = await creditAcceptance(account1.address, sat, credit)

      const fee = feeAt(sat, expectedFeeBps)
      const ownerDelta = (await tbtc.balanceOf(account1.address)).sub(
        ownerBefore
      )
      const vaultDelta = (await tbtc.balanceOf(vault.address)).sub(vaultBefore)

      expect(ownerDelta).to.equal(satsToTbtc(sat).sub(fee))
      expect(vaultDelta).to.equal(fee)
      // Owner plus vault fee equals the gross amount, to the unit.
      expect(ownerDelta.add(vaultDelta)).to.equal(satsToTbtc(sat))
      expect((await tbtc.totalSupply()).sub(supplyBefore)).to.equal(
        satsToTbtc(sat)
      )
      expect(await bank.balanceOf(vault.address)).to.equal(0)
      expect(await bank.balanceOf(account1.address)).to.equal(0)
      await expect(tx)
        .to.emit(vault, "ReservationCreditProcessed")
        .withArgs(account1.address, sat, fee)
    }

    context("when called by a non-bridge address", () => {
      it("should revert", async () => {
        await bank.connect(bridge.wallet).increaseBalance(vault.address, 1000)
        await expect(
          vault.connect(account1).creditReservation(1)
        ).to.be.revertedWith("Caller is not the Bridge")
      })

      it("should revert when called by the Bank", async () => {
        const bankSigner = await impersonateBank()
        await expect(
          vault.connect(bankSigner).creditReservation(1)
        ).to.be.revertedWith("Caller is not the Bridge")
      })
    })

    SEEDED.forEach(({ termId, custodyBps, feeBps }) => {
      it(`should charge ${feeBps} bps for entry ${termId} (${custodyBps} bps custody)`, async () => {
        await expectCreditAt({ termId, custodyBps }, feeBps)
      })
    })

    it("should charge a disabled entry's custody fee", async () => {
      await expectCreditAt({ termId: 3, custodyBps: 5, enabled: false }, 25)
    })

    it("should charge the live mint fee, not a default", async () => {
      await vault.updateMintFee(30)
      await expectCreditAt({ termId: 2, custodyBps: 2 }, 32)
    })

    context("at the 500 bps clamp", () => {
      it("should charge 499 bps when mint plus custody is 499", async () => {
        await expectCreditAt({ termId: 4, custodyBps: 479 }, 499)
      })

      it("should charge 500 bps when mint plus custody is exactly 500", async () => {
        await expectCreditAt({ termId: 4, custodyBps: 480 }, 500)
      })

      it("should clamp to 500 bps when mint plus custody is 501", async () => {
        await expectCreditAt({ termId: 4, custodyBps: 481 }, 500)
      })

      it("should clamp to 500 bps at both maxima (1000 bps unclamped)", async () => {
        await vault.updateMintFee(500)
        await expectCreditAt({ termId: 4, custodyBps: 500 }, 500)
      })
    })

    context("when the position is Stranded at credit", () => {
      it("should charge the mint fee only", async () => {
        await expectCreditAt(
          { termId: 1, custodyBps: 20, state: ReservationState.Stranded },
          20
        )
      })

      it("should charge the mint fee only even when mint plus custody would clamp", async () => {
        await vault.updateMintFee(500)
        await expectCreditAt(
          { termId: 4, custodyBps: 500, state: ReservationState.Stranded },
          500
        )
        await vault.updateMintFee(20)
        await expectCreditAt(
          { termId: 4, custodyBps: 500, state: ReservationState.Stranded },
          20
        )
      })
    })

    context("when the position carries no term id", () => {
      it("should charge the mint fee only and not revert", async () => {
        // Entry 0 is never added (ids are 1-8), so it reads as zeroed.
        await expectCreditAt({ termId: 0, custodyBps: 0, enabled: false }, 20)
      })
    })

    context("rounding", () => {
      it("should split an odd amount exactly, owner plus fee equal to gross", async () => {
        // 1 sat at 22 bps: fee 0.0022 sat = 22 * 10^6 TBTC units, exact.
        await expectCreditAt({ termId: 2, custodyBps: 2 }, 22, 1)
        await expectCreditAt({ termId: 3, custodyBps: 5 }, 25, 12_345_679)
        await expectCreditAt({ termId: 4, custodyBps: 481 }, 500, 7)
      })
    })

    it("should credit consecutive positions, keeping every fee in the vault", async () => {
      // A second credit would revert on a leftover Bank allowance
      // ("Non-atomic allowance change not allowed"); none is left.
      await creditAcceptance(account1.address, grossSat, {
        termId: 1,
        custodyBps: 20,
      })
      expect(await bank.allowance(vault.address, tbtcVault.address)).to.equal(0)
      await creditAcceptance(account2.address, grossSat, {
        termId: 2,
        custodyBps: 2,
      })
      expect(await tbtc.balanceOf(vault.address)).to.equal(
        feeAt(grossSat, 40).add(feeAt(grossSat, 22))
      )
      expect(await tbtc.balanceOf(account2.address)).to.equal(
        satsToTbtc(grossSat).sub(feeAt(grossSat, 22))
      )
    })

    it("should not be gated by the vault owner", async () => {
      await vault.transferOwnership(account2.address)
      await expectCreditAt({ termId: 2, custodyBps: 2 }, 22)
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

        await creditAcceptance(account1.address, reserveDepositSat)
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

        const mintFeeBps = await vault.mintFeeBps()
        const reserveTbtc = satsToTbtc(reserveDepositSat)
          .mul(mintFeeBps)
          .div(10000)
        coverableSat = reserveTbtc.div(SATOSHI_MULTIPLIER)
        shortfallSat = BigNumber.from(feeSat).sub(coverableSat)

        await creditAcceptance(account1.address, reserveDepositSat)
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

        // Fund account1 with plenty of TBTC to repay with (minted gross
        // through the fee-free Bank callback).
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

    it("should allow setting the target equal to the current balance, after which sweepFees is a no-op", async () => {
      await creditAcceptance(account1.address, 100_000)

      const currentBalance = await tbtc.balanceOf(vault.address)
      await vault.updateFeeReserveTarget(currentBalance)

      await expect(vault.sweepFees(account1.address)).to.not.be.reverted
      expect(await tbtc.balanceOf(vault.address)).to.equal(currentBalance)
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

    it("should be a no-op when balance is not above the reserve target", async () => {
      await vault.updateFeeReserveTarget(ethers.utils.parseEther("1"))
      const balanceBefore = await tbtc.balanceOf(vault.address)

      await expect(vault.sweepFees(account1.address)).to.not.be.reverted

      expect(await tbtc.balanceOf(vault.address)).to.equal(balanceBefore)
    })

    context("happy path (zero outstanding debt)", () => {
      const reserveTargetSat = 1_000_000
      const extraSat = 500_000

      before(async () => {
        await createSnapshot()

        const mintFeeBps = await vault.mintFeeBps()
        const totalFeeSat = reserveTargetSat + extraSat
        const depositSat = Math.ceil((totalFeeSat * 10000) / mintFeeBps)

        await creditAcceptance(account2.address, depositSat)

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
        const mintFeeBps = await vault.mintFeeBps()
        const totalFeeSat = debtSat + reserveTargetSat + extraSat
        const depositSat = Math.ceil((totalFeeSat * 10000) / mintFeeBps)

        await creditAcceptance(account2.address, depositSat)

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

    context("when debt is outstanding and nothing remains to sweep", () => {
      const debtSat = 500_000
      const reserveTargetSat = 1_000_000

      before(async () => {
        await createSnapshot()

        // Create debt against an empty reserve.
        await vault.connect(bridge.wallet).financeInKindFee(debtSat)

        // Fund the vault so the retained fee covers exactly debt + target,
        // leaving nothing above the reserve target after debt repayment.
        const mintFeeBps = await vault.mintFeeBps()
        const totalFeeSat = debtSat + reserveTargetSat
        const depositSat = Math.ceil((totalFeeSat * 10000) / mintFeeBps)

        await creditAcceptance(account2.address, depositSat)

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
        expect(await tbtc.balanceOf(vault.address)).to.equal(
          satsToTbtc(reserveTargetSat)
        )
        expect(await tbtc.balanceOf(account1.address)).to.equal(0)
      })

      it("should emit InKindFeeDebtRepaid but not FeesSwept", async () => {
        const tx = await vault.sweepFees(account1.address)

        await expect(tx)
          .to.emit(vault, "InKindFeeDebtRepaid")
          .withArgs(vault.address, debtSat)
        await expect(tx).to.not.emit(vault, "FeesSwept")
      })
    })
  })

  describe("updateMintFee", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should default to the 20 bps mint leg", async () => {
      expect(await vault.mintFeeBps()).to.equal(20)
    })

    it("should revert when called by a non-owner", async () => {
      await expect(
        vault.connect(account1).updateMintFee(40)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should succeed when called by the owner with a valid fee and emit the event", async () => {
      await expect(vault.updateMintFee(50))
        .to.emit(vault, "FeesUpdated")
        .withArgs(50)

      expect(await vault.mintFeeBps()).to.equal(50)
    })

    it("should revert when the fee exceeds MAX_FEE_BASIS_POINTS", async () => {
      await expect(vault.updateMintFee(501)).to.be.revertedWith(
        "Fee exceeds the maximum"
      )
    })

    it("should allow setting the fee to exactly MAX_FEE_BASIS_POINTS", async () => {
      const max = await vault.MAX_FEE_BASIS_POINTS()
      await expect(vault.updateMintFee(max))
        .to.emit(vault, "FeesUpdated")
        .withArgs(max)

      expect(await vault.mintFeeBps()).to.equal(max)
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
