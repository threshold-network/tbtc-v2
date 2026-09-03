/* eslint-disable @typescript-eslint/no-unused-expressions */

import { artifacts, ethers, waffle } from "hardhat"
import { expect } from "chai"
import { BigNumber, Contract, ContractTransaction } from "ethers"
import type { Interface } from "ethers/lib/utils"
import { createMock, expectCalledOnce, expectNotCalled } from "../helpers/mock"

import type { Mock } from "../helpers/mock"
import type {
  ReservationStrandingExecutor,
  IWalletRegistry,
} from "../../typechain"

const ZERO_BYTES20 = `0x${"00".repeat(20)}`

// Reservation.ReservationState enum values (matches `Reservation.sol`).
const reservationStateEnum = {
  Unknown: 0,
  Active: 1,
  ActionPending: 2,
  Closed: 3,
  Stranded: 4,
}

// Wallets.WalletState enum values (matches `Wallets.sol`).
const walletStateEnum = {
  Unknown: 0,
  Live: 1,
  MovingFunds: 2,
  Closing: 3,
  Closed: 4,
  Terminated: 5,
}

const reservationActionStateEnum = {
  None: 0,
  Pending: 1,
  TimedOut: 2,
  Settled: 3,
  Vetoed: 4,
}

// Reservation.ActionType enum values (matches `Reservation.sol`).
const reservationActionTypeEnum = {
  None: 0,
  Acceptance: 1,
  Redemption: 2,
  Reanchor: 3,
  Dissolution: 4,
}

const fixture = waffle.createFixtureLoader(waffle.provider.getWallets())

async function deployExecutor(): Promise<ReservationStrandingExecutor> {
  // The Reservation library is `external` (its `notifyReservationStranded`,
  // `notifyStaleReservedDeposit`, `notifyReservationActionTimeout`,
  // `notifyReservationRedemptionTimedOut`,
  // `notifyReservationDissolutionTimedOut`,
  // `requestReservationAcceptance`, and `requestReservationReanchor`
  // functions have the `external` visibility modifier). The bytecode of
  // the `ReservationStrandingExecutor` test contract embeds a
  // placeholder for the Reservation library because of the `using
  // Reservation for BridgeState.Storage` declaration. `Reservation.sol`
  // itself calls into `ReservationProofs.submitReservationProof`
  // (external), so `ReservationProofs` must be deployed and linked into
  // `Reservation` first. The executor's own direct calls into
  // `submitReservationAcceptanceProof`/`submitReservationReanchorProof`
  // are `internal` and get inlined at compile time, so the executor
  // itself only needs `Reservation` linked, not `ReservationProofs`.
  const ReservationProofsFactory = await ethers.getContractFactory(
    "ReservationProofs"
  )
  const reservationProofs = await ReservationProofsFactory.deploy()
  await reservationProofs.deployed()

  const ReservationFactory = await ethers.getContractFactory("Reservation", {
    libraries: {
      ReservationProofs: reservationProofs.address,
    },
  })
  const reservation = await ReservationFactory.deploy()
  await reservation.deployed()

  const Factory = await ethers.getContractFactory(
    "ReservationStrandingExecutor",
    {
      libraries: {
        Reservation: reservation.address,
      },
    }
  )
  const executor = (await Factory.deploy()) as ReservationStrandingExecutor
  await executor.deployed()
  return executor
}

async function setReservationConfig(
  executorAddress: string,
  params: {
    reservationVault?: string
    reservationMinAmount?: number | BigNumber
    reservationTxMaxFee?: number | BigNumber
    reservationTermSeconds?: number
    reservationDissolutionDelay?: number
    reservationMaxTotalAmount?: number | BigNumber
    reservationTotalAmount?: number | BigNumber
    maxReservationsPerWallet?: number
    reservationRouter?: string
    reservationActionTimeout?: number
    reservationRenewalWindowSeconds?: number
    maxReservationsAmountPerWallet?: number | BigNumber
    reservationMaxSingleAmount?: number | BigNumber
  }
) {
  if (
    params.reservationMinAmount !== undefined ||
    params.reservationTermSeconds !== undefined
  ) {
    const raw = await ethers.provider.getStorageAt(
      executorAddress,
      ethers.utils.hexValue(29)
    )
    let word29 = ethers.BigNumber.from(raw)
    if (params.reservationMinAmount !== undefined) {
      word29 = word29.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffffffffffff").shl(160)
        )
      )
      word29 = word29.or(
        ethers.BigNumber.from(params.reservationMinAmount).shl(160)
      )
    }
    if (params.reservationTermSeconds !== undefined) {
      word29 = word29.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffff").shl(224)
        )
      )
      word29 = word29.or(
        ethers.BigNumber.from(params.reservationTermSeconds).shl(224)
      )
    }
    await ethers.provider.send("hardhat_setStorageAt", [
      executorAddress,
      ethers.utils.hexValue(29),
      ethers.utils.hexZeroPad(word29.toHexString(), 32),
    ])
  }

  if (
    params.reservationVault !== undefined ||
    params.reservationTxMaxFee !== undefined ||
    params.reservationDissolutionDelay !== undefined
  ) {
    const raw = await ethers.provider.getStorageAt(
      executorAddress,
      ethers.utils.hexValue(30)
    )
    let word30 = ethers.BigNumber.from(raw)
    if (params.reservationVault !== undefined) {
      word30 = word30.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffffffffffffffffffffffffffffffffffff")
        )
      )
      word30 = word30.or(ethers.BigNumber.from(params.reservationVault))
    }
    if (params.reservationTxMaxFee !== undefined) {
      word30 = word30.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffffffffffff").shl(160)
        )
      )
      word30 = word30.or(
        ethers.BigNumber.from(params.reservationTxMaxFee).shl(160)
      )
    }
    if (params.reservationDissolutionDelay !== undefined) {
      word30 = word30.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffff").shl(224)
        )
      )
      word30 = word30.or(
        ethers.BigNumber.from(params.reservationDissolutionDelay).shl(224)
      )
    }
    await ethers.provider.send("hardhat_setStorageAt", [
      executorAddress,
      ethers.utils.hexValue(30),
      ethers.utils.hexZeroPad(word30.toHexString(), 32),
    ])
  }

  if (
    params.reservationMaxTotalAmount !== undefined ||
    params.reservationTotalAmount !== undefined ||
    params.maxReservationsPerWallet !== undefined
  ) {
    const raw = await ethers.provider.getStorageAt(
      executorAddress,
      ethers.utils.hexValue(31)
    )
    let word31 = ethers.BigNumber.from(raw)
    if (params.reservationMaxTotalAmount !== undefined) {
      word31 = word31.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffffffffffff")
        )
      )
      word31 = word31.or(
        ethers.BigNumber.from(params.reservationMaxTotalAmount)
      )
    }
    if (params.reservationTotalAmount !== undefined) {
      word31 = word31.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffffffffffff").shl(64)
        )
      )
      word31 = word31.or(
        ethers.BigNumber.from(params.reservationTotalAmount).shl(64)
      )
    }
    if (params.maxReservationsPerWallet !== undefined) {
      word31 = word31.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffff").shl(128)
        )
      )
      word31 = word31.or(
        ethers.BigNumber.from(params.maxReservationsPerWallet).shl(128)
      )
    }
    await ethers.provider.send("hardhat_setStorageAt", [
      executorAddress,
      ethers.utils.hexValue(31),
      ethers.utils.hexZeroPad(word31.toHexString(), 32),
    ])
  }

  if (
    params.reservationRouter !== undefined ||
    params.reservationActionTimeout !== undefined ||
    params.reservationRenewalWindowSeconds !== undefined
  ) {
    const raw = await ethers.provider.getStorageAt(
      executorAddress,
      ethers.utils.hexValue(32)
    )
    let word32 = ethers.BigNumber.from(raw)
    if (params.reservationRouter !== undefined) {
      word32 = word32.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffffffffffffffffffffffffffffffffffff")
        )
      )
      word32 = word32.or(ethers.BigNumber.from(params.reservationRouter))
    }
    if (params.reservationActionTimeout !== undefined) {
      word32 = word32.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffff").shl(160)
        )
      )
      word32 = word32.or(
        ethers.BigNumber.from(params.reservationActionTimeout).shl(160)
      )
    }
    if (params.reservationRenewalWindowSeconds !== undefined) {
      word32 = word32.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffff").shl(192)
        )
      )
      word32 = word32.or(
        ethers.BigNumber.from(params.reservationRenewalWindowSeconds).shl(192)
      )
    }
    await ethers.provider.send("hardhat_setStorageAt", [
      executorAddress,
      ethers.utils.hexValue(32),
      ethers.utils.hexZeroPad(word32.toHexString(), 32),
    ])
  }

  if (
    params.maxReservationsAmountPerWallet !== undefined ||
    params.reservationMaxSingleAmount !== undefined
  ) {
    const raw = await ethers.provider.getStorageAt(
      executorAddress,
      ethers.utils.hexValue(33)
    )
    let word33 = ethers.BigNumber.from(raw)
    if (params.maxReservationsAmountPerWallet !== undefined) {
      word33 = word33.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffffffffffff")
        )
      )
      word33 = word33.or(
        ethers.BigNumber.from(params.maxReservationsAmountPerWallet)
      )
    }
    if (params.reservationMaxSingleAmount !== undefined) {
      word33 = word33.and(
        ethers.constants.MaxUint256.sub(
          ethers.BigNumber.from("0xffffffffffffffff").shl(64)
        )
      )
      word33 = word33.or(
        ethers.BigNumber.from(params.reservationMaxSingleAmount).shl(64)
      )
    }
    await ethers.provider.send("hardhat_setStorageAt", [
      executorAddress,
      ethers.utils.hexValue(33),
      ethers.utils.hexZeroPad(word33.toHexString(), 32),
    ])
  }
}

async function seedDepositWithVault(
  executor: ReservationStrandingExecutor,
  depositKey: string | number | BigNumber,
  depositor: string,
  amount: number | BigNumber = 1_000_000,
  revealedAt?: number,
  vault?: string
) {
  await executor.seedDeposit(depositKey, depositor)

  const currentRevealedAt =
    revealedAt ??
    Number(await ethers.provider.getBlock("latest").then((b) => b!.timestamp))

  const baseSlot = ethers.utils.solidityKeccak256(
    ["uint256", "uint256"],
    [depositKey, 19]
  )

  const word0 = ethers.BigNumber.from(depositor)
    .or(ethers.BigNumber.from(amount).shl(160))
    .or(ethers.BigNumber.from(currentRevealedAt).shl(224))
  await ethers.provider.send("hardhat_setStorageAt", [
    executor.address,
    ethers.BigNumber.from(baseSlot).toHexString(),
    ethers.utils.hexZeroPad(word0.toHexString(), 32),
  ])

  if (vault) {
    const word1 = ethers.BigNumber.from(vault)
    await ethers.provider.send("hardhat_setStorageAt", [
      executor.address,
      ethers.BigNumber.from(baseSlot).add(1).toHexString(),
      ethers.utils.hexZeroPad(word1.toHexString(), 32),
    ])
  }
}

const ZERO_BYTES32 = `0x${"00".repeat(32)}`

describe("Bridge - Reservation Stranding (PR E library coverage)", () => {
  let executor: ReservationStrandingExecutor

  beforeEach(async () => {
    executor = await fixture(deployExecutor)
  })

  describe("notifyReservationStranded", () => {
    it("strands an Active reservation on a Terminated wallet", async () => {
      const walletPubKeyHash = `0x${"11".repeat(20)}` as `0x${string}`
      const reservationKey = `0x${"aa".repeat(32)}` // deposit key of the reserved deposit
      const owner = ethers.Wallet.createRandom().address
      const anchorAmount = 5_000_000 // 0.05 BTC in satoshi
      const anchorTxHash = `0x${"22".repeat(32)}` as `0x${string}`
      const anchorTxOutputIndex = 0

      // Seed wallet in Terminated state and an Active reservation that
      // references it, plus the bookkeeping counters the stranding path
      // releases.
      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      // Sanity check: counters and enumeration are populated before
      // stranding.
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
      expect(await executor.walletReservationsCount(walletPubKeyHash)).to.equal(
        1
      )
      expect(
        await executor.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(anchorAmount)
      expect(await executor.reservationTotalAmount()).to.equal(anchorAmount)
      expect(
        await executor.walletReservationKeysLength(walletPubKeyHash)
      ).to.equal(1)

      const tx: ContractTransaction = await executor.notifyReservationStranded(
        reservationKey
      )

      // The position is now Stranded.
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Stranded
      )
      // All four counters decremented to zero.
      expect(await executor.walletReservationsCount(walletPubKeyHash)).to.equal(
        0
      )
      expect(
        await executor.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(0)
      expect(await executor.reservationTotalAmount()).to.equal(0)
      // Enumeration entry removed.
      expect(
        await executor.walletReservationKeysLength(walletPubKeyHash)
      ).to.equal(0)
      expect(await executor.walletReservationKeyIndex(reservationKey)).to.equal(
        0
      )
      // Anchor outpoint reverse index released.
      const anchorUtxoHash = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [anchorTxHash, anchorTxOutputIndex]
      )
      expect(await executor.reservationsByAnchorUtxo(anchorUtxoHash)).to.equal(
        0
      )

      // The exact args of the emitted event match the pre-stranding
      // reservation: reservationKey, walletPubKeyHash, owner, anchorAmount.
      const receipt = await tx.wait()
      const stranded = receipt.events?.find(
        (e) => e.event === "ReservationStranded"
      )
      expect(stranded, "ReservationStranded event missing").to.not.be.undefined
      expect(stranded!.args!.reservationKey).to.equal(reservationKey)
      expect(stranded!.args!.walletPubKeyHash).to.equal(walletPubKeyHash)
      expect(stranded!.args!.owner).to.equal(owner)
      expect(stranded!.args!.anchorAmount).to.equal(anchorAmount)
    })

    it("rejects when the custodying wallet is Closing", async () => {
      // Closing is no longer an accepted wallet state for stranding: it is
      // also independently acceptable to `requestReservationReanchor`,
      // and a wallet with `mainUtxoHash == 0` can be permissionlessly
      // driven into `Closing` via `notifyWalletCloseable`, which would
      // otherwise let a Closing-wallet strand front-run a legitimate
      // reanchor in a deterministic two-transaction sequence.
      const walletPubKeyHash = `0x${"12".repeat(20)}` as `0x${string}`
      const reservationKey = `0x${"ab".repeat(32)}`
      const owner = ethers.Wallet.createRandom().address
      const anchorAmount = 5_000_000
      const anchorTxHash = `0x${"23".repeat(32)}` as `0x${string}`
      const anchorTxOutputIndex = 0

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Closing
      )
      await executor.seedReservation(
        reservationKey,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      await expect(
        executor.notifyReservationStranded(reservationKey)
      ).to.be.revertedWith("Wallet is not terminated or closed")
    })

    it("strands an Active reservation on a Closed wallet", async () => {
      const walletPubKeyHash = `0x${"13".repeat(20)}` as `0x${string}`
      const reservationKey = `0x${"ac".repeat(32)}`
      const owner = ethers.Wallet.createRandom().address
      const anchorAmount = 5_000_000
      const anchorTxHash = `0x${"24".repeat(32)}` as `0x${string}`
      const anchorTxOutputIndex = 0

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Closed
      )
      await executor.seedReservation(
        reservationKey,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
      expect(await executor.walletReservationsCount(walletPubKeyHash)).to.equal(
        1
      )
      expect(
        await executor.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(anchorAmount)
      expect(await executor.reservationTotalAmount()).to.equal(anchorAmount)
      expect(
        await executor.walletReservationKeysLength(walletPubKeyHash)
      ).to.equal(1)

      const tx: ContractTransaction = await executor.notifyReservationStranded(
        reservationKey
      )

      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Stranded
      )
      expect(await executor.walletReservationsCount(walletPubKeyHash)).to.equal(
        0
      )
      expect(
        await executor.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(0)
      expect(await executor.reservationTotalAmount()).to.equal(0)
      expect(
        await executor.walletReservationKeysLength(walletPubKeyHash)
      ).to.equal(0)
      expect(await executor.walletReservationKeyIndex(reservationKey)).to.equal(
        0
      )
      const anchorUtxoHash = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [anchorTxHash, anchorTxOutputIndex]
      )
      expect(await executor.reservationsByAnchorUtxo(anchorUtxoHash)).to.equal(
        0
      )

      const receipt = await tx.wait()
      const stranded = receipt.events?.find(
        (e) => e.event === "ReservationStranded"
      )
      expect(stranded, "ReservationStranded event missing").to.not.be.undefined
      expect(stranded!.args!.reservationKey).to.equal(reservationKey)
      expect(stranded!.args!.walletPubKeyHash).to.equal(walletPubKeyHash)
      expect(stranded!.args!.owner).to.equal(owner)
      expect(stranded!.args!.anchorAmount).to.equal(anchorAmount)
    })

    it("rejects when the reservation is not Active", async () => {
      const walletPubKeyHash = `0x${"33".repeat(20)}` as `0x${string}`
      const reservationKey = `0x${"bb".repeat(32)}`
      const owner = ethers.Wallet.createRandom().address
      const anchorAmount = 1_500_000
      const anchorTxHash = `0x${"44".repeat(32)}` as `0x${string}`
      const anchorTxOutputIndex = 0

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        // Closed: already-redeemed position cannot be re-stranded.
        reservationStateEnum.Closed
      )

      await expect(
        executor.notifyReservationStranded(reservationKey)
      ).to.be.revertedWith("Reservation is not active")
    })

    it("rejects when the custodying wallet is not Terminated or Closed", async () => {
      const walletPubKeyHash = `0x${"55".repeat(20)}` as `0x${string}`
      const reservationKey = `0x${"cc".repeat(32)}`
      const owner = ethers.Wallet.createRandom().address
      const anchorAmount = 2_500_000
      const anchorTxHash = `0x${"66".repeat(32)}` as `0x${string}`
      const anchorTxOutputIndex = 0

      // Wallet is Live - the rejection must come from the wallet-state
      // check, not the reservation-state check.
      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Live
      )
      await executor.seedReservation(
        reservationKey,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      await expect(
        executor.notifyReservationStranded(reservationKey)
      ).to.be.revertedWith("Wallet is not terminated or closed")
    })

    it("rejects when the custodying wallet is in MovingFunds state", async () => {
      const walletPubKeyHash = `0x${"56".repeat(20)}` as `0x${string}`
      const reservationKey = `0x${"c1".repeat(32)}`
      const owner = ethers.Wallet.createRandom().address
      const anchorAmount = 2_500_000
      const anchorTxHash = `0x${"67".repeat(32)}` as `0x${string}`
      const anchorTxOutputIndex = 0

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.MovingFunds
      )
      await executor.seedReservation(
        reservationKey,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      await expect(
        executor.notifyReservationStranded(reservationKey)
      ).to.be.revertedWith("Wallet is not terminated or closed")
    })

    it("rejects when both the reservation and wallet conditions are wrong", async () => {
      // A non-Terminated wallet AND a non-Active reservation must surface
      // the reservation-state message because that check runs first.
      const walletPubKeyHash = `0x${"77".repeat(20)}` as `0x${string}`
      const reservationKey = `0x${"dd".repeat(32)}`
      const owner = ethers.Wallet.createRandom().address
      const anchorAmount = 1_000_000
      const anchorTxHash = `0x${"88".repeat(32)}` as `0x${string}`
      const anchorTxOutputIndex = 0

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Live
      )
      await executor.seedReservation(
        reservationKey,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.ActionPending
      )

      await expect(
        executor.notifyReservationStranded(reservationKey)
      ).to.be.revertedWith("Reservation is not active")
    })

    it("releases counters and enumeration in one call when only one reservation is anchored to the wallet", async () => {
      // Stresses the four counter decrements and the enumeration
      // removal with a single Active reservation anchored to a single
      // Terminated wallet. Reaffirms the bookkeeping path
      // notifyReservationStranded -> strandReservation takes end-to-end.
      const walletPubKeyHash = `0x${"99".repeat(20)}` as `0x${string}`
      const reservationKey = `0x${"ee".repeat(32)}`
      const owner = ethers.Wallet.createRandom().address
      const anchorAmount = 7_000_000
      const anchorTxHash = `0x${"ab".repeat(32)}` as `0x${string}`
      const anchorTxOutputIndex = 0

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      const tx: ContractTransaction = await executor.notifyReservationStranded(
        reservationKey
      )
      const receipt = await tx.wait()
      const events = receipt.events?.filter(
        (e) => e.event === "ReservationStranded"
      )
      // Exactly one recovery evidence is emitted per stranding call.
      expect(events, "ReservationStranded event missing").to.have.lengthOf(1)
    })
  })

  describe("strandReservation (internal, reached via notifyReservationStranded)", () => {
    it("releases capacity and enumeration across multiple Active reservations", async () => {
      // The internal `strandReservation` runs once per `notifyReservationStranded`
      // call; this test exercises it twice to confirm the bookkeeping
      // stays consistent across multiple stranding events on the same
      // wallet.
      const walletPubKeyHash = `0x${"f0".repeat(20)}` as `0x${string}`
      const reservationA = `0x${"a1".repeat(32)}`
      const reservationB = `0x${"b1".repeat(32)}`
      const owner = ethers.Wallet.createRandom().address
      const anchorAmount = 1_000_000
      const anchorTxHash = `0x${"c1".repeat(32)}` as `0x${string}`
      const anchorTxOutputIndex = 0

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationA,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )
      await executor.seedReservation(
        reservationB,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      expect(
        await executor.walletReservationKeysLength(walletPubKeyHash)
      ).to.equal(2)
      expect(await executor.walletReservationsCount(walletPubKeyHash)).to.equal(
        2
      )
      expect(
        await executor.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(anchorAmount * 2)
      expect(await executor.reservationTotalAmount()).to.equal(anchorAmount * 2)

      // Strand the first reservation.
      await executor.notifyReservationStranded(reservationA)
      expect(
        await executor.walletReservationKeysLength(walletPubKeyHash)
      ).to.equal(1)
      expect(await executor.walletReservationsCount(walletPubKeyHash)).to.equal(
        1
      )
      expect(
        await executor.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(anchorAmount)
      expect(await executor.reservationTotalAmount()).to.equal(anchorAmount)
      // Only the surviving reservation remains in the enumeration.
      expect(
        await executor.walletReservationKeyAt(walletPubKeyHash, 0)
      ).to.equal(reservationB)

      // Strand the second reservation.
      await executor.notifyReservationStranded(reservationB)
      expect(
        await executor.walletReservationKeysLength(walletPubKeyHash)
      ).to.equal(0)
      expect(await executor.walletReservationsCount(walletPubKeyHash)).to.equal(
        0
      )
      expect(
        await executor.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(0)
      expect(await executor.reservationTotalAmount()).to.equal(0)
    })

    it("swap-removes the right enumeration entry when a non-tail reservation is stranded", async () => {
      // `removeWalletReservationKey` swaps the last element into the
      // removed slot. Strand the first reservation out of three to confirm
      // the tail element is moved into the removed slot and surviving indices are updated.
      const walletPubKeyHash = `0x${"d0".repeat(20)}` as `0x${string}`
      const reservationA = `0x${"a2".repeat(32)}`
      const reservationB = `0x${"b2".repeat(32)}`
      const reservationC = `0x${"c2".repeat(32)}`
      const owner = ethers.Wallet.createRandom().address
      const anchorAmount = 1_000_000
      const anchorTxHash = `0x${"d2".repeat(32)}` as `0x${string}`
      const anchorTxOutputIndex = 0

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationA,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )
      await executor.seedReservation(
        reservationB,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )
      await executor.seedReservation(
        reservationC,
        owner,
        walletPubKeyHash,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      // Order before: [A, B, C] with indices 1, 2, 3.
      expect(
        await executor.walletReservationKeyAt(walletPubKeyHash, 0)
      ).to.equal(reservationA)
      expect(await executor.walletReservationKeyIndex(reservationA)).to.equal(1)
      expect(await executor.walletReservationKeyIndex(reservationB)).to.equal(2)
      expect(await executor.walletReservationKeyIndex(reservationC)).to.equal(3)

      await executor.notifyReservationStranded(reservationA)

      // After: [C, B] with indices 1, 2 (C moved into slot 0).
      expect(
        await executor.walletReservationKeysLength(walletPubKeyHash)
      ).to.equal(2)
      expect(
        await executor.walletReservationKeyAt(walletPubKeyHash, 0)
      ).to.equal(reservationC)
      expect(
        await executor.walletReservationKeyAt(walletPubKeyHash, 1)
      ).to.equal(reservationB)
      expect(await executor.walletReservationKeyIndex(reservationA)).to.equal(0)
      expect(await executor.walletReservationKeyIndex(reservationB)).to.equal(2)
      expect(await executor.walletReservationKeyIndex(reservationC)).to.equal(1)
    })
  })

  describe("notifyStaleReservedDeposit", () => {
    it("rejects when refundDeadlineValidated is false but the deadline has not elapsed", async () => {
      // The refundDeadlineValidated flag no longer bypasses the deadline
      // check: the deadline must elapse unconditionally, matching what
      // `requestReservationAcceptance` already enforces unconditionally.
      const walletPubKeyHash = `0x${"e1".repeat(20)}` as `0x${string}`
      const depositKey = `0x${"f1".repeat(32)}`
      const depositor = ethers.Wallet.createRandom().address
      const futureDeadline =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 3600

      await executor.seedDeposit(depositKey, depositor)
      await executor.seedPendingReservedDeposit(
        depositKey,
        walletPubKeyHash,
        futureDeadline,
        false
      )

      expect(await executor.pendingReservedDeposits()).to.equal(1)
      expect(await executor.pendingReservedDepositWallet(depositKey)).to.equal(
        walletPubKeyHash
      )

      await expect(
        executor.notifyStaleReservedDeposit(depositKey)
      ).to.be.revertedWith("Deposit refund deadline has not elapsed")
    })

    it("marks a pending reserved deposit stale when refundDeadline has elapsed and refundDeadlineValidated is true", async () => {
      const walletPubKeyHash = `0x${"e2".repeat(20)}` as `0x${string}`
      const depositKey = `0x${"f2".repeat(32)}`
      const depositor = ethers.Wallet.createRandom().address

      await executor.seedDeposit(depositKey, depositor)
      await executor.seedPendingReservedDeposit(
        depositKey,
        walletPubKeyHash,
        // Deadline strictly in the past so the deadline-elapsed check
        // passes. block.timestamp must be strictly greater than
        // refundDeadline.
        1,
        true
      )

      await expect(executor.notifyStaleReservedDeposit(depositKey)).to.not.be
        .reverted

      expect(await executor.pendingReservedDepositWallet(depositKey)).to.equal(
        ZERO_BYTES20
      )
      expect(await executor.pendingReservedDeposits()).to.equal(0)
    })

    it("rejects when there is no pending reserved deposit", async () => {
      const depositKey = `0x${"f3".repeat(32)}`
      // No seedPendingReservedDeposit call -> pendingDeposit.walletPubKeyHash
      // is bytes20(0), the require fires.
      await expect(
        executor.notifyStaleReservedDeposit(depositKey)
      ).to.be.revertedWith("Not a pending reserved deposit")
    })

    it("rejects when the deposit has already been swept", async () => {
      const walletPubKeyHash = `0x${"e4".repeat(20)}` as `0x${string}`
      const depositKey = `0x${"f4".repeat(32)}`
      const depositor = ethers.Wallet.createRandom().address

      await executor.seedDeposit(depositKey, depositor)
      await executor.seedSweptDeposit(depositKey)
      await executor.seedPendingReservedDeposit(
        depositKey,
        walletPubKeyHash,
        0,
        false
      )

      await expect(
        executor.notifyStaleReservedDeposit(depositKey)
      ).to.be.revertedWith("Deposit already swept")
    })

    it("rejects when the refund deadline has not elapsed (validated=true)", async () => {
      const walletPubKeyHash = `0x${"e5".repeat(20)}` as `0x${string}`
      const depositKey = `0x${"f5".repeat(32)}`
      const depositor = ethers.Wallet.createRandom().address

      await executor.seedDeposit(depositKey, depositor)
      // Far-future deadline so the elapsed check fails deterministically.
      await executor.seedPendingReservedDeposit(
        depositKey,
        walletPubKeyHash,
        0xffffffff,
        true
      )

      await expect(
        executor.notifyStaleReservedDeposit(depositKey)
      ).to.be.revertedWith("Deposit refund deadline has not elapsed")
    })

    it("rejects when an acceptance authorization is still pending", async () => {
      const walletPubKeyHash = `0x${"e6".repeat(20)}` as `0x${string}`
      const depositKey = `0x${"f6".repeat(32)}`
      const depositor = ethers.Wallet.createRandom().address

      await executor.seedDeposit(depositKey, depositor)
      await executor.seedPendingReservedDeposit(
        depositKey,
        walletPubKeyHash,
        0,
        false
      )
      // The acceptance generation (reservationKey, requestNonce=0) is in
      // the Pending action state. The library must refuse to mark the
      // deposit stale until that authorization settles.
      await executor.seedPendingAction(depositKey, 0)

      expect(await executor.actionState(depositKey, 0)).to.equal(
        reservationActionStateEnum.Pending
      )

      await expect(
        executor.notifyStaleReservedDeposit(depositKey)
      ).to.be.revertedWith("Acceptance authorization pending")
    })

    it("decrements the pendingReservedDeposits counter exactly once", async () => {
      const walletPubKeyHash = `0x${"e7".repeat(20)}` as `0x${string}`
      const depositKeyA = `0x${"a7".repeat(32)}`
      const depositKeyB = `0x${"b7".repeat(32)}`
      const depositor = ethers.Wallet.createRandom().address
      // Elapsed deadline: the check is unconditional now, so both calls
      // must clear it regardless of the refundDeadlineValidated flag.
      const elapsedDeadline = 1

      await executor.seedDeposit(depositKeyA, depositor)
      await executor.seedPendingReservedDeposit(
        depositKeyA,
        walletPubKeyHash,
        elapsedDeadline,
        false
      )
      await executor.seedDeposit(depositKeyB, depositor)
      await executor.seedPendingReservedDeposit(
        depositKeyB,
        walletPubKeyHash,
        elapsedDeadline,
        false
      )

      expect(await executor.pendingReservedDeposits()).to.equal(2)

      await executor.notifyStaleReservedDeposit(depositKeyA)
      expect(await executor.pendingReservedDeposits()).to.equal(1)

      await executor.notifyStaleReservedDeposit(depositKeyB)
      expect(await executor.pendingReservedDeposits()).to.equal(0)
    })
  })
  describe("notifyReservationActionTimeout (Reanchor)", () => {
    it("releases target wallet capacity on Reanchor timeout", async () => {
      // Reanchor-timeout releases the target wallet's reserved capacity.
      // Not covered by base's own test suite (PR #1108's body explicitly
      // defers requestReservationReanchor/notifyReservationActionTimeout
      // coverage), so this case is this branch's own contribution.
      const sourceWallet = `0x${"b1".repeat(20)}` as `0x${string}`
      const targetWallet = `0x${"b2".repeat(20)}` as `0x${string}`
      const reservationKey = 2
      const amount = 1_000_000
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedReservation(
        reservationKey,
        ethers.Wallet.createRandom().address,
        sourceWallet,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )

      // seedReservation increments capacity for the wallet it is given, so
      // seed a second reservation directly on the target wallet to give it
      // pre-existing reserved capacity to release.
      await executor.seedReservation(
        3,
        ethers.Wallet.createRandom().address,
        targetWallet,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.Active
      )

      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(
        amount
      )

      // Now seed the reanchor action for reservationKey 2 to targetWallet.
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Reanchor,
        targetWallet,
        amount,
        timeoutAt,
        true,
        ethers.Wallet.createRandom().address
      )

      // Time travel
      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.notifyReservationActionTimeout(
        reservationKey,
        []
      )
      const receipt = await tx.wait()

      const reanchorTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationReanchorTimedOut"
      )
      expect(reanchorTimedOut).to.have.lengthOf(1)
      expect(reanchorTimedOut![0].args!.reservationKey).to.equal(reservationKey)
      expect(reanchorTimedOut![0].args!.requestNonce).to.equal(0)

      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(0)
      // Reanchor timeout must not touch the source wallet's own counters —
      // only the target wallet's reserved capacity is released.
      expect(await executor.walletReservationsAmount(sourceWallet)).to.equal(
        amount
      )
    })

    it("reverts when action has not timed out", async () => {
      const reservationKey = 4
      const targetWallet = `0x${"b3".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 1000

      await executor.seedReservation(
        reservationKey,
        ethers.Wallet.createRandom().address,
        ZERO_BYTES20,
        100,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Reanchor,
        targetWallet,
        100,
        timeoutAt,
        true,
        ethers.Wallet.createRandom().address
      )

      await expect(
        executor.notifyReservationActionTimeout(reservationKey, [])
      ).to.be.revertedWith("Action has not timed out")
    })
  })
  describe("notifyReservationRedemptionTimedOut and notifyReservationDissolutionTimedOut", () => {
    let bankStub: any // Using 'any' for simplicity, or could import Contract

    beforeEach(async () => {
      const BankStubFactory = await ethers.getContractFactory("BankStub")
      bankStub = await BankStubFactory.deploy()
      await bankStub.deployed()
      await executor.setBank(bankStub.address)
    })

    it("Redemption: mints retry credit, transfers balance, and emits events", async () => {
      const reservationKey = 101
      const requestNonce = 1
      const amount = 1_000_000
      const redeemer = ethers.Wallet.createRandom().address
      const walletPubKeyHash = `0x${"d1".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100
      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservationWithNonce(
        reservationKey,
        redeemer,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending,
        requestNonce
      )

      await executor.seedPendingReservationAction(
        reservationKey,
        requestNonce,
        reservationActionTypeEnum.Redemption,
        walletPubKeyHash,
        amount,
        timeoutAt,
        true, // feePaid
        redeemer
      )

      // Advance time
      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      // Initial balance for bankstub
      await bankStub.setBalance(executor.address, amount)

      const tx = await executor.notifyReservationRedemptionTimedOut(
        reservationKey,
        []
      )
      const receipt = await tx.wait()
      const actionTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationRedemptionTimedOut"
      )
      expect(actionTimedOut).to.have.lengthOf(1)
      expect(actionTimedOut![0].args!.requestNonce).to.equal(requestNonce)

      // Assert minting retry credit (feePaid=true)
      const retryCreditMinted = receipt.events?.filter(
        (e) => e.event === "ReservationRetryCreditMinted"
      )
      expect(retryCreditMinted).to.have.lengthOf(1)
      expect(retryCreditMinted![0].args!.reservationKey).to.equal(
        reservationKey
      )
      expect(await executor.retryCredit(reservationKey)).to.be.true
      expect(
        await executor.reservationRetryCreditActionNonce(reservationKey)
      ).to.equal(requestNonce)
      // Escrowed balance moved from the executor to the redeemer.
      expect(await bankStub.balanceOf(redeemer)).to.equal(amount)
      expect(await bankStub.balanceOf(executor.address)).to.equal(0)
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
    })
    it("Redemption: mints retry credit, transfers balance, and emits events (feePaid=false, usedRetryCredit=true)", async () => {
      const reservationKey = 103
      const requestNonce = 2
      const amount = 1_000_000
      const redeemer = ethers.Wallet.createRandom().address
      const walletPubKeyHash = `0x${"d3".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservationWithNonce(
        reservationKey,
        redeemer,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending,
        requestNonce
      )

      await executor.seedPendingReservationActionWithRetryCredit(
        reservationKey,
        requestNonce,
        reservationActionTypeEnum.Redemption,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        redeemer,
        true
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])
      await bankStub.setBalance(executor.address, amount)

      const tx = await executor.notifyReservationRedemptionTimedOut(
        reservationKey,
        []
      )
      const receipt = await tx.wait()

      // Events
      const actionTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationRedemptionTimedOut"
      )
      expect(actionTimedOut).to.have.lengthOf(1)
      expect(actionTimedOut![0].args!.requestNonce).to.equal(requestNonce)

      // Assert minting retry credit (usedRetryCredit=true)
      const retryCreditMinted = receipt.events?.filter(
        (e) => e.event === "ReservationRetryCreditMinted"
      )
      expect(retryCreditMinted).to.have.lengthOf(1)
      expect(retryCreditMinted![0].args!.reservationKey).to.equal(
        reservationKey
      )
      expect(await executor.retryCredit(reservationKey)).to.be.true
      expect(
        await executor.reservationRetryCreditActionNonce(reservationKey)
      ).to.equal(requestNonce)
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
    })
    it("Redemption: transfers balance, emits events, no retry credit (feePaid=false, usedRetryCredit=false)", async () => {
      const reservationKey = 104
      const amount = 1_000_000
      const redeemer = ethers.Wallet.createRandom().address
      const walletPubKeyHash = `0x${"d4".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        redeemer,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )

      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Redemption,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        redeemer
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])
      await bankStub.setBalance(executor.address, amount)

      const tx = await executor.notifyReservationRedemptionTimedOut(
        reservationKey,
        []
      )
      const receipt = await tx.wait()

      // Events
      expect(
        receipt.events?.filter(
          (e) => e.event === "ReservationRedemptionTimedOut"
        )
      ).to.have.lengthOf(1)

      // Assert NOT minting retry credit
      const retryCreditMinted = receipt.events?.filter(
        (e) => e.event === "ReservationRetryCreditMinted"
      )
      expect(retryCreditMinted).to.have.lengthOf(0)
      expect(await executor.retryCredit(reservationKey)).to.be.false
      expect(await bankStub.balanceOf(redeemer)).to.equal(amount)
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
    })
    it("Redemption: skips wallet slashing when wallet is Closed (non-redeemable)", async () => {
      const walletRegistry: Mock<IWalletRegistry> =
        await createMock<IWalletRegistry>("IWalletRegistry")
      await executor.setEcdsaWalletRegistry(walletRegistry.address)

      const reservationKey = 105
      const amount = 1_000_000
      const redeemer = ethers.Wallet.createRandom().address
      const walletPubKeyHash = `0x${"d5".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      // Seed wallet in Closed state. Pins the accepted-design decision that
      // a Closed wallet silently receives neither slash nor notifier reward
      // (signing group already disbanded and stake already withdrawn).
      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Closed
      )
      await executor.seedReservation(
        reservationKey,
        redeemer,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )

      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Redemption,
        walletPubKeyHash,
        amount,
        timeoutAt,
        true,
        redeemer
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])
      await bankStub.setBalance(executor.address, amount)

      const tx = await executor.notifyReservationRedemptionTimedOut(
        reservationKey,
        []
      )
      const receipt = await tx.wait()

      // Events
      const actionTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationRedemptionTimedOut"
      )
      expect(actionTimedOut).to.have.lengthOf(1)

      const retryCreditMinted = receipt.events?.filter(
        (e) => e.event === "ReservationRetryCreditMinted"
      )
      expect(retryCreditMinted).to.have.lengthOf(1)
      expect(retryCreditMinted![0].args!.reservationKey).to.equal(
        reservationKey
      )

      // Bank balance returned to redeemer
      expect(await bankStub.balanceOf(redeemer)).to.equal(amount)
      expect(await bankStub.balanceOf(executor.address)).to.equal(0)

      // Reservation state reset to Active
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )

      // Wallet state unchanged (remains Closed)
      expect(await executor.walletState(walletPubKeyHash)).to.equal(
        walletStateEnum.Closed
      )

      // ECDSA wallet registry slashing functions NOT called
      await expectNotCalled(walletRegistry.seize)
      await expectNotCalled(walletRegistry.closeWallet)
    })

    it("Redemption: slashes wallet when wallet is in MovingFunds state", async () => {
      const walletRegistry: Mock<IWalletRegistry> =
        await createMock<IWalletRegistry>("IWalletRegistry")
      await executor.setEcdsaWalletRegistry(walletRegistry.address)

      const reservationKey = 110
      const amount = 1_000_000
      const redeemer = ethers.Wallet.createRandom().address
      const walletPubKeyHash = `0x${"e0".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.MovingFunds
      )
      await executor.seedReservation(
        reservationKey,
        redeemer,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )

      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Redemption,
        walletPubKeyHash,
        amount,
        timeoutAt,
        true,
        redeemer
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])
      await bankStub.setBalance(executor.address, amount)

      const tx = await executor.notifyReservationRedemptionTimedOut(
        reservationKey,
        []
      )
      const receipt = await tx.wait()

      const actionTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationRedemptionTimedOut"
      )
      expect(actionTimedOut).to.have.lengthOf(1)

      await expectCalledOnce(walletRegistry.seize)
      expect(await bankStub.balanceOf(redeemer)).to.equal(amount)
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
    })

    it("Redemption: slashes wallet and preserves Closing state when wallet is already Closing", async () => {
      const walletRegistry: Mock<IWalletRegistry> =
        await createMock<IWalletRegistry>("IWalletRegistry")
      await executor.setEcdsaWalletRegistry(walletRegistry.address)

      const reservationKey = 115
      const requestNonce = 1
      const amount = 1_000_000
      const redeemer = ethers.Wallet.createRandom().address
      const walletPubKeyHash = `0x${"e5".repeat(20)}` as `0x${string}`
      const walletMembersIDs = [1, 2, 3]
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      // Seed wallet in Closing state before the call. This exercises the
      // `else if (walletState == Wallets.WalletState.Closing)` branch of
      // `_slashWalletIfRedeemable`, which routes through
      // `Wallets.notifyClosingWalletRedemptionTimeout`.
      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Closing
      )
      await executor.seedReservationWithNonce(
        reservationKey,
        redeemer,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending,
        requestNonce
      )

      await executor.seedPendingReservationAction(
        reservationKey,
        requestNonce,
        reservationActionTypeEnum.Redemption,
        walletPubKeyHash,
        amount,
        timeoutAt,
        true,
        redeemer
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])
      await bankStub.setBalance(executor.address, amount)

      const tx = await executor.notifyReservationRedemptionTimedOut(
        reservationKey,
        walletMembersIDs
      )
      const receipt = await tx.wait()

      const actionTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationRedemptionTimedOut"
      )
      expect(actionTimedOut).to.have.lengthOf(1)
      expect(actionTimedOut![0].args!.requestNonce).to.equal(requestNonce)

      // Slashed in registry with the provided member IDs, but not closed/terminated
      await expectCalledOnce(walletRegistry.seize)
      await expectNotCalled(walletRegistry.closeWallet)

      // Wallet remains in Closing state (not Terminated or Live)
      expect(await executor.walletState(walletPubKeyHash)).to.equal(
        walletStateEnum.Closing
      )

      // Escrowed balance moved from the executor to the redeemer
      expect(await bankStub.balanceOf(redeemer)).to.equal(amount)
      expect(await bankStub.balanceOf(executor.address)).to.equal(0)

      // Reservation resets to Active
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
    })

    it("Redemption: reverts when action is not Redemption", async () => {
      const reservationKey = 111
      const amount = 1_000_000
      const redeemer = ethers.Wallet.createRandom().address
      const walletPubKeyHash = `0x${"e1".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        redeemer,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Dissolution,
        walletPubKeyHash,
        amount,
        timeoutAt,
        true,
        redeemer
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      await expect(
        executor.notifyReservationRedemptionTimedOut(reservationKey, [])
      ).to.be.revertedWith("Unsupported action type for timeout")
    })

    it("Redemption: reverts when reservation is not in ActionPending state", async () => {
      const reservationKey = 112
      const amount = 1_000_000
      const redeemer = ethers.Wallet.createRandom().address
      const walletPubKeyHash = `0x${"e2".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        redeemer,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.Active
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Redemption,
        walletPubKeyHash,
        amount,
        timeoutAt,
        true,
        redeemer
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      await expect(
        executor.notifyReservationRedemptionTimedOut(reservationKey, [])
      ).to.be.revertedWith("Reservation is not in ActionPending state")
    })

    it("Redemption: reverts when action is not pending", async () => {
      const reservationKey = 113
      const amount = 1_000_000
      const redeemer = ethers.Wallet.createRandom().address
      const walletPubKeyHash = `0x${"e3".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        redeemer,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Redemption,
        walletPubKeyHash,
        amount,
        timeoutAt,
        true,
        redeemer
      )
      await executor.seedReservationActionState(
        reservationKey,
        0,
        reservationActionTypeEnum.Redemption,
        reservationActionStateEnum.Settled
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      await expect(
        executor.notifyReservationRedemptionTimedOut(reservationKey, [])
      ).to.be.revertedWith("Action is not pending")
    })

    it("Redemption: reverts when action has not timed out", async () => {
      const reservationKey = 114
      const amount = 1_000_000
      const redeemer = ethers.Wallet.createRandom().address
      const walletPubKeyHash = `0x${"e4".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 1000

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        redeemer,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Redemption,
        walletPubKeyHash,
        amount,
        timeoutAt,
        true,
        redeemer
      )

      await expect(
        executor.notifyReservationRedemptionTimedOut(reservationKey, [])
      ).to.be.revertedWith("Action has not timed out")
    })

    it("Dissolution: reverts to Active and clears pending dissolution", async () => {
      const reservationKey = 102
      const requestNonce = 1
      const amount = 1_000_000
      const walletPubKeyHash = `0x${"d2".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100
      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservationWithNonce(
        reservationKey,
        ethers.Wallet.createRandom().address,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending,
        requestNonce
      )
      await executor.seedWalletPendingDissolution(
        walletPubKeyHash,
        reservationKey
      )
      await executor.seedPendingReservationActionWithRetryCredit(
        reservationKey,
        requestNonce,
        reservationActionTypeEnum.Dissolution,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        ZERO_BYTES20,
        false
      )

      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(reservationKey)

      // Time travel
      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.notifyReservationDissolutionTimedOut(
        reservationKey,
        []
      )
      const receipt = await tx.wait()

      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(0)
      const actionTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationDissolutionTimedOut"
      )
      expect(actionTimedOut).to.have.lengthOf(1)
      expect(actionTimedOut![0].args!.requestNonce).to.equal(requestNonce)
    })

    it("Dissolution: preserves pending dissolution marker when wallet marker belongs to another reservation", async () => {
      const reservationKey = 120
      const otherReservationKey = 121
      const amount = 1_000_000
      const walletPubKeyHash = `0x${"f0".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        ethers.Wallet.createRandom().address,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )
      await executor.seedWalletPendingDissolution(
        walletPubKeyHash,
        otherReservationKey
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Dissolution,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        ZERO_BYTES20
      )

      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(otherReservationKey)

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.notifyReservationDissolutionTimedOut(
        reservationKey,
        []
      )
      const receipt = await tx.wait()

      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(otherReservationKey)

      const actionTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationDissolutionTimedOut"
      )
      expect(actionTimedOut).to.have.lengthOf(1)
    })

    it("Dissolution: escalates MovingFunds wallet to Terminated and clears pending dissolution", async () => {
      const walletRegistry: Mock<IWalletRegistry> =
        await createMock<IWalletRegistry>("IWalletRegistry")
      await executor.setEcdsaWalletRegistry(walletRegistry.address)

      const reservationKey = 106
      const amount = 1_000_000
      const walletPubKeyHash = `0x${"d6".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.MovingFunds
      )
      await executor.seedReservation(
        reservationKey,
        ethers.Wallet.createRandom().address,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )
      await executor.seedWalletPendingDissolution(
        walletPubKeyHash,
        reservationKey
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Dissolution,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        ZERO_BYTES20
      )

      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(reservationKey)
      expect(await executor.walletState(walletPubKeyHash)).to.equal(
        walletStateEnum.MovingFunds
      )

      // Advance time past timeoutAt
      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.notifyReservationDissolutionTimedOut(
        reservationKey,
        []
      )
      const receipt = await tx.wait()

      // Reservation resets to Active
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
      // Pending dissolution cleared
      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(0)
      // Wallet escalated from MovingFunds to Terminated
      expect(await executor.walletState(walletPubKeyHash)).to.equal(
        walletStateEnum.Terminated
      )

      // Event emitted
      const actionTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationDissolutionTimedOut"
      )
      expect(actionTimedOut).to.have.lengthOf(1)

      // Slashed and closed in registry
      await expectCalledOnce(walletRegistry.seize)
      await expectCalledOnce(walletRegistry.closeWallet)
    })

    it("Dissolution: transitions Live wallet with main UTXO to MovingFunds on first failure", async () => {
      const walletRegistry: Mock<IWalletRegistry> =
        await createMock<IWalletRegistry>("IWalletRegistry")
      await executor.setEcdsaWalletRegistry(walletRegistry.address)

      const reservationKey = 122
      const amount = 1_000_000
      const walletPubKeyHash = `0x${"f1".repeat(20)}` as `0x${string}`
      const mainUtxoHash = `0x${"ab".repeat(32)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedWalletWithMainUtxo(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Live,
        mainUtxoHash
      )
      await executor.seedReservation(
        reservationKey,
        ethers.Wallet.createRandom().address,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )
      await executor.seedWalletPendingDissolution(
        walletPubKeyHash,
        reservationKey
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Dissolution,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        ZERO_BYTES20
      )

      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(reservationKey)
      expect(await executor.walletState(walletPubKeyHash)).to.equal(
        walletStateEnum.Live
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.notifyReservationDissolutionTimedOut(
        reservationKey,
        []
      )
      const receipt = await tx.wait()

      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(0)
      expect(await executor.walletState(walletPubKeyHash)).to.equal(
        walletStateEnum.MovingFunds
      )

      const actionTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationDissolutionTimedOut"
      )
      expect(actionTimedOut).to.have.lengthOf(1)

      await expectCalledOnce(walletRegistry.seize)
      await expectNotCalled(walletRegistry.closeWallet)
    })

    it("Dissolution: slashes but does not terminate a Live wallet that transitions to Closing on its first failure", async () => {
      const walletRegistry: Mock<IWalletRegistry> =
        await createMock<IWalletRegistry>("IWalletRegistry")
      await executor.setEcdsaWalletRegistry(walletRegistry.address)

      const reservationKey = 107
      const amount = 1_000_000
      const walletPubKeyHash = `0x${"d7".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      // Seed wallet in Live state with mainUtxoHash = bytes32(0).
      // When notifyWalletRedemptionTimeout runs on a Live wallet with no main UTXO,
      // moveFunds() calls beginWalletClosing() which sets wallet.state = Closing.
      // Because the wallet was Live (not MovingFunds) pre-call, it is slashed but
      // not terminated, ending the call in Closing state.
      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Live
      )
      await executor.seedReservation(
        reservationKey,
        ethers.Wallet.createRandom().address,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )
      await executor.seedWalletPendingDissolution(
        walletPubKeyHash,
        reservationKey
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Dissolution,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        ZERO_BYTES20
      )

      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(reservationKey)
      expect(await executor.walletState(walletPubKeyHash)).to.equal(
        walletStateEnum.Live
      )

      // Advance time past timeoutAt
      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.notifyReservationDissolutionTimedOut(
        reservationKey,
        []
      )
      const receipt = await tx.wait()

      // Reservation resets to Active
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
      // Pending dissolution cleared
      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(0)
      // Wallet transitioned to Closing (not Terminated)
      expect(await executor.walletState(walletPubKeyHash)).to.equal(
        walletStateEnum.Closing
      )

      // Event emitted
      const actionTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationDissolutionTimedOut"
      )
      expect(actionTimedOut).to.have.lengthOf(1)

      // Slashed in registry but not closed/terminated
      await expectCalledOnce(walletRegistry.seize)
      await expectNotCalled(walletRegistry.closeWallet)
    })

    it("Dissolution: slashes but does not terminate a wallet that was already Closing before the call", async () => {
      const walletRegistry: Mock<IWalletRegistry> =
        await createMock<IWalletRegistry>("IWalletRegistry")
      await executor.setEcdsaWalletRegistry(walletRegistry.address)

      const reservationKey = 116
      const requestNonce = 1
      const amount = 1_000_000
      const walletPubKeyHash = `0x${"e6".repeat(20)}` as `0x${string}`
      const walletMembersIDs = [1, 2, 3]
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      // Seed wallet in Closing state before the call. This pins the accepted-design
      // leniency decision that a wallet already Closing before the timeout call
      // is slashed via notifyClosingWalletRedemptionTimeout but NOT terminated by
      // dissolution timeout (walletWasMovingFunds is false).
      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Closing
      )
      await executor.seedReservationWithNonce(
        reservationKey,
        ethers.Wallet.createRandom().address,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending,
        requestNonce
      )
      await executor.seedWalletPendingDissolution(
        walletPubKeyHash,
        reservationKey
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        requestNonce,
        reservationActionTypeEnum.Dissolution,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        ZERO_BYTES20
      )

      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(reservationKey)
      expect(await executor.walletState(walletPubKeyHash)).to.equal(
        walletStateEnum.Closing
      )

      // Advance time past timeoutAt
      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.notifyReservationDissolutionTimedOut(
        reservationKey,
        walletMembersIDs
      )
      const receipt = await tx.wait()

      // Reservation resets to Active
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
      // Pending dissolution cleared
      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(0)
      // Wallet remains Closing (slashed-but-not-terminated, pinning accepted design)
      expect(await executor.walletState(walletPubKeyHash)).to.equal(
        walletStateEnum.Closing
      )

      // Event emitted
      const actionTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationDissolutionTimedOut"
      )
      expect(actionTimedOut).to.have.lengthOf(1)
      expect(actionTimedOut![0].args!.requestNonce).to.equal(requestNonce)

      // Slashed in registry with member IDs, but not closed/terminated
      await expectCalledOnce(walletRegistry.seize)
      await expectNotCalled(walletRegistry.closeWallet)
    })

    it("Dissolution: skips wallet slashing when wallet is Closed (non-redeemable)", async () => {
      const walletRegistry: Mock<IWalletRegistry> =
        await createMock<IWalletRegistry>("IWalletRegistry")
      await executor.setEcdsaWalletRegistry(walletRegistry.address)

      const reservationKey = 117
      const requestNonce = 1
      const amount = 1_000_000
      const walletPubKeyHash = `0x${"e7".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      // Seed wallet in Closed state. Pins the accepted-design decision that
      // a Closed wallet silently receives neither slash nor notifier reward
      // (signing group already disbanded and stake already withdrawn).
      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Closed
      )
      await executor.seedReservationWithNonce(
        reservationKey,
        ethers.Wallet.createRandom().address,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending,
        requestNonce
      )
      await executor.seedWalletPendingDissolution(
        walletPubKeyHash,
        reservationKey
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        requestNonce,
        reservationActionTypeEnum.Dissolution,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        ZERO_BYTES20
      )

      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(reservationKey)
      expect(await executor.walletState(walletPubKeyHash)).to.equal(
        walletStateEnum.Closed
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.notifyReservationDissolutionTimedOut(
        reservationKey,
        []
      )
      const receipt = await tx.wait()

      // Reservation resets to Active
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
      // Pending dissolution cleared
      expect(
        await executor.walletPendingDissolution(walletPubKeyHash)
      ).to.equal(0)
      // Wallet state unchanged (remains Closed)
      expect(await executor.walletState(walletPubKeyHash)).to.equal(
        walletStateEnum.Closed
      )

      const actionTimedOut = receipt.events?.filter(
        (e) => e.event === "ReservationDissolutionTimedOut"
      )
      expect(actionTimedOut).to.have.lengthOf(1)
      expect(actionTimedOut![0].args!.requestNonce).to.equal(requestNonce)

      // ECDSA wallet registry slashing functions NOT called
      await expectNotCalled(walletRegistry.seize)
      await expectNotCalled(walletRegistry.closeWallet)
    })

    it("Dissolution: reverts when action is not Dissolution", async () => {
      const reservationKey = 123
      const amount = 1_000_000
      const walletPubKeyHash = `0x${"f2".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        ethers.Wallet.createRandom().address,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Redemption,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        ZERO_BYTES20
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      await expect(
        executor.notifyReservationDissolutionTimedOut(reservationKey, [])
      ).to.be.revertedWith("Unsupported action type for timeout")
    })

    it("Dissolution: reverts when reservation is not in ActionPending state", async () => {
      const reservationKey = 124
      const amount = 1_000_000
      const walletPubKeyHash = `0x${"f3".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        ethers.Wallet.createRandom().address,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.Active
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Dissolution,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        ZERO_BYTES20
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      await expect(
        executor.notifyReservationDissolutionTimedOut(reservationKey, [])
      ).to.be.revertedWith("Reservation is not in ActionPending state")
    })

    it("Dissolution: reverts when action is not pending", async () => {
      const reservationKey = 125
      const amount = 1_000_000
      const walletPubKeyHash = `0x${"f4".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 100

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        ethers.Wallet.createRandom().address,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Dissolution,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        ZERO_BYTES20
      )
      await executor.seedReservationActionState(
        reservationKey,
        0,
        reservationActionTypeEnum.Dissolution,
        reservationActionStateEnum.Settled
      )

      await ethers.provider.send("evm_setNextBlockTimestamp", [timeoutAt + 1])
      await ethers.provider.send("evm_mine", [])

      await expect(
        executor.notifyReservationDissolutionTimedOut(reservationKey, [])
      ).to.be.revertedWith("Action is not pending")
    })

    it("Dissolution: reverts when action has not timed out", async () => {
      const reservationKey = 126
      const amount = 1_000_000
      const walletPubKeyHash = `0x${"f5".repeat(20)}` as `0x${string}`
      const timeoutAt =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 1000

      await executor.seedWallet(
        walletPubKeyHash,
        ZERO_BYTES32,
        walletStateEnum.Terminated
      )
      await executor.seedReservation(
        reservationKey,
        ethers.Wallet.createRandom().address,
        walletPubKeyHash,
        amount,
        ZERO_BYTES32,
        0,
        reservationStateEnum.ActionPending
      )
      await executor.seedPendingReservationAction(
        reservationKey,
        0,
        reservationActionTypeEnum.Dissolution,
        walletPubKeyHash,
        amount,
        timeoutAt,
        false,
        ZERO_BYTES20
      )

      await expect(
        executor.notifyReservationDissolutionTimedOut(reservationKey, [])
      ).to.be.revertedWith("Action has not timed out")
    })
  })
  describe("requestReservationReanchor", () => {
    const sourceWallet = `0x${"11".repeat(20)}` as `0x${string}`
    const targetWallet = `0x${"22".repeat(20)}` as `0x${string}`
    const reservationKey = `0x${"aa".repeat(32)}`
    const owner = ethers.Wallet.createRandom().address
    const anchorAmount = 1_000_000
    const anchorTxHash = `0x${"33".repeat(32)}` as `0x${string}`
    const anchorTxOutputIndex = 0
    const txMaxFee = 10_000
    const actionTimeout = 6 * 3600
    const maxPerWallet = 5
    const maxAmountPerWallet = 50_000_000
    let reservationInterface: Interface

    beforeEach(async () => {
      // Only the ABI is needed here (for event decoding via parseLog
      // below), so read the artifact directly rather than constructing a
      // ContractFactory, which would require linking ReservationProofs.
      const reservationArtifact = await artifacts.readArtifact("Reservation")
      reservationInterface = new ethers.utils.Interface(reservationArtifact.abi)

      await setReservationConfig(executor.address, {
        reservationTxMaxFee: txMaxFee,
        reservationActionTimeout: actionTimeout,
        maxReservationsPerWallet: maxPerWallet,
        maxReservationsAmountPerWallet: maxAmountPerWallet,
      })
      await executor.seedWallet(
        sourceWallet,
        ZERO_BYTES32,
        walletStateEnum.MovingFunds
      )
      await executor.seedWallet(
        targetWallet,
        ZERO_BYTES32,
        walletStateEnum.Live
      )
      await executor.seedReservation(
        reservationKey,
        owner,
        sourceWallet,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )
    })

    it("successfully requests reservation re-anchor from MovingFunds wallet (unprivileged happy path)", async () => {
      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(0)
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(0)

      const tx = await executor.requestReservationReanchor(
        reservationKey,
        targetWallet,
        false
      )
      const receipt = await tx.wait()

      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.ActionPending
      )
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(1)
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(
        anchorAmount
      )
      expect(await executor.actionState(reservationKey, 1)).to.equal(
        reservationActionStateEnum.Pending
      )

      const parsedEvents = receipt.logs
        .map((log) => {
          try {
            return reservationInterface.parseLog(log)
          } catch {
            return null
          }
        })
        .filter((e) => e !== null)

      const requested = parsedEvents.find(
        (e) => e!.name === "ReservationReanchorRequested"
      )
      expect(requested, "ReservationReanchorRequested event missing").to.not.be
        .undefined
      expect(requested!.args.reservationKey).to.equal(reservationKey)
      expect(requested!.args.requestNonce).to.equal(1)
      expect(requested!.args.sourceWalletPubKeyHash).to.equal(sourceWallet)
      expect(requested!.args.targetWalletPubKeyHash).to.equal(targetWallet)
      expect(requested!.args.txMaxFee).to.equal(txMaxFee)
    })

    it("successfully requests reservation re-anchor from Closing wallet (unprivileged happy path)", async () => {
      await executor.seedWallet(
        sourceWallet,
        ZERO_BYTES32,
        walletStateEnum.Closing
      )

      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.Active
      )
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(0)
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(0)

      const tx = await executor.requestReservationReanchor(
        reservationKey,
        targetWallet,
        false
      )
      const receipt = await tx.wait()

      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.ActionPending
      )
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(1)
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(
        anchorAmount
      )
      expect(await executor.actionState(reservationKey, 1)).to.equal(
        reservationActionStateEnum.Pending
      )

      const parsedEvents = receipt.logs
        .map((log) => {
          try {
            return reservationInterface.parseLog(log)
          } catch {
            return null
          }
        })
        .filter((e) => e !== null)

      const requested = parsedEvents.find(
        (e) => e!.name === "ReservationReanchorRequested"
      )
      expect(requested, "ReservationReanchorRequested event missing").to.not.be
        .undefined
      expect(requested!.args.reservationKey).to.equal(reservationKey)
      expect(requested!.args.requestNonce).to.equal(1)
      expect(requested!.args.sourceWalletPubKeyHash).to.equal(sourceWallet)
      expect(requested!.args.targetWalletPubKeyHash).to.equal(targetWallet)
      expect(requested!.args.txMaxFee).to.equal(txMaxFee)
    })

    it("successfully requests reservation re-anchor from Live wallet by governance (privileged happy path)", async () => {
      await executor.seedWallet(
        sourceWallet,
        ZERO_BYTES32,
        walletStateEnum.Live
      )

      const tx = await executor.requestReservationReanchor(
        reservationKey,
        targetWallet,
        true
      )
      const receipt = await tx.wait()

      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.ActionPending
      )
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(1)
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(
        anchorAmount
      )
      expect(await executor.actionState(reservationKey, 1)).to.equal(
        reservationActionStateEnum.Pending
      )

      const parsedEvents = receipt.logs
        .map((log) => {
          try {
            return reservationInterface.parseLog(log)
          } catch {
            return null
          }
        })
        .filter((e) => e !== null)

      const requested = parsedEvents.find(
        (e) => e!.name === "ReservationReanchorRequested"
      )
      expect(requested).to.not.be.undefined
      expect(requested!.args.reservationKey).to.equal(reservationKey)
      expect(requested!.args.requestNonce).to.equal(1)
      expect(requested!.args.sourceWalletPubKeyHash).to.equal(sourceWallet)
      expect(requested!.args.targetWalletPubKeyHash).to.equal(targetWallet)
      expect(requested!.args.txMaxFee).to.equal(txMaxFee)
    })

    it("rejects when reservation is not Active", async () => {
      const closedReservationKey = `0x${"ab".repeat(32)}`
      await executor.seedReservation(
        closedReservationKey,
        owner,
        sourceWallet,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Closed
      )

      await expect(
        executor.requestReservationReanchor(
          closedReservationKey,
          targetWallet,
          false
        )
      ).to.be.revertedWith("Reservation is not active")
    })

    it("rejects when reservation is dissolution-eligible", async () => {
      const pastEligibleKey = `0x${"ac".repeat(32)}`
      await executor.seedReservation(
        pastEligibleKey,
        owner,
        sourceWallet,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      // Time travel past dissolutionEligibleAt (365 + 30 days)
      await ethers.provider.send("evm_increaseTime", [400 * 86400])
      await ethers.provider.send("evm_mine", [])

      await expect(
        executor.requestReservationReanchor(
          pastEligibleKey,
          targetWallet,
          false
        )
      ).to.be.revertedWith("Reservation is dissolution-eligible")
    })

    it("rejects when source wallet is Live and call is not privileged", async () => {
      await executor.seedWallet(
        sourceWallet,
        ZERO_BYTES32,
        walletStateEnum.Live
      )

      await expect(
        executor.requestReservationReanchor(reservationKey, targetWallet, false)
      ).to.be.revertedWith("Only governance can rotate a Live wallet's anchor")
    })

    it("rejects when source wallet is not in Live, MovingFunds, or Closing state", async () => {
      await executor.seedWallet(
        sourceWallet,
        ZERO_BYTES32,
        walletStateEnum.Closed
      )

      await expect(
        executor.requestReservationReanchor(reservationKey, targetWallet, false)
      ).to.be.revertedWith(
        "Source wallet must be in MovingFunds or Closing state"
      )
    })

    it("rejects when target wallet is the same as source wallet", async () => {
      await expect(
        executor.requestReservationReanchor(reservationKey, sourceWallet, false)
      ).to.be.revertedWith("Target wallet must differ from the source wallet")
    })

    it("rejects when target wallet is not in Live state", async () => {
      await executor.seedWallet(
        targetWallet,
        ZERO_BYTES32,
        walletStateEnum.MovingFunds
      )

      await expect(
        executor.requestReservationReanchor(reservationKey, targetWallet, false)
      ).to.be.revertedWith("Target wallet must be in Live state")
    })

    it("rejects when target wallet reservation count cap is exceeded", async () => {
      await setReservationConfig(executor.address, {
        maxReservationsPerWallet: 1,
      })
      await executor.seedReservation(
        `0x${"b1".repeat(32)}`,
        owner,
        targetWallet,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      await expect(
        executor.requestReservationReanchor(reservationKey, targetWallet, false)
      ).to.be.revertedWith("Wallet reservations cap exceeded")
    })

    it("rejects when target wallet reserved amount cap is exceeded", async () => {
      await setReservationConfig(executor.address, {
        maxReservationsAmountPerWallet: 1_500_000,
      })
      await executor.seedReservation(
        `0x${"b2".repeat(32)}`,
        owner,
        targetWallet,
        1_000_000,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      await expect(
        executor.requestReservationReanchor(reservationKey, targetWallet, false)
      ).to.be.revertedWith("Wallet reserved amount cap exceeded")
    })
  })
})
