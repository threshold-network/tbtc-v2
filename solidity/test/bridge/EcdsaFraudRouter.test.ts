/* eslint-disable no-underscore-dangle */
import { BigNumber } from "ethers"
import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import chai, { expect } from "chai"
import { smock, FakeContract } from "@defi-wonderland/smock"
import type {
  Bridge,
  BridgeStub,
  EcdsaFraudRouter,
  IWalletRegistry,
  RevertingEcdsaFraudChallenger,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { walletState } from "../fixtures"
import {
  FraudTestData,
  nonWitnessSignSingleInputTx,
  wallet as fraudWallet,
  wrongSighashType,
} from "../data/fraud"

chai.use(smock.matchers)

const { increaseTime, lastBlockTime } = helpers.time

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
  let walletRegistry: FakeContract<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let ecdsaFraudRouter: EcdsaFraudRouter
  let fraudChallengeDepositAmount: BigNumber
  let fraudChallengeDefeatTimeout: number

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ thirdParty, treasury, walletRegistry, bridge, ecdsaFraudRouter } =
      await waffle.loadFixture(bridgeFixture))

    const fraudParameters = await bridge.fraudParameters()
    fraudChallengeDepositAmount = fraudParameters.fraudChallengeDepositAmount
    fraudChallengeDefeatTimeout = fraudParameters.fraudChallengeDefeatTimeout

    await bridge.setWallet(fraudWallet.pubKeyHash160, {
      ecdsaWalletID: fraudWallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })
  })

  afterEach(async () => {
    walletRegistry.seize.reset()
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

  const markHonestlySpent = async (data: FraudTestData) => {
    await bridge.setSweptDeposits(data.deposits)
    await bridge.setSpentMainUtxos(data.spentMainUtxos)
    await bridge.setProcessedMovedFundsSweepRequests(
      data.movedFundsSweepRequests
    )
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
    await bridge.setWallet(fraudWallet.pubKeyHash160, {
      ecdsaWalletID: ethers.constants.HashZero,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
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
    expect(walletRegistry.seize).to.have.been.calledWith(
      (await bridge.fraudParameters()).fraudSlashingAmount,
      (await bridge.fraudParameters()).fraudNotifierRewardMultiplier,
      thirdParty.address,
      fraudWallet.ecdsaWalletID,
      walletMembersIDs
    )
    expect(
      (await ecdsaFraudRouter.fraudChallenges(challengeKey(data))).resolved
    ).to.equal(true)
    expect(await ecdsaFraudRouter.openFraudChallengeCount()).to.equal(0)
    expect((await bridge.wallets(fraudWallet.pubKeyHash160)).state).to.equal(
      walletState.Terminated
    )
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
    expect(walletRegistry.seize).to.have.been.calledWith(
      (await bridge.fraudParameters()).fraudSlashingAmount,
      (await bridge.fraudParameters()).fraudNotifierRewardMultiplier,
      revertingChallenger.address,
      fraudWallet.ecdsaWalletID,
      walletMembersIDs
    )
    expect(
      (await ecdsaFraudRouter.fraudChallenges(challengeKey(data))).resolved
    ).to.equal(true)
    expect(await ecdsaFraudRouter.openFraudChallengeCount()).to.equal(0)
    expect((await bridge.wallets(fraudWallet.pubKeyHash160)).state).to.equal(
      walletState.Terminated
    )
    await expect(tx)
      .to.emit(ecdsaFraudRouter, "FraudChallengeDefeatTimedOut")
      .withArgs(fraudWallet.pubKeyHash160, data.sighash)
  })
})
