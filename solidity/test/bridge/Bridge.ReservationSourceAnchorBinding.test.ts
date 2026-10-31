/**
 * Extracted from tbtc-v2 PR #1104 (refs/pull/1104/head @ 1a636939),
 * itself based on PR #1094 (origin/feat/utxo-reservation-guards @ bcfed23f).
 * Ported onto m1 (PR G, m1/bridge-integration-seams) per human decision
 * 2026-08-26. Pruned of m2-only paths (dissolution, redemption, renewal,
 * watchtower veto, retry credit) per roadmap.md §0.7.
 *
 * Kept describes:
 *   - action source-anchor binding
 *   - late settlement of a timed-out generation (added 2026-10-30: the
 *     late branch's unwind of a newer pending generation, which needs the
 *     two-settleable-generations state this file already builds)
 *
 * Pruned describes from original source block:
 *   - claim double-spend regression (full block - redemption-racing only)
 *   - retry-credit restoration after a late re-anchor
 *   - watchtower authorization enforcement in the proof path
 *   - per-wallet dissolution lock (concurrent dissolutions)
 *   - reserved redemption gating
 *   - production MaintainerProxy reservation proof route (depends on
 *     `MaintainerProxyV2`, which does not exist anywhere in m1 - no
 *     contract, no deploy script, not compiled. Porting it is new scope
 *     beyond a test port; dropped rather than faked. Found 2026-08-26.)
 *
 * The second `it("rejects an old redemption authorization against a re-anchored output")`
 * case was dropped: it calls `redeemReservation` on ReservationVault, which is an
 * m2-only function (does not exist in m1 - no such method in ReservationVault.sol).
 * The re-anchor binding logic it exercises is already covered by the first case.
 */

// Adversarial settlement tests for the action source-anchor binding:
// the re-anchor's source-anchor snapshot correctly rejects proofs against
// a stale/replaced anchor (via `requireCurrentSourceAnchor` in
// ReservationProofs.sol).

import { ethers, helpers } from "hardhat"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { Contract } from "ethers"
import { expect } from "chai"
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
import type { Mock } from "../helpers/mock"
import { walletState } from "../fixtures"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

const ZERO_BYTES32 = ethers.ZeroHash

const RESERVATION_TERM = 31536000 // 365 days
const RESERVATION_GRACE = 2592000 // 30 days
const RESERVATION_MIN_AMOUNT = 10000
const RESERVATION_TX_MAX_FEE = 2000
// `deploy/97_set_reservation_parameters.ts` already runs as part of
// `deployments.fixture()` and sets real caps (reservationMaxSingleAmount
// 100,000, maxActiveReservations 100 - see agent-docs/inventory/
// reservation-parameters.md), unlike the source test's assumption of a
// pristine, caps-never-set bridge. `updateReservationParameters`'s
// relational check (`reservationMaxTotalAmount <= maxActiveReservations *
// reservationMaxSingleAmount`) is live from that deploy step onward, so
// this must fit under 100 * 100,000 = 10,000,000 - found 2026-08-26.
const RESERVATION_MAX_TOTAL = BigInt("10000000")
const MAX_RESERVATIONS_PER_WALLET = 10
const RESERVATION_ACTION_TIMEOUT = 172800 // 48 hours
const RESERVATION_RENEWAL_WINDOW = 2592000 // 30 days

const SATOSHI_MULTIPLIER = 10n ** 10n

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

describe("Bridge - Reservation source-anchor binding", () => {
  let governance: HardhatEthersSigner
  let spvMaintainer: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let deployer: HardhatEthersSigner

  let bank: Bank & BankStub
  let relay: Mock<IRelay>
  let walletRegistry: Mock<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let reservationRouter: ReservationRouter
  let reimbursementPool: ReimbursementPool
  let tbtc: TBTC
  let tbtcVault: TBTCVault
  let reservationVault: ReservationVault
  let bridgeGovernanceSigner: HardhatEthersSigner

  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const secondWalletPubKeyHash = "0xafcdf88d15a0e0c2134dbbc9f6da24d0e26c8f21"
  const blindingFactor = "0xf9f0c90d00039523"
  const refundPubKeyHash = "0x28e081f285138ccbe389c1eb8985716230129f89"
  let refundLocktime: string

  const depositAmount = BigInt(3000000)
  const anchorFee = 1500n
  const anchorAmount = depositAmount - anchorFee
  const grossTbtc = anchorAmount * SATOSHI_MULTIPLIER

  before(async () => {
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
    } = await bridgeFixture())

    // Reservation router functions (`updateReservationParameters`,
    // `requestReservation*`, `submitReservationAcceptanceProof`,
    // `submitReservationReanchorProof`, etc.) are declared
    // on `ReservationRouter`, not `Bridge`. Per `ReservationRouter.sol`
    // invariant 3 ("no standalone authority"), every one of them is only
    // reachable through `Bridge.fallback()`'s delegatecall - calling the
    // router's own deployed address directly executes against its own
    // empty storage. `ethers.getContractAt` with the router's ABI but
    // Bridge's address gives correctly-encoded calls that land on
    // `Bridge.fallback()`, exactly like the production caller path.
    reservationRouter = await ethers.getContractAt(
      "ReservationRouter",
      bridge.target
    )
    reservationVault = await helpers.contracts.getContract("ReservationVault")
    bridgeGovernanceSigner = await impersonateContract(
      await bridge.governance()
    )
    refundLocktime = `0x${toLE((await lastBlockTime()) + 89 * 24 * 60 * 60, 4)}`

    await bridge
      .connect(bridgeGovernanceSigner)
      .setVaultStatus(reservationVault.target, true)
    // `deploy/97_set_reservation_parameters.ts` already set
    // `reservationMaxSingleAmount` to 100,000 as part of the fixture, but
    // this fixture's anchor is 2,998,500 sat - well over that single-
    // reservation cap (Reservation.sol:540-544, "Reservation exceeds the
    // single-reservation cap"). Raise it with headroom before creating any
    // reservation - found 2026-08-26.
    await reservationRouter
      .connect(bridgeGovernanceSigner)
      .updateReservationCaps(
        RESERVATION_MAX_TOTAL,
        RESERVATION_MAX_TOTAL,
        10,
        1,
        1
      ) // 10 = 2 wallets * MAX_RESERVATIONS_PER_WALLET, satisfying the Item-3 sizing relation with this fixture's two Live wallets; 1 = hand-off reserve, leaving one remaining Live wallet with 10 positions
    await reservationRouter
      .connect(bridgeGovernanceSigner)
      .updateReservationParameters(
        reservationVault.target,
        RESERVATION_MIN_AMOUNT,
        RESERVATION_TX_MAX_FEE,
        RESERVATION_TERM,
        RESERVATION_GRACE,
        RESERVATION_MAX_TOTAL,
        MAX_RESERVATIONS_PER_WALLET,
        RESERVATION_ACTION_TIMEOUT,
        RESERVATION_RENEWAL_WINDOW
      )

    await relay.getCurrentEpochDifficulty.returns(0)
    await relay.getPrevEpochDifficulty.returns(0)

    await bridge.setDepositDustThreshold(10000)
    await bridge.setDepositTxMaxFee(2000)
    await bridge.setDepositRevealAheadPeriod(0)
    await liveWallet(walletPubKeyHash)
    // A second Live wallet so the hand-off reserve gate (one Live wallet
    // held back) still leaves a remaining Live wallet with capacity.
    await liveWallet(secondWalletPubKeyHash)

    const tbtcOwner = await impersonateContract(await tbtc.owner())
    await tbtc.connect(tbtcOwner).transferOwnership(tbtcVault.target)
  })

  async function impersonateContract(
    address: string
  ): Promise<HardhatEthersSigner> {
    await ethers.provider.send("hardhat_impersonateAccount", [address])
    await ethers.provider.send("hardhat_setBalance", [
      address,
      "0x8AC7230489E80000",
    ])
    return ethers.getSigner(address)
  }

  async function liveWallet(pkh: string) {
    await bridge.setWallet(pkh, {
      ecdsaWalletID: ethers.randomBytes(32),
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

  // ---- Bitcoin fixture crafting (regtest-style difficulty) ----

  const REGTEST_BITS_LE = "ffff7f20"
  const REGTEST_TARGET = BigInt(0x7fffff) * 2n ** BigInt(8 * (0x20 - 3))

  const reverseHex = (hex: string): string =>
    (hex.replace(/^0x/, "").match(/../g) ?? []).reverse().join("")

  const hash256 = (hexData: string): string =>
    ethers.sha256(ethers.sha256(hexData))

  const toLE = (value: number | bigint, byteLength: number): string =>
    reverseHex(
      BigInt(value)
        .toString(16)
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
    outputs: { valueSat: bigint | number; script: string }[]
  ) {
    const inputVector = `0x${compactSize(inputs.length)}${inputs
      .map((i) => `${i.txHash.slice(2)}${toLE(i.index, 4)}00ffffffff`)
      .join("")}`
    const outputVector = `0x${compactSize(outputs.length)}${outputs
      .map(
        (o) =>
          `${toLE(BigInt(o.valueSat), 8)}${compactSize(
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
    const prevBlock = ethers.hexlify(ethers.randomBytes(32)).slice(2)
    const base = `20000000${prevBlock}${merkleRoot.slice(
      2
    )}662a2c68${REGTEST_BITS_LE}`
    for (let nonce = 0; ; nonce++) {
      const header = `0x${base}${toLE(nonce, 4)}`
      if (BigInt(`0x${reverseHex(hash256(header))}`) <= REGTEST_TARGET) {
        return header
      }
    }
  }

  function proofFor(txHash: string) {
    const coinbasePreimage = ethers.sha256(ethers.randomBytes(32))
    const coinbaseTxId = ethers.sha256(coinbasePreimage)
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
    `0020${ethers.sha256(`0x${script}`).slice(2)}`

  const p2wpkhScript = (pkh: string): string => `0014${pkh.slice(2)}`

  const randomRedeemerScript = (): string =>
    `0x16${p2wpkhScript(ethers.hexlify(ethers.randomBytes(20)))}`

  // Reveals a fresh reserved deposit and requests acceptance (generation 1).
  async function makeRequestedReservation(custodian = walletPubKeyHash) {
    const fundingTx = buildTx(
      [
        {
          txHash: ethers.hexlify(ethers.randomBytes(32)),
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
      vault: reservationVault.target,
    })

    const reservationKey = BigInt(
      ethers.solidityPackedKeccak256(
        ["bytes32", "uint32"],
        [fundingTx.txHash, 0]
      )
    )

    await reservationRouter
      .connect(thirdParty)
      .requestReservationAcceptance(
        fundingTx.info,
        proofFor(fundingTx.txHash),
        0,
        custodian
      )

    const anchorTx = buildTx(
      [{ txHash: fundingTx.txHash, index: 0 }],
      [{ valueSat: anchorAmount, script: p2wpkhScript(custodian) }]
    )

    return { fundingTx, anchorTx, reservationKey }
  }

  // Reveals a fresh reserved deposit, requests acceptance (generation 1)
  // and proves the anchor.
  async function makeAcceptedReservation(custodian = walletPubKeyHash) {
    const { fundingTx, anchorTx, reservationKey } =
      await makeRequestedReservation(custodian)

    await reservationRouter
      .connect(spvMaintainer)
      .submitReservationAcceptanceProof(
        anchorTx.info,
        proofFor(anchorTx.txHash),
        reservationKey,
        1
      )

    return { fundingTx, anchorTx, reservationKey }
  }

  describe("action source-anchor binding", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("rejects a timed-out re-anchor replay against a later anchor", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      const thirdWalletPubKeyHash = ethers.hexlify(ethers.randomBytes(20))
      await liveWallet(secondWalletPubKeyHash)
      await liveWallet(thirdWalletPubKeyHash)
      const custodianWallet = await bridge.wallets(walletPubKeyHash)
      await bridge.setWallet(walletPubKeyHash, {
        ecdsaWalletID: custodianWallet.ecdsaWalletID,
        mainUtxoHash: custodianWallet.mainUtxoHash,
        pendingRedemptionsValue: custodianWallet.pendingRedemptionsValue,
        createdAt: custodianWallet.createdAt,
        movingFundsRequestedAt: await lastBlockTime(),
        closingStartedAt: custodianWallet.closingStartedAt,
        pendingMovedFundsSweepRequestsCount:
          custodianWallet.pendingMovedFundsSweepRequestsCount,
        state: walletState.MovingFunds,
        movingFundsTargetWalletsCommitmentHash:
          custodianWallet.movingFundsTargetWalletsCommitmentHash,
      })

      // Generation 2 authorizes A -> B and times out while its already-
      // confirmed transaction awaits an SPV proof.
      await reservationRouter
        .connect(thirdParty)
        .requestReservationReanchor(
          reservationKey,
          secondWalletPubKeyHash,
          [],
          0
        )
      const firstReanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount - 500n,
            script: p2wpkhScript(secondWalletPubKeyHash),
          },
        ]
      )
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await reservationRouter
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey)

      // Advance past the re-anchor cooldown (d600a8bf's P2 anti-griefing
      // fix) that generation 2's timeout just started. Unrelated to what
      // this test actually characterizes (source-anchor binding across a
      // stale generation's replay); without this the next request reverts
      // with "Reanchor cooldown in effect" before reaching that scenario.
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)

      // Generation 3 authorizes the same source A -> C and also times out.
      await reservationRouter
        .connect(thirdParty)
        .requestReservationReanchor(
          reservationKey,
          thirdWalletPubKeyHash,
          [],
          0
        )
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await reservationRouter
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey)

      const originalAnchorHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint32"],
        [anchorTx.txHash, 0]
      )
      expect(
        (await reservationRouter.reservationActions(reservationKey, 2))
          .sourceAnchorUtxoHash
      ).to.equal(originalAnchorHash)
      expect(
        (await reservationRouter.reservationActions(reservationKey, 3))
          .sourceAnchorUtxoHash
      ).to.equal(originalAnchorHash)

      // The genuine, already-confirmed generation-2 transaction remains
      // late-settleable and advances the tracked anchor from A to B.
      await expect(
        reservationRouter
          .connect(spvMaintainer)
          .submitReservationReanchorProof(
            firstReanchorTx.info,
            proofFor(firstReanchorTx.txHash),
            reservationKey,
            2
          )
      )
        .to.emit(reservationRouter, "ReservationReanchored")
        .withArgs(
          reservationKey,
          2,
          secondWalletPubKeyHash,
          firstReanchorTx.txHash,
          anchorAmount - 500n,
          500
        )

      // A freshly crafted B -> C transaction has generation 3's shape but
      // spends an anchor that generation never authorized. Without the
      // source snapshot it would settle as a valid late generation-3 proof.
      const replayTx = buildTx(
        [{ txHash: firstReanchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount - 1000n,
            script: p2wpkhScript(thirdWalletPubKeyHash),
          },
        ]
      )
      await expect(
        reservationRouter
          .connect(spvMaintainer)
          .submitReservationReanchorProof(
            replayTx.info,
            proofFor(replayTx.txHash),
            reservationKey,
            3
          )
      ).to.be.revertedWith("Action source anchor is no longer current")

      const reservation = await reservationRouter.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.walletPubKeyHash).to.equal(secondWalletPubKeyHash)
      expect(reservation.anchorTxHash).to.equal(firstReanchorTx.txHash)
      expect(
        (await reservationRouter.reservationActions(reservationKey, 3)).state
      ).to.equal(ActionState.TimedOut)
      expect(
        await bridge.spentMainUTXOs(
          BigInt(
            ethers.solidityPackedKeccak256(
              ["bytes32", "uint32"],
              [firstReanchorTx.txHash, 0]
            )
          )
        )
      ).to.be.false
    })

    // it("rejects an old redemption authorization against a re-anchored output", async () => {
    //   // DROPPED: depends on `redeemReservation` on ReservationVault, which
    //   // is m2-only (does not exist in m1).
    // })
  })

  // ---- Late settlement of a timed-out re-anchor ----
  //
  // `submitReservationReanchorProof` has two settlement shapes: an on-time
  // proof names the position's current `Pending` generation, and a late
  // proof names an older `TimedOut` one whose source anchor is still
  // current (`ReservationProofs.sol:713-735`). The late shape has one extra
  // duty: if the position has meanwhile moved on to a newer `Pending`
  // generation, that generation can never settle (the late proof consumes
  // the anchor it was authorized to spend), so it is unwound to
  // `Superseded` and its reserved capacity is released before the late
  // settlement re-takes the capacity the timeout released
  // (`unwindPendingAction`, `:722-728`).
  //
  // This is the state the H-4R lab run left behind: two generations
  // snapshotting the same anchor outpoint, the newer one settling on time
  // and the older one stranded as `TimedOut` (see
  // `agent-docs/overnight-2026-10-30/h4-cause-analysis.md`).
  describe("late settlement of a timed-out generation", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    // The re-anchor request is privileged while the source wallet is Live
    // (only `BridgeGovernance` may rotate a Live source), so the source is
    // put into `MovingFunds` first, which makes the permissionless branch
    // reachable for `thirdParty`.
    async function moveWalletToMovingFunds(pkh: string) {
      const wallet = await bridge.wallets(pkh)
      await bridge.setWallet(pkh, {
        ecdsaWalletID: wallet.ecdsaWalletID,
        mainUtxoHash: wallet.mainUtxoHash,
        pendingRedemptionsValue: wallet.pendingRedemptionsValue,
        createdAt: wallet.createdAt,
        movingFundsRequestedAt: await lastBlockTime(),
        closingStartedAt: wallet.closingStartedAt,
        pendingMovedFundsSweepRequestsCount:
          wallet.pendingMovedFundsSweepRequestsCount,
        state: walletState.MovingFunds,
        movingFundsTargetWalletsCommitmentHash:
          wallet.movingFundsTargetWalletsCommitmentHash,
      })
    }

    // Generation 2 authorizes the A -> B hop and times out while the hop
    // transaction is already confirmed on Bitcoin. Generation 3 then
    // re-authorizes the same hop and stays `Pending`. Both snapshot the same
    // source outpoint, so the one confirmed transaction is a valid candidate
    // for either generation, which is exactly the collision the late branch
    // resolves.
    async function timedOutGenerationUnderAPendingNewer() {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await moveWalletToMovingFunds(walletPubKeyHash)

      await reservationRouter
        .connect(thirdParty)
        .requestReservationReanchor(
          reservationKey,
          secondWalletPubKeyHash,
          [],
          0
        )
      const hopTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount - 500n,
            script: p2wpkhScript(secondWalletPubKeyHash),
          },
        ]
      )

      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await reservationRouter
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey)

      // The timeout opens the re-anchor cooldown; wait it out before asking
      // for the next generation.
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await reservationRouter
        .connect(thirdParty)
        .requestReservationReanchor(
          reservationKey,
          secondWalletPubKeyHash,
          [],
          0
        )

      return { anchorTx, hopTx, reservationKey }
    }

    it("settles the older generation late and supersedes the newer pending one", async () => {
      const { hopTx, reservationKey } =
        await timedOutGenerationUnderAPendingNewer()

      // Both generations are settleable from the same confirmed transaction.
      expect(
        (await reservationRouter.reservations(reservationKey)).state
      ).to.equal(ReservationState.ActionPending)
      expect(
        (await reservationRouter.reservationActions(reservationKey, 3)).state
      ).to.equal(ActionState.Pending)
      expect(
        await reservationRouter.walletReservationsCount(secondWalletPubKeyHash)
      ).to.equal(1n)

      const tx = reservationRouter
        .connect(spvMaintainer)
        .submitReservationReanchorProof(
          hopTx.info,
          proofFor(hopTx.txHash),
          reservationKey,
          2
        )

      await expect(tx)
        .to.emit(reservationRouter, "ReservationLateSettled")
        .withArgs(reservationKey, 2, ActionType.Reanchor)
      await expect(tx)
        .to.emit(reservationRouter, "ReservationActionSuperseded")
        .withArgs(reservationKey, 3)
      await expect(tx)
        .to.emit(reservationRouter, "ReservationReanchored")
        .withArgs(
          reservationKey,
          2,
          secondWalletPubKeyHash,
          hopTx.txHash,
          anchorAmount - 500n,
          500
        )

      const reservation = await reservationRouter.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.walletPubKeyHash).to.equal(secondWalletPubKeyHash)
      expect(reservation.anchorTxHash).to.equal(hopTx.txHash)
      expect(reservation.anchorAmount).to.equal(anchorAmount - 500n)
      // The settled generation is 2, but the position's generation counter
      // stays at 3: the newer generation is terminal `Superseded`, not
      // settled, and nothing renumbers it.
      expect(reservation.requestNonce).to.equal(3n)

      expect(
        (await reservationRouter.reservationActions(reservationKey, 2)).state
      ).to.equal(ActionState.Settled)
      expect(
        (await reservationRouter.reservationActions(reservationKey, 3)).state
      ).to.equal(ActionState.Superseded)

      // The unwind released generation 3's reservation of B and the late
      // path re-took the capacity generation 2's timeout released, so B ends
      // holding exactly one position: the post-hop anchor. Without the
      // unwind B would hold two, one of them for a generation that can never
      // settle.
      expect(
        await reservationRouter.walletReservationsCount(secondWalletPubKeyHash)
      ).to.equal(1n)
      expect(
        await reservationRouter.walletReservationsAmount(secondWalletPubKeyHash)
      ).to.equal(anchorAmount - 500n)
      expect(
        await reservationRouter.walletReservationsCount(walletPubKeyHash)
      ).to.equal(0n)
      expect(
        await reservationRouter.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(0n)

      // Reference kept intentionally out of the assertions above: the
      // generations' shared source snapshot is the reason both are
      // candidates, and it is what makes the collision real.
      expect(
        (await reservationRouter.reservationActions(reservationKey, 2))
          .sourceAnchorUtxoHash
      ).to.equal(
        (await reservationRouter.reservationActions(reservationKey, 3))
          .sourceAnchorUtxoHash
      )
    })

    // Negative control for the unwind half of the branch. Same prefix, with
    // no newer pending generation: the late settlement must still emit
    // `ReservationLateSettled`, and it must not emit
    // `ReservationActionSuperseded` or release anything else. A late branch
    // that unwound unconditionally fails here on the missing pending action
    // ("No pending action to unwind"); a late branch that never unwinds
    // fails the test above on the extra reserved position.
    it("settles a timed-out generation late with no newer pending one, superseding nothing", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await moveWalletToMovingFunds(walletPubKeyHash)

      await reservationRouter
        .connect(thirdParty)
        .requestReservationReanchor(
          reservationKey,
          secondWalletPubKeyHash,
          [],
          0
        )
      const hopTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount - 500n,
            script: p2wpkhScript(secondWalletPubKeyHash),
          },
        ]
      )
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await reservationRouter
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey)

      const tx = reservationRouter
        .connect(spvMaintainer)
        .submitReservationReanchorProof(
          hopTx.info,
          proofFor(hopTx.txHash),
          reservationKey,
          2
        )

      await expect(tx).to.emit(reservationRouter, "ReservationLateSettled")
      await expect(tx).to.not.emit(
        reservationRouter,
        "ReservationActionSuperseded"
      )

      const reservation = await reservationRouter.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.walletPubKeyHash).to.equal(secondWalletPubKeyHash)
      expect(reservation.requestNonce).to.equal(2n)
      expect(
        (await reservationRouter.reservationActions(reservationKey, 2)).state
      ).to.equal(ActionState.Settled)
      expect(
        await reservationRouter.walletReservationsCount(secondWalletPubKeyHash)
      ).to.equal(1n)
      expect(
        await reservationRouter.walletReservationsAmount(secondWalletPubKeyHash)
      ).to.equal(anchorAmount - 500n)
    })

    // Negative control for the late events. From the identical
    // two-settleable-generations state, proving the newer `Pending`
    // generation is the on-time path: it emits neither `ReservationLateSettled`
    // nor `ReservationActionSuperseded`, leaves the older generation
    // `TimedOut`, and reaches the same final position and counters. This is
    // the resolution the client actually chose in H-4R, and it shows the
    // two events are specific to the late branch rather than to settlement
    // in general.
    it("settles the pending newer generation on time from the same transaction, emitting neither late event", async () => {
      const { hopTx, reservationKey } =
        await timedOutGenerationUnderAPendingNewer()

      const tx = reservationRouter
        .connect(spvMaintainer)
        .submitReservationReanchorProof(
          hopTx.info,
          proofFor(hopTx.txHash),
          reservationKey,
          3
        )

      await expect(tx)
        .to.emit(reservationRouter, "ReservationReanchored")
        .withArgs(
          reservationKey,
          3,
          secondWalletPubKeyHash,
          hopTx.txHash,
          anchorAmount - 500n,
          500
        )
      await expect(tx).to.not.emit(reservationRouter, "ReservationLateSettled")
      await expect(tx).to.not.emit(
        reservationRouter,
        "ReservationActionSuperseded"
      )

      const reservation = await reservationRouter.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.requestNonce).to.equal(3n)
      expect(
        (await reservationRouter.reservationActions(reservationKey, 2)).state
      ).to.equal(ActionState.TimedOut)
      expect(
        (await reservationRouter.reservationActions(reservationKey, 3)).state
      ).to.equal(ActionState.Settled)
      expect(
        await reservationRouter.walletReservationsCount(secondWalletPubKeyHash)
      ).to.equal(1n)
      expect(
        await reservationRouter.walletReservationsAmount(secondWalletPubKeyHash)
      ).to.equal(anchorAmount - 500n)
    })
  })
  // The router's read-only surface must reflect the on-chain state it is
  // delegate-called against: the pending third-party hold counter and the
  // anchor-outpoint index are the two mappings the router exposes, and the
  // mutations above are the ones that populate them.
  describe("router getters", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("reads the pending third-party re-anchor hold back from the router", async () => {
      const { reservationKey } = await makeAcceptedReservation()
      const custodianWallet = await bridge.wallets(walletPubKeyHash)
      await bridge.setWallet(walletPubKeyHash, {
        ecdsaWalletID: custodianWallet.ecdsaWalletID,
        mainUtxoHash: custodianWallet.mainUtxoHash,
        pendingRedemptionsValue: custodianWallet.pendingRedemptionsValue,
        createdAt: custodianWallet.createdAt,
        movingFundsRequestedAt: await lastBlockTime(),
        closingStartedAt: custodianWallet.closingStartedAt,
        pendingMovedFundsSweepRequestsCount:
          custodianWallet.pendingMovedFundsSweepRequestsCount,
        state: walletState.MovingFunds,
        movingFundsTargetWalletsCommitmentHash:
          custodianWallet.movingFundsTargetWalletsCommitmentHash,
      })

      // A third-party (non-privileged) request: the position owner is
      // `thirdParty`, `governance` is neither the owner nor the SPV
      // maintainer, and no member proof is presented, so the request counts
      // the target's pending hold against the governance cap.
      await reservationRouter
        .connect(governance)
        .requestReservationReanchor(
          reservationKey,
          secondWalletPubKeyHash,
          [],
          0
        )

      expect(
        await reservationRouter.pendingThirdPartyReanchorHolds(
          secondWalletPubKeyHash
        )
      ).to.equal(1)
    })

    it("reads the proven anchor's reservation key back from the router", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      // The settled acceptance registers the anchor outpoint under exactly
      // its (hash, index-0) key.
      expect(
        await reservationRouter.reservationByAnchorUtxo(anchorTx.txHash, 0)
      ).to.equal(reservationKey)
      // No other output index of the same transaction, and no foreign
      // transaction, is tracked.
      expect(
        await reservationRouter.reservationByAnchorUtxo(anchorTx.txHash, 1)
      ).to.equal(0n)
      expect(
        await reservationRouter.reservationByAnchorUtxo(
          ethers.hexlify(ethers.randomBytes(32)),
          0
        )
      ).to.equal(0n)
    })
  })
})
