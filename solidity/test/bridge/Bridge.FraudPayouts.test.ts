/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers, helpers, waffle } from "hardhat"
import { expect } from "chai"
import proxyArtifact from "@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json"
import { walletState } from "../fixtures"

describe("Bridge - deferred fraud payouts", () => {
  const heartbeat = "0xFFFFFFFFFFFFFFFF0000000000E0EED7"
  const preimageSha256 = ethers.utils.sha256(heartbeat)
  const sighash = ethers.utils.sha256(preimageSha256)

  async function fixture() {
    // Only fraud-resolution state is needed. Use the real linked Bridge/Fraud
    // code without deploying unrelated staking, beacon and SPV fixtures.
    const [governance, treasury, thirdParty, proxyAdmin] =
      await ethers.getSigners()
    const libraries = Object.fromEntries(
      await Promise.all(
        [
          "Deposit",
          "DepositSweep",
          "Redemption",
          "Wallets",
          "Fraud",
          "MovingFunds",
        ].map(async (name) => {
          const library = await (
            await ethers.getContractFactory(
              `contracts/bridge/${name}.sol:${name}`
            )
          ).deploy()
          return [name, library.address]
        })
      )
    )
    const bridgeFactory = await ethers.getContractFactory("BridgeStub", {
      libraries,
    })
    const implementation = await bridgeFactory.deploy()
    const proxy = await new ethers.ContractFactory(
      proxyArtifact.abi,
      proxyArtifact.bytecode,
      governance
    ).deploy(
      implementation.address,
      proxyAdmin.address,
      bridgeFactory.interface.encodeFunctionData("initialize", [
        governance.address,
        governance.address,
        treasury.address,
        governance.address,
        governance.address,
        1,
      ])
    )
    const bridge = bridgeFactory.attach(proxy.address)
    const context = { bridge, governance, treasury, thirdParty }
    const receiver = await (
      await ethers.getContractFactory("FraudPayoutReceiver")
    ).deploy()
    const wallet = ethers.Wallet.createRandom()
    const publicKey = `0x${wallet.publicKey.substring(4)}`
    const pubKeyHash = ethers.utils.ripemd160(
      ethers.utils.sha256(ethers.utils.computePublicKey(wallet.publicKey, true))
    )
    const signature = ethers.utils.splitSignature(
      new ethers.utils.SigningKey(wallet.privateKey).signDigest(sighash)
    )
    const walletData = {
      ecdsaWalletID: ethers.constants.HashZero,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await helpers.time.lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    }
    await bridge.setWallet(pubKeyHash, walletData)
    const { fraudChallengeDepositAmount, fraudChallengeDefeatTimeout } =
      await bridge.fraudParameters()
    return {
      ...context,
      receiver,
      publicKey,
      pubKeyHash,
      signature,
      walletData,
      amount: fraudChallengeDepositAmount,
      timeout: fraudChallengeDefeatTimeout,
    }
  }

  async function defeatedTreasuryCredit(mode = 1) {
    const context = await waffle.loadFixture(fixture)
    const {
      bridge,
      governance,
      thirdParty,
      receiver,
      publicKey,
      signature,
      amount,
    } = context
    await receiver.setMode(mode)
    await bridge.connect(governance).updateTreasury(receiver.address)
    await bridge
      .connect(thirdParty)
      .submitFraudChallenge(publicKey, preimageSha256, signature, {
        value: amount,
      })
    const tx = await bridge.defeatFraudChallengeWithHeartbeat(
      publicKey,
      heartbeat
    )
    return { ...context, tx }
  }

  it("keeps ordinary treasury payouts immediate", async () => {
    const { bridge, treasury, thirdParty, publicKey, signature, amount } =
      await waffle.loadFixture(fixture)
    await bridge
      .connect(thirdParty)
      .submitFraudChallenge(publicKey, preimageSha256, signature, {
        value: amount,
      })
    const before = await ethers.provider.getBalance(treasury.address)
    await bridge.defeatFraudChallengeWithHeartbeat(publicKey, heartbeat)
    expect(await ethers.provider.getBalance(treasury.address)).to.equal(
      before.add(amount)
    )
    expect(
      await bridge.pendingFraudChallengePayouts(treasury.address)
    ).to.equal(0)
  })

  it("resolves the challenge and credits a rejecting treasury", async () => {
    const { bridge, receiver, amount, tx, publicKey } =
      await defeatedTreasuryCredit()
    await expect(tx)
      .to.emit(bridge, "FraudChallengePayoutDeferred")
      .withArgs(receiver.address, amount)
    const key = ethers.utils.keccak256(
      ethers.utils.solidityPack(["bytes", "bytes32"], [publicKey, sighash])
    )
    expect((await bridge.fraudChallenges(key)).resolved).to.be.true
    expect(
      await bridge.pendingFraudChallengePayouts(receiver.address)
    ).to.equal(amount)
  })

  it("lets only the beneficiary retry to an alternate receiver exactly once", async () => {
    const { bridge, receiver, thirdParty, amount } =
      await defeatedTreasuryCredit()
    await expect(
      bridge.connect(thirdParty).claimFraudChallengePayout(thirdParty.address)
    ).to.be.revertedWith("No pending fraud challenge payout")
    const before = await ethers.provider.getBalance(thirdParty.address)
    const data = bridge.interface.encodeFunctionData(
      "claimFraudChallengePayout",
      [thirdParty.address]
    )
    await receiver.execute(bridge.address, data)
    expect(await ethers.provider.getBalance(thirdParty.address)).to.equal(
      before.add(amount)
    )
    expect(
      await bridge.pendingFraudChallengePayouts(receiver.address)
    ).to.equal(0)
    await expect(receiver.execute(bridge.address, data)).to.be.revertedWith(
      "No pending fraud challenge payout"
    )
  })

  it("restores a credit after a failed claim", async () => {
    const { bridge, receiver, amount } = await defeatedTreasuryCredit()
    const data = bridge.interface.encodeFunctionData(
      "claimFraudChallengePayout",
      [receiver.address]
    )
    await expect(receiver.execute(bridge.address, data)).to.be.revertedWith(
      "Fraud challenge payout failed"
    )
    expect(
      await bridge.pendingFraudChallengePayouts(receiver.address)
    ).to.equal(amount)
  })

  it("restores a credit after a failed permissionless retry", async () => {
    const { bridge, receiver, thirdParty, amount } =
      await defeatedTreasuryCredit()
    await expect(
      bridge.connect(thirdParty).retryFraudChallengePayout(receiver.address)
    ).to.be.revertedWith("Fraud challenge payout failed")
    expect(
      await bridge.pendingFraudChallengePayouts(receiver.address)
    ).to.equal(amount)
  })

  it("rejects a zero recipient without consuming the credit", async () => {
    const { bridge, receiver, amount } = await defeatedTreasuryCredit()
    const data = bridge.interface.encodeFunctionData(
      "claimFraudChallengePayout",
      [ethers.constants.AddressZero]
    )
    await expect(receiver.execute(bridge.address, data)).to.be.revertedWith(
      "Recipient must not be 0x0"
    )
    expect(
      await bridge.pendingFraudChallengePayouts(receiver.address)
    ).to.equal(amount)
  })

  it("can pay a storage-writing receiver beyond the push budget on retry", async () => {
    const { bridge, receiver, amount } = await defeatedTreasuryCredit(2)
    expect(
      await bridge.pendingFraudChallengePayouts(receiver.address)
    ).to.equal(amount)
    const data = bridge.interface.encodeFunctionData(
      "claimFraudChallengePayout",
      [receiver.address]
    )
    await receiver.execute(bridge.address, data)
    expect(await receiver.received()).to.equal(amount)
    expect(
      await bridge.pendingFraudChallengePayouts(receiver.address)
    ).to.equal(0)
  })

  it("clears the credit before calling a reentrant receiver", async () => {
    const { bridge, receiver, amount } = await defeatedTreasuryCredit()
    await receiver.setMode(3)
    const data = bridge.interface.encodeFunctionData(
      "claimFraudChallengePayout",
      [receiver.address]
    )
    await receiver.execute(bridge.address, data)
    expect(await receiver.reentrySucceeded()).to.be.false
    expect(await receiver.received()).to.equal(amount)
    expect(
      await bridge.pendingFraudChallengePayouts(receiver.address)
    ).to.equal(0)
  })

  it("lets a third party retry payment only to the original beneficiary", async () => {
    const { bridge, receiver, thirdParty, amount } =
      await defeatedTreasuryCredit(2)
    await bridge.connect(thirdParty).retryFraudChallengePayout(receiver.address)
    expect(await receiver.received()).to.equal(amount)
    expect(
      await bridge.pendingFraudChallengePayouts(receiver.address)
    ).to.equal(0)
    await expect(
      bridge.connect(thirdParty).retryFraudChallengePayout(receiver.address)
    ).to.be.revertedWith("No pending fraud challenge payout")
  })

  it("credits the challenger when a timed-out challenge refund fails", async () => {
    const {
      bridge,
      receiver,
      publicKey,
      pubKeyHash,
      signature,
      walletData,
      amount,
      timeout,
    } = await waffle.loadFixture(fixture)
    await receiver.setMode(1)
    await receiver.execute(
      bridge.address,
      bridge.interface.encodeFunctionData("submitFraudChallenge", [
        publicKey,
        preimageSha256,
        signature,
      ]),
      { value: amount }
    )
    await helpers.time.increaseTime(timeout)
    await bridge.setWallet(pubKeyHash, {
      ...walletData,
      state: walletState.Terminated,
    })
    await expect(
      bridge.notifyFraudChallengeDefeatTimeout(publicKey, [], preimageSha256)
    )
      .to.emit(bridge, "FraudChallengePayoutDeferred")
      .withArgs(receiver.address, amount)
    expect(
      await bridge.pendingFraudChallengePayouts(receiver.address)
    ).to.equal(amount)
  })
})
