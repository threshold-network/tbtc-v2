/* eslint-disable @typescript-eslint/no-unused-expressions */

// Independent safety guards: the reveal-side designated-wallet binding,
// the pending-reserved-deposit tracking behind the vault-migration guard,
// stranding of reservations custodied by terminated wallets, and the
// monitoring surface (per-wallet enumeration, reverse anchor lookup).

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
const DEPOSIT_REVEAL_AHEAD_PERIOD = 1296000 // 15 days

const SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)

const ProofType = {
  Acceptance: 0,
  Redemption: 1,
  Reanchor: 2,
  Dissolution: 3,
}

const ReservationState = {
  Unknown: 0,
  Active: 1,
  ActionPending: 2,
  Closed: 3,
  Stranded: 4,
}

const ActionState = {
  Unknown: 0,
  Pending: 1,
  Settled: 2,
  TimedOut: 3,
  Vetoed: 4,
  Superseded: 5,
}

describe("Bridge - Reservation guards", () => {
  let governance: SignerWithAddress
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
  const refundLocktime = "0x60bcea61"
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
      governance,
      spvMaintainer,
      thirdParty,
      bank,
      relay,
      bridge,
      tbtc,
      tbtcVault,
    } = await waffle.loadFixture(bridgeFixture))

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

    const reservationKey = BigNumber.from(
      ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [fundingTx.txHash, 0]
      )
    )
    return { fundingTx, reservationKey }
  }

  async function makeAcceptedReservation(custodian = walletPubKeyHash) {
    const { fundingTx, reservationKey } = await revealReservedDeposit(custodian)

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

  describe("designated-wallet binding at acceptance", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("rejects an acceptance authorization for a non-designated wallet", async () => {
      const { reservationKey } = await revealReservedDeposit(walletPubKeyHash)

      // The second wallet is Live too, but the reveal's script commitment
      // designates the first wallet; forcing custody elsewhere is not
      // possible.
      await expect(
        bridge
          .connect(thirdParty)
          .requestReservationAcceptance(reservationKey, secondWalletPubKeyHash)
      ).to.be.revertedWith("Wallet is not the deposit's designated wallet")

      await bridge
        .connect(thirdParty)
        .requestReservationAcceptance(reservationKey, walletPubKeyHash)
    })
  })

  describe("pending reserved deposits and the vault-migration guard", () => {
    beforeEach(async () => {
      await createSnapshot()
      await bridge.setDepositRevealAheadPeriod(DEPOSIT_REVEAL_AHEAD_PERIOD)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("tracks reveals through acceptance and blocks vault changes while pending", async () => {
      expect(await bridge.pendingReservedDeposits()).to.equal(0)

      // Reveal with a locktime far enough for the ahead-period check.
      const futureLocktime = `0x${toLE(
        (await lastBlockTime()) + 3 * DEPOSIT_REVEAL_AHEAD_PERIOD,
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
                walletPubKeyHash,
                refundPubKeyHash,
                futureLocktime
              )
            ),
          },
        ]
      )
      await bridge.connect(thirdParty).revealDeposit(fundingTx.info, {
        fundingOutputIndex: 0,
        blindingFactor,
        walletPubKeyHash,
        refundPubKeyHash,
        refundLocktime: futureLocktime,
        vault: reservationVault.address,
      })
      const reservationKey = BigNumber.from(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [fundingTx.txHash, 0]
        )
      )

      expect(await bridge.pendingReservedDeposits()).to.equal(1)
      expect(await bridge.reservedDepositWallet(reservationKey)).to.equal(
        walletPubKeyHash
      )

      // The vault cannot be changed while a reserved deposit is pending:
      // the deposit would become pool-sweepable while the old vault still
      // mints on the callback.
      await expect(
        bridge
          .connect(bridgeGovernanceSigner)
          .updateReservationParameters(
            thirdParty.address,
            RESERVATION_MIN_AMOUNT,
            RESERVATION_TX_MAX_FEE,
            RESERVATION_TERM,
            RESERVATION_GRACE,
            RESERVATION_MAX_TOTAL,
            MAX_RESERVATIONS_PER_WALLET,
            RESERVATION_ACTION_TIMEOUT,
            RESERVATION_RENEWAL_WINDOW
          )
      ).to.be.revertedWith("Pending reserved deposits exist")

      // Acceptance settles the deposit and releases the pending marker.
      await bridge
        .connect(thirdParty)
        .requestReservationAcceptance(reservationKey, walletPubKeyHash)
      const anchorTx = buildTx(
        [{ txHash: fundingTx.txHash, index: 0 }],
        [{ valueSat: anchorAmount, script: p2wpkhScript(walletPubKeyHash) }]
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

      expect(await bridge.pendingReservedDeposits()).to.equal(0)
      expect(await bridge.reservedDepositWallet(reservationKey)).to.equal(
        `0x${"00".repeat(20)}`
      )
    })

    it("releases a never-anchored deposit via the stale notification", async () => {
      await bridge.setDepositRevealAheadPeriod(0)
      const { reservationKey } = await revealReservedDeposit()
      expect(await bridge.pendingReservedDeposits()).to.equal(1)

      // With the reveal-ahead validation disabled the margin is zero.
      const tx = await bridge
        .connect(thirdParty)
        .notifyStaleReservedDeposit(reservationKey)
      await expect(tx)
        .to.emit(bridge, "ReservedDepositMarkedStale")
        .withArgs(reservationKey)

      expect(await bridge.pendingReservedDeposits()).to.equal(0)

      // A stale deposit cannot be re-authorized.
      await expect(
        bridge
          .connect(thirdParty)
          .requestReservationAcceptance(reservationKey, walletPubKeyHash)
      ).to.be.revertedWith("Wallet is not the deposit's designated wallet")

      // And cannot be marked stale twice.
      await expect(
        bridge.connect(thirdParty).notifyStaleReservedDeposit(reservationKey)
      ).to.be.revertedWith("Not a pending reserved deposit")
    })

    it("refuses the stale notification while an authorization is pending", async () => {
      await bridge.setDepositRevealAheadPeriod(0)
      const { reservationKey } = await revealReservedDeposit()
      await bridge
        .connect(thirdParty)
        .requestReservationAcceptance(reservationKey, walletPubKeyHash)

      await expect(
        bridge.connect(thirdParty).notifyStaleReservedDeposit(reservationKey)
      ).to.be.revertedWith("Acceptance authorization pending")
    })
  })

  describe("stranding on wallet termination", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("rejects stranding while the wallet is not terminated", async () => {
      const { reservationKey } = await makeAcceptedReservation()
      await expect(
        bridge.connect(thirdParty).notifyReservationStranded(reservationKey)
      ).to.be.revertedWith("Wallet is not terminated")
    })

    it("strands an active reservation of a terminated wallet", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      const ownerBalanceBefore = await tbtc.balanceOf(thirdParty.address)

      await terminatedWallet(walletPubKeyHash)

      const tx = await bridge
        .connect(thirdParty)
        .notifyReservationStranded(reservationKey)
      await expect(tx)
        .to.emit(bridge, "ReservationStranded")
        .withArgs(
          reservationKey,
          walletPubKeyHash,
          thirdParty.address,
          anchorAmount
        )

      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Stranded)

      // Capacity and monitoring surfaces are released.
      expect(await bridge.walletReservationsCount(walletPubKeyHash)).to.equal(0)
      expect(await bridge.walletReservationsAmount(walletPubKeyHash)).to.equal(
        0
      )
      expect(await bridge.walletReservations(walletPubKeyHash)).to.deep.equal(
        []
      )
      expect(await bridge.reservationByAnchorUtxo(anchorTx.txHash, 0)).to.equal(
        0
      )

      // The owner keeps their minted balance: it is simply an ordinary
      // pooled claim now.
      expect(await tbtc.balanceOf(thirdParty.address)).to.equal(
        ownerBalanceBefore
      )

      // Stranding is terminal.
      await expect(
        bridge.connect(thirdParty).notifyReservationStranded(reservationKey)
      ).to.be.revertedWith("Reservation is not active")
    })

    it("unwinds a pending redemption while stranding", async () => {
      const { reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation() // funds the owner for the surrender

      const redemptionFee = grossTbtc.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(redemptionFee))
      await reservationVault
        .connect(thirdParty)
        .redeemReservation(reservationKey, randomRedeemerScript())

      expect(await bank.balanceOf(bridge.address)).to.equal(anchorAmount)

      await terminatedWallet(walletPubKeyHash)

      const tx = await bridge
        .connect(thirdParty)
        .notifyReservationStranded(reservationKey)
      await expect(tx)
        .to.emit(bridge, "ReservationActionSuperseded")
        .withArgs(reservationKey, 2)

      // The escrowed claim returned to the redeemer as Bank balance.
      expect(await bank.balanceOf(bridge.address)).to.equal(0)
      expect(await bank.balanceOf(thirdParty.address)).to.equal(anchorAmount)
      expect(
        (await bridge.reservationActions(reservationKey, 2)).state
      ).to.equal(ActionState.Superseded)
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Stranded
      )
    })
  })

  describe("monitoring surface", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("enumerates per-wallet reservations across the lifecycle", async () => {
      const first = await makeAcceptedReservation()
      const second = await makeAcceptedReservation()

      expect(
        (await bridge.walletReservations(walletPubKeyHash)).map(String)
      ).to.deep.equal([
        first.reservationKey.toString(),
        second.reservationKey.toString(),
      ])
      expect(
        await bridge.reservationByAnchorUtxo(first.anchorTx.txHash, 0)
      ).to.equal(first.reservationKey)

      // Re-anchor moves the entry between wallets.
      await bridge
        .connect(bridgeGovernanceSigner)
        .requestReservationReanchor(
          first.reservationKey,
          secondWalletPubKeyHash
        )
      const reanchorTx = buildTx(
        [{ txHash: first.anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: p2wpkhScript(secondWalletPubKeyHash),
          },
        ]
      )
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Reanchor,
          reanchorTx.info,
          proofFor(reanchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          first.reservationKey,
          2
        )

      expect(
        (await bridge.walletReservations(walletPubKeyHash)).map(String)
      ).to.deep.equal([second.reservationKey.toString()])
      expect(
        (await bridge.walletReservations(secondWalletPubKeyHash)).map(String)
      ).to.deep.equal([first.reservationKey.toString()])
      expect(
        await bridge.reservationByAnchorUtxo(reanchorTx.txHash, 0)
      ).to.equal(first.reservationKey)
      expect(
        await bridge.reservationByAnchorUtxo(first.anchorTx.txHash, 0)
      ).to.equal(0)

      // Redemption removes the entry.
      const redeemerScript = randomRedeemerScript()
      const newAnchor = anchorAmount.sub(1000)
      const redemptionFee = newAnchor.mul(SATOSHI_MULTIPLIER).mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(
          reservationVault.address,
          newAnchor.mul(SATOSHI_MULTIPLIER).add(redemptionFee)
        )
      await reservationVault
        .connect(thirdParty)
        .redeemReservation(first.reservationKey, redeemerScript)
      const redemptionTx = buildTx(
        [{ txHash: reanchorTx.txHash, index: 0 }],
        [{ valueSat: newAnchor.sub(500), script: redeemerScript.slice(4) }]
      )
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          redemptionTx.info,
          proofFor(redemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          first.reservationKey,
          3
        )

      expect(
        await bridge.walletReservations(secondWalletPubKeyHash)
      ).to.deep.equal([])
    })
  })
})
