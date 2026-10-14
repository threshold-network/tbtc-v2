/* eslint-disable @typescript-eslint/no-unused-expressions */

import { artifacts, ethers } from "hardhat"
import { expect } from "chai"
import {
  Contract,
  ContractTransactionResponse,
  getAddress,
  Interface,
  LogDescription,
  Log,
  solidityPackedKeccak256,
} from "ethers"
import loadFixture from "../helpers/fixture"

import type { Mock } from "../helpers/mock"
import type {
  ReservationStrandingExecutor,
  IWalletRegistry,
} from "../../typechain"

const ZERO_BYTES20 = `0x${"00".repeat(20)}`

// 256-bit all-ones word (replaces `ethers.constants.MaxUint256`).
const MAX_UINT256 =
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn

// 0x-prefixed, 32-byte-padded hex encoding of a storage word.
const padWordHex = (word: bigint): string =>
  `0x${(word & MAX_UINT256).toString(16).padStart(64, "0")}`
// Zeroes the `bits`-wide field at bit offset `shift` within a 256-bit word,
// leaving every other bit untouched. v6 BigInt replacement for the original
// `ethers.constants.MaxUint256.sub(fieldMask)` idiom used to clear a packed
// storage field before writing a new value into it.
const clearField = (word: bigint, shift: number, bits: number): bigint => {
  const field = (1n << BigInt(bits)) - 1n
  return (word & (MAX_UINT256 ^ (field << BigInt(shift)))) & MAX_UINT256
}
// Collects the `name`-matched LogDescriptions emitted by a receipt,
// decoded through the given ABI (v6 replacement for the v5
// `receipt.events` convenience property).
function receiptEvents(
  receipt: { logs: Log[] },
  iface: Interface,
  eventName: string
): LogDescription[] {
  return receipt.logs
    .map((log) => {
      try {
        const parsed = iface.parseLog(log)
        return parsed && parsed.name === eventName ? parsed : null
      } catch {
        return null
      }
    })
    .filter((e): e is LogDescription => e !== null)
}


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

async function deployExecutor(): Promise<ReservationStrandingExecutor> {
  // The Reservation library is `external` (its `notifyReservationStranded`,
  // `notifyStaleReservedDeposit`, `notifyReservationActionTimeout`,
  // `requestReservationAcceptance`, and `requestReservationReanchor`
  // functions have the `external` visibility modifier). The bytecode of
  // the `ReservationStrandingExecutor` test contract embeds a
  // placeholder for the Reservation library because of the `using
  // Reservation for BridgeState.Storage` declaration. `Reservation.sol`
  // no longer calls into `ReservationProofs` (the router calls
  // `ReservationProofs.submitReservationProof` directly instead), so
  // `Reservation` needs no library linking of its own. The executor's
  // own direct calls into `submitReservationAcceptanceProof`/
  // `submitReservationReanchorProof` are `internal` and get inlined at
  // compile time, so the executor itself only needs `Reservation`
  // linked, not `ReservationProofs`.
  const ReservationFactory = await ethers.getContractFactory("Reservation")
  const reservation = await ReservationFactory.deploy()
  await reservation.waitForDeployment()

  const Factory = await ethers.getContractFactory(
    "ReservationStrandingExecutor",
    {
      libraries: {
        Reservation: reservation.target,
      },
    }
  )
  const executor = (await Factory.deploy()) as ReservationStrandingExecutor
  await executor.waitForDeployment()
  return executor
}

async function setReservationConfig(
  executorAddress: string,
  params: {
    reservationVault?: string
    reservationMinAmount?: number | bigint
    reservationTxMaxFee?: number | bigint
    reservationTermSeconds?: number | bigint
    reservationDissolutionDelay?: number | bigint
    reservationMaxTotalAmount?: number | bigint
    reservationTotalAmount?: number | bigint
    maxReservationsPerWallet?: number | bigint
    reservationRouter?: string
    reservationActionTimeout?: number | bigint
    reservationRenewalWindowSeconds?: number | bigint
    maxReservationsAmountPerWallet?: number | bigint
    reservationMaxSingleAmount?: number | bigint
    maxThirdPartyReanchorHoldsPerWallet?: number | bigint
  }
) {
  if (
    params.reservationMinAmount !== undefined ||
    params.reservationTermSeconds !== undefined
  ) {
    const raw = await ethers.provider.getStorage(
      executorAddress,
      ethers.toQuantity(29)
    )
    let word29 = BigInt(raw)
    if (params.reservationMinAmount !== undefined) {
      word29 =
        clearField(word29, 160, 64) |
        (BigInt(params.reservationMinAmount) << 160n)
    }
    if (params.reservationTermSeconds !== undefined) {
      word29 =
        clearField(word29, 224, 32) |
        (BigInt(params.reservationTermSeconds) << 224n)
    }
    await ethers.provider.send("hardhat_setStorageAt", [
      executorAddress,
      ethers.toQuantity(29),
      padWordHex(word29),
    ])
  }

  if (
    params.reservationVault !== undefined ||
    params.reservationTxMaxFee !== undefined ||
    params.reservationDissolutionDelay !== undefined
  ) {
    const raw = await ethers.provider.getStorage(
      executorAddress,
      ethers.toQuantity(30)
    )
    let word30 = BigInt(raw)
    if (params.reservationVault !== undefined) {
      word30 =
        clearField(word30, 0, 160) | BigInt(params.reservationVault)
    }
    if (params.reservationTxMaxFee !== undefined) {
      word30 =
        clearField(word30, 160, 64) |
        (BigInt(params.reservationTxMaxFee) << 160n)
    }
    if (params.reservationDissolutionDelay !== undefined) {
      word30 =
        clearField(word30, 224, 32) |
        (BigInt(params.reservationDissolutionDelay) << 224n)
    }
    await ethers.provider.send("hardhat_setStorageAt", [
      executorAddress,
      ethers.toQuantity(30),
      padWordHex(word30),
    ])
  }

  if (
    params.reservationMaxTotalAmount !== undefined ||
    params.reservationTotalAmount !== undefined ||
    params.maxReservationsPerWallet !== undefined
  ) {
    const raw = await ethers.provider.getStorage(
      executorAddress,
      ethers.toQuantity(31)
    )
    let word31 = BigInt(raw)
    if (params.reservationMaxTotalAmount !== undefined) {
      word31 =
        clearField(word31, 0, 64) | BigInt(params.reservationMaxTotalAmount)
    }
    if (params.reservationTotalAmount !== undefined) {
      word31 =
        clearField(word31, 64, 64) |
        (BigInt(params.reservationTotalAmount) << 64n)
    }
    if (params.maxReservationsPerWallet !== undefined) {
      word31 =
        clearField(word31, 128, 32) |
        (BigInt(params.maxReservationsPerWallet) << 128n)
    }
    await ethers.provider.send("hardhat_setStorageAt", [
      executorAddress,
      ethers.toQuantity(31),
      padWordHex(word31),
    ])
  }

  if (
    params.reservationRouter !== undefined ||
    params.reservationActionTimeout !== undefined ||
    params.reservationRenewalWindowSeconds !== undefined
  ) {
    const raw = await ethers.provider.getStorage(
      executorAddress,
      ethers.toQuantity(32)
    )
    let word32 = BigInt(raw)
    if (params.reservationRouter !== undefined) {
      word32 =
        clearField(word32, 0, 160) | BigInt(params.reservationRouter)
    }
    if (params.reservationActionTimeout !== undefined) {
      word32 =
        clearField(word32, 160, 32) |
        (BigInt(params.reservationActionTimeout) << 160n)
    }
    if (params.reservationRenewalWindowSeconds !== undefined) {
      word32 =
        clearField(word32, 192, 32) |
        (BigInt(params.reservationRenewalWindowSeconds) << 192n)
    }
    await ethers.provider.send("hardhat_setStorageAt", [
      executorAddress,
      ethers.toQuantity(32),
      padWordHex(word32),
    ])
  }

  if (
    params.maxReservationsAmountPerWallet !== undefined ||
    params.reservationMaxSingleAmount !== undefined
  ) {
    const raw = await ethers.provider.getStorage(
      executorAddress,
      ethers.toQuantity(33)
    )
    let word33 = BigInt(raw)
    if (params.maxReservationsAmountPerWallet !== undefined) {
      word33 =
        clearField(word33, 0, 64) | BigInt(params.maxReservationsAmountPerWallet)
    }
    if (params.reservationMaxSingleAmount !== undefined) {
      word33 =
        clearField(word33, 64, 64) |
        (BigInt(params.reservationMaxSingleAmount) << 64n)
    }
    await ethers.provider.send("hardhat_setStorageAt", [
      executorAddress,
      ethers.toQuantity(33),
      padWordHex(word33),
    ])
  }

  if (params.maxThirdPartyReanchorHoldsPerWallet !== undefined) {
    const raw = await ethers.provider.getStorage(
      executorAddress,
      ethers.toQuantity(39)
    )
    let word39 = BigInt(raw)
    word39 =
      clearField(word39, 0, 32) |
      (BigInt(params.maxThirdPartyReanchorHoldsPerWallet) & ((1n << 32n) - 1n))
    await ethers.provider.send("hardhat_setStorageAt", [
      executorAddress,
      ethers.toQuantity(39),
      padWordHex(word39),
    ])
  }
}

async function seedDepositWithVault(
  executor: ReservationStrandingExecutor,
  depositKey: string | number | bigint,
  depositor: string,
  amount: number | bigint = 1_000_000,
  revealedAt?: number,
  vault?: string
) {
  await executor.seedDepositBasic(depositKey, depositor)

  const currentRevealedAt =
    revealedAt ??
    Number(await ethers.provider.getBlock("latest").then((b) => b!.timestamp))

  const baseSlot = solidityPackedKeccak256(
    ["uint256", "uint256"],
    [depositKey, 19]
  )

  const word0 =
    BigInt(depositor) |
    (BigInt(amount) << 160n) |
    (BigInt(currentRevealedAt) << 224n)
  await ethers.provider.send("hardhat_setStorageAt", [
    executor.target,
    padWordHex(BigInt(baseSlot) & MAX_UINT256),
    padWordHex(word0),
  ])

  if (vault) {
    const word1 = BigInt(vault)
    await ethers.provider.send("hardhat_setStorageAt", [
      executor.target,
      padWordHex((BigInt(baseSlot) & MAX_UINT256) + 1n),
      padWordHex(word1),
    ])
  }
}

const ZERO_BYTES32 = `0x${"00".repeat(32)}`

describe("Bridge - Reservation Stranding (PR E library coverage)", () => {
  let executor: ReservationStrandingExecutor

  beforeEach(async () => {
    executor = await loadFixture(deployExecutor)
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

      // Sanity check: counters are populated before stranding.
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

      const tx: ContractTransactionResponse = await executor.notifyReservationStranded(
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
      // Anchor outpoint reverse index released.
      const anchorUtxoHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint32"],
        [anchorTxHash, anchorTxOutputIndex]
      )
      expect(await executor.reservationsByAnchorUtxo(anchorUtxoHash)).to.equal(
        0
      )

      // The exact args of the emitted event match the pre-stranding
      // reservation: reservationKey, walletPubKeyHash, owner, anchorAmount.
      const receipt = (await tx.wait())!
      const stranded = receiptEvents(
        receipt,
        executor.interface!,
        "ReservationStranded"
      ).find((e) => e.name === "ReservationStranded")
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
      ).to.be.revertedWith(
        "Wallet is not terminated, closed, or a dissolution-eligible closing wallet"
      )
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

      const tx: ContractTransactionResponse = await executor.notifyReservationStranded(
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
      const anchorUtxoHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint32"],
        [anchorTxHash, anchorTxOutputIndex]
      )
      expect(await executor.reservationsByAnchorUtxo(anchorUtxoHash)).to.equal(
        0
      )

      const receipt = (await tx.wait())!
      const stranded = receiptEvents(
        receipt,
        executor.interface!,
        "ReservationStranded"
      ).find((e) => e.name === "ReservationStranded")
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
      ).to.be.revertedWith(
        "Wallet is not terminated, closed, or a dissolution-eligible closing wallet"
      )
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
      ).to.be.revertedWith(
        "Wallet is not terminated, closed, or a dissolution-eligible closing wallet"
      )
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

      const tx: ContractTransactionResponse = await executor.notifyReservationStranded(
        reservationKey
      )
      const receipt = (await tx.wait())!
      const events = receiptEvents(
        receipt,
        executor.interface!,
        "ReservationStranded"
      )
      // Exactly one recovery evidence is emitted per stranding call.
      expect(events, "ReservationStranded event missing").to.have.lengthOf(1)
    })
  })

  describe("strandReservation (internal, reached via notifyReservationStranded)", () => {
    it("releases capacity across multiple Active reservations", async () => {
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

      expect(await executor.walletReservationsCount(walletPubKeyHash)).to.equal(
        2
      )
      expect(
        await executor.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(anchorAmount * 2)
      expect(await executor.reservationTotalAmount()).to.equal(anchorAmount * 2)

      // Strand the first reservation.
      const tx: ContractTransactionResponse = await executor.notifyReservationStranded(
        reservationA
      )
      expect(await executor.walletReservationsCount(walletPubKeyHash)).to.equal(
        1
      )
      expect(
        await executor.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(anchorAmount)
      expect(await executor.reservationTotalAmount()).to.equal(anchorAmount)
      // The correct reservation was stranded; the other survives untouched.
      const receipt = (await tx.wait())!
      const stranded = receiptEvents(
        receipt,
        executor.interface!,
        "ReservationStranded"
      ).find((e) => e.name === "ReservationStranded")
      expect(stranded, "ReservationStranded event missing").to.not.be.undefined
      expect(stranded!.args!.reservationKey).to.equal(reservationA)
      expect(await executor.reservationState(reservationB)).to.equal(
        reservationStateEnum.Active
      )

      // Strand the second reservation.
      await executor.notifyReservationStranded(reservationB)
      expect(await executor.walletReservationsCount(walletPubKeyHash)).to.equal(
        0
      )
      expect(
        await executor.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(0)
      expect(await executor.reservationTotalAmount()).to.equal(0)
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

      await executor.seedDepositBasic(depositKey, depositor)
      await executor.seedPendingReservedDepositBasic(
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

      await executor.seedDepositBasic(depositKey, depositor)
      await executor.seedPendingReservedDepositBasic(
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

      await executor.seedDepositBasic(depositKey, depositor)
      await executor.seedSweptDeposit(depositKey)
      await executor.seedPendingReservedDepositBasic(
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

      await executor.seedDepositBasic(depositKey, depositor)
      // Far-future deadline so the elapsed check fails deterministically.
      await executor.seedPendingReservedDepositBasic(
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

      await executor.seedDepositBasic(depositKey, depositor)
      await executor.seedPendingReservedDepositBasic(
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

      await executor.seedDepositBasic(depositKeyA, depositor)
      await executor.seedPendingReservedDepositBasic(
        depositKeyA,
        walletPubKeyHash,
        elapsedDeadline,
        false
      )
      await executor.seedDepositBasic(depositKeyB, depositor)
      await executor.seedPendingReservedDepositBasic(
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

      const tx = await executor.notifyReservationActionTimeout(reservationKey)
      const receipt = (await tx.wait())!

      const reanchorTimedOut = receiptEvents(
        receipt,
        executor.interface!,
        "ReservationReanchorTimedOut"
      )
      expect(reanchorTimedOut).to.have.lengthOf(1)
      expect(reanchorTimedOut[0].args.reservationKey).to.equal(reservationKey)
      expect(reanchorTimedOut[0].args.requestNonce).to.equal(0)

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
        executor.notifyReservationActionTimeout(reservationKey)
      ).to.be.revertedWith("Action has not timed out")
    })

    it("releases target wallet capacity on Reanchor timeout even after the reservation is dissolution-eligible", async () => {
      // Confirms that the timeout path is not gated by dissolutionEligibleAt,
      // mirroring the removal of that gate from requestReservationReanchor.
      const sourceWallet = `0x${"c1".repeat(20)}` as `0x${string}`
      const targetWallet = `0x${"c2".repeat(20)}` as `0x${string}`
      const reservationKey = 5
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

      // Seed a second reservation directly on the target wallet to give it
      // pre-existing reserved capacity to release.
      await executor.seedReservation(
        6,
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

      // Seed the reanchor action for reservationKey 5 to targetWallet.
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

      // Time travel past both dissolutionEligibleAt and timeoutAt.
      await ethers.provider.send("evm_increaseTime", [400 * 86400])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.notifyReservationActionTimeout(reservationKey)
      const receipt = (await tx.wait())!

      const reanchorTimedOut = receiptEvents(
        receipt,
        executor.interface!,
        "ReservationReanchorTimedOut"
      )
      expect(reanchorTimedOut).to.have.lengthOf(1)
      expect(reanchorTimedOut[0].args.reservationKey).to.equal(reservationKey)
      expect(reanchorTimedOut[0].args.requestNonce).to.equal(0)

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
      reservationInterface = new ethers.Interface(reservationArtifact.abi)

      await setReservationConfig(executor.target as string, {
        reservationTxMaxFee: txMaxFee,
        reservationActionTimeout: actionTimeout,
        maxReservationsPerWallet: maxPerWallet,
        maxReservationsAmountPerWallet: maxAmountPerWallet,
        // The unprivileged (third-party) re-anchor paths exercised below
        // count against the per-target third-party hold cap; the storage
        // default is 0, which would block every one of them before the
        // count/amount caps they exist to probe. 1 headroom lets them
        // reach the checks they target.
        maxThirdPartyReanchorHoldsPerWallet: 1,
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
        false,
        [],
        0
      )
      const receipt = (await tx.wait())!

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
        false,
        [],
        0
      )
      const receipt = (await tx.wait())!

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
        true,
        [],
        0
      )
      const receipt = (await tx.wait())!

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
        false,
        [],
        0
        )
      ).to.be.revertedWith("Reservation is not active")
    })

    it("succeeds when reservation is dissolution-eligible (re-anchor is unbounded in time per m1-b-implementation.md §4.4)", async () => {
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

      // Time travel past dissolutionEligibleAt (365 + 30 days). Variant B
      // deletes the dissolution-eligibility timing gate on re-anchor, so
      // this must still succeed.
      await ethers.provider.send("evm_increaseTime", [400 * 86400])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.requestReservationReanchor(
        pastEligibleKey,
        targetWallet,
        false,
        [],
        0
      )
      const receipt = (await tx.wait())!

      expect(await executor.reservationState(pastEligibleKey)).to.equal(
        reservationStateEnum.ActionPending
      )
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(1)
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(
        anchorAmount
      )
      expect(await executor.actionState(pastEligibleKey, 1)).to.equal(
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
      expect(requested!.args.reservationKey).to.equal(pastEligibleKey)
      expect(requested!.args.requestNonce).to.equal(1)
      expect(requested!.args.sourceWalletPubKeyHash).to.equal(sourceWallet)
      expect(requested!.args.targetWalletPubKeyHash).to.equal(targetWallet)
      expect(requested!.args.txMaxFee).to.equal(txMaxFee)
    })

    it("succeeds with re-anchor unbounded far into the future (10 years past dissolution eligibility)", async () => {
      const farFutureKey = `0x${"ad".repeat(32)}`
      await executor.seedReservation(
        farFutureKey,
        owner,
        sourceWallet,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      // Time travel 10 years past dissolutionEligibleAt. Proves re-anchor
      // is unbounded by time, not just past one arbitrary boundary.
      await ethers.provider.send("evm_increaseTime", [3650 * 86400])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.requestReservationReanchor(
        farFutureKey,
        targetWallet,
        false,
        [],
        0
      )
      const receipt = (await tx.wait())!

      expect(await executor.reservationState(farFutureKey)).to.equal(
        reservationStateEnum.ActionPending
      )
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(1)
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(
        anchorAmount
      )
      expect(await executor.actionState(farFutureKey, 1)).to.equal(
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
      expect(requested!.args.reservationKey).to.equal(farFutureKey)
      expect(requested!.args.requestNonce).to.equal(1)
      expect(requested!.args.sourceWalletPubKeyHash).to.equal(sourceWallet)
      expect(requested!.args.targetWalletPubKeyHash).to.equal(targetWallet)
      expect(requested!.args.txMaxFee).to.equal(txMaxFee)
    })

    it("succeeds when reservation is dissolution-eligible and source wallet is Live with a privileged caller", async () => {
      const pastEligibleKey = `0x${"ae".repeat(32)}`
      await executor.seedWallet(
        sourceWallet,
        ZERO_BYTES32,
        walletStateEnum.Live
      )
      await executor.seedReservation(
        pastEligibleKey,
        owner,
        sourceWallet,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      // Time travel past dissolutionEligibleAt (365 + 30 days).
      await ethers.provider.send("evm_increaseTime", [400 * 86400])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.requestReservationReanchor(
        pastEligibleKey,
        targetWallet,
        true,
        [],
        0
      )
      const receipt = (await tx.wait())!

      expect(await executor.reservationState(pastEligibleKey)).to.equal(
        reservationStateEnum.ActionPending
      )
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(1)
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(
        anchorAmount
      )
      expect(await executor.actionState(pastEligibleKey, 1)).to.equal(
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
      expect(requested!.args.reservationKey).to.equal(pastEligibleKey)
      expect(requested!.args.requestNonce).to.equal(1)
      expect(requested!.args.sourceWalletPubKeyHash).to.equal(sourceWallet)
      expect(requested!.args.targetWalletPubKeyHash).to.equal(targetWallet)
      expect(requested!.args.txMaxFee).to.equal(txMaxFee)
    })

    it("succeeds when reservation is dissolution-eligible and source wallet is Closing", async () => {
      const pastEligibleKey = `0x${"af".repeat(32)}`
      await executor.seedWallet(
        sourceWallet,
        ZERO_BYTES32,
        walletStateEnum.Closing
      )
      await executor.seedReservation(
        pastEligibleKey,
        owner,
        sourceWallet,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      // Time travel past dissolutionEligibleAt (365 + 30 days).
      await ethers.provider.send("evm_increaseTime", [400 * 86400])
      await ethers.provider.send("evm_mine", [])

      const tx = await executor.requestReservationReanchor(
        pastEligibleKey,
        targetWallet,
        false,
        [],
        0
      )
      const receipt = (await tx.wait())!

      expect(await executor.reservationState(pastEligibleKey)).to.equal(
        reservationStateEnum.ActionPending
      )
      expect(await executor.walletReservationsCount(targetWallet)).to.equal(1)
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(
        anchorAmount
      )
      expect(await executor.actionState(pastEligibleKey, 1)).to.equal(
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
      expect(requested!.args.reservationKey).to.equal(pastEligibleKey)
      expect(requested!.args.requestNonce).to.equal(1)
      expect(requested!.args.sourceWalletPubKeyHash).to.equal(sourceWallet)
      expect(requested!.args.targetWalletPubKeyHash).to.equal(targetWallet)
      expect(requested!.args.txMaxFee).to.equal(txMaxFee)
    })
    it("rejects when reanchor cooldown is in effect", async () => {
      const cooldownKey = `0x${"b0".repeat(32)}`
      await executor.seedReservation(
        cooldownKey,
        owner,
        sourceWallet,
        anchorAmount,
        anchorTxHash,
        anchorTxOutputIndex,
        reservationStateEnum.Active
      )

      // Time travel past dissolutionEligibleAt first, then set the cooldown
      // to a timestamp still in the future relative to the new block time,
      // so the cooldown genuinely outlives the dissolution-eligibility
      // boundary instead of expiring before the call under test.
      await ethers.provider.send("evm_increaseTime", [400 * 86400])
      await ethers.provider.send("evm_mine", [])

      const futureTimestamp =
        Number(
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp)
        ) + 1000
      await executor.seedReservationCooldown(cooldownKey, futureTimestamp)

      await expect(
        executor.requestReservationReanchor(cooldownKey, targetWallet, false, [], 0)
      ).to.be.revertedWith("Reanchor cooldown in effect")
    })

    it("rejects when source wallet is Live and call is not privileged", async () => {
      await executor.seedWallet(
        sourceWallet,
        ZERO_BYTES32,
        walletStateEnum.Live
      )

      await expect(
        executor.requestReservationReanchor(reservationKey, targetWallet, false, [], 0)
      ).to.be.revertedWith("Only governance can rotate a Live wallet's anchor")
    })

    it("rejects when source wallet is not in Live, MovingFunds, or Closing state", async () => {
      await executor.seedWallet(
        sourceWallet,
        ZERO_BYTES32,
        walletStateEnum.Closed
      )

      await expect(
        executor.requestReservationReanchor(reservationKey, targetWallet, false, [], 0)
      ).to.be.revertedWith(
        "Source wallet must be in MovingFunds or Closing state"
      )
    })

    it("rejects when target wallet is the same as source wallet", async () => {
      await expect(
        executor.requestReservationReanchor(reservationKey, sourceWallet, false, [], 0)
      ).to.be.revertedWith("Target wallet must differ from the source wallet")
    })

    it("rejects when target wallet is not in Live state", async () => {
      await executor.seedWallet(
        targetWallet,
        ZERO_BYTES32,
        walletStateEnum.MovingFunds
      )

      await expect(
        executor.requestReservationReanchor(reservationKey, targetWallet, false, [], 0)
      ).to.be.revertedWith("Target wallet must be in Live state")
    })

    it("rejects when target wallet reservation count cap is exceeded", async () => {
      await setReservationConfig(executor.target as string, {
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
        executor.requestReservationReanchor(reservationKey, targetWallet, false, [], 0)
      ).to.be.revertedWith("Wallet reservations cap exceeded")
    })

    it("rejects a re-anchor whose anchor is exactly the min amount plus tx fee floor", async () => {
      // Request-time floor is `anchorAmount > txMaxFee + minAmount`
      // (Reservation.sol, "Reanchor would fall below the minimum
      // reservation amount"). Pin `minAmount` so the fixture's anchor sits
      // exactly ON that floor: the strict `>` must refuse it, leaving the
      // anchor no room for the next hop's miner fee.
      await executor.setReservationMinAmount(anchorAmount - txMaxFee)

      await expect(
        executor.requestReservationReanchor(
          reservationKey,
          targetWallet,
          false,
          [],
          0
        )
      ).to.be.revertedWith(
        "Reanchor would fall below the minimum reservation amount"
      )
    })

    it("rejects a governance re-anchor of a Live wallet whose anchor is exactly the floor", async () => {
      // Same boundary, reached through the governance-discriminated
      // (`privileged`) path off a Live source, so the floor is the only
      // thing that can refuse the request.
      await executor.setReservationMinAmount(anchorAmount - txMaxFee)
      await executor.seedWallet(
        sourceWallet,
        ZERO_BYTES32,
        walletStateEnum.Live
      )

      await expect(
        executor.requestReservationReanchor(
          reservationKey,
          targetWallet,
          true,
          [],
          0
        )
      ).to.be.revertedWith(
        "Reanchor would fall below the minimum reservation amount"
      )
    })

    it("accepts a re-anchor one satoshi above the min amount plus tx fee floor", async () => {
      // Boundary counterpart: exactly one satoshi of headroom clears the
      // floor, so a `>=` variant of the guard cannot pass this test.
      await executor.setReservationMinAmount(anchorAmount - txMaxFee - 1)

      await executor.requestReservationReanchor(
        reservationKey,
        targetWallet,
        false,
        [],
        0
      )

      expect(await executor.reservationState(reservationKey)).to.equal(
        reservationStateEnum.ActionPending
      )
      expect(await executor.walletReservationsAmount(targetWallet)).to.equal(
        anchorAmount
      )
    })

    it("rejects when target wallet reserved amount cap is exceeded", async () => {
      await setReservationConfig(executor.target as string, {
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
        executor.requestReservationReanchor(reservationKey, targetWallet, false, [], 0)
      ).to.be.revertedWith("Wallet reserved amount cap exceeded")
    })
  })
})
