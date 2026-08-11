/* eslint-disable @typescript-eslint/no-unused-expressions */

// Global-accounting invariant test: across a mixed reservation lifecycle
// (accept, re-anchor, dissolve, redeem, time out, retry) the total TBTC
// supply equals the Bitcoin backing the protocol accounts for — the sum of
// live anchor values plus the pooled backing that dissolutions returned —
// with the vault's financed in-kind fees the only supply reductions and
// zero uncovered fee debt. This is the M-09 supply-equals-backing check
// exercising the full stack (settlement + backing + guards).

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
  IRelay,
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

const RESERVATION_TERM = 31536000
const RESERVATION_GRACE = 2592000
const RESERVATION_MIN_AMOUNT = 10000
const RESERVATION_TX_MAX_FEE = 2000
const RESERVATION_MAX_TOTAL = BigNumber.from("2100000000000000")
const MAX_RESERVATIONS_PER_WALLET = 10
const RESERVATION_ACTION_TIMEOUT = 172800
const RESERVATION_RENEWAL_WINDOW = 2592000

const SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)

const ProofType = {
  Acceptance: 0,
  Redemption: 1,
  Reanchor: 2,
  Dissolution: 3,
}

describe("Bridge - Reservation invariants", () => {
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress

  let bank: Bank & BankStub
  let relay: FakeContract<IRelay>
  let bridge: Bridge & BridgeStub & ReservationRouter
  let tbtc: TBTC & Contract
  let tbtcVault: TBTCVault & Contract
  let reservationVault: ReservationVault
  let bridgeGovernanceSigner: SignerWithAddress

  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const secondWalletPubKeyHash = "0xafcdf88d15a0e0c2134dbbc9f6da24d0e26c8f21"
  const blindingFactor = "0xf9f0c90d00039523"
  const refundPubKeyHash = "0x28e081f285138ccbe389c1eb8985716230129f89"
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
    ;({ spvMaintainer, thirdParty, bank, relay, bridge, tbtc, tbtcVault } =
      await waffle.loadFixture(bridgeFixture))

    reservationVault = await helpers.contracts.getContract("ReservationVault")
    bridgeGovernanceSigner = await impersonateContract(
      await bridge.governance()
    )

    await bridge
      .connect(bridgeGovernanceSigner)
      .setVaultStatus(reservationVault.address, true)
    await bridge
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
    await liveWallet(secondWalletPubKeyHash)
    await bridge.setLiveWalletsCount(2)

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

  const compactSize = (n: number): string => n.toString(16).padStart(2, "0")

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

  async function makeAcceptedReservation(custodian = walletPubKeyHash) {
    const refundLocktime = `0x${toLE(
      (await lastBlockTime()) + 400 * 24 * 60 * 60,
      4
    )}`
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
    const reservationKey = BigNumber.from(
      ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [fundingTx.txHash, 0]
      )
    )
    await bridge
      .connect(thirdParty)
      .requestReservationAcceptance(reservationKey, custodian)
    const anchorTx = buildTx(
      [{ txHash: fundingTx.txHash, index: 0 }],
      [{ valueSat: anchorAmount, script: p2wpkhScript(custodian) }]
    )
    await bridge
      .connect(spvMaintainer)
      .submitReservationProof(
        ProofType.Acceptance,
        anchorTx.info,
        proofFor(anchorTx.txHash),
        NO_MAIN_UTXO_PARAM,
        reservationKey,
        1
      )
    return { fundingTx, anchorTx, reservationKey }
  }

  // The Bitcoin backing the protocol accounts for: every live anchor
  // (== the reservation total) plus the pooled backing that dissolutions
  // rejoined (tracked here as we drive the scenario), in TBTC units. The
  // vault's fee reserve and the escrow the Bridge holds during a pending
  // redemption are TBTC that already exists against live anchors, so the
  // invariant compares against total supply minus nothing extra: supply
  // equals the reserved backing plus the dissolved-to-pool backing, since
  // financed fees burn supply exactly as they reduce backing.
  describe("supply equals accounted backing across a mixed lifecycle", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("holds after accept, re-anchor, dissolve, redeem and timeout+retry", async () => {
      let dissolvedToPoolSat = BigNumber.from(0)

      // Helper: the accounted backing in TBTC = live reserved anchors +
      // pooled backing dissolutions returned. Supply must equal it exactly
      // (financed fees burn supply in lockstep; no uncovered debt).
      const assertInvariant = async () => {
        const params = await bridge.reservationParameters()
        const reservedSat = params.reservationTotalAmount
        const accountedBackingTbtc = reservedSat
          .add(dissolvedToPoolSat)
          .mul(SATOSHI_MULTIPLIER)
        expect(await tbtc.totalSupply()).to.equal(accountedBackingTbtc)
        expect(await reservationVault.inKindFeeDebtSat()).to.equal(0)
      }

      // --- Position A: accept, re-anchor, then redeem ---
      const a = await makeAcceptedReservation()
      await assertInvariant()

      await bridge
        .connect(bridgeGovernanceSigner)
        .requestReservationReanchor(a.reservationKey, secondWalletPubKeyHash)
      const aReanchorFee = 800
      const aNewAnchor = anchorAmount.sub(aReanchorFee)
      const aReanchorTx = buildTx(
        [{ txHash: a.anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: aNewAnchor,
            script: p2wpkhScript(secondWalletPubKeyHash),
          },
        ]
      )
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Reanchor,
          aReanchorTx.info,
          proofFor(aReanchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          a.reservationKey,
          2
        )
      await assertInvariant()

      // Redeem position A in-kind while it is still well before expiry
      // (the later dissolution time-jump would otherwise close its
      // strict pre-expiry redemption window). Fund the owner first with a
      // throwaway acceptance so they hold enough TBTC.
      await makeAcceptedReservation()
      const redeemerScript = randomRedeemerScript()
      const aGross = aNewAnchor.mul(SATOSHI_MULTIPLIER)
      const aRedemptionFee = aGross.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, aGross.add(aRedemptionFee))
      await reservationVault
        .connect(thirdParty)
        .redeemReservation(a.reservationKey, redeemerScript, aRedemptionFee)
      const aRedemptionTx = buildTx(
        [{ txHash: aReanchorTx.txHash, index: 0 }],
        [{ valueSat: aNewAnchor.sub(400), script: redeemerScript.slice(4) }]
      )
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          aRedemptionTx.info,
          proofFor(aRedemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          a.reservationKey,
          3
        )
      await assertInvariant()

      // --- Position B: accept, then dissolve after term ---
      const b = await makeAcceptedReservation()
      await assertInvariant()

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(b.reservationKey)
      const bDissolveFee = 500
      const bDissolveTx = buildTx(
        [{ txHash: b.anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(bDissolveFee),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          bDissolveTx.info,
          proofFor(bDissolveTx.txHash),
          NO_MAIN_UTXO_PARAM,
          b.reservationKey,
          2
        )
      // The pool absorbed anchor - fee; the owner's claim (== anchor) stays
      // outstanding, so the accounted pooled backing grows by anchor - fee.
      dissolvedToPoolSat = dissolvedToPoolSat.add(
        anchorAmount.sub(bDissolveFee)
      )
      await assertInvariant()

      // --- Position C: accept, request redemption, time out, then the
      //     late proof settles against the terminal record ---
      const c = await makeAcceptedReservation()
      await assertInvariant()

      const cScript = randomRedeemerScript()
      await tbtc
        .connect(thirdParty)
        .approve(
          reservationVault.address,
          grossTbtc.add(grossTbtc.mul(20).div(10000))
        )
      await reservationVault
        .connect(thirdParty)
        .redeemReservation(
          c.reservationKey,
          cScript,
          grossTbtc.mul(20).div(10000)
        )
      // While the redemption is pending, the invariant does NOT hold in
      // its quiescent form: the vault unminted the gross claim (supply
      // dropped) but the anchor is still counted reserved, with the gap
      // held by the Bridge as escrowed Bank balance. This is the expected
      // transient, so no assertion here.

      const cRedemptionTx = buildTx(
        [{ txHash: c.anchorTx.txHash, index: 0 }],
        [{ valueSat: anchorAmount.sub(400), script: cScript.slice(4) }]
      )

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(c.reservationKey, [])
      // Still pending-equivalent: the timeout moved the escrow to the
      // redeemer as Bank balance (not re-minted TBTC) and left the anchor
      // reserved, so the quiescent invariant is still suspended.

      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          cRedemptionTx.info,
          proofFor(cRedemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          c.reservationKey,
          2
        )
      // Late settlement closes the anchor lineage (reserved drops by the
      // anchor) and burns the escrowed Bank balance. Supply was already
      // reduced by the request-time unmint, so supply and the reserved
      // total reconcile back to the quiescent invariant with no dissolved
      // increment: the redeemer's timeout refund was a Bank claim over the
      // (slashed) wallet, separate from the TBTC/anchor accounting.
      await assertInvariant()
    })
  })
})
