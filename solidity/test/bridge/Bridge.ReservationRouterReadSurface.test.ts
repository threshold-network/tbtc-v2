import { ethers, helpers } from "hardhat"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { expect } from "chai"
import type {
  Bridge,
  BridgeStub,
  IRelay,
  ReservationRouter,
  ReservationVault,
  TBTC,
  TBTCVault,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import type { Mock } from "../helpers/mock"
import { walletState } from "../fixtures"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time

const ZERO_BYTES32 = ethers.ZeroHash

const RESERVATION_TERM = 31536000 // 365 days
const RESERVATION_GRACE = 2592000 // 30 days
const RESERVATION_MIN_AMOUNT = 10000
const RESERVATION_TX_MAX_FEE = 2000
const RESERVATION_MAX_TOTAL = BigInt("10000000")
const MAX_RESERVATIONS_PER_WALLET = 10
const RESERVATION_ACTION_TIMEOUT = 172800 // 48 hours
const RESERVATION_RENEWAL_WINDOW = 2592000 // 30 days

const ReservationState = {
  Unknown: 0,
  Active: 1,
  ActionPending: 2,
  Closed: 3,
  Stranded: 4,
}

describe("Bridge - Reservation router read surface", () => {
  let spvMaintainer: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner

  let relay: Mock<IRelay>
  let bridge: Bridge & BridgeStub
  let reservationRouter: ReservationRouter
  let reservationVault: ReservationVault
  let tbtc: TBTC
  let tbtcVault: TBTCVault
  let bridgeGovernanceSigner: HardhatEthersSigner

  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const secondWalletPubKeyHash = "0xafcdf88d15a0e0c2134dbbc9f6da24d0e26c8f21"
  const blindingFactor = "0xf9f0c90d00039523"
  const refundPubKeyHash = "0x28e081f285138ccbe389c1eb8985716230129f89"
  let refundLocktime: string

  const depositAmount = BigInt(3000000)
  const anchorFee = 1500n
  const anchorAmount = depositAmount - anchorFee

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ spvMaintainer, thirdParty, relay, bridge, tbtc, tbtcVault } =
      await bridgeFixture())

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
    await reservationRouter
      .connect(bridgeGovernanceSigner)
      .updateReservationCaps(
        RESERVATION_MAX_TOTAL,
        RESERVATION_MAX_TOTAL,
        10,
        1,
        1
      )
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

  const REGTEST_BITS_LE = "ffff7f20"
  const REGTEST_TARGET = BigInt(0x7fffff) * 2n ** BigInt(8 * (0x20 - 3))

  const reverseHex = (hex: string): string =>
    hex.replace(/^0x/, "").match(/../g)!.reverse().join("")

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

  async function movingFundsWallet(pkh: string) {
    const custodianWallet = await bridge.wallets(pkh)
    await bridge.setWallet(pkh, {
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
  }

  async function terminatedWallet(pkh: string) {
    const custodianWallet = await bridge.wallets(pkh)
    await bridge.setWallet(pkh, {
      ecdsaWalletID: custodianWallet.ecdsaWalletID,
      mainUtxoHash: custodianWallet.mainUtxoHash,
      pendingRedemptionsValue: custodianWallet.pendingRedemptionsValue,
      createdAt: custodianWallet.createdAt,
      movingFundsRequestedAt: await lastBlockTime(),
      closingStartedAt: custodianWallet.closingStartedAt,
      pendingMovedFundsSweepRequestsCount:
        custodianWallet.pendingMovedFundsSweepRequestsCount,
      state: walletState.Terminated,
      movingFundsTargetWalletsCommitmentHash:
        custodianWallet.movingFundsTargetWalletsCommitmentHash,
    })
  }

  describe("reservationByAnchorUtxo", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("resolves the anchor outpoint of an accepted reservation to its reservation key", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      expect(
        await reservationRouter.reservationByAnchorUtxo(anchorTx.txHash, 0)
      ).to.equal(reservationKey)
    })

    it("stops resolving the anchor outpoint once the position is stranded", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      expect(
        await reservationRouter.reservationByAnchorUtxo(anchorTx.txHash, 0)
      ).to.equal(reservationKey)

      await terminatedWallet(walletPubKeyHash)
      await expect(
        reservationRouter.notifyReservationStranded(reservationKey)
      ).to.emit(reservationRouter, "ReservationStranded")

      expect(
        (await reservationRouter.reservations(reservationKey)).state
      ).to.equal(ReservationState.Stranded)

      expect(
        await reservationRouter.reservationByAnchorUtxo(anchorTx.txHash, 0)
      ).to.equal(0n)
    })

    it("moves the index entry to the new outpoint when the position re-anchors", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      expect(
        await reservationRouter.reservationByAnchorUtxo(anchorTx.txHash, 0)
      ).to.equal(reservationKey)

      await movingFundsWallet(walletPubKeyHash)

      await reservationRouter
        .connect(thirdParty)
        .requestReservationReanchor(
          reservationKey,
          secondWalletPubKeyHash,
          [],
          0
        )

      const reanchorFee = 500n
      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount - reanchorFee,
            script: p2wpkhScript(secondWalletPubKeyHash),
          },
        ]
      )

      await reservationRouter
        .connect(spvMaintainer)
        .submitReservationReanchorProof(
          reanchorTx.info,
          proofFor(reanchorTx.txHash),
          reservationKey,
          2
        )

      expect(
        await reservationRouter.reservationByAnchorUtxo(anchorTx.txHash, 0)
      ).to.equal(0n)
      expect(
        await reservationRouter.reservationByAnchorUtxo(reanchorTx.txHash, 0)
      ).to.equal(reservationKey)

      const reservation = await reservationRouter.reservations(reservationKey)
      expect(reservation.anchorTxHash).to.equal(reanchorTx.txHash)
      expect(reservation.anchorTxOutputIndex).to.equal(0)
      expect(reservation.walletPubKeyHash).to.equal(secondWalletPubKeyHash)
    })

    it("does not resolve an outpoint that no reservation anchors", async () => {
      const { anchorTx } = await makeAcceptedReservation()

      expect(
        await reservationRouter.reservationByAnchorUtxo(
          ethers.hexlify(ethers.randomBytes(32)),
          0
        )
      ).to.equal(0n)
      expect(
        await reservationRouter.reservationByAnchorUtxo(anchorTx.txHash, 1)
      ).to.equal(0n)
    })
  })

  describe("reservationRouter", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("preserves router identity and anchor lookup after a rejected router replacement", async () => {
      const reportedRouter = await reservationRouter.reservationRouter()
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      const replacement = await helpers.contracts.getContract("ReservationVault")

      await expect(
        bridge
          .connect(bridgeGovernanceSigner)
          .setReservationRouter(replacement.target)
      ).to.be.revertedWith("Reservation router already set")

      expect(await reservationRouter.reservationRouter()).to.equal(
        reportedRouter
      )
      expect(await bridge.getReservationRouter()).to.equal(reportedRouter)
      expect(
        await reservationRouter.reservationByAnchorUtxo(anchorTx.txHash, 0)
      ).to.equal(reservationKey)
      expect(
        (await reservationRouter.reservations(reservationKey)).state
      ).to.equal(ReservationState.Active)
    })
  })

  describe("requestReservationReanchor privilege", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("caps a third party whose address sorts below governance", async () => {
      // The router marks a caller privileged only when its address equals the
      // governance address. An ordered comparison would exempt every address
      // that sorts at or below governance, so a third party there would skip
      // the target's hold cap.
      const first = await makeAcceptedReservation()
      const second = await makeAcceptedReservation()
      await movingFundsWallet(walletPubKeyHash)

      const lowCaller = await impersonateContract(
        "0x0000000000000000000000000000000000000abc"
      )
      expect(BigInt(lowCaller.address)).to.be.lessThan(
        BigInt(bridgeGovernanceSigner.address)
      )

      await reservationRouter
        .connect(lowCaller)
        .requestReservationReanchor(
          first.reservationKey,
          secondWalletPubKeyHash,
          [],
          0
        )
      await expect(
        reservationRouter
          .connect(lowCaller)
          .requestReservationReanchor(
            second.reservationKey,
            secondWalletPubKeyHash,
            [],
            0
          )
      ).to.be.revertedWith("Target third-party re-anchor holds exceeded")
    })
  })
})
