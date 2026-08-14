/* eslint-disable @typescript-eslint/no-unused-expressions */

// Adversarial settlement tests for the two-phase reservation state machine:
// the claim double-spend regression (timeout racing a confirmed redemption),
// the late-proof settlement matrix, the on-chain watchtower-delay
// enforcement, the per-wallet dissolution lock, and the
// capacity-reserved-before-signing guarantee.

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
  MaintainerProxy,
  MaintainerProxyV2,
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
const RESERVATION_MAX_TOTAL = BigNumber.from("2100000000000000")
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

describe("Bridge - Reservation settlement", () => {
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let deployer: SignerWithAddress

  let bank: Bank & BankStub
  let relay: FakeContract<IRelay>
  let walletRegistry: FakeContract<IWalletRegistry>
  let bridge: Bridge & BridgeStub & ReservationRouter
  let maintainerProxy: MaintainerProxy
  let maintainerProxyV2: MaintainerProxyV2
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

    maintainerProxy = await helpers.contracts.getContract("MaintainerProxy")
    maintainerProxyV2 = await helpers.contracts.getContract("MaintainerProxyV2")

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
    await bridge.setLiveWalletsCount(10)

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

  async function expectWalletSeized(ecdsaWalletID: string) {
    const {
      redemptionTimeoutSlashingAmount,
      redemptionTimeoutNotifierRewardMultiplier,
    } = await bridge.redemptionParameters()

    expect(walletRegistry.seize).to.have.been.calledWith(
      redemptionTimeoutSlashingAmount,
      redemptionTimeoutNotifierRewardMultiplier,
      await thirdParty.getAddress(),
      ecdsaWalletID,
      []
    )
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

  // Reveals a fresh reserved deposit and requests acceptance (generation 1).
  async function makeRequestedReservation(custodian = walletPubKeyHash) {
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

    return { fundingTx, anchorTx, reservationKey }
  }

  // Reveals a fresh reserved deposit, requests acceptance (generation 1)
  // and proves the anchor.
  async function makeAcceptedReservation(custodian = walletPubKeyHash) {
    const { fundingTx, anchorTx, reservationKey } =
      await makeRequestedReservation(custodian)

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

  async function completeMovingFundsWhileReservationsRemain() {
    await liveWallet(secondWalletPubKeyHash)

    const mainUtxo = {
      txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      txOutputIndex: 0,
      txOutputValue: 7000000,
    }
    const ecdsaWalletID = ethers.utils.hexlify(ethers.utils.randomBytes(32))
    await bridge.setWallet(walletPubKeyHash, {
      ecdsaWalletID,
      mainUtxoHash: ZERO_BYTES32,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: await lastBlockTime(),
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.MovingFunds,
      movingFundsTargetWalletsCommitmentHash: ethers.utils.solidityKeccak256(
        ["bytes20[]"],
        [[secondWalletPubKeyHash]]
      ),
    })
    await bridge.setWalletMainUtxo(walletPubKeyHash, mainUtxo)

    const movingFundsTx = buildTx(
      [{ txHash: mainUtxo.txHash, index: mainUtxo.txOutputIndex }],
      [
        {
          valueSat: BigNumber.from(mainUtxo.txOutputValue).sub(500),
          script: p2wpkhScript(secondWalletPubKeyHash),
        },
      ]
    )
    const tx = await bridge
      .connect(spvMaintainer)
      .submitMovingFundsProof(
        movingFundsTx.info,
        proofFor(movingFundsTx.txHash),
        mainUtxo,
        walletPubKeyHash
      )

    return { ecdsaWalletID, movingFundsTx, tx }
  }

  // Requests an in-kind redemption of the given accepted reservation via
  // the real vault flow (fee paid in TBTC).
  async function requestRedemption(
    reservationKey: BigNumber,
    redeemerScript: string
  ) {
    const redemptionFee = grossTbtc.mul(20).div(10000)
    await tbtc
      .connect(thirdParty)
      .approve(reservationVault.address, grossTbtc.add(redemptionFee))
    await reservationVault
      .connect(thirdParty)
      .redeemReservation(reservationKey, redeemerScript, redemptionFee)
  }

  // Retries via the Bank-balance path after a timeout refund.
  async function retryRedemption(
    reservationKey: BigNumber,
    redeemerScript: string
  ) {
    await bank
      .connect(thirdParty)
      .approveBalance(reservationVault.address, anchorAmount)
    await reservationVault
      .connect(thirdParty)
      .retryRedeemReservation(reservationKey, redeemerScript)
  }

  async function requestAndTimeoutReanchor(
    reservationKey: BigNumber,
    anchorTxHash: string
  ) {
    await liveWallet(secondWalletPubKeyHash)
    await bridge
      .connect(thirdParty)
      .requestReservationReanchor(reservationKey, secondWalletPubKeyHash)

    const reanchorTx = buildTx(
      [{ txHash: anchorTxHash, index: 0 }],
      [
        {
          valueSat: anchorAmount.sub(500),
          script: p2wpkhScript(secondWalletPubKeyHash),
        },
      ]
    )

    await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
    await bridge
      .connect(thirdParty)
      .notifyReservationActionTimeout(reservationKey, [])

    return reanchorTx
  }

  describe("production MaintainerProxy reservation proof route", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("settles and reimburses a real proof when only the proxy is authorized in Bridge", async () => {
      await bridge
        .connect(bridgeGovernanceSigner)
        .setSpvMaintainerStatus(spvMaintainer.address, false)
      await bridge
        .connect(bridgeGovernanceSigner)
        .setSpvMaintainerStatus(maintainerProxyV2.address, false)
      await maintainerProxyV2
        .connect(governance)
        .authorizeSpvMaintainer(spvMaintainer.address)
      await deployer.sendTransaction({
        to: reimbursementPool.address,
        value: ethers.utils.parseEther("1"),
      })

      const { anchorTx, reservationKey } = await makeRequestedReservation()
      const proof = proofFor(anchorTx.txHash)

      // The immutable production proxy does not have this selector, so it
      // cannot provide an authorized route even though it knows the caller.
      await maintainerProxy
        .connect(governance)
        .authorizeSpvMaintainer(spvMaintainer.address)
      expect(
        await maintainerProxy.isSpvMaintainer(spvMaintainer.address)
      ).to.not.equal(0)
      const legacyProxyReservationBridge = await ethers.getContractAt(
        "IReservationBridge",
        maintainerProxy.address
      )
      await expect(
        legacyProxyReservationBridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Acceptance,
            anchorTx.info,
            proof,
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            1
          )
      ).to.be.reverted

      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Acceptance,
            anchorTx.info,
            proof,
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            1
          )
      ).to.be.revertedWith("Caller is not SPV maintainer")

      const proxyReservationBridge = await ethers.getContractAt(
        "IReservationBridge",
        maintainerProxyV2.address
      )
      await expect(
        proxyReservationBridge
          .connect(thirdParty)
          .submitReservationProof(
            ProofType.Acceptance,
            anchorTx.info,
            proof,
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            1
          )
      ).to.be.revertedWith("Caller is not authorized")

      await expect(
        proxyReservationBridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Acceptance,
            anchorTx.info,
            proof,
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            1
          )
      ).to.be.revertedWith("Caller is not SPV maintainer")

      await bridge
        .connect(bridgeGovernanceSigner)
        .setSpvMaintainerStatus(maintainerProxyV2.address, true)

      expect(await reimbursementPool.isAuthorized(maintainerProxyV2.address)).to
        .be.false
      await expect(
        proxyReservationBridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Acceptance,
            anchorTx.info,
            proof,
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            1
          )
      ).to.be.revertedWith("Contract is not authorized for a refund")

      // The strict refund failure rolls the external Bridge settlement back.
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Unknown
      )
      expect(
        (await bridge.reservationActions(reservationKey, 1)).state
      ).to.equal(ActionState.Pending)

      await reimbursementPool
        .connect(governance)
        .authorize(maintainerProxyV2.address)

      const balanceBefore = await ethers.provider.getBalance(
        spvMaintainer.address
      )
      const tx = await proxyReservationBridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Acceptance,
          anchorTx.info,
          proof,
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          1
        )

      const reservation = await bridge.reservations(reservationKey)
      await expect(tx)
        .to.emit(bridge, "ReservationAccepted")
        .withArgs(
          reservationKey,
          1,
          walletPubKeyHash,
          thirdParty.address,
          anchorTx.txHash,
          anchorAmount,
          reservation.expiresAt
        )

      const balanceAfter = await ethers.provider.getBalance(
        spvMaintainer.address
      )
      expect(balanceAfter).to.be.gt(balanceBefore)
      expect(reservation.state).to.equal(ReservationState.Active)
    })

    it("keeps the proof offset owner-configurable", async () => {
      expect(
        await maintainerProxyV2.submitReservationProofGasOffset()
      ).to.equal(30000)

      await expect(
        maintainerProxyV2
          .connect(thirdParty)
          .updateReservationProofGasOffset(31000)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await expect(
        maintainerProxyV2
          .connect(governance)
          .updateReservationProofGasOffset(31000)
      )
        .to.emit(maintainerProxyV2, "ReservationProofGasOffsetUpdated")
        .withArgs(31000)

      expect(
        await maintainerProxyV2.submitReservationProofGasOffset()
      ).to.equal(31000)
    })
  })

  describe("claim double-spend regression (timeout racing a confirmed redemption)", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("settles the late proof without a second refund and defeats fraud exposure", async () => {
      // Two acceptances: the second funds the owner with the TBTC needed
      // for the gross surrender plus fee on the first.
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestRedemption(reservationKey, redeemerScript)

      // The wallet signs and broadcasts; the transaction confirms on
      // Bitcoin (crafted below) but its proof does not reach the Bridge
      // before the timeout.
      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4),
          },
        ]
      )

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      // The timeout refunded the escrowed claim to the redeemer.
      const redeemerBankBalance = await bank.balanceOf(thirdParty.address)
      expect(redeemerBankBalance).to.equal(anchorAmount)
      const bridgeBankBalance = await bank.balanceOf(bridge.address)

      // The late proof settles against the terminal TimedOut record.
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          redemptionTx.info,
          proofFor(redemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )

      await expect(tx)
        .to.emit(bridge, "ReservationLateSettled")
        .withArgs(reservationKey, 2, ActionType.Redemption)
      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionCompleted")
        .withArgs(reservationKey, 2, redemptionTx.txHash)

      // No second refund and no burn: the Bank moved nothing during the
      // late settlement.
      expect(await bank.balanceOf(thirdParty.address)).to.equal(
        redeemerBankBalance
      )
      expect(await bank.balanceOf(bridge.address)).to.equal(bridgeBankBalance)

      // The lineage is closed and the consumed anchor is registered as
      // honestly spent, so the wallet's signature defeats any fraud
      // challenge.
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Closed
      )
      expect(
        await bridge.spentMainUTXOs(
          BigNumber.from(
            ethers.utils.solidityKeccak256(
              ["bytes32", "uint32"],
              [anchorTx.txHash, 0]
            )
          )
        )
      ).to.be.true

      // The settled generation cannot be settled twice.
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Redemption,
            redemptionTx.info,
            proofFor(redemptionTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            2
          )
      ).to.be.revertedWith("Action is not settleable")
    })
  })

  describe("late proof against a position with a newer pending generation", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("forces settlement against a matching pending generation", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestRedemption(reservationKey, redeemerScript)

      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4),
          },
        ]
      )

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      // The owner retries with the SAME redeemer script (generation 3).
      await retryRedemption(reservationKey, redeemerScript)

      // The transaction satisfies both generation 2 (timed out) and
      // generation 3 (pending). The late-settlement path must refuse it:
      // settling the pending generation burns the escrow, which is the
      // correct accounting.
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Redemption,
            redemptionTx.info,
            proofFor(redemptionTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            2
          )
      ).to.be.revertedWith("Must settle the pending generation")

      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          redemptionTx.info,
          proofFor(redemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          3
        )
      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionCompleted")
        .withArgs(reservationKey, 3, redemptionTx.txHash)

      // The pending settlement burned the escrow.
      expect(await bank.balanceOf(bridge.address)).to.equal(0)
    })

    it("unwinds a non-matching pending generation and refunds its escrow", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestRedemption(reservationKey, redeemerScript)

      // Generation 2's transaction confirms on Bitcoin.
      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4),
          },
        ]
      )

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      // The owner retries toward a DIFFERENT redeemer script
      // (generation 3) -- unaware the old transaction confirmed.
      const otherScript = randomRedeemerScript()
      await retryRedemption(reservationKey, otherScript)
      expect(await bank.balanceOf(bridge.address)).to.equal(anchorAmount)

      // The late proof of generation 2 settles; generation 3 can never
      // settle (its anchor is gone), so it is unwound and its escrow
      // refunded.
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          redemptionTx.info,
          proofFor(redemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )

      await expect(tx)
        .to.emit(bridge, "ReservationActionSuperseded")
        .withArgs(reservationKey, 3)
      await expect(tx)
        .to.emit(bridge, "ReservationLateSettled")
        .withArgs(reservationKey, 2, ActionType.Redemption)

      expect(
        (await bridge.reservationActions(reservationKey, 3)).state
      ).to.equal(ActionState.Superseded)
      expect(
        (await bridge.reservationActions(reservationKey, 3)).usedRetryCredit
      ).to.be.true
      expect((await bridge.reservations(reservationKey)).retryCredit).to.be
        .false
      // Generation 3's escrow returned to its redeemer. (The generation 2
      // timeout refund was re-spent on the retry, so the redeemer's net
      // Bank balance is exactly the unwound escrow.)
      expect(await bank.balanceOf(bridge.address)).to.equal(0)
      expect(await bank.balanceOf(thirdParty.address)).to.equal(anchorAmount)
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Closed
      )
    })
  })

  describe("action source-anchor binding", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("rejects a timed-out re-anchor replay against a later anchor", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      const thirdWalletPubKeyHash = ethers.utils.hexlify(
        ethers.utils.randomBytes(20)
      )
      await liveWallet(secondWalletPubKeyHash)
      await liveWallet(thirdWalletPubKeyHash)
      await bridge.setWallet(walletPubKeyHash, {
        ...(await bridge.wallets(walletPubKeyHash)),
        state: walletState.MovingFunds,
        movingFundsRequestedAt: await lastBlockTime(),
      })

      // Generation 2 authorizes A -> B and times out while its already-
      // confirmed transaction awaits an SPV proof.
      await bridge
        .connect(thirdParty)
        .requestReservationReanchor(reservationKey, secondWalletPubKeyHash)
      const firstReanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(500),
            script: p2wpkhScript(secondWalletPubKeyHash),
          },
        ]
      )
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      // Generation 3 authorizes the same source A -> C and also times out.
      await bridge
        .connect(thirdParty)
        .requestReservationReanchor(reservationKey, thirdWalletPubKeyHash)
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      const originalAnchorHash = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [anchorTx.txHash, 0]
      )
      expect(
        (await bridge.reservationActions(reservationKey, 2))
          .sourceAnchorUtxoHash
      ).to.equal(originalAnchorHash)
      expect(
        (await bridge.reservationActions(reservationKey, 3))
          .sourceAnchorUtxoHash
      ).to.equal(originalAnchorHash)

      // The genuine, already-confirmed generation-2 transaction remains
      // late-settleable and advances the tracked anchor from A to B.
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Reanchor,
            firstReanchorTx.info,
            proofFor(firstReanchorTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            2
          )
      )
        .to.emit(bridge, "ReservationReanchored")
        .withArgs(
          reservationKey,
          2,
          secondWalletPubKeyHash,
          firstReanchorTx.txHash,
          anchorAmount.sub(500)
        )

      // A freshly crafted B -> C transaction has generation 3's shape but
      // spends an anchor that generation never authorized. Without the
      // source snapshot it would settle as a valid late generation-3 proof.
      const replayTx = buildTx(
        [{ txHash: firstReanchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: p2wpkhScript(thirdWalletPubKeyHash),
          },
        ]
      )
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Reanchor,
            replayTx.info,
            proofFor(replayTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            3
          )
      ).to.be.revertedWith("Action source anchor is no longer current")

      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.walletPubKeyHash).to.equal(secondWalletPubKeyHash)
      expect(reservation.anchorTxHash).to.equal(firstReanchorTx.txHash)
      expect(
        (await bridge.reservationActions(reservationKey, 3)).state
      ).to.equal(ActionState.TimedOut)
      expect(
        await bridge.spentMainUTXOs(
          BigNumber.from(
            ethers.utils.solidityKeccak256(
              ["bytes32", "uint32"],
              [firstReanchorTx.txHash, 0]
            )
          )
        )
      ).to.be.false
    })

    it("rejects an old redemption authorization against a re-anchored output", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestRedemption(reservationKey, redeemerScript)
      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      const refundedBalance = await bank.balanceOf(thirdParty.address)
      const redemptionAction = await bridge.reservationActions(
        reservationKey,
        2
      )
      expect(redemptionAction.actionDataHash).to.equal(
        ethers.utils.keccak256(redeemerScript)
      )
      expect(redemptionAction.sourceAnchorUtxoHash).to.equal(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [anchorTx.txHash, 0]
        )
      )

      await liveWallet(secondWalletPubKeyHash)
      await bridge
        .connect(thirdParty)
        .requestReservationReanchor(reservationKey, secondWalletPubKeyHash)
      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(500),
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
          reservationKey,
          3
        )

      // This transaction spends the new B anchor and pays the old
      // redemption script. It must not inherit generation 2's authority.
      const replayTx = buildTx(
        [{ txHash: reanchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1500),
            script: redeemerScript.slice(4),
          },
        ]
      )
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Redemption,
            replayTx.info,
            proofFor(replayTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            2
          )
      ).to.be.revertedWith("Action source anchor is no longer current")

      const currentAnchorKey = BigNumber.from(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [reanchorTx.txHash, 0]
        )
      )
      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.walletPubKeyHash).to.equal(secondWalletPubKeyHash)
      expect(reservation.anchorTxHash).to.equal(reanchorTx.txHash)
      expect(
        (await bridge.reservationActions(reservationKey, 2)).state
      ).to.equal(ActionState.TimedOut)
      expect(await bridge.spentMainUTXOs(currentAnchorKey)).to.be.false
      expect(await bank.balanceOf(thirdParty.address)).to.equal(refundedBalance)
    })
  })

  describe("retry-credit restoration after a late re-anchor", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("restores a retry credit when the late re-anchor supersedes the retry", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      // Generation 2 is fee-paid. Its timeout refunds the escrow, mints the
      // one-shot retry credit, and naturally moves the custody wallet into
      // MovingFunds so anyone can request the migration below.
      await requestRedemption(reservationKey, randomRedeemerScript())
      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])
      expect((await bridge.reservations(reservationKey)).retryCredit).to.be.true

      // Generation 3 re-anchors the original reservation output but its
      // proof is delayed until after the authorization times out.
      const reanchorTx = await requestAndTimeoutReanchor(
        reservationKey,
        anchorTx.txHash
      )

      // Generation 4 consumes the one-shot credit and escrows the timeout
      // refund for a fee-free retry against the still-current old anchor.
      const retryScript = randomRedeemerScript()
      await retryRedemption(reservationKey, retryScript)
      expect((await bridge.reservations(reservationKey)).retryCredit).to.be
        .false
      expect(await bank.balanceOf(thirdParty.address)).to.equal(0)
      expect(await bank.balanceOf(bridge.address)).to.equal(anchorAmount)

      const retryTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: retryScript.slice(4),
          },
        ]
      )

      // The already-confirmed generation 3 transaction consumes the old
      // anchor. Generation 4 can never settle, so it is superseded and its
      // escrow is refunded. The consumed retry entitlement must return to
      // the now-Active position.
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Reanchor,
          reanchorTx.info,
          proofFor(reanchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          3
        )

      await expect(tx)
        .to.emit(bridge, "ReservationActionSuperseded")
        .withArgs(reservationKey, 4)
      await expect(tx)
        .to.emit(bridge, "ReservationRetryCreditMinted")
        .withArgs(reservationKey)

      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.retryCredit).to.be.true
      expect(reservation.walletPubKeyHash).to.equal(secondWalletPubKeyHash)
      expect(
        (await bridge.reservationActions(reservationKey, 4)).state
      ).to.equal(ActionState.Superseded)
      expect(
        (await bridge.reservationActions(reservationKey, 4)).usedRetryCredit
      ).to.be.true
      expect(await bank.balanceOf(thirdParty.address)).to.equal(anchorAmount)
      expect(await bank.balanceOf(bridge.address)).to.equal(0)

      // Supersession is terminal and the escrow was refunded exactly once.
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Redemption,
            retryTx.info,
            proofFor(retryTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            4
          )
      ).to.be.revertedWith("Action is not settleable")
      expect(await bank.balanceOf(thirdParty.address)).to.equal(anchorAmount)
      expect(await bank.balanceOf(bridge.address)).to.equal(0)

      // The restored entitlement is usable again and is consumed exactly
      // once by a new fee-free retry against the re-anchored position.
      await retryRedemption(reservationKey, randomRedeemerScript())
      expect((await bridge.reservations(reservationKey)).retryCredit).to.be
        .false
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.ActionPending
      )
      expect(
        (await bridge.reservationActions(reservationKey, 5)).usedRetryCredit
      ).to.be.true
      // The backing branch writes the claim down by the re-anchor miner fee.
      // The restored credit therefore re-escrows the current claim, leaving
      // the financed 500-satoshi write-down in the redeemer's Bank balance.
      expect(await bank.balanceOf(thirdParty.address)).to.equal(500)
      expect(await bank.balanceOf(bridge.address)).to.equal(
        anchorAmount.sub(500)
      )
    })

    it("does not mint credit when the superseded redemption paid a fee", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      // Put the source wallet on its ordinary migration path without first
      // creating a retry entitlement.
      await bridge.setWallet(walletPubKeyHash, {
        ...(await bridge.wallets(walletPubKeyHash)),
        state: walletState.MovingFunds,
        movingFundsRequestedAt: await lastBlockTime(),
      })

      const reanchorTx = await requestAndTimeoutReanchor(
        reservationKey,
        anchorTx.txHash
      )

      // Generation 3 is a fresh fee-paid redemption, not a retry.
      const redeemerScript = randomRedeemerScript()
      await requestRedemption(reservationKey, redeemerScript)
      expect(await bank.balanceOf(bridge.address)).to.equal(anchorAmount)

      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Reanchor,
          reanchorTx.info,
          proofFor(reanchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )

      await expect(tx)
        .to.emit(bridge, "ReservationActionSuperseded")
        .withArgs(reservationKey, 3)
      await expect(tx).not.to.emit(bridge, "ReservationRetryCreditMinted")

      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.retryCredit).to.be.false
      expect(
        (await bridge.reservationActions(reservationKey, 3)).state
      ).to.equal(ActionState.Superseded)
      expect(
        (await bridge.reservationActions(reservationKey, 3)).usedRetryCredit
      ).to.be.false
      expect(await bank.balanceOf(thirdParty.address)).to.equal(anchorAmount)
      expect(await bank.balanceOf(bridge.address)).to.equal(0)

      await bank
        .connect(thirdParty)
        .approveBalance(reservationVault.address, anchorAmount)
      await expect(
        reservationVault
          .connect(thirdParty)
          .retryRedeemReservation(reservationKey, randomRedeemerScript())
      ).to.be.revertedWith("No retry entitlement")
    })
  })

  describe("watchtower authorization enforcement in the proof path", () => {
    let redemptionWatchtower: Contract

    before(async () => {
      await createSnapshot()

      redemptionWatchtower = await helpers.contracts.getContract(
        "RedemptionWatchtower"
      )
      const watchtowerOwner = await impersonateContract(
        await redemptionWatchtower.owner()
      )
      const guardians = (await ethers.getSigners()).slice(10, 13)
      await redemptionWatchtower.connect(watchtowerOwner).enableWatchtower(
        governance.address,
        guardians.map((g) => g.address)
      )
      await bridge
        .connect(bridgeGovernanceSigner)
        .setRedemptionWatchtower(redemptionWatchtower.address)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("rejects a proof before the delay elapses and accepts it afterwards", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestRedemption(reservationKey, redeemerScript)

      // A Byzantine wallet signs and broadcasts immediately; the
      // transaction confirms on Bitcoin. The Bridge must not let it
      // finalize before the guardians' window closes.
      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4),
          },
        ]
      )

      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Redemption,
            redemptionTx.info,
            proofFor(redemptionTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            2
          )
      ).to.be.revertedWith("Watchtower delay has not elapsed")

      // Default delay is 2 hours.
      await increaseTime(7300)

      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          redemptionTx.info,
          proofFor(redemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )
      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionCompleted")
        .withArgs(reservationKey, 2, redemptionTx.txHash)
    })

    it("never settles a vetoed generation", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestRedemption(reservationKey, redeemerScript)

      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4),
          },
        ]
      )

      const guardians = (await ethers.getSigners()).slice(10, 13)
      await redemptionWatchtower
        .connect(guardians[0])
        .raiseReservedObjection(reservationKey, 2)
      await redemptionWatchtower
        .connect(guardians[1])
        .raiseReservedObjection(reservationKey, 2)
      await redemptionWatchtower
        .connect(guardians[2])
        .raiseReservedObjection(reservationKey, 2)

      expect(
        (await bridge.reservationActions(reservationKey, 2)).state
      ).to.equal(ActionState.Vetoed)

      // The early-signed transaction is unprovable forever: the signature
      // stays exposed to the fraud machinery, which is the intended
      // consequence of signing before authorization.
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Redemption,
            redemptionTx.info,
            proofFor(redemptionTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            2
          )
      ).to.be.revertedWith("Action is not settleable")
    })
  })

  describe("per-wallet dissolution lock (concurrent dissolutions)", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("serializes no-main-UTXO dissolutions of the same wallet", async () => {
      const first = await makeAcceptedReservation()
      const second = await makeAcceptedReservation()

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)

      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(first.reservationKey)

      // The second dissolution of the same wallet is locked out while the
      // first is in flight.
      await expect(
        bridge
          .connect(thirdParty)
          .requestReservationDissolution(second.reservationKey)
      ).to.be.revertedWith("Another dissolution is pending for the wallet")

      // Settle the first dissolution; its output becomes the main UTXO.
      const dissolutionFee = 500
      const firstTx = buildTx(
        [{ txHash: first.anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(dissolutionFee),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          firstTx.info,
          proofFor(firstTx.txHash),
          NO_MAIN_UTXO_PARAM,
          first.reservationKey,
          2
        )

      // The lock released; the second dissolution can now be requested,
      // and its snapshot records the new main UTXO -- the second
      // transaction must spend it (2-in-1-out).
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(second.reservationKey)

      const mainUtxo = {
        txHash: firstTx.txHash,
        txOutputIndex: 0,
        txOutputValue: anchorAmount.sub(dissolutionFee),
      }
      const secondTx = buildTx(
        [
          { txHash: second.anchorTx.txHash, index: 0 },
          { txHash: firstTx.txHash, index: 0 },
        ],
        [
          {
            valueSat: anchorAmount
              .sub(dissolutionFee)
              .add(anchorAmount)
              .sub(dissolutionFee),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          secondTx.info,
          proofFor(secondTx.txHash),
          mainUtxo,
          second.reservationKey,
          2
        )
      await expect(tx)
        .to.emit(bridge, "ReservationDissolved")
        .withArgs(second.reservationKey, 2, walletPubKeyHash, secondTx.txHash)
    })

    it("rearms a completed moving-funds timeout when dissolution creates a main UTXO", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await bridge.setWallet(walletPubKeyHash, {
        ...(await bridge.wallets(walletPubKeyHash)),
        state: walletState.MovingFunds,
        movingFundsRequestedAt: 0,
      })

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(reservationKey)

      const dissolutionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(500),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          dissolutionTx.info,
          proofFor(dissolutionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )

      const wallet = await bridge.wallets(walletPubKeyHash)
      expect(wallet.mainUtxoHash).not.to.equal(ZERO_BYTES32)
      expect(wallet.movingFundsRequestedAt).to.equal(await lastBlockTime())
    })

    it("strands a late dissolution output after the source wallet terminates", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      const supplyBefore = await tbtc.totalSupply()
      const reserveBefore = await tbtc.balanceOf(reservationVault.address)
      const debtBefore = await reservationVault.inKindFeeDebtSat()
      const ownerBalanceBefore = await tbtc.balanceOf(thirdParty.address)
      expect(debtBefore).to.equal(0)

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(reservationKey)

      // The dissolution generation times out and moves the source wallet
      // into MovingFunds. A subsequent moving-funds timeout terminates the
      // wallet before the already-confirmed dissolution proof reaches the
      // Bridge.
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])
      const { movingFundsTimeout } = await bridge.movingFundsParameters()
      await increaseTime(movingFundsTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyMovingFundsTimeout(walletPubKeyHash, [])
      expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
        walletState.Terminated
      )

      const dissolutionFee = 500
      const dissolutionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(dissolutionFee),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          dissolutionTx.info,
          proofFor(dissolutionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )
      await expect(tx)
        .to.emit(bridge, "ReservationLateSettled")
        .withArgs(reservationKey, 2, ActionType.Dissolution)
      await expect(tx)
        .to.emit(bridge, "ReservationDissolved")
        .withArgs(reservationKey, 2, walletPubKeyHash, dissolutionTx.txHash)
      await expect(tx)
        .to.emit(reservationVault, "InKindFeeFinanced")
        .withArgs(dissolutionFee, 0)

      const financedTbtc =
        BigNumber.from(dissolutionFee).mul(SATOSHI_MULTIPLIER)
      expect(await tbtc.totalSupply()).to.equal(supplyBefore.sub(financedTbtc))
      expect(await tbtc.balanceOf(reservationVault.address)).to.equal(
        reserveBefore.sub(financedTbtc)
      )
      expect(await reservationVault.inKindFeeDebtSat()).to.equal(debtBefore)
      expect(await tbtc.balanceOf(thirdParty.address)).to.equal(
        ownerBalanceBefore
      )

      const wallet = await bridge.wallets(walletPubKeyHash)
      expect(wallet.state).to.equal(walletState.Terminated)
      expect(wallet.mainUtxoHash).to.equal(ZERO_BYTES32)
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Stranded
      )
      expect(
        (await bridge.reservationActions(reservationKey, 2)).state
      ).to.equal(ActionState.Settled)
      expect(
        (await bridge.reservationParameters()).reservationTotalAmount
      ).to.equal(0)
      expect(await bridge.walletReservationsAmount(walletPubKeyHash)).to.equal(
        0
      )
      expect(await bridge.walletPendingDissolution(walletPubKeyHash)).to.equal(
        0
      )

      const outputKey = BigNumber.from(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [dissolutionTx.txHash, 0]
        )
      )
      expect((await bridge.movedFundsSweepRequests(outputKey)).state).to.equal(
        0
      )
      const anchorKey = BigNumber.from(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [anchorTx.txHash, 0]
        )
      )
      expect(await bridge.spentMainUTXOs(anchorKey)).to.equal(true)
    })

    it("clears a consumed main UTXO when a late dissolution settles after termination", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      const mainUtxo = {
        txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
        txOutputIndex: 1,
        txOutputValue: 7000000,
      }
      await bridge.setWalletMainUtxo(walletPubKeyHash, mainUtxo)

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(reservationKey)
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])
      const { movingFundsTimeout } = await bridge.movingFundsParameters()
      await increaseTime(movingFundsTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyMovingFundsTimeout(walletPubKeyHash, [])

      const dissolutionFee = 500
      const dissolutionTx = buildTx(
        [
          { txHash: anchorTx.txHash, index: 0 },
          { txHash: mainUtxo.txHash, index: mainUtxo.txOutputIndex },
        ],
        [
          {
            valueSat: anchorAmount
              .add(mainUtxo.txOutputValue)
              .sub(dissolutionFee),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          dissolutionTx.info,
          proofFor(dissolutionTx.txHash),
          mainUtxo,
          reservationKey,
          2
        )

      const wallet = await bridge.wallets(walletPubKeyHash)
      expect(wallet.state).to.equal(walletState.Terminated)
      expect(wallet.mainUtxoHash).to.equal(ZERO_BYTES32)
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Stranded
      )
      expect(await bridge.walletPendingDissolution(walletPubKeyHash)).to.equal(
        0
      )

      const mainUtxoKey = BigNumber.from(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [mainUtxo.txHash, mainUtxo.txOutputIndex]
        )
      )
      expect(await bridge.spentMainUTXOs(mainUtxoKey)).to.equal(true)
      const outputKey = BigNumber.from(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [dissolutionTx.txHash, 0]
        )
      )
      expect((await bridge.movedFundsSweepRequests(outputKey)).state).to.equal(
        0
      )
    })

    it("supersedes a cross-reservation lock when a late dissolution consumes its main UTXO", async () => {
      const first = await makeAcceptedReservation()
      const second = await makeAcceptedReservation()
      const mainUtxo = {
        txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
        txOutputIndex: 0,
        txOutputValue: 7000000,
      }
      await bridge.setWalletMainUtxo(walletPubKeyHash, mainUtxo)

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(first.reservationKey)

      // Generation A times out and releases the wallet lock, but its
      // confirmed Bitcoin transaction remains late-settleable.
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(first.reservationKey, [])

      // Generation B acquires the lock against the same registry main UTXO.
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(second.reservationKey)
      expect(await bridge.walletPendingDissolution(walletPubKeyHash)).to.equal(
        second.reservationKey
      )

      const dissolutionFee = 500
      const firstTx = buildTx(
        [
          { txHash: first.anchorTx.txHash, index: 0 },
          { txHash: mainUtxo.txHash, index: mainUtxo.txOutputIndex },
        ],
        [
          {
            valueSat: anchorAmount
              .add(mainUtxo.txOutputValue)
              .sub(dissolutionFee),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          firstTx.info,
          proofFor(firstTx.txHash),
          mainUtxo,
          first.reservationKey,
          2
        )

      await expect(tx)
        .to.emit(bridge, "ReservationActionSuperseded")
        .withArgs(second.reservationKey, 2)
      expect(
        (await bridge.reservationActions(second.reservationKey, 2)).state
      ).to.equal(ActionState.Superseded)
      expect((await bridge.reservations(second.reservationKey)).state).to.equal(
        ReservationState.Active
      )
      expect(await bridge.walletPendingDissolution(walletPubKeyHash)).to.equal(
        0
      )
    })

    it("re-registers a drifted dissolution output for the sweep machinery", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      await bridge.setWallet(walletPubKeyHash, {
        ecdsaWalletID: ethers.utils.randomBytes(32),
        mainUtxoHash: ZERO_BYTES32,
        pendingRedemptionsValue: 0,
        createdAt: await lastBlockTime(),
        movingFundsRequestedAt: await lastBlockTime(),
        closingStartedAt: 0,
        pendingMovedFundsSweepRequestsCount: 0,
        state: walletState.MovingFunds,
        movingFundsTargetWalletsCommitmentHash: ZERO_BYTES32,
      })

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(reservationKey)

      // The authorized 1-input dissolution confirms on Bitcoin, but before
      // its proof lands a deposit sweep registers a new main UTXO.
      const dissolutionFee = 500
      const dissolutionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(dissolutionFee),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )

      const sweepUtxo = {
        txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
        txOutputIndex: 0,
        txOutputValue: 1,
      }
      await bridge.setWalletMainUtxo(walletPubKeyHash, sweepUtxo)
      const driftedMainUtxoHash = (await bridge.wallets(walletPubKeyHash))
        .mainUtxoHash

      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          dissolutionTx.info,
          proofFor(dissolutionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )
      await expect(tx).to.emit(bridge, "ReservationDissolved")

      // The wallet's main UTXO is untouched; the dissolution output is
      // registered as a moved-funds sweep request instead.
      expect((await bridge.wallets(walletPubKeyHash)).mainUtxoHash).to.equal(
        driftedMainUtxoHash
      )
      const sweepRequest = await bridge.movedFundsSweepRequests(
        BigNumber.from(
          ethers.utils.solidityKeccak256(
            ["bytes32", "uint32"],
            [dissolutionTx.txHash, 0]
          )
        )
      )
      expect(sweepRequest.walletPubKeyHash).to.equal(walletPubKeyHash)
      expect(sweepRequest.value).to.equal(anchorAmount.sub(dissolutionFee))
      expect(
        (await bridge.wallets(walletPubKeyHash))
          .pendingMovedFundsSweepRequestsCount
      ).to.equal(1)

      // The drifted output remains a tracked obligation after the last
      // reservation closes, so even the below-dust path cannot put the
      // wallet in Closing and strand the sweep.
      await expect(
        bridge.notifyMovingFundsBelowDust(walletPubKeyHash, sweepUtxo)
      ).to.be.revertedWith("Wallet has pending moved funds sweep requests")
      expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
        walletState.MovingFunds
      )

      // The normal sweep proof path remains available and balances the
      // counter created by the dissolution settlement.
      await bridge.setMovedFundsSweepTxMaxTotalFee(2000)
      const movedFundsSweepTx = buildTx(
        [
          { txHash: dissolutionTx.txHash, index: 0 },
          { txHash: sweepUtxo.txHash, index: sweepUtxo.txOutputIndex },
        ],
        [
          {
            valueSat: anchorAmount.sub(dissolutionFee).sub(500).add(1),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )
      await bridge
        .connect(spvMaintainer)
        .submitMovedFundsSweepProof(
          movedFundsSweepTx.info,
          proofFor(movedFundsSweepTx.txHash),
          sweepUtxo
        )

      expect(
        (await bridge.wallets(walletPubKeyHash))
          .pendingMovedFundsSweepRequestsCount
      ).to.equal(0)
      expect(
        (
          await bridge.movedFundsSweepRequests(
            BigNumber.from(
              ethers.utils.solidityKeccak256(
                ["bytes32", "uint32"],
                [dissolutionTx.txHash, 0]
              )
            )
          )
        ).state
      ).to.equal(2) // Processed
    })
  })

  describe("capacity reserved before signing (fill-then-prove)", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("settles an authorized acceptance even after the caps fill up", async () => {
      // Authorize an acceptance while capacity is available.
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
                refundLocktime
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
        .requestReservationAcceptance(reservationKey, walletPubKeyHash)

      // The caps fill up after the authorization (a governance tightening
      // to the current usage level models any competing fill).
      const params = await bridge.reservationParameters()
      await bridge.connect(bridgeGovernanceSigner).updateReservationParameters(
        reservationVault.address,
        RESERVATION_MIN_AMOUNT,
        RESERVATION_TX_MAX_FEE,
        RESERVATION_TERM,
        RESERVATION_GRACE,
        params.reservationTotalAmount, // no room beyond what is reserved
        MAX_RESERVATIONS_PER_WALLET,
        RESERVATION_ACTION_TIMEOUT,
        RESERVATION_RENEWAL_WINDOW
      )

      // A new authorization cannot be created any more...
      const otherFundingTx = buildTx(
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
                refundLocktime
              )
            ),
          },
        ]
      )
      await bridge.connect(thirdParty).revealDeposit(otherFundingTx.info, {
        fundingOutputIndex: 0,
        blindingFactor,
        walletPubKeyHash,
        refundPubKeyHash,
        refundLocktime,
        vault: reservationVault.address,
      })
      await expect(
        bridge
          .connect(thirdParty)
          .requestReservationAcceptance(
            BigNumber.from(
              ethers.utils.solidityKeccak256(
                ["bytes32", "uint32"],
                [otherFundingTx.txHash, 0]
              )
            ),
            walletPubKeyHash
          )
      ).to.be.revertedWith("Total reserved amount cap exceeded")

      // ...but the already-authorized (and, on Bitcoin, already signed)
      // anchor still settles: capacity was reserved before signing.
      const anchorTx = buildTx(
        [{ txHash: fundingTx.txHash, index: 0 }],
        [{ valueSat: anchorAmount, script: p2wpkhScript(walletPubKeyHash) }]
      )
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Acceptance,
          anchorTx.info,
          proofFor(anchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          1
        )
      await expect(tx).to.emit(bridge, "ReservationAccepted")
    })
  })

  describe("acceptance authorization timeout", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("releases capacity, allows re-authorization, and still settles the late anchor", async () => {
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
                refundLocktime
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
        .requestReservationAcceptance(reservationKey, walletPubKeyHash)

      const totalBefore = (await bridge.reservationParameters())
        .reservationTotalAmount

      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      const timeoutTx = await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])
      await expect(timeoutTx)
        .to.emit(bridge, "ReservationActionTimedOut")
        .withArgs(reservationKey, 1, ActionType.Acceptance)

      // The reserved capacity was released.
      expect(
        (await bridge.reservationParameters()).reservationTotalAmount
      ).to.equal(totalBefore.sub(depositAmount))

      // The anchor -- signed while generation 1 was pending -- confirmed
      // on Bitcoin anyway. Its late proof still settles and re-takes the
      // capacity.
      const anchorTx = buildTx(
        [{ txHash: fundingTx.txHash, index: 0 }],
        [{ valueSat: anchorAmount, script: p2wpkhScript(walletPubKeyHash) }]
      )
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Acceptance,
          anchorTx.info,
          proofFor(anchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          1
        )
      await expect(tx)
        .to.emit(bridge, "ReservationLateSettled")
        .withArgs(reservationKey, 1, ActionType.Acceptance)
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Active
      )
    })
  })

  describe("reserved redemption gating", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("rejects requests at and after expiry (stranding bound)", async () => {
      const { reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      // Strictly pre-expiry: at/after expiry no new redemption generation
      // can be created; the dissolution delay is not an owner window.
      await increaseTime(RESERVATION_TERM + 1)

      const redemptionFee = grossTbtc.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(redemptionFee))
      await expect(
        reservationVault
          .connect(thirdParty)
          .redeemReservation(
            reservationKey,
            randomRedeemerScript(),
            redemptionFee
          )
      ).to.be.revertedWith("Reservation expired")
    })

    it("rejects requests while the wallet is not Live or MovingFunds", async () => {
      const { reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      await bridge.setWallet(walletPubKeyHash, {
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

      const redemptionFee = grossTbtc.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(redemptionFee))
      await expect(
        reservationVault
          .connect(thirdParty)
          .redeemReservation(
            reservationKey,
            randomRedeemerScript(),
            redemptionFee
          )
      ).to.be.revertedWith("Wallet must be in Live or MovingFunds state")
    })
  })

  describe("wallet lifecycle integration", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("keeps a reservation-holding wallet out of the Closing state", async () => {
      await makeAcceptedReservation()

      // A redemption-timeout-style transition of the (main-UTXO-less)
      // wallet must land in MovingFunds, not Closing: the wallet still
      // custodies an anchor.
      const secondReservation = await makeAcceptedReservation()
      const redeemerScript = randomRedeemerScript()
      await requestRedemption(secondReservation.reservationKey, redeemerScript)
      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(secondReservation.reservationKey, [])

      expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
        walletState.MovingFunds
      )
    })

    it("records a confirmed main-UTXO move while reservation obligations remain", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      const { movingFundsTx, tx } =
        await completeMovingFundsWhileReservationsRemain()

      await expect(tx)
        .to.emit(bridge, "MovingFundsCompleted")
        .withArgs(walletPubKeyHash, movingFundsTx.txHash)

      const sourceWallet = await bridge.wallets(walletPubKeyHash)
      expect(sourceWallet.mainUtxoHash).to.equal(ZERO_BYTES32)
      expect(sourceWallet.state).to.equal(walletState.MovingFunds)
      expect(sourceWallet.movingFundsRequestedAt).to.equal(0)
      expect(sourceWallet.movingFundsTargetWalletsCommitmentHash).to.equal(
        ZERO_BYTES32
      )

      const targetRequest = await bridge.movedFundsSweepRequests(
        BigNumber.from(
          ethers.utils.solidityKeccak256(
            ["bytes32", "uint32"],
            [movingFundsTx.txHash, 0]
          )
        )
      )
      expect(targetRequest.walletPubKeyHash).to.equal(secondWalletPubKeyHash)
      expect(targetRequest.state).to.equal(1) // Pending
      expect(
        (await bridge.wallets(secondWalletPubKeyHash))
          .pendingMovedFundsSweepRequestsCount
      ).to.equal(1)

      // Move the final reservation obligation away from the source wallet.
      // Its already-proven moving-funds generation must stay completed rather
      // than becoming slashable again when the retained count reaches zero.
      await bridge
        .connect(thirdParty)
        .requestReservationReanchor(reservationKey, secondWalletPubKeyHash)
      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(500),
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
          reservationKey,
          2
        )
      const { movingFundsTimeout } = await bridge.movingFundsParameters()
      await increaseTime(movingFundsTimeout + 1)
      await expect(
        bridge
          .connect(thirdParty)
          .notifyMovingFundsTimeout(walletPubKeyHash, [])
      ).to.be.revertedWith("Moving funds process already completed")
      expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
        walletState.MovingFunds
      )
    })

    it("terminates a completed MovingFunds wallet that refuses residual reservation dissolution", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      const { ecdsaWalletID } =
        await completeMovingFundsWhileReservationsRemain()

      const completedWallet = await bridge.wallets(walletPubKeyHash)
      expect(completedWallet.state).to.equal(walletState.MovingFunds)
      expect(completedWallet.movingFundsRequestedAt).to.equal(0)

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(reservationKey)

      const dissolutionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(500),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )

      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await walletRegistry.closeWallet.reset()
      await walletRegistry.seize.reset()
      const timeoutTx = await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      await expect(timeoutTx)
        .to.emit(bridge, "WalletTerminated")
        .withArgs(ecdsaWalletID, walletPubKeyHash)
      expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
        walletState.Terminated
      )
      await expectWalletSeized(ecdsaWalletID)
      expect(walletRegistry.closeWallet).to.have.been.calledWith(ecdsaWalletID)

      // A dissolution transaction that was already confirmed remains
      // late-settleable and supplies the evidence to strand the position.
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          dissolutionTx.info,
          proofFor(dissolutionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Stranded
      )
    })

    it("keeps the existing moving-funds path for a Live wallet after dissolution timeout", async () => {
      const { reservationKey } = await makeAcceptedReservation()

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(reservationKey)
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)

      await walletRegistry.closeWallet.reset()
      await walletRegistry.seize.reset()
      const tx = await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      await expect(tx).to.emit(bridge, "WalletMovingFunds")
      const wallet = await bridge.wallets(walletPubKeyHash)
      expect(wallet.state).to.equal(walletState.MovingFunds)
      expect(wallet.movingFundsRequestedAt).to.equal(await lastBlockTime())
      await expectWalletSeized(wallet.ecdsaWalletID)
      expect(walletRegistry.closeWallet).not.to.have.been.called
    })

    it("terminates an active MovingFunds wallet despite a reset deadline", async () => {
      const { reservationKey } = await makeAcceptedReservation()
      const movingFundsRequestedAt = await lastBlockTime()
      await bridge.setWallet(walletPubKeyHash, {
        ...(await bridge.wallets(walletPubKeyHash)),
        state: walletState.MovingFunds,
        movingFundsRequestedAt,
      })
      await bridge.setLiveWalletsCount(0)

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)
      await bridge.resetMovingFundsTimeout(walletPubKeyHash)
      const resetRequestedAt = (await bridge.wallets(walletPubKeyHash))
        .movingFundsRequestedAt
      expect(resetRequestedAt).to.be.greaterThan(movingFundsRequestedAt)

      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(reservationKey)
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)

      await walletRegistry.closeWallet.reset()
      await walletRegistry.seize.reset()
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      const wallet = await bridge.wallets(walletPubKeyHash)
      expect(wallet.state).to.equal(walletState.Terminated)
      expect(wallet.movingFundsRequestedAt).to.equal(resetRequestedAt)
      await expectWalletSeized(wallet.ecdsaWalletID)
      expect(walletRegistry.closeWallet).to.have.been.calledWith(
        wallet.ecdsaWalletID
      )
    })

    it("does not slash or terminate an already-Terminated wallet again", async () => {
      const { reservationKey } = await makeAcceptedReservation()

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(reservationKey)
      await bridge.setWallet(walletPubKeyHash, {
        ...(await bridge.wallets(walletPubKeyHash)),
        state: walletState.Terminated,
      })
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)

      await walletRegistry.closeWallet.reset()
      await walletRegistry.seize.reset()
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
        walletState.Terminated
      )
      expect(walletRegistry.seize).not.to.have.been.called
      expect(walletRegistry.closeWallet).not.to.have.been.called
    })
  })
})
