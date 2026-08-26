/**
 * Adversarial coverage for two termination-adjacent stranding paths that
 * have zero historical coverage in tbtc-v2 PR #1104 (refs/pull/1104/head @
 * 1a636939) and were not ported into `Bridge.ReservationSettlement.test.ts`
 * (PR G of the m1 UTXO-reservations milestone): `notifyReservationStranded`
 * and `notifyStaleReservedDeposit`. Both live on `Reservation.sol`
 * (`/tmp/m1-g/solidity/contracts/bridge/Reservation.sol`):
 *   - `notifyReservationStranded`    -> lines 901-920 (with
 *     `strandReservation` at 1123-1162 and the `ReservationStranded` event
 *     at 305-310)
 *   - `notifyStaleReservedDeposit`   -> lines 850-883 (with the
 *     `ReservedDepositMarkedStale` event at 304)
 *
 * Scope (m1, PR G, `m1/bridge-integration-seams`):
 *   - `notifyReservationStranded` happy path: Active reservation on
 *     Terminated wallet strands correctly. State transitions to Stranded.
 *     The four reserved-capacity counters decrement by the right amount.
 *     The `ReservationStranded` event fires with the exact args.
 *   - Rejects when the reservation is not Active (already Stranded after
 *     a previous call; Unknown after a reveal without an acceptance
 *     request).
 *   - Rejects when the wallet is not Terminated (Live, MovingFunds).
 *   - `notifyStaleReservedDeposit` happy path with `refundDeadlineValidated
 *     = false` (the disabled-validation path the contract comment calls
 *     out explicitly): succeeds without time travel.
 *   - `notifyStaleReservedDeposit` happy path with `refundDeadlineValidated
 *     = true` (the standard reveal-ahead-enabled path): succeeds once the
 *     refund deadline has elapsed.
 *   - Rejects when the deposit key is unknown
 *     ("Not a pending reserved deposit").
 *   - Rejects when the refund deadline has not yet elapsed
 *     (`refundDeadlineValidated = true`).
 *   - Rejects when an acceptance authorization is still pending
 *     (`ActionState.Pending`).
 *
 * The fixture mirrors `Bridge.ReservationSettlement.test.ts` exactly so
 * the test runs against the same deployed bridge/reservation-router pair;
 * `bridge.setWallet(pkh, {...})` is the established test-only state
 * injection path (`BridgeStub` exposes direct storage writes), so
 * terminating a wallet here is a one-call stub operation - the real
 * seize/closing flow is out of scope and intentionally not exercised.
 *
 * Pruned (out of m1 scope per roadmap.md §0.7): redemption, dissolution,
 * renewal, watchtower veto, and any MaintainerProxyV2 path. None of those
 * are referenced here.
 *
 * Storage reads: `BridgeState` storage is private to the bridge contract,
 * so its `pendingReservedDeposit`/`reservationsByAnchorUtxo`/etc. mappings
 * do not have auto-generated getters. The verifiable counters and
 * reservation struct live on `ReservationRouter` (callable through
 * `bridge.fallback()`); the wallet state lives behind `Bridge.wallets(pkh)`
 * and the underlying deposit behind `Bridge.deposits(depositKey)`. This
 * file sticks to those public surfaces.
 *
 * Note on the `evidenceAlreadyEmitted` branch of `strandReservation`: the
 * external `state == ReservationState.Active` guard in
 * `notifyReservationStranded` rejects a second call against an already
 * Stranded reservation with "Reservation is not active", so the
 * idempotent-evidence short-circuit inside `strandReservation` is not
 * reachable through the external API in current source. The "already
 * Stranded" rejection test below is the externally-observable
 * idempotence; the internal branch is a defensive guard against a future
 * code path that calls `strandReservation` directly.
 */
/* eslint-disable @typescript-eslint/no-unused-expressions */

// Stranding tests for `notifyReservationStranded` and
// `notifyStaleReservedDeposit`.

import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, Contract } from "ethers"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import type {
  Bank,
  BankStub,
  Bridge,
  BridgeStub,
  IWalletRegistry,
  IRelay,
  ReimbursementPool,
  ReservationRouter,
  ReservationVault,
  TBTCVault,
  TBTC,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { walletState } from "../fixtures"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

const ZERO_BYTES32 = ethers.constants.HashZero

const RESERVATION_TERM = 31536000 // 365 days
const RESERVATION_GRACE = 2592000 // 30 days
const RESERVATION_MIN_AMOUNT = 10000
const RESERVATION_TX_MAX_FEE = 2000
// `deploy/97_set_reservation_parameters.ts` already runs as part of
// `deployments.fixture()` and sets real caps (reservationMaxSingleAmount
// 100,000, maxActiveReservations 100), unlike a pristine caps-never-set
// bridge. The relational check
// (`reservationMaxTotalAmount <= maxActiveReservations *
// reservationMaxSingleAmount`) is live from that deploy step onward, so
// RESERVATION_MAX_TOTAL must fit under 100 * 100,000 = 10,000,000.
const RESERVATION_MAX_TOTAL = BigNumber.from("10000000")
const MAX_RESERVATIONS_PER_WALLET = 10
const RESERVATION_ACTION_TIMEOUT = 172800 // 48 hours
const RESERVATION_RENEWAL_WINDOW = 2592000 // 30 days

const SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)

const ReservationState = {
  Unknown: 0,
  Active: 1,
  ActionPending: 2,
  Closed: 3,
  Stranded: 4,
}

const ActionType = {
  None: 0,
  Acceptance: 1,
  Redemption: 2,
  Reanchor: 3,
  Dissolution: 4,
}

const ActionState = {
  Unknown: 0,
  Pending: 1,
  Settled: 2,
  TimedOut: 3,
  Vetoed: 4,
  Superseded: 5,
}

const ProofType = {
  Acceptance: 0,
  Redemption: 1,
  Reanchor: 2,
  Dissolution: 3,
}

describe("Bridge - Reservation stranding", () => {
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let deployer: SignerWithAddress

  let bank: Bank & BankStub
  let relay: FakeContract<IRelay>
  let walletRegistry: FakeContract<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let reservationRouter: ReservationRouter
  let reimbursementPool: ReimbursementPool
  let tbtc: TBTC & Contract
  let tbtcVault: TBTCVault & Contract
  let reservationVault: ReservationVault
  let bridgeGovernanceSigner: SignerWithAddress

  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const secondWalletPubKeyHash = "0xafcdf88d15a0e0c2134dbbc9f6da24d0e26c8f21"
  const blindingFactor = "0xf9f0c90d00039523"
  const refundPubKeyHash = "0x28e081f285138ccbe389c1eb8985716230129f89"
  let refundLocktime: string
  const NO_MAIN_UTXO_PARAM = {
    txHash: ZERO_BYTES32,
    txOutputIndex: 0,
    txOutputValue: 0,
  }

  const depositAmount = BigNumber.from(3000000)
  const anchorFee = 1500
  const anchorAmount = depositAmount.sub(anchorFee)
  const grossTbtc = anchorAmount.mul(SATOSHI_MULTIPLIER)

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      spvMaintainer,
      thirdParty,
      bank,
      relay,
      walletRegistry,
      bridge,
      reimbursementPool,
      tbtc,
      tbtcVault,
    } = await waffle.loadFixture(bridgeFixture))

    // Reservation router functions (`updateReservationParameters`,
    // `requestReservation*`, `submitReservationProof`, etc.) are declared
    // on `ReservationRouter`, not `Bridge`. Per `ReservationRouter.sol`
    // invariant 3 ("no standalone authority"), every one of them is only
    // reachable through `Bridge.fallback()`'s delegatecall - calling the
    // router's own deployed address directly executes against its own
    // empty storage. `ethers.getContractAt` with the router's ABI but
    // Bridge's address gives correctly-encoded calls that land on
    // `Bridge.fallback()`, exactly like the production caller path.
    reservationRouter = await ethers.getContractAt(
      "ReservationRouter",
      bridge.address
    )
    reservationVault = await helpers.contracts.getContract("ReservationVault")
    bridgeGovernanceSigner = await impersonateContract(
      await bridge.governance()
    )
    refundLocktime = `0x${toLE(
      (await lastBlockTime()) + 4000 * 24 * 60 * 60,
      4
    )}`

    await bridge
      .connect(bridgeGovernanceSigner)
      .setVaultStatus(reservationVault.address, true)
    // `deploy/97_set_reservation_parameters.ts` already set
    // `reservationMaxSingleAmount` to 100,000 as part of the fixture, but
    // this fixture's anchor is 2,998,500 sat - well over that single-
    // reservation cap (Reservation.sol:540-544, "Reservation exceeds the
    // single-reservation cap"). Raise it with headroom before creating any
    // reservation.
    await reservationRouter
      .connect(bridgeGovernanceSigner)
      .updateReservationCaps(RESERVATION_MAX_TOTAL, RESERVATION_MAX_TOTAL, 100)
    await reservationRouter
      .connect(bridgeGovernanceSigner)
      .updateReservationParameters(
        reservationVault.address,
        RESERVATION_MIN_AMOUNT,
        RESERVATION_TX_MAX_FEE,
        RESERVATION_TERM,
        RESERVATION_GRACE,
        RESERVATION_MAX_TOTAL,
        MAX_RESERVATIONS_PER_WALLET,
        RESERVATION_ACTION_TIMEOUT,
        RESERVATION_RENEWAL_WINDOW
      )

    relay.getCurrentEpochDifficulty.returns(0)
    relay.getPrevEpochDifficulty.returns(0)

    await bridge.setDepositDustThreshold(10000)
    await bridge.setDepositTxMaxFee(2000)
    await bridge.setDepositRevealAheadPeriod(0)
    await liveWallet(walletPubKeyHash)

    const tbtcOwner = await impersonateContract(await tbtc.owner())
    await tbtc.connect(tbtcOwner).transferOwnership(tbtcVault.address)
  })

  async function impersonateContract(
    address: string
  ): Promise<SignerWithAddress> {
    await ethers.provider.send("hardhat_impersonateAccount", [address])
    await ethers.provider.send("hardhat_setBalance", [
      address,
      "0x8AC7230489E80000",
    ])
    return ethers.getSigner(address)
  }

  async function liveWallet(pkh: string) {
    await bridge.setWallet(pkh, {
      ecdsaWalletID: ethers.utils.randomBytes(32),
      mainUtxoHash: ZERO_BYTES32,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: ZERO_BYTES32,
    })
  }

  // Test-only direct-state-injection helper. The BridgeStub exposes
  // `setWallet(pkh, wallet)` so we can install a Terminated wallet
  // without driving the real seize/closing flow (out of scope for the
  // stranding tests; we only need the wallet in the right state to
  // exercise `notifyReservationStranded`'s guards and the
  // `strandReservation` accounting transition).
  async function terminatedWallet(pkh: string) {
    await bridge.setWallet(pkh, {
      ecdsaWalletID: ethers.utils.randomBytes(32),
      mainUtxoHash: ZERO_BYTES32,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Terminated,
      movingFundsTargetWalletsCommitmentHash: ZERO_BYTES32,
    })
  }

  // Install a MovingFunds wallet - one of the two non-Terminated,
  // non-Live states `notifyReservationStranded` must reject.
  async function movingFundsWallet(pkh: string) {
    await bridge.setWallet(pkh, {
      ecdsaWalletID: ethers.utils.randomBytes(32),
      mainUtxoHash: ZERO_BYTES32,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.MovingFunds,
      movingFundsTargetWalletsCommitmentHash: ZERO_BYTES32,
    })
  }

  // ---- Bitcoin fixture crafting (regtest-style difficulty) ----

  const REGTEST_BITS_LE = "ffff7f20"
  const REGTEST_TARGET = BigNumber.from("0x7fffff").mul(
    BigNumber.from(2).pow(8 * (0x20 - 3))
  )

  const reverseHex = (hex: string): string =>
    hex.replace(/^0x/, "").match(/../g)!.reverse().join("")

  const hash256 = (hexData: string): string =>
    ethers.utils.sha256(ethers.utils.sha256(hexData))

  const toLE = (value: number | BigNumber, byteLength: number): string =>
    reverseHex(
      BigNumber.from(value)
        .toHexString()
        .slice(2)
        .padStart(byteLength * 2, "0")
    )

  const compactSize = (n: number): string => {
    if (n >= 0xfd) {
      throw new Error("compactSize > 252 not supported in fixtures")
    }
    return n.toString(16).padStart(2, "0")
  }

  function buildTx(
    inputs: { txHash: string; index: number }[],
    outputs: { valueSat: BigNumber | number; script: string }[]
  ) {
    const inputVector = `0x${compactSize(inputs.length)}${inputs
      .map((i) => `${i.txHash.slice(2)}${toLE(i.index, 4)}00ffffffff`)
      .join("")}`
    const outputVector = `0x${compactSize(outputs.length)}${outputs
      .map(
        (o) =>
          `${toLE(BigNumber.from(o.valueSat), 8)}${compactSize(
            o.script.length / 2
          )}${o.script}`
      )
      .join("")}`
    const info = {
      version: "0x01000000",
      inputVector,
      outputVector,
      locktime: "0x00000000",
    }
    const txHash = hash256(
      `0x01000000${inputVector.slice(2)}${outputVector.slice(2)}00000000`
    )
    return { info, txHash }
  }

  function mineHeader(merkleRoot: string): string {
    const prevBlock = ethers.utils
      .hexlify(ethers.utils.randomBytes(32))
      .slice(2)
    const base = `20000000${prevBlock}${merkleRoot.slice(
      2
    )}662a2c68${REGTEST_BITS_LE}`
    for (let nonce = 0; ; nonce++) {
      const header = `0x${base}${toLE(nonce, 4)}`
      if (
        BigNumber.from(`0x${reverseHex(hash256(header))}`).lte(REGTEST_TARGET)
      ) {
        return header
      }
    }
  }

  function proofFor(txHash: string) {
    const coinbasePreimage = ethers.utils.sha256(ethers.utils.randomBytes(32))
    const coinbaseTxId = ethers.utils.sha256(coinbasePreimage)
    const merkleRoot = hash256(`0x${coinbaseTxId.slice(2)}${txHash.slice(2)}`)
    return {
      merkleProof: coinbaseTxId,
      txIndexInBlock: 1,
      bitcoinHeaders: mineHeader(merkleRoot),
      coinbasePreimage,
      coinbaseProof: txHash,
    }
  }

  const buildDepositScript = (
    depositor: string,
    blinding: string,
    walletPkh: string,
    refundPkh: string,
    locktime: string
  ): string =>
    `14${depositor.slice(2)}7508${blinding.slice(2)}7576a914${walletPkh
      .slice(2)
      .toLowerCase()}8763ac6776a914${refundPkh.slice(2)}8804${locktime.slice(
      2
    )}b175ac68`

  const p2wshScript = (script: string): string =>
    `0020${ethers.utils.sha256(`0x${script}`).slice(2)}`

  const p2wpkhScript = (pkh: string): string => `0014${pkh.slice(2)}`

  const randomRedeemerScript = (): string =>
    `0x16${p2wpkhScript(ethers.utils.hexlify(ethers.utils.randomBytes(20)))}`

  // Reveals a single fresh reserved deposit to the bridge. Does NOT
  // request acceptance. After this returns:
  //   - `pendingReservedDeposit[depositKey]` is populated (refundDeadline
  //     set, refundDeadlineValidated reflects the current
  //     `depositRevealAheadPeriod`).
  //   - `reservations[depositKey].state == Unknown`, `requestNonce == 0`
  //     and no action exists for any generation.
  // This is the right starting point for `notifyStaleReservedDeposit` -
  // any acceptance request would put a `Pending` action on the position
  // and immediately bounce off that guard.
  async function revealReservedDeposit(custodian = walletPubKeyHash) {
    const fundingTx = buildTx(
      [
        {
          txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
          index: 0,
        },
      ],
      [
        {
          valueSat: depositAmount,
          script: p2wshScript(
            buildDepositScript(
              thirdParty.address,
              blindingFactor,
              custodian,
              refundPubKeyHash,
              refundLocktime
            )
          ),
        },
      ]
    )

    await bridge.connect(thirdParty).revealDeposit(fundingTx.info, {
      fundingOutputIndex: 0,
      blindingFactor,
      walletPubKeyHash: custodian,
      refundPubKeyHash,
      refundLocktime,
      vault: reservationVault.address,
    })

    const depositKey = BigNumber.from(
      ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [fundingTx.txHash, 0]
      )
    )

    return { fundingTx, depositKey }
  }

  // Reveals a fresh reserved deposit and requests acceptance (generation 1).
  // After this returns:
  //   - `pendingReservedDeposit[depositKey]` is populated.
  //   - `reservations[depositKey].state == Unknown`,
  //     `requestNonce == 1` (set inside `requestReservationAcceptance`),
  //     action at generation 1 in `ActionState.Pending`.
  async function makeRequestedReservation(custodian = walletPubKeyHash) {
    const { fundingTx, depositKey } = await revealReservedDeposit(custodian)

    await reservationRouter
      .connect(thirdParty)
      .requestReservationAcceptance(depositKey, custodian)

    const anchorTx = buildTx(
      [{ txHash: fundingTx.txHash, index: 0 }],
      [{ valueSat: anchorAmount, script: p2wpkhScript(custodian) }]
    )

    return { fundingTx, anchorTx, depositKey, reservationKey: depositKey }
  }

  // Reveals a fresh reserved deposit, requests acceptance (generation 1)
  // and proves the anchor. The reservation is now Active, all four
  // counters are populated.
  async function makeAcceptedReservation(custodian = walletPubKeyHash) {
    const { fundingTx, anchorTx, depositKey, reservationKey } =
      await makeRequestedReservation(custodian)

    await reservationRouter
      .connect(spvMaintainer)
      .submitReservationProof(
        ProofType.Acceptance,
        anchorTx.info,
        proofFor(anchorTx.txHash),
        NO_MAIN_UTXO_PARAM,
        reservationKey,
        1
      )

    return { fundingTx, anchorTx, depositKey, reservationKey }
  }

  // Snapshot the stranding-relevant counters straight off the router
  // (they are exposed by `ReservationRouter`; `BridgeState`'s library
  // storage has no public getter of its own). `activeReservationsCount`
  // returns a `[count, maxActive]` tuple in this router's ABI.
  async function readStrandingGlobals() {
    const active = await reservationRouter.activeReservationsCount()
    return {
      activeCount: active.count,
      walletCount: await reservationRouter.walletReservationsCount(
        walletPubKeyHash
      ),
      walletAmount: await reservationRouter.walletReservationsAmount(
        walletPubKeyHash
      ),
    }
  }

  describe("notifyReservationStranded", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("strands an Active reservation on a Terminated wallet: state transition, counter decrement, and event with exact args", async () => {
      const { reservationKey } = await makeAcceptedReservation()

      const before = await readStrandingGlobals()
      expect(before.activeCount).to.equal(1)
      expect(before.walletCount).to.equal(1)
      expect(before.walletAmount).to.equal(anchorAmount)

      await terminatedWallet(walletPubKeyHash)

      await expect(reservationRouter.notifyReservationStranded(reservationKey))
        .to.emit(reservationRouter, "ReservationStranded")
        .withArgs(
          reservationKey,
          walletPubKeyHash,
          thirdParty.address,
          anchorAmount
        )

      const reservation = await reservationRouter.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Stranded)
      expect(reservation.anchorAmount).to.equal(anchorAmount)

      const after = await readStrandingGlobals()
      expect(after.activeCount).to.equal(before.activeCount - 1)
      expect(after.walletCount).to.equal(before.walletCount - 1)
      expect(after.walletAmount).to.equal(before.walletAmount.sub(anchorAmount))
    })

    it("rejects a second stranding call after a successful strand (state is no longer Active)", async () => {
      const { reservationKey } = await makeAcceptedReservation()
      await terminatedWallet(walletPubKeyHash)

      await reservationRouter.notifyReservationStranded(reservationKey)

      await expect(
        reservationRouter.notifyReservationStranded(reservationKey)
      ).to.be.revertedWith("Reservation is not active")
    })

    it("rejects when the reservation has not been accepted yet (Unknown state)", async () => {
      // `requestReservationAcceptance` increments `requestNonce` to 1 and
      // creates a Pending action, but the `ReservationRequest.state` field
      // itself stays at `Unknown` (only `submitReservationProof` advances
      // it to Active). That is the cleanest non-Active, non-Stranded
      // rejection path - no acceptance proof means there is no anchor to
      // strand.
      const { reservationKey } = await makeRequestedReservation()
      await terminatedWallet(walletPubKeyHash)

      const reservation = await reservationRouter.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Unknown)

      await expect(
        reservationRouter.notifyReservationStranded(reservationKey)
      ).to.be.revertedWith("Reservation is not active")
    })

    it("rejects when the wallet is Live", async () => {
      const { reservationKey } = await makeAcceptedReservation()

      const wallet = await bridge.wallets(walletPubKeyHash)
      expect(wallet.state).to.equal(walletState.Live)

      await expect(
        reservationRouter.notifyReservationStranded(reservationKey)
      ).to.be.revertedWith("Wallet is not terminated")
    })

    it("rejects when the wallet is in MovingFunds", async () => {
      const { reservationKey } = await makeAcceptedReservation()
      await movingFundsWallet(walletPubKeyHash)

      const wallet = await bridge.wallets(walletPubKeyHash)
      expect(wallet.state).to.equal(walletState.MovingFunds)

      await expect(
        reservationRouter.notifyReservationStranded(reservationKey)
      ).to.be.revertedWith("Wallet is not terminated")
    })
  })

  describe("notifyStaleReservedDeposit", () => {
    beforeEach(async () => {
      await createSnapshot()
      // Default `depositRevealAheadPeriod` is 0 (set in `before`).
      // Reset it back to 0 after any per-test override so each test
      // starts with the same reveal-ahead configuration the fixture
      // establishes.
      await bridge.setDepositRevealAheadPeriod(0)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("marks a pending reserved deposit stale immediately when refundDeadlineValidated is false (reveal-ahead disabled)", async () => {
      // Default fixture state: `bridge.setDepositRevealAheadPeriod(0)`
      // in `before` means `refundDeadlineValidated = false` for any
      // reserved deposit revealed here. The contract comment on
      // `notifyStaleReservedDeposit` calls this out: with reveal-ahead
      // validation disabled at reveal, the deposit can be marked stale
      // immediately, matching the disabled protection.
      //
      // We must NOT call `requestReservationAcceptance` here - that would
      // park a Pending action on the position and bounce the call off
      // the acceptance-authorization guard. A bare reveal is the right
      // starting state.
      const { depositKey } = await revealReservedDeposit()

      expect(await reservationRouter.pendingReservedDeposits()).to.equal(1)

      await expect(reservationRouter.notifyStaleReservedDeposit(depositKey))
        .to.emit(reservationRouter, "ReservedDepositMarkedStale")
        .withArgs(depositKey)

      expect(await reservationRouter.pendingReservedDeposits()).to.equal(0)
    })

    it("rejects when the deposit key is not a pending reserved deposit", async () => {
      const unknownKey = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [ethers.utils.hexlify(ethers.utils.randomBytes(32)), 0]
      )

      expect(await reservationRouter.pendingReservedDeposits()).to.equal(0)

      await expect(
        reservationRouter.notifyStaleReservedDeposit(unknownKey)
      ).to.be.revertedWith("Not a pending reserved deposit")
    })

    it("rejects when the refund deadline has not yet elapsed (reveal-ahead enabled, validated=true)", async () => {
      // Switch to a reveal-ahead-enabled regime so a fresh reserved
      // deposit emerges with `refundDeadlineValidated = true`. Then
      // call immediately - the deadline is in the future, the
      // contract must reject.
      //
      // We still use `revealReservedDeposit` (no acceptance request) so
      // the call does not bounce off the acceptance-pending guard first.
      // The refund-deadline check fires before that one in the source.
      await bridge.setDepositRevealAheadPeriod(3600)
      const { depositKey } = await revealReservedDeposit()

      expect(await reservationRouter.pendingReservedDeposits()).to.equal(1)
      const deposit = await bridge.deposits(depositKey)
      expect(deposit.sweptAt).to.equal(0)

      await expect(
        reservationRouter.notifyStaleReservedDeposit(depositKey)
      ).to.be.revertedWith("Deposit refund deadline has not elapsed")
    })

    it("succeeds when the refund deadline has elapsed (reveal-ahead enabled, validated=true)", async () => {
      await bridge.setDepositRevealAheadPeriod(3600)
      const { depositKey } = await revealReservedDeposit()

      // The deposit's refundLocktime was baked in 4000 days from
      // fixture setup. Going forward by (refundLocktime - now + 1)
      // is the simplest deterministic time travel that lands us past
      // both the reveal-ahead period AND the deposit's refund deadline.
      const targetTime = (await lastBlockTime()) + 4000 * 24 * 60 * 60 + 2
      await increaseTime(
        BigNumber.from(targetTime)
          .sub(await lastBlockTime())
          .toNumber()
      )

      await expect(reservationRouter.notifyStaleReservedDeposit(depositKey))
        .to.emit(reservationRouter, "ReservedDepositMarkedStale")
        .withArgs(depositKey)

      expect(await reservationRouter.pendingReservedDeposits()).to.equal(0)
    })

    it("rejects when an acceptance authorization is pending", async () => {
      // `makeRequestedReservation` parks an `ActionState.Pending` record
      // at generation 1 - exactly the path `notifyStaleReservedDeposit`
      // rejects on. State of the `ReservationRequest` itself stays at
      // `Unknown` here (`requestReservationAcceptance` only sets the
      // action state); the rejection is driven by the action, not the
      // position state.
      const { depositKey } = await makeRequestedReservation()

      const reservation = await reservationRouter.reservations(depositKey)
      expect(reservation.requestNonce).to.equal(1)
      expect(reservation.state).to.equal(ReservationState.Unknown)

      const action = await reservationRouter.reservationActions(depositKey, 1)
      expect(action.state).to.equal(ActionState.Pending)

      await expect(
        reservationRouter.notifyStaleReservedDeposit(depositKey)
      ).to.be.revertedWith("Acceptance authorization pending")
    })
  })
})
