/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers } from "hardhat"
import { expect } from "chai"
import loadFixture from "../helpers/fixture"
import createMock from "../helpers/mock"

import type {
  ReservationStrandingExecutor,
  ReservationCapsGovernanceExecutor,
  IWalletRegistry,
  IRelay,
  Bank,
  MockReservationVault,
} from "../../typechain"
import { MovedFundsSweepWithoutMainUtxo as movedFundsSweepData } from "../data/moving-funds"

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as `0x${string}`

// Wallets.WalletState enum values (matches `Wallets.sol`).
const walletStateEnum = {
  Unknown: 0,
  Live: 1,
  MovingFunds: 2,
  Closing: 3,
  Closed: 4,
  Terminated: 5,
}

const HOURS = 3600

async function deployExecutor(): Promise<ReservationStrandingExecutor> {
  const ReservationFactory = await ethers.getContractFactory("Reservation")
  const reservation = await ReservationFactory.deploy()
  await reservation.waitForDeployment()

  const Factory = await ethers.getContractFactory("ReservationStrandingExecutor", {
    libraries: { Reservation: reservation.target },
  })
  const executor = (await Factory.deploy()) as ReservationStrandingExecutor
  await executor.waitForDeployment()
  return executor
}

async function deployCapsGovernanceExecutor(): Promise<ReservationCapsGovernanceExecutor> {
  const LibFactory = await ethers.getContractFactory("BridgeGovernanceParameters")
  const lib = await LibFactory.deploy()
  await lib.waitForDeployment()

  const Factory = await ethers.getContractFactory("ReservationCapsGovernanceExecutor", {
    libraries: { BridgeGovernanceParameters: lib.target },
  })
  const cap = (await Factory.deploy(0)) as ReservationCapsGovernanceExecutor
  await cap.waitForDeployment()
  return cap
}

async function lastBlockTime(): Promise<number> {
  const block = await ethers.provider.getBlock("latest")
  return Number(block!.timestamp)
}

describe("Bridge - reservation third-party re-anchor holds (per-target cap)", () => {
  let executor: ReservationStrandingExecutor
  // The library's `msg.sender` is the test's default signer (the caller of
  // `executor.requestReservationReanchor`), NOT the executor contract. The
  // privilege discriminators (owner / SPV maintainer / source-wallet member)
  // are evaluated against this caller address.
  let caller: string

  const sourceWallet = `0x${"11".repeat(20)}` as `0x${string}`
  const targetWallet = `0x${"22".repeat(20)}` as `0x${string}`
  const secondSourceWallet = `0x${"55".repeat(20)}` as `0x${string}`
  const reservationKey = `0x${"aa".repeat(32)}`
  const randomOwner = ethers.Wallet.createRandom().address
  const sourceEcdsaId = `0x${"cd".repeat(32)}` as `0x${string}`

  beforeEach(async () => {
    executor = await loadFixture(deployExecutor)
    caller = (await ethers.getSigners())[0].address
    // Admissible re-anchor config: a low min-amount floor keeps the
    // fixture's re-anchor settlement admissible, the 6h action timeout
    // outlives the request-time safety margin, and the per-wallet caps
    // leave target headroom.
    await executor.setReservationTxMaxFee(10_000)
    await executor.setReservationMinAmount(1_000)
    await executor.setReservationActionTimeout(6 * HOURS)
    await executor.setMaxReservationsPerWallet(5)
    await executor.setMaxReservationsAmountPerWallet(0) // disabled
    await executor.setReservationMaxSingleAmount(0) // disabled
  })

  // Seed a MovingFunds source wallet custodiying an Active reservation and a
  // Live target wallet — the admissible re-anchor shape.
  async function seedReanchorableReservation(owner: string = randomOwner) {
    await executor.seedWallet(sourceWallet, sourceEcdsaId, walletStateEnum.MovingFunds)
    await executor.seedWallet(targetWallet, ZERO_BYTES32, walletStateEnum.Live)
    await executor.seedReservation(
      reservationKey,
      owner,
      sourceWallet,
      1_000_000,
      `0x${"33".repeat(32)}`,
      0,
      1 // Active
    )
  }

  // A distinct Active reservation (on a distinct source wallet) re-anchoring
  // to the SAME target wallet, for the cap-stacking / re-request scenarios.
  async function seedSecondReanchorable(key: string, target: `0x${string}`) {
    await executor.seedWallet(secondSourceWallet, ZERO_BYTES32, walletStateEnum.MovingFunds)
    await executor.seedReservation(
      key,
      randomOwner,
      secondSourceWallet,
      1_000_000,
      `0x${"34".repeat(32)}`,
      0,
      1 // Active
    )
    void target
  }

  // A third-party request fills the cap against `targetWallet`.
  async function fillTargetCap() {
    await seedReanchorableReservation()
    await executor.requestReservationReanchor(reservationKey, targetWallet, false, [], 0)
    expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(1)
  }

  describe("third-party hold cap (request-time)", () => {
    it("blocks a third party once the target's pending holds reach the cap", async () => {
      await executor.setMaxThirdPartyReanchorHoldsPerWallet(1)
      await fillTargetCap()

      // A second third-party reservation re-anchoring to the same target is
      // blocked at the cap.
      await seedSecondReanchorable(`0x${"ab".repeat(32)}`, targetWallet)
      await expect(
        executor.requestReservationReanchor(
          `0x${"ab".repeat(32)}`,
          targetWallet,
          false,
          [],
          0
        )
      ).to.be.revertedWith("Target third-party re-anchor holds exceeded")
    })

    it("lets the reservation owner request past a full cap", async () => {
      await executor.setMaxThirdPartyReanchorHoldsPerWallet(1)
      await fillTargetCap()

      // The caller is the owner of a distinct reservation: privileged, so it
      // requests against the already-full target without counting and without
      // reverting.
      await executor.seedWallet(secondSourceWallet, ZERO_BYTES32, walletStateEnum.MovingFunds)
      await executor.seedReservation(
        `0x${"ac".repeat(32)}`,
        caller,
        secondSourceWallet,
        1_000_000,
        `0x${"35".repeat(32)}`,
        0,
        1
      )
      await executor.requestReservationReanchor(
        `0x${"ac".repeat(32)}`,
        targetWallet,
        false,
        [],
        0
      )
      // Privileged requests never count, so the hold count is unchanged.
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(1)
    })

    it("lets an SPV maintainer request past a full cap", async () => {
      await executor.setMaxThirdPartyReanchorHoldsPerWallet(1)
      await fillTargetCap()

      await executor.setSpvMaintainer(caller, true)
      await executor.seedWallet(secondSourceWallet, ZERO_BYTES32, walletStateEnum.MovingFunds)
      await executor.seedReservation(
        `0x${"ad".repeat(32)}`,
        randomOwner,
        secondSourceWallet,
        1_000_000,
        `0x${"36".repeat(32)}`,
        0,
        1
      )
      await executor.requestReservationReanchor(
        `0x${"ad".repeat(32)}`,
        targetWallet,
        false,
        [],
        0
      )
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(1)
    })

    it("lets a proven source-wallet member request past a full cap", async () => {
      await executor.setMaxThirdPartyReanchorHoldsPerWallet(1)
      await fillTargetCap()

      const registry = await createMock<IWalletRegistry>("IWalletRegistry")
      await executor.setEcdsaWalletRegistry(registry.address)
      await executor.seedWallet(secondSourceWallet, sourceEcdsaId, walletStateEnum.MovingFunds)
      await executor.seedReservation(
        `0x${"ae".repeat(32)}`,
        randomOwner,
        secondSourceWallet,
        1_000_000,
        `0x${"37".repeat(32)}`,
        0,
        1
      )
      await registry.isWalletMember
        .whenCalledWith(sourceEcdsaId, [1, 2, 3], caller, 2)
        .returns(true)

      await executor.requestReservationReanchor(
        `0x${"ae".repeat(32)}`,
        targetWallet,
        false,
        [1, 2, 3],
        2
      )
      // The member proof is privileged, so it does not count toward the cap.
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(1)
    })

    it("reverts when a non-empty member proof fails validation", async () => {
      await executor.setMaxThirdPartyReanchorHoldsPerWallet(5)
      await seedReanchorableReservation()

      const registry = await createMock<IWalletRegistry>("IWalletRegistry")
      await executor.setEcdsaWalletRegistry(registry.address)
      await registry.isWalletMember
        .whenCalledWith(sourceEcdsaId, [1, 2, 3], caller, 2)
        .returns(false)

      await expect(
        executor.requestReservationReanchor(reservationKey, targetWallet, false, [1, 2, 3], 2)
      ).to.be.revertedWith("Caller is not a member of the source wallet")
    })

    it("blocks third parties entirely when the cap is zero", async () => {
      await executor.setMaxThirdPartyReanchorHoldsPerWallet(0)
      await seedReanchorableReservation()

      await expect(
        executor.requestReservationReanchor(reservationKey, targetWallet, false, [], 0)
      ).to.be.revertedWith("Target third-party re-anchor holds exceeded")
    })
  })

  describe("hold release: counter drops so a third party can request again", () => {
    async function seedOneThirdPartyHold() {
      await executor.setMaxThirdPartyReanchorHoldsPerWallet(1)
      await seedReanchorableReservation()
      await executor.requestReservationReanchor(reservationKey, targetWallet, false, [], 0)
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(1)
      // A distinct reservation that can re-anchor to the same target, used
      // for the "a third party can request again" assertion.
      await seedSecondReanchorable(`0x${"bb".repeat(32)}`, targetWallet)
    }

    it("drops on action timeout", async () => {
      await seedOneThirdPartyHold()
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(1)

      // The requested generation times out (now + 6h action timeout).
      await ethers.provider.send("evm_increaseTime", [6 * HOURS + 1])
      await ethers.provider.send("evm_mine", [])

      await executor.notifyReservationActionTimeout(reservationKey)
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(0)

      // A third party can now re-request against the same target via the
      // distinct reservation.
      await executor.requestReservationReanchor(`0x${"bb".repeat(32)}`, targetWallet, false, [], 0)
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(1)
    })

    it("drops on supersede-unwind of the pending generation", async () => {
      await seedOneThirdPartyHold()
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(1)

      // A newer generation supersedes the pending one, unwinding its reserved
      // target capacity and its counted third-party hold.
      await executor.unwindPendingAction(reservationKey, false)
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(0)

      // A third party can now re-request against the same target via the
      // distinct reservation.
      await executor.requestReservationReanchor(`0x${"bb".repeat(32)}`, targetWallet, false, [], 0)
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(1)
    })

    it("drops on on-time re-anchor settlement, so a third party can request again", async () => {
      await executor.setMaxThirdPartyReanchorHoldsPerWallet(1)

      const key = reservationKey
      const sourcePk = `0x${"aa".repeat(20)}` as `0x${string}`
      const targetPk = movedFundsSweepData.wallet.pubKeyHash as `0x${string}`
      const anchorTxHash = movedFundsSweepData.movedFundsSweepRequest.txHash
      const anchorValue = movedFundsSweepData.movedFundsSweepRequest.txOutputValue

      await executor.seedWallet(sourcePk, sourceEcdsaId, walletStateEnum.MovingFunds)
      await executor.seedWallet(targetPk, ZERO_BYTES32, walletStateEnum.Live)
      await executor.seedReservation(key, randomOwner, sourcePk, anchorValue, anchorTxHash, 0, 1)

      // A third party fills the cap.
      await executor.requestReservationReanchor(key, targetPk, false, [], 0)
      expect(await executor.pendingThirdPartyReanchorHolds(targetPk)).to.equal(1)

      // A distinct third-party reservation against the same (now-full) target
      // is blocked while the hold is pending.
      await seedSecondReanchorable(`0x${"bb".repeat(32)}`, targetPk)
      await expect(
        executor.requestReservationReanchor(`0x${"bb".repeat(32)}`, targetPk, false, [], 0)
      ).to.be.revertedWith("Target third-party re-anchor holds exceeded")

      // Wire the fee-financing vault and the SPV relay for the settling proof.
      const BankFactory = await ethers.getContractFactory("Bank")
      const bank = (await BankFactory.deploy()) as Bank
      const VaultFactory = await ethers.getContractFactory("MockReservationVault")
      const vault = (await VaultFactory.deploy(bank.target)) as MockReservationVault
      await executor.setDeposit(key, randomOwner, anchorValue, await lastBlockTime(), vault.target)
      const relay = await createMock<IRelay>("IRelay")
      await executor.setRelay(relay.address)
      await relay.getCurrentEpochDifficulty.returns(movedFundsSweepData.chainDifficulty)
      await relay.getPrevEpochDifficulty.returns(movedFundsSweepData.chainDifficulty)

      // Settle the pending re-anchor generation on time with the fixture proof.
      await executor.submitReservationReanchorProof(
        movedFundsSweepData.sweepTx,
        movedFundsSweepData.sweepProof,
        key,
        1
      )

      // The on-time settlement released the counted hold.
      expect(await executor.pendingThirdPartyReanchorHolds(targetPk)).to.equal(0)

      // The distinct third-party reservation can now request against the target.
      await executor.requestReservationReanchor(`0x${"bb".repeat(32)}`, targetPk, false, [], 0)
      expect(await executor.pendingThirdPartyReanchorHolds(targetPk)).to.equal(1)
    })
  })

  // Known limit of the cap: the exemption covers only the third-party cap.
  // Every pending hold still consumes the target's ordinary per-wallet
  // capacity (`maxReservationsPerWallet` / `maxReservationsAmountPerWallet`),
  // so a privileged re-request against a target whose single free slot a
  // third-party hold occupies reverts on the ordinary per-wallet cap until
  // the hold is released (timeout, supersede-unwind, or settlement).
  describe("cap limit: a third-party hold still uses the target's ordinary capacity", () => {
    const memberKey = `0x${"bb".repeat(32)}`

    // The target wallet holds exactly one free slot, and the pending
    // third-party hold is within the third-party cap.
    async function seedThirdPartyHold() {
      await executor.setMaxReservationsPerWallet(1)
      await executor.setMaxThirdPartyReanchorHoldsPerWallet(2)
      await seedReanchorableReservation()
      await executor.requestReservationReanchor(reservationKey, targetWallet, false, [], 0)
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(1)
    }

    // A distinct, privileged (source-wallet-member) reservation re-anchoring
    // to the SAME target, whose proof goes through the mocked registry.
    async function seedMemberRequest() {
      const registry = await createMock<IWalletRegistry>("IWalletRegistry")
      await executor.setEcdsaWalletRegistry(registry.address)
      await seedSecondReanchorable(memberKey, targetWallet)
      await executor.seedWallet(secondSourceWallet, sourceEcdsaId, walletStateEnum.MovingFunds)
      await registry.isWalletMember
        .whenCalledWith(sourceEcdsaId, [1, 2, 3], caller, 2)
        .returns(true)
    }

    it("a third-party hold still uses the target's ordinary per-wallet slot", async () => {
      await seedThirdPartyHold()
      await seedMemberRequest()

      // The member proof is exempt from the third-party cap, but the pending
      // hold already consumed the target's only ordinary slot.
      await expect(
        executor.requestReservationReanchor(memberKey, targetWallet, false, [1, 2, 3], 2)
      ).to.be.revertedWith("Wallet reservations cap exceeded")
    })

    it("the member request succeeds after the third-party hold times out", async () => {
      await seedThirdPartyHold()
      await seedMemberRequest()

      // The pending generation times out: both the counted hold and the
      // target's reserved ordinary capacity are released.
      await ethers.provider.send("evm_increaseTime", [6 * HOURS + 1])
      await ethers.provider.send("evm_mine", [])
      await executor.notifyReservationActionTimeout(reservationKey)
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(0)

      await executor.requestReservationReanchor(memberKey, targetWallet, false, [1, 2, 3], 2)
      // The member request is privileged, so it does not count as a hold.
      expect(await executor.pendingThirdPartyReanchorHolds(targetWallet)).to.equal(0)
    })
  })

  describe("governance staging of the cap", () => {
    it("stages and finalizes the cap through the begin/finalize ceremony", async () => {
      const cap = await loadFixture(deployCapsGovernanceExecutor)

      await cap.beginReservationCapsUpdate(1_000_000, 100_000, 100, 2)

      const staged = await cap.staged()
      expect(staged.newMaxThirdPartyReanchorHoldsPerWallet).to.equal(2)
      expect(staged.newMaxActiveReservations).to.equal(100)
      expect(staged.changeInitiated).to.be.greaterThan(0)

      // With a zero governance delay the finalizer clears the staged change.
      await cap.finalizeReservationCapsUpdate(0)
      const cleared = await cap.staged()
      expect(cleared.newMaxThirdPartyReanchorHoldsPerWallet).to.equal(0)
      expect(cleared.changeInitiated).to.equal(0)
    })

    it("reverts finalize before the governance delay elapses", async () => {
      const cap = await loadFixture(deployCapsGovernanceExecutor)
      await cap.beginReservationCapsUpdate(1_000_000, 100_000, 100, 2)
      // The executor was deployed with a zero delay, so passing a nonzero delay
      // to the finalizer enforces a window that has not yet elapsed.
      await expect(cap.finalizeReservationCapsUpdate(60)).to.be.revertedWith(
        "Governance delay has not elapsed"
      )
    })
  })
})
