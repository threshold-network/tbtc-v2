import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber, BigNumberish } from "ethers"

import {
  Bank,
  Bridge,
  TBTC,
  TBTCVault,
  TBTCVaultThrottleExemptStub,
} from "../../typechain"
import { createMock } from "../helpers/mock"
import type { Mock } from "../helpers/mock"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime } = helpers.time
const { impersonateAccount } = helpers.account

describe("TBTCVault - OptimisticMintingCaps", () => {
  // 1 BTC in satoshi.
  const BTC = 100_000_000
  const DAY = 86400

  // Multiplier converting satoshi to 1e18 TBTC precision.
  const SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)

  const MAX_UINT64 = BigNumber.from(2).pow(64).sub(1)
  const MAX_UINT32 = BigNumber.from(2).pow(32).sub(1)

  // Contract defaults.
  const DEFAULT_DEBT_CAP = 10 * BTC
  const DEFAULT_CAP_PER_MINTER = 10 * BTC
  const DEFAULT_MAX_DEPOSIT_SIZE = 5 * BTC
  const DEFAULT_REQUEST_LIMIT = 100

  let governance: SignerWithAddress
  let minter: SignerWithAddress
  let minterTwo: SignerWithAddress
  let guardian: SignerWithAddress
  let depositorSigner: SignerWithAddress
  let treasury: SignerWithAddress
  let thirdParty: SignerWithAddress

  let bridge: Mock<Bridge>
  let bank: Mock<Bank>
  let tbtc: TBTC
  let tbtcVault: TBTCVault

  // Ensures unique funding transaction hashes across all fabricated deposits.
  let depositNonce = 0

  // Fabricates a revealed deposit of the given amount in the fake Bridge,
  // targeted at the given vault. Returns the funding transaction coordinates
  // to be used with requestOptimisticMint.
  async function fabricateDeposit(
    amountSat: BigNumberish,
    vaultAddress: string,
    treasuryFee: BigNumberish = 0
  ): Promise<{ fundingTxHash: string; fundingOutputIndex: number }> {
    depositNonce += 1
    const fundingTxHash = ethers.utils.hexZeroPad(
      BigNumber.from(depositNonce).toHexString(),
      32
    )
    const fundingOutputIndex = 0
    const depositKey = ethers.utils.solidityKeccak256(
      ["bytes32", "uint32"],
      [fundingTxHash, fundingOutputIndex]
    )
    await bridge.deposits.whenCalledWith(BigNumber.from(depositKey)).returns({
      depositor: depositorSigner.address,
      amount: amountSat,
      revealedAt: 1,
      vault: vaultAddress,
      treasuryFee,
      sweptAt: 0,
      extraData: ethers.constants.HashZero,
    })
    return { fundingTxHash, fundingOutputIndex }
  }

  // Updates the optimistic minting limits, waiting out the governance delay.
  async function updateCaps(
    debtCap: BigNumberish,
    capPerMinter: BigNumberish,
    maxDepositSize: BigNumberish,
    requestLimit: BigNumberish
  ) {
    await tbtcVault
      .connect(governance)
      .beginOptimisticMintingCapsUpdate(
        debtCap,
        capPerMinter,
        maxDepositSize,
        requestLimit
      )
    await increaseTime(DAY)
    await tbtcVault.connect(governance).finalizeOptimisticMintingCapsUpdate()
  }

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[
      governance,
      minter,
      minterTwo,
      guardian,
      depositorSigner,
      treasury,
      thirdParty,
    ] = await ethers.getSigners()

    bridge = await createMock<Bridge>("Bridge")
    bank = await createMock<Bank>("Bank")
    await bridge.treasury.returns(treasury.address)

    const TBTCFactory = await ethers.getContractFactory("TBTC")
    tbtc = await TBTCFactory.connect(governance).deploy()

    const TBTCVaultFactory = await ethers.getContractFactory("TBTCVault")
    tbtcVault = await TBTCVaultFactory.connect(governance).deploy(
      bank.address,
      tbtc.address,
      bridge.address
    )

    await tbtc.connect(governance).transferOwnership(tbtcVault.address)

    await tbtcVault.connect(governance).addMinter(minter.address)
    await tbtcVault.connect(governance).addMinter(minterTwo.address)
    await tbtcVault.connect(governance).addGuardian(guardian.address)
  })

  describe("default parameters", () => {
    it("should set the expected limit defaults", async () => {
      expect(await tbtcVault.optimisticMintingDebtCap()).to.equal(
        DEFAULT_DEBT_CAP
      )
      expect(await tbtcVault.optimisticMintingCapPerMinter()).to.equal(
        DEFAULT_CAP_PER_MINTER
      )
      expect(await tbtcVault.optimisticMintingMaxDepositSize()).to.equal(
        DEFAULT_MAX_DEPOSIT_SIZE
      )
      expect(await tbtcVault.optimisticMintingRequestLimitPerMinter()).to.equal(
        DEFAULT_REQUEST_LIMIT
      )
    })

    it("should report full allowances for an unused minter", async () => {
      const allowance = await tbtcVault.getOptimisticMintingAllowance(
        minter.address
      )
      expect(allowance.minterValueRemaining).to.equal(DEFAULT_CAP_PER_MINTER)
      expect(allowance.minterRequestsRemaining).to.equal(DEFAULT_REQUEST_LIMIT)
      expect(allowance.globalHeadroomRemaining).to.equal(DEFAULT_DEBT_CAP)
    })
  })

  describe("beginOptimisticMintingCapsUpdate", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault
            .connect(thirdParty)
            .beginOptimisticMintingCapsUpdate(1, 2, 3, 4)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the governance", () => {
      it("should set pending values and emit an event", async () => {
        const tx = await tbtcVault
          .connect(governance)
          .beginOptimisticMintingCapsUpdate(60 * BTC, 20 * BTC, 5 * BTC, 40)

        await expect(tx)
          .to.emit(tbtcVault, "OptimisticMintingCapsUpdateStarted")
          .withArgs(60 * BTC, 20 * BTC, 5 * BTC, 40)

        expect(await tbtcVault.newOptimisticMintingDebtCap()).to.equal(60 * BTC)
        expect(await tbtcVault.newOptimisticMintingCapPerMinter()).to.equal(
          20 * BTC
        )
        expect(await tbtcVault.newOptimisticMintingMaxDepositSize()).to.equal(
          5 * BTC
        )
        expect(
          await tbtcVault.newOptimisticMintingRequestLimitPerMinter()
        ).to.equal(40)
        expect(
          await tbtcVault.optimisticMintingCapsUpdateInitiatedTimestamp()
        ).to.be.gt(0)

        // Current values are not changed yet.
        expect(await tbtcVault.optimisticMintingDebtCap()).to.equal(
          DEFAULT_DEBT_CAP
        )
      })
    })
  })

  describe("finalizeOptimisticMintingCapsUpdate", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the update has not been initiated", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault.connect(governance).finalizeOptimisticMintingCapsUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await tbtcVault
          .connect(governance)
          .beginOptimisticMintingCapsUpdate(60 * BTC, 20 * BTC, 5 * BTC, 40)
        await increaseTime(DAY)
        await expect(
          tbtcVault.connect(thirdParty).finalizeOptimisticMintingCapsUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the governance delay has not elapsed", () => {
      it("should revert", async () => {
        await tbtcVault
          .connect(governance)
          .beginOptimisticMintingCapsUpdate(60 * BTC, 20 * BTC, 5 * BTC, 40)
        await increaseTime(DAY - 3600) // 23 hours
        await expect(
          tbtcVault.connect(governance).finalizeOptimisticMintingCapsUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context("when the governance delay has elapsed", () => {
      it("should update the values, emit an event and reset the state", async () => {
        await increaseTime(3600) // 24 hours in total

        const tx = await tbtcVault
          .connect(governance)
          .finalizeOptimisticMintingCapsUpdate()

        await expect(tx)
          .to.emit(tbtcVault, "OptimisticMintingCapsUpdated")
          .withArgs(60 * BTC, 20 * BTC, 5 * BTC, 40)

        expect(await tbtcVault.optimisticMintingDebtCap()).to.equal(60 * BTC)
        expect(await tbtcVault.optimisticMintingCapPerMinter()).to.equal(
          20 * BTC
        )
        expect(await tbtcVault.optimisticMintingMaxDepositSize()).to.equal(
          5 * BTC
        )
        expect(
          await tbtcVault.optimisticMintingRequestLimitPerMinter()
        ).to.equal(40)

        expect(await tbtcVault.newOptimisticMintingDebtCap()).to.equal(0)
        expect(await tbtcVault.newOptimisticMintingCapPerMinter()).to.equal(0)
        expect(await tbtcVault.newOptimisticMintingMaxDepositSize()).to.equal(0)
        expect(
          await tbtcVault.newOptimisticMintingRequestLimitPerMinter()
        ).to.equal(0)
        expect(
          await tbtcVault.optimisticMintingCapsUpdateInitiatedTimestamp()
        ).to.equal(0)
      })
    })
  })

  describe("deposit size cap", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should reject a deposit exceeding the maximum size", async () => {
      const deposit = await fabricateDeposit(
        DEFAULT_MAX_DEPOSIT_SIZE + 1,
        tbtcVault.address
      )
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.be.revertedWith("Deposit exceeds optimistic minting size cap")
    })

    it("should accept a deposit of exactly the maximum size", async () => {
      const deposit = await fabricateDeposit(
        DEFAULT_MAX_DEPOSIT_SIZE,
        tbtcVault.address
      )
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.emit(tbtcVault, "OptimisticMintingRequested")
    })
  })

  describe("per-minter cap", () => {
    before(async () => {
      await createSnapshot()
      // Only the per-minter value cap is active.
      await updateCaps(0, 5 * BTC, 0, 0)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should consume the minter allowance and emit an event", async () => {
      const deposit = await fabricateDeposit(3 * BTC, tbtcVault.address)
      const tx = await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      // The first request starts from a full bucket so the remaining values
      // are exact. The global cap is disabled so its remaining value is
      // reported as the uint64 sentinel.
      await expect(tx)
        .to.emit(tbtcVault, "OptimisticMintingAllowanceConsumed")
        .withArgs(minter.address, 3 * BTC, 2 * BTC, MAX_UINT64, MAX_UINT32)
    })

    it("should reject a request exceeding the remaining allowance", async () => {
      const deposit = await fabricateDeposit(3 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.be.revertedWith("Optimistic minting minter cap exceeded")
    })

    it("should track other minters' allowances independently", async () => {
      const deposit = await fabricateDeposit(3 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minterTwo)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.emit(tbtcVault, "OptimisticMintingRequested")
    })
  })

  describe("debt cap", () => {
    beforeEach(async () => {
      await createSnapshot()
      await updateCaps(6 * BTC, 5 * BTC, 0, 0)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should bind across minters and enforce the inclusive cap boundary", async () => {
      const first = await fabricateDeposit(4 * BTC, tbtcVault.address)
      const tx = await tbtcVault
        .connect(minter)
        .requestOptimisticMint(first.fundingTxHash, first.fundingOutputIndex)

      await expect(tx)
        .to.emit(tbtcVault, "OptimisticMintingAllowanceConsumed")
        .withArgs(minter.address, 4 * BTC, 1 * BTC, 2 * BTC, MAX_UINT32)

      const exact = await fabricateDeposit(2 * BTC, tbtcVault.address)
      const exactTx = await tbtcVault
        .connect(minterTwo)
        .requestOptimisticMint(exact.fundingTxHash, exact.fundingOutputIndex)
      await expect(exactTx)
        .to.emit(tbtcVault, "OptimisticMintingAllowanceConsumed")
        .withArgs(minterTwo.address, 2 * BTC, 3 * BTC, 0, MAX_UINT32)

      const over = await fabricateDeposit(1, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minterTwo)
          .requestOptimisticMint(over.fundingTxHash, over.fundingOutputIndex)
      ).to.be.revertedWith("Optimistic minting debt cap exceeded")
    })

    it("should release the headroom on cancellation", async () => {
      const first = await fabricateDeposit(4 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(first.fundingTxHash, first.fundingOutputIndex)

      expect(await tbtcVault.optimisticMintingPendingTotal()).to.equal(4 * BTC)

      await tbtcVault
        .connect(guardian)
        .cancelOptimisticMint(first.fundingTxHash, first.fundingOutputIndex)

      expect(await tbtcVault.optimisticMintingPendingTotal()).to.equal(0)

      const second = await fabricateDeposit(4 * BTC, tbtcVault.address)
      const tx = await tbtcVault
        .connect(minterTwo)
        .requestOptimisticMint(second.fundingTxHash, second.fundingOutputIndex)
      await expect(tx)
        .to.emit(tbtcVault, "OptimisticMintingAllowanceConsumed")
        .withArgs(minterTwo.address, 4 * BTC, 1 * BTC, 2 * BTC, MAX_UINT32)

      const third = await fabricateDeposit(2 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(third.fundingTxHash, third.fundingOutputIndex)
      ).to.be.revertedWith("Optimistic minting minter cap exceeded")
    })

    it("should release pending exposure permissionlessly once the deposit is swept", async () => {
      const deposit = await fabricateDeposit(4 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      const depositKey = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [deposit.fundingTxHash, deposit.fundingOutputIndex]
      )
      await bridge.deposits.whenCalledWith(BigNumber.from(depositKey)).returns({
        depositor: depositorSigner.address,
        amount: 4 * BTC,
        revealedAt: 1,
        vault: tbtcVault.address,
        treasuryFee: 0,
        sweptAt: 1,
        extraData: ethers.constants.HashZero,
      })

      await expect(
        tbtcVault
          .connect(thirdParty)
          .releaseOptimisticMintForSweptDeposit(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.emit(tbtcVault, "OptimisticMintingPendingReleased")

      expect(await tbtcVault.optimisticMintingPendingTotal()).to.equal(0)

      // Allowance should remain consumed: a new request from the same
      // minter, sized to exceed the ~1 BTC bucket remainder after the
      // original 4 BTC request, should still exceed the minter cap
      // (mirrors guardian cancellation behavior). Re-requesting the same
      // swept deposit is not usable for this assertion since it now
      // reverts earlier with "The deposit is already swept".
      const another = await fabricateDeposit(2 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            another.fundingTxHash,
            another.fundingOutputIndex
          )
      ).to.be.revertedWith("Optimistic minting minter cap exceeded")
    })
  })

  describe("debt settlement", () => {
    beforeEach(async () => {
      await createSnapshot()
      await updateCaps(6 * BTC, 0, 0, 0)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should count in-flight requests against the cap", async () => {
      const deposit = await fabricateDeposit(4 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )
      expect(await tbtcVault.optimisticMintingPendingTotal()).to.equal(4 * BTC)

      const blocked = await fabricateDeposit(3 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            blocked.fundingTxHash,
            blocked.fundingOutputIndex
          )
      ).to.be.revertedWith("Optimistic minting debt cap exceeded")
    })

    it("should move the pending value to the debt on finalization", async () => {
      const deposit = await fabricateDeposit(4 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      const delay = await tbtcVault.optimisticMintingDelay()
      await increaseTime(delay + 1)

      await tbtcVault
        .connect(minter)
        .finalizeOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      expect(await tbtcVault.optimisticMintingPendingTotal()).to.equal(0)
      expect(await tbtcVault.optimisticMintingDebtTotal()).to.equal(
        SATOSHI_MULTIPLIER.mul(4 * BTC)
      )

      const blocked = await fabricateDeposit(3 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            blocked.fundingTxHash,
            blocked.fundingOutputIndex
          )
      ).to.be.revertedWith("Optimistic minting debt cap exceeded")
    })

    it("should apply treasury fee when moving pending to debt", async () => {
      const treasuryFee = 10
      const deposit = await fabricateDeposit(
        4 * BTC,
        tbtcVault.address,
        treasuryFee
      )
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      expect(await tbtcVault.optimisticMintingPendingTotal()).to.equal(4 * BTC)

      const delay = await tbtcVault.optimisticMintingDelay()
      await increaseTime(delay + 1)
      await tbtcVault
        .connect(minter)
        .finalizeOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      expect(await tbtcVault.optimisticMintingPendingTotal()).to.equal(0)
      expect(await tbtcVault.optimisticMintingDebtTotal()).to.equal(
        SATOSHI_MULTIPLIER.mul(4 * BTC - treasuryFee)
      )
    })

    it("should keep an unswept deposit's debt counted against the cap after a different deposit for the same depositor is repaid", async () => {
      await updateCaps(10 * BTC, 10 * BTC, 5 * BTC, 100)

      // First deposit: 1 BTC
      const deposit1 = await fabricateDeposit(1 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit1.fundingTxHash,
          deposit1.fundingOutputIndex
        )
      const delay = await tbtcVault.optimisticMintingDelay()
      await increaseTime(delay + 1)
      await tbtcVault
        .connect(minter)
        .finalizeOptimisticMint(
          deposit1.fundingTxHash,
          deposit1.fundingOutputIndex
        )

      // Second deposit: 3 BTC
      const deposit2 = await fabricateDeposit(3 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit2.fundingTxHash,
          deposit2.fundingOutputIndex
        )
      await increaseTime(delay + 1)
      await tbtcVault
        .connect(minter)
        .finalizeOptimisticMint(
          deposit2.fundingTxHash,
          deposit2.fundingOutputIndex
        )

      // Now, total debt = 4 BTC (1+3) under a 10 BTC cap -> headroom = 6 BTC
      // We will repay the first deposit (1 BTC) only
      const bankSigner = await impersonateAccount(bank.address, {
        from: governance,
        value: 10,
      })
      await tbtcVault
        .connect(bankSigner)
        .receiveBalanceIncrease([depositorSigner.address], [1 * BTC])

      // After repaying 1 BTC, the total debt should be 3 BTC
      expect(await tbtcVault.optimisticMintingDebtTotal()).to.equal(
        SATOSHI_MULTIPLIER.mul(3 * BTC)
      )

      const allowance = await tbtcVault.getOptimisticMintingAllowance(
        minter.address
      )
      // The global headroom remaining should be: cap - remaining debt = 10 BTC - 3 BTC = 7 BTC
      expect(allowance.globalHeadroomRemaining).to.equal(7 * BTC)
    })

    it("should recycle the capacity when the debt is repaid", async () => {
      const deposit = await fabricateDeposit(4 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      const delay = await tbtcVault.optimisticMintingDelay()
      await increaseTime(delay + 1)
      await tbtcVault
        .connect(minter)
        .finalizeOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      const bankSigner = await impersonateAccount(bank.address, {
        from: governance,
        value: 10,
      })
      await tbtcVault
        .connect(bankSigner)
        .receiveBalanceIncrease([depositorSigner.address], [4 * BTC])

      expect(await tbtcVault.optimisticMintingDebtTotal()).to.equal(0)

      const unblocked = await fabricateDeposit(3 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            unblocked.fundingTxHash,
            unblocked.fundingOutputIndex
          )
      ).to.emit(tbtcVault, "OptimisticMintingRequested")
    })
  })

  describe("cap lowered below the outstanding exposure", () => {
    let deposit
    before(async () => {
      await createSnapshot()
      await updateCaps(6 * BTC, 0, 0, 0)

      deposit = await fabricateDeposit(5 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      await updateCaps(3 * BTC, 0, 0, 0)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should report zero headroom", async () => {
      const allowance = await tbtcVault.getOptimisticMintingAllowance(
        minter.address
      )
      expect(allowance.globalHeadroomRemaining).to.equal(0)
    })

    it("should reject new requests", async () => {
      const deposit = await fabricateDeposit(1 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.be.revertedWith("Optimistic minting debt cap exceeded")
    })

    it("should allow finalizing pre-existing requests after cap is lowered", async () => {
      const delay = await tbtcVault.optimisticMintingDelay()
      await increaseTime(delay + 1)
      await expect(
        tbtcVault
          .connect(minter)
          .finalizeOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.not.be.reverted
    })
  })

  describe("per-minter cap lowering", () => {
    beforeEach(async () => {
      await createSnapshot()
      await updateCaps(0, 10 * BTC, 0, 10)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should clamp a lowered value cap and reject requests above it", async () => {
      const deposit = await fabricateDeposit(2 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      await updateCaps(0, 4 * BTC, 0, 10)

      const allowance = await tbtcVault.getOptimisticMintingAllowance(
        minter.address
      )
      expect(allowance.minterValueRemaining).to.equal(4 * BTC)

      const blocked = await fabricateDeposit(5 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            blocked.fundingTxHash,
            blocked.fundingOutputIndex
          )
      ).to.be.revertedWith("Optimistic minting minter cap exceeded")
    })

    it("should clamp a lowered request limit", async () => {
      await updateCaps(0, 0, 0, 3)

      const first = await fabricateDeposit(0.1 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minterTwo)
        .requestOptimisticMint(first.fundingTxHash, first.fundingOutputIndex)

      await updateCaps(0, 0, 0, 1)

      const allowance = await tbtcVault.getOptimisticMintingAllowance(
        minterTwo.address
      )
      expect(allowance.minterRequestsRemaining).to.equal(1)
    })
  })

  describe("allowance refill", () => {
    before(async () => {
      await createSnapshot()
      await updateCaps(0, 4 * BTC, 0, 0)

      // Exhaust the minter's bucket.
      const deposit = await fabricateDeposit(4 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should reject a request right after the bucket exhausts", async () => {
      const deposit = await fabricateDeposit(1 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.be.revertedWith("Optimistic minting minter cap exceeded")
    })

    it("should refill the bucket continuously", async () => {
      await increaseTime(DAY / 2)

      // After 12 hours, roughly half of the 4 BTC cap has refilled.
      const allowance = await tbtcVault.getOptimisticMintingAllowance(
        minter.address
      )
      expect(allowance.minterValueRemaining).to.be.closeTo(
        BigNumber.from(2 * BTC),
        0.1 * BTC
      )

      const deposit = await fabricateDeposit(1.5 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.emit(tbtcVault, "OptimisticMintingRequested")
    })

    it("should clamp the refill at the cap", async () => {
      await increaseTime(2 * DAY)

      const allowance = await tbtcVault.getOptimisticMintingAllowance(
        minter.address
      )
      expect(allowance.minterValueRemaining).to.equal(4 * BTC)
    })
  })

  describe("request count limit", () => {
    before(async () => {
      await createSnapshot()
      await updateCaps(0, 0, 0, 2)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should bound the number of requests in the window", async () => {
      const first = await fabricateDeposit(0.1 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(first.fundingTxHash, first.fundingOutputIndex)

      const second = await fabricateDeposit(0.1 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(second.fundingTxHash, second.fundingOutputIndex)

      const third = await fabricateDeposit(0.1 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(third.fundingTxHash, third.fundingOutputIndex)
      ).to.be.revertedWith("Optimistic minting request limit exceeded")
    })

    it("should accrue the fractional refill without loss", async () => {
      // Half a window refills exactly limit/2 = 1 request token.
      await increaseTime(DAY / 2)

      const first = await fabricateDeposit(0.1 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(first.fundingTxHash, first.fundingOutputIndex)

      const second = await fabricateDeposit(0.1 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            second.fundingTxHash,
            second.fundingOutputIndex
          )
      ).to.be.revertedWith("Optimistic minting request limit exceeded")
    })

    it("should allow requests again after the window refills", async () => {
      await increaseTime(DAY)

      const deposit = await fabricateDeposit(0.1 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.emit(tbtcVault, "OptimisticMintingRequested")
    })
  })

  describe("fractional allowance refill", () => {
    describe("when a whole token leaves a fractional remainder", () => {
      before(async () => {
        await createSnapshot()
        await updateCaps(0, 2, 0, 2)

        // Exhaust both two-token buckets.
        for (let i = 0; i < 2; i++) {
          // Mock setup and requests must be mined sequentially.
          // eslint-disable-next-line no-await-in-loop
          const deposit = await fabricateDeposit(1, tbtcVault.address)
          // eslint-disable-next-line no-await-in-loop
          await tbtcVault
            .connect(minter)
            .requestOptimisticMint(
              deposit.fundingTxHash,
              deposit.fundingOutputIndex
            )
        }
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should preserve the remainder for value and request tokens", async () => {
        const rawAllowance = await tbtcVault.minterAllowances(minter.address)
        const checkpoint = rawAllowance.requestsRefilledAt.toNumber()
        expect(rawAllowance.valueRefilledAt).to.equal(checkpoint)

        const first = await fabricateDeposit(1, tbtcVault.address)
        // At a rate of two tokens per day, 23 hours accrues one token and
        // leaves 11 hours of fractional refill time.
        await ethers.provider.send("evm_setNextBlockTimestamp", [
          BigNumber.from(checkpoint + (23 * DAY) / 24).toHexString(),
        ])
        await expect(
          tbtcVault
            .connect(minter)
            .requestOptimisticMint(
              first.fundingTxHash,
              first.fundingOutputIndex
            )
        ).to.emit(tbtcVault, "OptimisticMintingRequested")

        const second = await fabricateDeposit(1, tbtcVault.address)
        // The retained remainder plus one more hour completes the next token.
        await ethers.provider.send("evm_setNextBlockTimestamp", [
          BigNumber.from(checkpoint + DAY).toHexString(),
        ])
        await expect(
          tbtcVault
            .connect(minter)
            .requestOptimisticMint(
              second.fundingTxHash,
              second.fundingOutputIndex
            )
        ).to.emit(tbtcVault, "OptimisticMintingRequested")
      })
    })

    describe("when the daily limit does not divide a day", () => {
      before(async () => {
        await createSnapshot()
        await updateCaps(0, 0, 0, 7)

        for (let i = 0; i < 7; i++) {
          // Mock setup and requests must be mined sequentially.
          // eslint-disable-next-line no-await-in-loop
          const deposit = await fabricateDeposit(1, tbtcVault.address)
          // eslint-disable-next-line no-await-in-loop
          await tbtcVault
            .connect(minter)
            .requestOptimisticMint(
              deposit.fundingTxHash,
              deposit.fundingOutputIndex
            )
        }
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not credit the next request token early", async () => {
        const rawAllowance = await tbtcVault.minterAllowances(minter.address)
        const checkpoint = rawAllowance.requestsRefilledAt.toNumber()
        const firstTokenAt = checkpoint + Math.ceil(DAY / 7)
        const secondTokenAt = checkpoint + Math.ceil((2 * DAY) / 7)

        const deposit = await fabricateDeposit(1, tbtcVault.address)
        await ethers.provider.send("evm_setNextBlockTimestamp", [
          BigNumber.from(firstTokenAt).toHexString(),
        ])
        await tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )

        await ethers.provider.send("evm_setNextBlockTimestamp", [
          BigNumber.from(secondTokenAt - 1).toHexString(),
        ])
        await ethers.provider.send("evm_mine", [])
        let allowance = await tbtcVault.getOptimisticMintingAllowance(
          minter.address
        )
        expect(allowance.minterRequestsRemaining).to.equal(0)

        await ethers.provider.send("evm_setNextBlockTimestamp", [
          BigNumber.from(secondTokenAt).toHexString(),
        ])
        await ethers.provider.send("evm_mine", [])
        allowance = await tbtcVault.getOptimisticMintingAllowance(
          minter.address
        )
        expect(allowance.minterRequestsRemaining).to.equal(1)
      })
    })
  })

  describe("enabling a previously-disabled limit", () => {
    before(async () => {
      await createSnapshot()
      // Count-only throttling: the value dimension is disabled and must not
      // be poisoned by activity happening while it is off.
      await updateCaps(0, 0, 0, 5)

      const first = await fabricateDeposit(3 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(first.fundingTxHash, first.fundingOutputIndex)
      const second = await fabricateDeposit(3 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(second.fundingTxHash, second.fundingOutputIndex)

      // Enable the per-minter value cap.
      await updateCaps(0, 5 * BTC, 0, 5)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should give active minters a full bucket for the newly-enabled limit", async () => {
      // The minter was active while the value cap was disabled; the newly
      // enabled 5 BTC bucket starts full, so an exact-boundary request
      // consuming the whole bucket succeeds.
      const deposit = await fabricateDeposit(5 * BTC, tbtcVault.address)
      const tx = await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )
      await expect(tx)
        .to.emit(tbtcVault, "OptimisticMintingAllowanceConsumed")
        .withArgs(minter.address, 5 * BTC, 0, MAX_UINT64, 4)

      // The bucket is exhausted by the exact-boundary request.
      const blocked = await fabricateDeposit(1 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            blocked.fundingTxHash,
            blocked.fundingOutputIndex
          )
      ).to.be.revertedWith("Optimistic minting minter cap exceeded")
    })
  })

  describe("cancellation", () => {
    before(async () => {
      await createSnapshot()
      await updateCaps(0, 5 * BTC, 0, 0)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should not restore the consumed allowance", async () => {
      const deposit = await fabricateDeposit(4 * BTC, tbtcVault.address)
      await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      await tbtcVault
        .connect(guardian)
        .cancelOptimisticMint(deposit.fundingTxHash, deposit.fundingOutputIndex)

      // Requesting the same deposit again is allowed but the bucket still
      // remembers the first request: only ~1 BTC of allowance is left.
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.be.revertedWith("Optimistic minting minter cap exceeded")
    })

    it("should allow requesting the cancelled deposit after a refill", async () => {
      await increaseTime(DAY)

      const deposit = await fabricateDeposit(4 * BTC, tbtcVault.address)
      await expect(
        tbtcVault
          .connect(minter)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.emit(tbtcVault, "OptimisticMintingRequested")
    })
  })

  describe("disabled limits", () => {
    before(async () => {
      await createSnapshot()
      await updateCaps(0, 0, 0, 0)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should not limit requests", async () => {
      const deposit = await fabricateDeposit(200 * BTC, tbtcVault.address)
      const tx = await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      await expect(tx)
        .to.emit(tbtcVault, "OptimisticMintingAllowanceConsumed")
        .withArgs(minter.address, 200 * BTC, MAX_UINT64, MAX_UINT64, MAX_UINT32)

      // The in-flight exposure is still measured even with the limits
      // disabled.
      expect(await tbtcVault.optimisticMintingPendingTotal()).to.equal(
        200 * BTC
      )
    })

    it("should report maximum allowances", async () => {
      const allowance = await tbtcVault.getOptimisticMintingAllowance(
        minter.address
      )
      expect(allowance.minterValueRemaining).to.equal(MAX_UINT64)
      expect(allowance.minterRequestsRemaining).to.equal(MAX_UINT32)
      expect(allowance.globalHeadroomRemaining).to.equal(MAX_UINT64)
    })
  })

  describe("finalization", () => {
    before(async () => {
      await createSnapshot()
      await updateCaps(10 * BTC, 10 * BTC, 0, 0)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should not consume any additional allowance", async () => {
      const deposit = await fabricateDeposit(2 * BTC, tbtcVault.address)
      const tx = await tbtcVault
        .connect(minter)
        .requestOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )
      await expect(tx)
        .to.emit(tbtcVault, "OptimisticMintingAllowanceConsumed")
        .withArgs(minter.address, 2 * BTC, 8 * BTC, 8 * BTC, MAX_UINT32)

      const delay = await tbtcVault.optimisticMintingDelay()
      await increaseTime(delay + 1)

      await tbtcVault
        .connect(minter)
        .finalizeOptimisticMint(
          deposit.fundingTxHash,
          deposit.fundingOutputIndex
        )

      // TBTC has been minted to the depositor...
      expect(await tbtc.balanceOf(depositorSigner.address)).to.be.gt(0)

      // ...but no additional allowance has been consumed. The minter bucket
      // can only have refilled since the request and the debt cap headroom
      // is exactly the cap minus the 2 BTC of outstanding debt.
      const allowance = await tbtcVault.getOptimisticMintingAllowance(
        minter.address
      )
      expect(allowance.minterValueRemaining).to.be.gte(8 * BTC)
      expect(allowance.globalHeadroomRemaining).to.equal(8 * BTC)
    })
  })

  describe("throttle exemption", () => {
    let stubVault: TBTCVaultThrottleExemptStub

    before(async () => {
      await createSnapshot()

      const StubFactory = await ethers.getContractFactory(
        "TBTCVaultThrottleExemptStub"
      )
      stubVault = await StubFactory.connect(governance).deploy(
        bank.address,
        tbtc.address,
        bridge.address
      )
      await stubVault.connect(governance).addMinter(minter.address)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should enforce the limits for non-exempt requesters", async () => {
      const deposit = await fabricateDeposit(20 * BTC, stubVault.address)
      await expect(
        stubVault
          .connect(minter)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      ).to.be.revertedWith("Deposit exceeds optimistic minting size cap")
    })

    it("should bypass the limits for exempt requesters", async () => {
      await stubVault.setThrottleExempt(minter.address, true)

      const deposit = await fabricateDeposit(20 * BTC, stubVault.address)
      await expect(
        stubVault
          .connect(minter)
          .requestOptimisticMint(
            deposit.fundingTxHash,
            deposit.fundingOutputIndex
          )
      )
        .to.emit(stubVault, "OptimisticMintingRequested")
        .and.to.emit(stubVault, "OptimisticMintingAllowanceConsumed")
    })

    it("should not consume the per-minter allowance for exempt requesters", async () => {
      const allowance = await stubVault.getOptimisticMintingAllowance(
        minter.address
      )
      expect(allowance.minterValueRemaining).to.equal(DEFAULT_CAP_PER_MINTER)
      expect(allowance.minterRequestsRemaining).to.equal(DEFAULT_REQUEST_LIMIT)
    })

    it("should still measure the exempt in-flight exposure", async () => {
      // The 20 BTC exempt request counts toward the pending total and
      // reduces the headroom available to non-exempt requesters. As it
      // exceeds the whole 10 BTC debt cap, the reported headroom clamps
      // to zero.
      expect(await stubVault.optimisticMintingPendingTotal()).to.equal(20 * BTC)
      const allowance = await stubVault.getOptimisticMintingAllowance(
        minter.address
      )
      expect(allowance.globalHeadroomRemaining).to.equal(0)
    })
  })
})
