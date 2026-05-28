/* eslint-disable no-underscore-dangle */
import { BigNumber } from "ethers"
import { ethers, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import chai, { expect } from "chai"
import { smock, FakeContract } from "@defi-wonderland/smock"
import type {
  EcdsaFraudRouter,
  IBridgeForFraud,
  RevertingEcdsaFraudChallenger,
} from "../../typechain"
import {
  constants,
  movedFundsSweepRequestState,
  walletState,
} from "../fixtures"
import {
  FraudTestData,
  nonWitnessSignSingleInputTx,
  wallet as fraudWallet,
  wrongSighashType,
} from "../data/fraud"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime, lastBlockTime } = helpers.time
const { HashZero, AddressZero: ZeroAddress } = ethers.constants

async function expectBalanceDelta(
  tx: { blockNumber?: number; from: string; wait: () => Promise<any> },
  target: { address: string } | string,
  expectedDelta: BigNumber
) {
  const address = typeof target === "string" ? target : target.address
  const before = await ethers.provider.getBalance(address, tx.blockNumber! - 1)
  const after = await ethers.provider.getBalance(address, tx.blockNumber!)
  let delta = after.sub(before)
  if (address.toLowerCase() === tx.from.toLowerCase()) {
    const receipt = await tx.wait()
    delta = delta.add(receipt.gasUsed.mul(receipt.effectiveGasPrice))
  }
  expect(delta).to.equal(expectedDelta)
}

describe("EcdsaFraudRouter", () => {
  let thirdParty: SignerWithAddress
  let treasury: SignerWithAddress
  let bridge: FakeContract<IBridgeForFraud>
  let ecdsaFraudRouter: EcdsaFraudRouter
  let fraudChallengeDepositAmount: BigNumber
  let fraudChallengeDefeatTimeout: number
  let fraudSlashingAmount: BigNumber
  let fraudNotifierRewardMultiplier: number

  beforeEach(async () => {
    await createSnapshot()

    const [thirdPartySigner, treasurySigner] =
      await helpers.signers.getUnnamedSigners()
    thirdParty = thirdPartySigner
    treasury = treasurySigner
    bridge = await smock.fake<IBridgeForFraud>("IBridgeForFraud")

    fraudChallengeDepositAmount = constants.fraudChallengeDepositAmount
    fraudChallengeDefeatTimeout = constants.fraudChallengeDefeatTimeout
    fraudSlashingAmount = constants.fraudSlashingAmount
    fraudNotifierRewardMultiplier = constants.fraudNotifierRewardMultiplier

    bridge.fraudParameters.returns([
      fraudChallengeDepositAmount,
      fraudChallengeDefeatTimeout,
      fraudSlashingAmount,
      fraudNotifierRewardMultiplier,
    ])
    bridge.treasury.returns(treasury.address)
    bridge.activeWalletPubKeyHash.returns(ZeroAddress)
    bridge.activeWalletID.returns(HashZero)
    bridge.walletID.returns(fraudWallet.ecdsaWalletID)
    bridge.walletPubKeyHashForWalletID.returns(fraudWallet.pubKeyHash160)
    bridge.deposits.returns({
      depositor: ZeroAddress,
      amount: 0,
      revealedAt: 0,
      vault: ZeroAddress,
      treasuryFee: 0,
      sweptAt: 0,
      extraData: HashZero,
    })
    bridge.spentMainUTXOs.returns(false)
    bridge.movedFundsSweepRequests.returns({
      walletPubKeyHash: ZeroAddress,
      value: 0,
      createdAt: 0,
      state: movedFundsSweepRequestState.Unknown,
    })

    bridge.wallets.whenCalledWith(fraudWallet.pubKeyHash160).returns({
      ecdsaWalletID: fraudWallet.ecdsaWalletID,
      mainUtxoHash: HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: HashZero,
    })

    const EcdsaFraudRouterFactory = await ethers.getContractFactory(
      "EcdsaFraudRouter"
    )
    ecdsaFraudRouter = (await EcdsaFraudRouterFactory.deploy(
      bridge.address
    )) as EcdsaFraudRouter
    await ecdsaFraudRouter.deployed()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  const challengeKey = (data: FraudTestData) =>
    ethers.BigNumber.from(
      ethers.utils.solidityKeccak256(
        ["bytes", "bytes32"],
        [fraudWallet.publicKey, data.sighash]
      )
    )

  const submitChallenge = (data: FraudTestData = nonWitnessSignSingleInputTx) =>
    ecdsaFraudRouter
      .connect(thirdParty)
      .submitFraudChallenge(
        fraudWallet.publicKey,
        data.preimageSha256,
        data.signature,
        {
          value: fraudChallengeDepositAmount,
        }
      )

  const utxoKey = (utxo: {
    txHash: string | Uint8Array
    txOutputIndex: number
  }) =>
    ethers.BigNumber.from(
      ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [utxo.txHash, utxo.txOutputIndex]
      )
    )

  const markHonestlySpent = async (data: FraudTestData) => {
    data.deposits.forEach((deposit) => {
      bridge.deposits.whenCalledWith(utxoKey(deposit)).returns({
        depositor: ZeroAddress,
        amount: deposit.txOutputValue,
        revealedAt: 1,
        vault: ZeroAddress,
        treasuryFee: 0,
        sweptAt: 1,
        extraData: HashZero,
      })
    })

    data.spentMainUtxos.forEach((spentMainUtxo) => {
      bridge.spentMainUTXOs.whenCalledWith(utxoKey(spentMainUtxo)).returns(true)
    })

    data.movedFundsSweepRequests.forEach((request) => {
      bridge.movedFundsSweepRequests.whenCalledWith(utxoKey(request)).returns({
        walletPubKeyHash: fraudWallet.pubKeyHash160,
        value: request.txOutputValue,
        createdAt: 1,
        state: movedFundsSweepRequestState.Processed,
      })
    })
  }

  it("submits and stores an ECDSA fraud challenge", async () => {
    const data = nonWitnessSignSingleInputTx
    const tx = await submitChallenge(data)

    await expectBalanceDelta(
      tx,
      ecdsaFraudRouter.address,
      fraudChallengeDepositAmount
    )

    const challenge = await ecdsaFraudRouter.fraudChallenges(challengeKey(data))
    expect(challenge.challenger).to.equal(thirdParty.address)
    expect(challenge.depositAmount).to.equal(fraudChallengeDepositAmount)
    expect(challenge.reportedAt).to.equal(await lastBlockTime())
    expect(challenge.resolved).to.equal(false)
    expect(await ecdsaFraudRouter.openFraudChallengeCount()).to.equal(1)

    await expect(tx)
      .to.emit(ecdsaFraudRouter, "FraudChallengeSubmitted")
      .withArgs(
        fraudWallet.pubKeyHash160,
        data.sighash,
        data.signature.v,
        data.signature.r,
        data.signature.s
      )
  })

  it("rejects duplicate ECDSA fraud challenges", async () => {
    await submitChallenge()

    await expect(submitChallenge()).to.be.revertedWith(
      "Fraud challenge already exists"
    )
  })

  it("rejects FROST wallets even when they are not the active wallet", async () => {
    bridge.wallets.whenCalledWith(fraudWallet.pubKeyHash160).returns({
      ecdsaWalletID: HashZero,
      mainUtxoHash: HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: HashZero,
    })

    await expect(submitChallenge()).to.be.revertedWith(
      "Legacy ECDSA wallet required"
    )
  })

  it("defeats a fraud challenge and forwards the deposit to treasury", async () => {
    const data = nonWitnessSignSingleInputTx
    await submitChallenge(data)
    await markHonestlySpent(data)

    const tx = await ecdsaFraudRouter.defeatFraudChallenge(
      fraudWallet.publicKey,
      data.preimage,
      data.witness
    )

    await expectBalanceDelta(tx, treasury, fraudChallengeDepositAmount)
    expect(
      (await ecdsaFraudRouter.fraudChallenges(challengeKey(data))).resolved
    ).to.equal(true)
    expect(await ecdsaFraudRouter.openFraudChallengeCount()).to.equal(0)
    await expect(tx)
      .to.emit(ecdsaFraudRouter, "FraudChallengeDefeated")
      .withArgs(fraudWallet.pubKeyHash160, data.sighash)
  })

  it("rejects defeat with a wrong sighash type", async () => {
    const data = wrongSighashType
    await submitChallenge(data)
    await markHonestlySpent(data)

    await expect(
      ecdsaFraudRouter.defeatFraudChallenge(
        fraudWallet.publicKey,
        data.preimage,
        data.witness
      )
    ).to.be.revertedWith("Wrong sighash type")
  })

  it("rejects defeat when the signed UTXO is not honestly spent", async () => {
    const data = nonWitnessSignSingleInputTx
    await submitChallenge(data)

    await expect(
      ecdsaFraudRouter.defeatFraudChallenge(
        fraudWallet.publicKey,
        data.preimage,
        data.witness
      )
    ).to.be.revertedWith("Spent UTXO not found among correctly spent UTXOs")
  })

  it("rejects timeout before the challenge defeat period elapses", async () => {
    const data = nonWitnessSignSingleInputTx
    await submitChallenge(data)

    await expect(
      ecdsaFraudRouter.notifyFraudChallengeDefeatTimeout(
        fraudWallet.publicKey,
        [1, 2, 3],
        data.preimageSha256
      )
    ).to.be.revertedWith("Fraud challenge defeat period did not time out yet")
  })

  it("rejects timeout after the challenge has been defeated", async () => {
    const data = nonWitnessSignSingleInputTx
    await submitChallenge(data)
    await markHonestlySpent(data)
    await ecdsaFraudRouter.defeatFraudChallenge(
      fraudWallet.publicKey,
      data.preimage,
      data.witness
    )
    await increaseTime(fraudChallengeDefeatTimeout)

    await expect(
      ecdsaFraudRouter.notifyFraudChallengeDefeatTimeout(
        fraudWallet.publicKey,
        [1, 2, 3],
        data.preimageSha256
      )
    ).to.be.revertedWith("Fraud challenge has already been resolved")
  })

  it("times out a fraud challenge, refunds the challenger, seizes stake, and terminates the wallet", async () => {
    const data = nonWitnessSignSingleInputTx
    const walletMembersIDs = [1, 2, 3]
    await submitChallenge(data)
    await increaseTime(fraudChallengeDefeatTimeout)

    const tx = await ecdsaFraudRouter
      .connect(thirdParty)
      .notifyFraudChallengeDefeatTimeout(
        fraudWallet.publicKey,
        walletMembersIDs,
        data.preimageSha256
      )

    await expectBalanceDelta(tx, thirdParty, fraudChallengeDepositAmount)
    expect(bridge.slashWalletForFraud).to.have.been.calledWith(
      fraudWallet.pubKeyHash160,
      walletMembersIDs,
      thirdParty.address
    )
    expect(
      (await ecdsaFraudRouter.fraudChallenges(challengeKey(data))).resolved
    ).to.equal(true)
    expect(await ecdsaFraudRouter.openFraudChallengeCount()).to.equal(0)
    await expect(tx)
      .to.emit(ecdsaFraudRouter, "FraudChallengeDefeatTimedOut")
      .withArgs(fraudWallet.pubKeyHash160, data.sighash)
  })

  it("does not block timeout slashing when the challenger refund reverts", async () => {
    const data = nonWitnessSignSingleInputTx
    const walletMembersIDs = [1, 2, 3]
    const RevertingChallengerFactory = await ethers.getContractFactory(
      "RevertingEcdsaFraudChallenger"
    )
    const revertingChallenger = (await RevertingChallengerFactory.deploy(
      ecdsaFraudRouter.address
    )) as RevertingEcdsaFraudChallenger
    await revertingChallenger.deployed()

    await revertingChallenger.submitFraudChallenge(
      fraudWallet.publicKey,
      data.preimageSha256,
      data.signature,
      {
        value: fraudChallengeDepositAmount,
      }
    )
    await increaseTime(fraudChallengeDefeatTimeout)

    const routerBalanceBefore = await ethers.provider.getBalance(
      ecdsaFraudRouter.address
    )
    const tx = await revertingChallenger.notifyFraudChallengeDefeatTimeout(
      fraudWallet.publicKey,
      walletMembersIDs,
      data.preimageSha256
    )

    expect(await ethers.provider.getBalance(ecdsaFraudRouter.address)).to.equal(
      routerBalanceBefore
    )
    expect(bridge.slashWalletForFraud).to.have.been.calledWith(
      fraudWallet.pubKeyHash160,
      walletMembersIDs,
      revertingChallenger.address
    )
    expect(
      (await ecdsaFraudRouter.fraudChallenges(challengeKey(data))).resolved
    ).to.equal(true)
    expect(await ecdsaFraudRouter.openFraudChallengeCount()).to.equal(0)
    await expect(tx)
      .to.emit(ecdsaFraudRouter, "FraudChallengeDefeatTimedOut")
      .withArgs(fraudWallet.pubKeyHash160, data.sighash)
  })
})
