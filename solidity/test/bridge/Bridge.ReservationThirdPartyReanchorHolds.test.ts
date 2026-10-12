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
  // Privileged hand-off (design C): a privileged re-anchor from a retiring
  // source (MovingFunds/Closing) may exceed the target's ordinary
  // per-wallet count and amount caps, so a retirement stays possible even
  // when the target's slots are saturated. Third-party requests and
  // governance rotations off a Live source keep the caps.
  describe("privileged hand-off: a retiring source may exceed the target's caps", () => {
    const holderKey = `0x${"c0".repeat(32)}`
    const callerKey = `0x${"c1".repeat(32)}`
    // Distinct third-party owner: a reservation `caller` does not own,
    // so a re-anchor request from it keeps the ordinary caps.
    const thirdPartyOwner = ethers.Wallet.createRandom().address

    // Fill the target's only ordinary slot with a third-party hold: the
    // target's count cap is 1 and the hold fills it.
    async function fillTargetSlot() {
      await executor.seedWallet(targetWallet, ZERO_BYTES32, walletStateEnum.Live)
      await executor.setMaxReservationsPerWallet(1)
      // The holder request is a third-party hold, so the per-target hold
      // cap must leave room for it and the follow-up third-party requests
      // below.
      await executor.setMaxThirdPartyReanchorHoldsPerWallet(3)
      // A distinct third-party reservation on the second source wallet
      // holds the target's one free slot.
      await executor.seedWallet(secondSourceWallet, ZERO_BYTES32, walletStateEnum.MovingFunds)
      await executor.seedReservation(
        holderKey,
        thirdPartyOwner,
        secondSourceWallet,
        1_000_000,
        `0x${"37".repeat(32)}`,
        0,
        1 // Active
      )
      await executor.requestReservationReanchor(holderKey, targetWallet, false, [], 0)
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(1)
    }

    // A caller-owned reservation on the first source wallet, re-anchorable
    // to the same target, so the caller is privileged.
    async function seedCallerReanchorable(source = walletStateEnum.MovingFunds) {
      await executor.seedWallet(sourceWallet, ZERO_BYTES32, source)
      await executor.seedReservation(
        callerKey,
        caller,
        sourceWallet,
        1_000_000,
        `0x${"38".repeat(32)}`,
        0,
        1 // Active
      )
    }

    // Seed a target whose reserved amount, plus a second re-anchor,
    // exceeds the per-wallet amount cap, while the count cap stays
    // generous (the default 5) so the amount cap is the binding check.
    async function fillTargetAmount(cap: number) {
      await executor.seedWallet(targetWallet, ZERO_BYTES32, walletStateEnum.Live)
      await executor.setMaxReservationsAmountPerWallet(cap)
      await executor.setMaxThirdPartyReanchorHoldsPerWallet(3)
      await executor.seedWallet(secondSourceWallet, ZERO_BYTES32, walletStateEnum.MovingFunds)
      await executor.seedReservation(
        holderKey,
        thirdPartyOwner,
        secondSourceWallet,
        1_000_000,
        `0x${"37".repeat(32)}`,
        0,
        1 // Active
      )
      await executor.requestReservationReanchor(holderKey, targetWallet, false, [], 0)
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(1_000_000)
    }

    it("owner: a MovingFunds re-anchor to a full target succeeds and the target count becomes cap+1", async () => {
      await fillTargetSlot()
      await seedCallerReanchorable()

      await executor.requestReservationReanchor(callerKey, targetWallet, false, [], 0)
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(2)
    })

    it("owner: a Closing re-anchor to a full target succeeds", async () => {
      await fillTargetSlot()
      await seedCallerReanchorable(walletStateEnum.Closing)

      await executor.requestReservationReanchor(callerKey, targetWallet, false, [], 0)
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(2)
    })

    it("SPV maintainer: a MovingFunds re-anchor to a full target succeeds", async () => {
      await fillTargetSlot()
      await seedCallerReanchorable()
      await executor.setSpvMaintainer(caller, true)

      await executor.requestReservationReanchor(callerKey, targetWallet, false, [], 0)
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(2)
    })

    it("proven source-wallet member: a MovingFunds re-anchor to a full target succeeds", async () => {
      await fillTargetSlot()
      const registry = await createMock<IWalletRegistry>("IWalletRegistry")
      await executor.setEcdsaWalletRegistry(registry.address)
      await seedCallerReanchorable()
      await executor.seedWallet(sourceWallet, sourceEcdsaId, walletStateEnum.MovingFunds)
      await registry.isWalletMember
        .whenCalledWith(sourceEcdsaId, [1, 2, 3], caller, 2)
        .returns(true)

      await executor.requestReservationReanchor(callerKey, targetWallet, false, [1, 2, 3], 2)
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(2)
    })

    it("a third party into the full target still reverts on the count cap", async () => {
      await fillTargetSlot()
      // A second third-party reservation re-anchoring to the same full
      // target exceeds the count cap.
      await executor.seedReservation(
        `0x${"c2".repeat(32)}`,
        thirdPartyOwner,
        secondSourceWallet,
        1_000_000,
        `0x${"39".repeat(32)}`,
        0,
        1 // Active
      )

      await expect(
        executor.requestReservationReanchor(`0x${"c2".repeat(32)}`, targetWallet, false, [], 0)
      ).to.be.revertedWith("Wallet reservations cap exceeded")
    })

    it("governance (privileged) from a Live source into a full target still reverts on the count cap", async () => {
      await fillTargetSlot()
      await seedCallerReanchorable(walletStateEnum.Live)

      await expect(
        executor.requestReservationReanchor(callerKey, targetWallet, true, [], 0)
      ).to.be.revertedWith("Wallet reservations cap exceeded")
    })

    it("a privileged MovingFunds re-anchor may exceed the target's amount cap", async () => {
      await fillTargetAmount(1_500_000)
      await seedCallerReanchorable()

      await executor.requestReservationReanchor(callerKey, targetWallet, false, [], 0)
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(2_000_000)
    })

    it("a third party into a target over its amount cap still reverts", async () => {
      await fillTargetAmount(1_500_000)
      await executor.seedReservation(
        `0x${"c3".repeat(32)}`,
        randomOwner,
        secondSourceWallet,
        1_000_000,
        `0x${"3a".repeat(32)}`,
        0,
        1 // Active
      )

      await expect(
        executor.requestReservationReanchor(`0x${"c3".repeat(32)}`, targetWallet, false, [], 0)
      ).to.be.revertedWith("Wallet reserved amount cap exceeded")
    })

  })
  // The hand-off exemption extends past the third-party hold cap to the
  // target's ordinary per-wallet caps, but only for a privileged re-request
  // off a retiring source (MovingFunds/Closing). A pending third-party hold
  // still occupies the target's ordinary slot and still counts against the
  // third-party cap; it merely no longer blocks a privileged hand-off.
  // A third-party re-request into the same saturated target still reverts
  // on the ordinary per-wallet cap until the hold is released (timeout,
  // supersede-unwind, or settlement).
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

    it("a privileged hand-off skips the target's ordinary cap when a hold occupies the slot", async () => {
      await seedThirdPartyHold()
      await seedMemberRequest()

      // The hold consumed the target's only ordinary slot. A privileged
      // re-request off the retiring (MovingFunds) source skips the target's
      // per-wallet caps, so it succeeds into the saturated target instead of
      // reverting on the count cap.
      await executor.requestReservationReanchor(memberKey, targetWallet, false, [1, 2, 3], 2)
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(2)
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

      await cap.beginReservationCapsUpdate(1_000_000, 100_000, 100, 2, 1)

      const staged = await cap.staged()
      expect(staged.newMaxThirdPartyReanchorHoldsPerWallet).to.equal(2)
      expect(staged.newHandoffReserveWallets).to.equal(1)
      expect(staged.newMaxActiveReservations).to.equal(100)
      expect(staged.changeInitiated).to.be.greaterThan(0)

      // With a zero governance delay the finalizer clears the staged change.
      await cap.finalizeReservationCapsUpdate(0)
      const cleared = await cap.staged()
      expect(cleared.newMaxThirdPartyReanchorHoldsPerWallet).to.equal(0)
      expect(cleared.newHandoffReserveWallets).to.equal(0)
    })

    it("reverts finalize before the governance delay elapses", async () => {
      const cap = await loadFixture(deployCapsGovernanceExecutor)
      await cap.beginReservationCapsUpdate(1_000_000, 100_000, 100, 2, 1)
      // The executor was deployed with a zero delay, so passing a nonzero delay
      // to the finalizer enforces a window that has not yet elapsed.
      await expect(cap.finalizeReservationCapsUpdate(60)).to.be.revertedWith(
        "Governance delay has not elapsed"
      )
    })
  })
})
