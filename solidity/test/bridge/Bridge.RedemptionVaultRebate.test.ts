/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import chai, { expect } from "chai"
import { BigNumber, Contract, ContractTransaction } from "ethers"
import type { FakeContract } from "@defi-wonderland/smock"
import { smock } from "@defi-wonderland/smock"
import type {
  Bank,
  BankStub,
  Bridge,
  BridgeStub,
  BridgeGovernance,
  IWalletRegistry,
  RebateStaking,
} from "../../typechain"
import { walletState } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"
import { to1e18 } from "../helpers/contract-test-helpers"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time
const { impersonateAccount } = helpers.account

// Shared stake amount used across all staking scenarios (5 T tokens).
const stakeAmount = to1e18(5)

/**
 * Encodes the redemption data payload expected by
 * Bridge.receiveBalanceApproval for vault-path redemptions.
 */
function encodeRedemptionData(
  redeemer: string,
  pubKeyHash: string,
  utxo: { txHash: string; txOutputIndex: number; txOutputValue: number },
  outputScript: string
): string {
  return ethers.utils.defaultAbiCoder.encode(
    ["address", "bytes20", "bytes32", "uint32", "uint64", "bytes"],
    [
      redeemer,
      pubKeyHash,
      utxo.txHash,
      utxo.txOutputIndex,
      utxo.txOutputValue,
      outputScript,
    ]
  )
}

/**
 * Creates a Live wallet on the bridge with the given main UTXO.
 * Uses HashZero for ecdsaWalletID unless overridden.
 */
async function setupWallet(
  bridge: Bridge & BridgeStub,
  pubKeyHash: string,
  utxo: { txHash: string; txOutputIndex: number; txOutputValue: number },
  ecdsaWalletID: string = ethers.constants.HashZero
): Promise<void> {
  await bridge.setWallet(pubKeyHash, {
    ecdsaWalletID,
    mainUtxoHash: ethers.constants.HashZero,
    pendingRedemptionsValue: 0,
    createdAt: await lastBlockTime(),
    movingFundsRequestedAt: 0,
    closingStartedAt: 0,
    pendingMovedFundsSweepRequestsCount: 0,
    state: walletState.Live,
    movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
  })
  await bridge.setWalletMainUtxo(pubKeyHash, utxo)
}

/**
 * Mints T tokens for an account, approves, and stakes them in RebateStaking.
 */
async function stakeTokens(
  t: Contract,
  rebateStaking: RebateStaking,
  minter: SignerWithAddress,
  staker: SignerWithAddress,
  amount: BigNumber = stakeAmount
): Promise<void> {
  await t.connect(minter).mint(staker.address, amount)
  await t.connect(staker).approve(rebateStaking.address, amount)
  await rebateStaking.connect(staker).stake(amount)
}

describe("Bridge - Vault-Path Redemption Rebate", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let deployer: SignerWithAddress

  let bank: Bank & BankStub
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let t: Contract
  let rebateStaking: RebateStaking
  let walletRegistry: FakeContract<IWalletRegistry>

  let redemptionTimeout: number

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      thirdParty,
      bank,
      bridge,
      bridgeGovernance,
      t,
      rebateStaking,
      walletRegistry,
    } = await waffle.loadFixture(bridgeFixture))

    // Set the redemption dust threshold to 0.001 BTC (10x smaller than
    // the initial value) to save test Bitcoins.
    await bridge.setRedemptionDustThreshold(100000)
    // Set the moving funds dust threshold below redemption dust threshold.
    await bridgeGovernance
      .connect(governance)
      .beginMovingFundsDustThresholdUpdate(20000)
    await increaseTime(await bridgeGovernance.governanceDelays(0))
    await bridgeGovernance
      .connect(governance)
      .finalizeMovingFundsDustThresholdUpdate()
    // Adjust redemption TX max fee by the same 10x scale.
    await bridgeGovernance
      .connect(governance)
      .beginRedemptionTxMaxFeeUpdate(10000)
    await increaseTime(await bridgeGovernance.governanceDelays(0))
    await bridgeGovernance
      .connect(governance)
      .finalizeRedemptionTxMaxFeeUpdate()

    await bridgeGovernance
      .connect(governance)
      .setRebateStaking(rebateStaking.address)

    redemptionTimeout = (await bridge.redemptionParameters()).redemptionTimeout
  })

  describe("receiveBalanceApproval with rebate staking", () => {
    const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
    // Requested amount is 1901000 satoshi.
    const requestedAmount = BigNumber.from(1901000)
    // Treasury fee is requestedAmount / redemptionTreasuryFeeDivisor
    // where the divisor is 2000 initially: 1901000 / 2000 = 950.5
    // Solidity truncates to 950.
    const treasuryFee = 950

    let balanceOwner: SignerWithAddress
    let redeemerAddress: string
    let redeemerSigner: SignerWithAddress

    const redeemerOutputScript =
      "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"

    const mainUtxo = {
      txHash:
        "0x3835ecdee2daa83c9a19b5012104ace55ecab197b5e16489c26d372e475f5d2a",
      txOutputIndex: 0,
      txOutputValue: 10000000,
    }

    before(async () => {
      await createSnapshot()

      // Use thirdParty as balanceOwner (the Vault in real scenario).
      balanceOwner = thirdParty

      // Resolve unnamed accounts once and destructure the ones needed
      // across all scenarios.
      const unnamedAccounts = await getUnnamedAccounts()
      // eslint-disable-next-line prefer-destructuring
      redeemerAddress = unnamedAccounts[10]

      // Get a signer for the redeemer address so we can stake T tokens.
      redeemerSigner = await impersonateAccount(redeemerAddress, {
        from: deployer,
        value: 10,
      })

      // Give the balance owner enough Bank balance for all vault-path
      // redemptions in this describe block.
      await bank.setBalance(balanceOwner.address, requestedAmount.mul(6))

      // Set up the wallet as Live with a main UTXO and a non-zero
      // ecdsaWalletID (required for timeout scenario slashing).
      await setupWallet(
        bridge,
        walletPubKeyHash,
        mainUtxo,
        ethers.utils.keccak256("0x01")
      )
      await bridge.setActiveWallet(walletPubKeyHash)

      // Stake T tokens for the REDEEMER (not the balanceOwner).
      // This ensures only the redeemer has a rebate cap.
      await stakeTokens(t, rebateStaking, deployer, redeemerSigner)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context(
      "when redeemer is staked but has not authorized balanceOwner",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          const data = encodeRedemptionData(
            redeemerAddress,
            walletPubKeyHash,
            mainUtxo,
            redeemerOutputScript
          )

          // Execute the vault-path redemption via Bank.approveBalanceAndCall.
          // balanceOwner != redeemer and the redeemer has not authorized
          // balanceOwner via setRebateAuthorization. Under v2 soft-fail, the
          // redemption must proceed with no rebate applied.
          tx = await bank
            .connect(balanceOwner)
            .approveBalanceAndCall(bridge.address, requestedAmount, data)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should not revert", async () => {
          const receipt = await tx.wait()
          expect(receipt.status).to.be.equal(1)
        })

        it("should not emit RebateReceived", async () => {
          // No authorization, so applyForRebate is not called and no event
          // is emitted, even though the redeemer has a non-zero rebate cap.
          await expect(tx).to.not.emit(rebateStaking, "RebateReceived")
        })

        it("should store the full treasury fee in the redemption request", async () => {
          const redemptionKey = buildRedemptionKey(
            walletPubKeyHash,
            redeemerOutputScript
          )
          const redemptionRequest = await bridge.pendingRedemptions(
            redemptionKey
          )
          // No rebate was applied; the full treasuryFee remains.
          expect(redemptionRequest.treasuryFee).to.be.equal(treasuryFee)
        })

        it("should leave the redeemer's available rebate unchanged", async () => {
          const availableRebate = await rebateStaking.getAvailableRebate(
            redeemerAddress
          )
          const rebateCap = await rebateStaking.getRebateCap(redeemerAddress)
          // The redeemer's full rebate cap is intact because no rebate was
          // applied. This is the property that closes the spoof primitive.
          expect(availableRebate).to.be.equal(rebateCap)
        })
      }
    )

    context("when redeemer is staked and has authorized balanceOwner", () => {
      let tx: ContractTransaction
      // Use a different output script to avoid collision with the prior
      // context (the redemption key depends on the output script).
      const authorizedOutputScript =
        "0x160014a2b3c4d5e6f7081929304a5b6c7d8e9f0a1b2c3d"

      before(async () => {
        await createSnapshot()

        // Redeemer authorizes the balance owner.
        await rebateStaking
          .connect(redeemerSigner)
          .setRebateAuthorization(balanceOwner.address, true)

        const data = encodeRedemptionData(
          redeemerAddress,
          walletPubKeyHash,
          mainUtxo,
          authorizedOutputScript
        )

        tx = await bank
          .connect(balanceOwner)
          .approveBalanceAndCall(bridge.address, requestedAmount, data)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit RebateReceived for the redeemer", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "RebateReceived")
          .withArgs(redeemerAddress, treasuryFee)
      })

      it("should store reduced treasury fee in the redemption request", async () => {
        const redemptionKey = buildRedemptionKey(
          walletPubKeyHash,
          authorizedOutputScript
        )
        const redemptionRequest = await bridge.pendingRedemptions(redemptionKey)
        // The redeemer's rebate cap exceeds the fee, so the stored fee
        // drops to 0 after rebate application.
        expect(redemptionRequest.treasuryFee).to.be.equal(0)
      })

      it("should decrease available rebate for the redeemer", async () => {
        const availableRebate = await rebateStaking.getAvailableRebate(
          redeemerAddress
        )
        const rebateCap = await rebateStaking.getRebateCap(redeemerAddress)
        expect(availableRebate.lt(rebateCap)).to.be.true
      })
    })

    context("when authorized vault-path redemption times out", () => {
      let tx: ContractTransaction
      let initialRedeemerBalance: BigNumber
      let availableRebateBeforeTimeout: BigNumber

      const walletMembersIDs = [1, 2, 3, 4, 5]
      // Use a different output script for this scenario.
      const timeoutOutputScript =
        "0x160014b3c4d5e6f7a8091929304a5b6c7d8e9f0a1b2c3d"

      before(async () => {
        await createSnapshot()

        // Authorize and request a rebate-eligible vault-path redemption.
        await rebateStaking
          .connect(redeemerSigner)
          .setRebateAuthorization(balanceOwner.address, true)

        const data = encodeRedemptionData(
          redeemerAddress,
          walletPubKeyHash,
          mainUtxo,
          timeoutOutputScript
        )

        await bank
          .connect(balanceOwner)
          .approveBalanceAndCall(bridge.address, requestedAmount, data)

        availableRebateBeforeTimeout = await rebateStaking.getAvailableRebate(
          redeemerAddress
        )
        initialRedeemerBalance = await bank.balanceOf(redeemerAddress)

        await increaseTime(redemptionTimeout)

        tx = await bridge
          .connect(thirdParty)
          .notifyRedemptionTimeout(
            walletPubKeyHash,
            walletMembersIDs,
            timeoutOutputScript
          )
      })

      after(async () => {
        walletRegistry.seize.reset()
        await restoreSnapshot()
      })

      it("should emit RebateCanceled for the redeemer", async () => {
        await expect(tx).to.emit(rebateStaking, "RebateCanceled")
      })

      it("should restore available rebate for the redeemer", async () => {
        const availableRebateAfterTimeout =
          await rebateStaking.getAvailableRebate(redeemerAddress)
        expect(availableRebateAfterTimeout.gt(availableRebateBeforeTimeout)).to
          .be.true
      })

      it("should return the requested amount to the redeemer", async () => {
        const currentRedeemerBalance = await bank.balanceOf(redeemerAddress)
        expect(currentRedeemerBalance).to.be.equal(
          initialRedeemerBalance.add(requestedAmount)
        )
      })
    })

    context("when unauthorized vault-path redemption times out", () => {
      let tx: ContractTransaction
      let initialRedeemerBalance: BigNumber
      let rebateCapBeforeTimeout: BigNumber

      const walletMembersIDs = [1, 2, 3, 4, 5]
      // Different output script for collision avoidance.
      const unauthorizedTimeoutOutputScript =
        "0x160014c4d5e6f7a8b9091929304a5b6c7d8e9f0a1b2c3d"

      before(async () => {
        await createSnapshot()

        // No authorization — rebate is skipped at apply time.
        const data = encodeRedemptionData(
          redeemerAddress,
          walletPubKeyHash,
          mainUtxo,
          unauthorizedTimeoutOutputScript
        )

        await bank
          .connect(balanceOwner)
          .approveBalanceAndCall(bridge.address, requestedAmount, data)

        rebateCapBeforeTimeout = await rebateStaking.getRebateCap(
          redeemerAddress
        )
        initialRedeemerBalance = await bank.balanceOf(redeemerAddress)

        await increaseTime(redemptionTimeout)

        tx = await bridge
          .connect(thirdParty)
          .notifyRedemptionTimeout(
            walletPubKeyHash,
            walletMembersIDs,
            unauthorizedTimeoutOutputScript
          )
      })

      after(async () => {
        walletRegistry.seize.reset()
        await restoreSnapshot()
      })

      it("should not emit RebateCanceled", async () => {
        // No rebate was applied, so there is nothing to cancel.
        // cancelRebate is invoked with the redeemer but is a no-op when
        // no matching rebate exists for the requestedAt.
        await expect(tx).to.not.emit(rebateStaking, "RebateCanceled")
      })

      it("should refund the redeemer the requested amount", async () => {
        const currentRedeemerBalance = await bank.balanceOf(redeemerAddress)
        expect(currentRedeemerBalance).to.be.equal(
          initialRedeemerBalance.add(requestedAmount)
        )
      })

      it("should leave the redeemer's rebate cap unchanged", async () => {
        const rebateCapAfterTimeout = await rebateStaking.getRebateCap(
          redeemerAddress
        )
        expect(rebateCapAfterTimeout).to.be.equal(rebateCapBeforeTimeout)
      })
    })

    context("when redeemer has no stake", () => {
      let tx: ContractTransaction
      // Use a different output script to avoid collision with scenario 1.
      const nonStakedOutputScript =
        "0x160014a1b2c3d4e5f607182939495a6b7c8d9e0f1a2b3c"

      let nonStakedRedeemerAddress: string

      before(async () => {
        await createSnapshot()

        const unnamedAccounts = await getUnnamedAccounts()
        // eslint-disable-next-line prefer-destructuring
        nonStakedRedeemerAddress = unnamedAccounts[11]

        const data = encodeRedemptionData(
          nonStakedRedeemerAddress,
          walletPubKeyHash,
          mainUtxo,
          nonStakedOutputScript
        )

        // Execute vault-path redemption with a non-staked redeemer. Soft-fail
        // means the redemption still succeeds without a rebate.
        tx = await bank
          .connect(balanceOwner)
          .approveBalanceAndCall(bridge.address, requestedAmount, data)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not revert", async () => {
        const receipt = await tx.wait()
        expect(receipt.status).to.be.equal(1)
      })

      it("should not emit RebateReceived", async () => {
        await expect(tx).to.not.emit(rebateStaking, "RebateReceived")
      })

      it("should store full treasury fee in the redemption request", async () => {
        const redemptionKey = buildRedemptionKey(
          walletPubKeyHash,
          nonStakedOutputScript
        )
        const redemptionRequest = await bridge.pendingRedemptions(redemptionKey)
        expect(redemptionRequest.treasuryFee).to.be.equal(treasuryFee)
      })
    })

    context("when balanceOwner equals redeemer (direct path)", () => {
      let tx: ContractTransaction
      const directOutputScript =
        "0x160014b1c2d3e4f5a6071829304a5b6c7d8e9f0a1b2c3d"

      // Use a different wallet to avoid interference with vault-path
      // scenarios.
      const directWalletPubKeyHash =
        "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726"
      const directMainUtxo = {
        txHash:
          "0x4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293",
        txOutputIndex: 0,
        txOutputValue: 10000000,
      }

      before(async () => {
        await createSnapshot()

        await setupWallet(bridge, directWalletPubKeyHash, directMainUtxo)

        await bank.setBalance(redeemerAddress, requestedAmount)
        await bank
          .connect(redeemerSigner)
          .approveBalance(bridge.address, requestedAmount)

        tx = await bridge
          .connect(redeemerSigner)
          .requestRedemption(
            directWalletPubKeyHash,
            directMainUtxo,
            directOutputScript,
            requestedAmount
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should apply rebate using the redeemer address", async () => {
        await expect(tx)
          .to.emit(rebateStaking, "RebateReceived")
          .withArgs(redeemerAddress, treasuryFee)
      })

      it("should store reduced treasury fee in the redemption request", async () => {
        const redemptionKey = buildRedemptionKey(
          directWalletPubKeyHash,
          directOutputScript
        )
        const redemptionRequest = await bridge.pendingRedemptions(redemptionKey)
        expect(redemptionRequest.treasuryFee).to.be.equal(0)
      })
    })

    context("when two stakers both authorize the same balanceOwner", () => {
      let firstTx: ContractTransaction
      let secondTx: ContractTransaction

      let firstStakerAddress: string
      let secondStakerAddress: string
      let firstStakerSigner: SignerWithAddress
      let secondStakerSigner: SignerWithAddress

      const firstOutputScript =
        "0x160014d5e6f7a8b9c0091929304a5b6c7d8e9f0a1b2c3d"
      const secondOutputScript =
        "0x160014e6f7a8b9c0d1091929304a5b6c7d8e9f0a1b2c3d"

      // Use a fresh wallet for multi-tenant scenario.
      const multiTenantWalletPubKeyHash =
        "0x9bd4f9489c3e69f6a0fd2a206db95fe3251ee937"
      const multiTenantMainUtxo = {
        txHash:
          "0x6c7d8e9f0a1b2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d4e5f60718293040",
        txOutputIndex: 0,
        txOutputValue: 10000000,
      }

      before(async () => {
        await createSnapshot()

        const unnamedAccounts = await getUnnamedAccounts()
        // eslint-disable-next-line prefer-destructuring
        firstStakerAddress = unnamedAccounts[14]
        // eslint-disable-next-line prefer-destructuring
        secondStakerAddress = unnamedAccounts[15]

        firstStakerSigner = await impersonateAccount(firstStakerAddress, {
          from: deployer,
          value: 10,
        })
        secondStakerSigner = await impersonateAccount(secondStakerAddress, {
          from: deployer,
          value: 10,
        })

        await stakeTokens(t, rebateStaking, deployer, firstStakerSigner)
        await stakeTokens(t, rebateStaking, deployer, secondStakerSigner)

        // Both stakers authorize the same balance owner. Under v2's
        // many-to-one rebateAuthorizations mapping, this must succeed
        // without colliding.
        await rebateStaking
          .connect(firstStakerSigner)
          .setRebateAuthorization(balanceOwner.address, true)
        await rebateStaking
          .connect(secondStakerSigner)
          .setRebateAuthorization(balanceOwner.address, true)

        await setupWallet(
          bridge,
          multiTenantWalletPubKeyHash,
          multiTenantMainUtxo
        )

        firstTx = await bank
          .connect(balanceOwner)
          .approveBalanceAndCall(
            bridge.address,
            requestedAmount,
            encodeRedemptionData(
              firstStakerAddress,
              multiTenantWalletPubKeyHash,
              multiTenantMainUtxo,
              firstOutputScript
            )
          )

        secondTx = await bank
          .connect(balanceOwner)
          .approveBalanceAndCall(
            bridge.address,
            requestedAmount,
            encodeRedemptionData(
              secondStakerAddress,
              multiTenantWalletPubKeyHash,
              multiTenantMainUtxo,
              secondOutputScript
            )
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit RebateReceived for the first staker", async () => {
        await expect(firstTx)
          .to.emit(rebateStaking, "RebateReceived")
          .withArgs(firstStakerAddress, treasuryFee)
      })

      it("should emit RebateReceived for the second staker", async () => {
        await expect(secondTx)
          .to.emit(rebateStaking, "RebateReceived")
          .withArgs(secondStakerAddress, treasuryFee)
      })

      it("should consume each staker's own rebate cap", async () => {
        const firstAvailable = await rebateStaking.getAvailableRebate(
          firstStakerAddress
        )
        const firstCap = await rebateStaking.getRebateCap(firstStakerAddress)
        const secondAvailable = await rebateStaking.getAvailableRebate(
          secondStakerAddress
        )
        const secondCap = await rebateStaking.getRebateCap(secondStakerAddress)
        expect(firstAvailable.lt(firstCap)).to.be.true
        expect(secondAvailable.lt(secondCap)).to.be.true
      })
    })

    context("when attacker spoofs an unrelated staker via Bank", () => {
      let tx: ContractTransaction
      let victimRebateCapBefore: BigNumber

      let attacker: SignerWithAddress
      let victimSigner: SignerWithAddress
      let victimAddress: string

      const spoofOutputScript =
        "0x160014f7a8b9c0d1e2091929304a5b6c7d8e9f0a1b2c3d"

      const spoofWalletPubKeyHash = "0x5fc3b8478b2d58e791edb7184ca84ec1330d3826"
      const spoofMainUtxo = {
        txHash:
          "0x7d8e9f0a1b2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d4e5f607182930405a",
        txOutputIndex: 0,
        txOutputValue: 10000000,
      }

      before(async () => {
        await createSnapshot()

        const unnamedAccounts = await getUnnamedAccounts()
        // eslint-disable-next-line prefer-destructuring
        victimAddress = unnamedAccounts[16]
        attacker = thirdParty

        victimSigner = await impersonateAccount(victimAddress, {
          from: deployer,
          value: 10,
        })

        await stakeTokens(t, rebateStaking, deployer, victimSigner)
        victimRebateCapBefore = await rebateStaking.getRebateCap(victimAddress)

        // Victim has NOT authorized the attacker. The attacker uses their
        // own Bank balance and names the victim as redeemer.
        await setupWallet(bridge, spoofWalletPubKeyHash, spoofMainUtxo)
        await bank.setBalance(attacker.address, requestedAmount)

        const data = encodeRedemptionData(
          victimAddress,
          spoofWalletPubKeyHash,
          spoofMainUtxo,
          spoofOutputScript
        )
        tx = await bank
          .connect(attacker)
          .approveBalanceAndCall(bridge.address, requestedAmount, data)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not consume the victim's rebate cap", async () => {
        // No authorization, no rebate applied — victim's rebate cap is
        // intact. This is the property that closes the spoof primitive.
        const availableAfter = await rebateStaking.getAvailableRebate(
          victimAddress
        )
        expect(availableAfter).to.be.equal(victimRebateCapBefore)
      })

      it("should not emit RebateReceived for the victim", async () => {
        await expect(tx).to.not.emit(rebateStaking, "RebateReceived")
      })

      it("should store full treasury fee in the redemption request", async () => {
        const redemptionKey = buildRedemptionKey(
          spoofWalletPubKeyHash,
          spoofOutputScript
        )
        const request = await bridge.pendingRedemptions(redemptionKey)
        expect(request.treasuryFee).to.be.equal(treasuryFee)
      })
    })

    it("does not apply rebate through stale authorization after full unstake and later delegation", async () => {
      await createSnapshot()
      try {
        const accounts = await getUnnamedAccounts()
        const formerStaker = await impersonateAccount(accounts[17], {
          from: deployer,
          value: 10,
        })
        const victim = await impersonateAccount(accounts[18], {
          from: deployer,
          value: 10,
        })
        const attacker = thirdParty

        await stakeTokens(t, rebateStaking, deployer, formerStaker)
        await rebateStaking
          .connect(formerStaker)
          .setRebateAuthorization(attacker.address, true)

        await rebateStaking.connect(formerStaker).startUnstaking(stakeAmount)
        await increaseTime(await rebateStaking.unstakingPeriod())
        await rebateStaking
          .connect(formerStaker)
          .finalizeUnstaking(formerStaker.address)
        expect(await rebateStaking.getStake(formerStaker.address)).to.equal(0)

        await stakeTokens(t, rebateStaking, deployer, victim)
        await rebateStaking.connect(victim).setDelegatee(formerStaker.address)

        const victimAvailableBefore = await rebateStaking.getAvailableRebate(
          victim.address
        )
        const victimRebatesBefore = await rebateStaking.getRebateLength(
          victim.address
        )

        const pubKeyHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const outputScript = "0x1600141111111111111111111111111111111111111111"
        const utxo = {
          txHash:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          txOutputIndex: 0,
          txOutputValue: 10000000,
        }

        await setupWallet(bridge, pubKeyHash, utxo)
        await bank.setBalance(attacker.address, requestedAmount)

        const tx = await bank
          .connect(attacker)
          .approveBalanceAndCall(
            bridge.address,
            requestedAmount,
            encodeRedemptionData(
              formerStaker.address,
              pubKeyHash,
              utxo,
              outputScript
            )
          )

        await expect(tx).to.not.emit(rebateStaking, "RebateReceived")
        expect(await rebateStaking.getAvailableRebate(victim.address)).to.equal(
          victimAvailableBefore
        )
        expect(await rebateStaking.getRebateLength(victim.address)).to.equal(
          victimRebatesBefore
        )

        const request = await bridge.pendingRedemptions(
          buildRedemptionKey(pubKeyHash, outputScript)
        )
        expect(request.treasuryFee).to.equal(treasuryFee)
        expect((await tx.wait()).status).to.equal(1)
      } finally {
        await restoreSnapshot()
      }
    })

    it("makes force-transferred stale authorizations inert even if the new staker delegates to the old address", async () => {
      await createSnapshot()
      try {
        const accounts = await getUnnamedAccounts()
        const oldStaker = await impersonateAccount(accounts[19], {
          from: deployer,
          value: 10,
        })
        const newStaker = await impersonateAccount(accounts[20], {
          from: deployer,
          value: 10,
        })
        const attacker = thirdParty

        await stakeTokens(t, rebateStaking, deployer, oldStaker)
        await rebateStaking
          .connect(oldStaker)
          .setRebateAuthorization(attacker.address, true)

        await rebateStaking
          .connect(deployer)
          .forceStakeTransfer(oldStaker.address, newStaker.address)

        expect(
          await rebateStaking.isRebateAuthorized(
            oldStaker.address,
            attacker.address
          )
        ).to.be.false
        expect(
          await rebateStaking.isRebateAuthorized(
            newStaker.address,
            attacker.address
          )
        ).to.be.false

        await rebateStaking
          .connect(newStaker)
          .setRebateAuthorization(attacker.address, true)
        expect(
          await rebateStaking.isRebateAuthorized(
            newStaker.address,
            attacker.address
          )
        ).to.be.true

        await rebateStaking.connect(newStaker).setDelegatee(oldStaker.address)

        const availableBefore = await rebateStaking.getAvailableRebate(
          newStaker.address
        )
        const rebatesBefore = await rebateStaking.getRebateLength(
          newStaker.address
        )

        const pubKeyHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        const outputScript = "0x1600142222222222222222222222222222222222222222"
        const utxo = {
          txHash:
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          txOutputIndex: 0,
          txOutputValue: 10000000,
        }

        await setupWallet(bridge, pubKeyHash, utxo)
        await bank.setBalance(attacker.address, requestedAmount)

        const tx = await bank
          .connect(attacker)
          .approveBalanceAndCall(
            bridge.address,
            requestedAmount,
            encodeRedemptionData(
              oldStaker.address,
              pubKeyHash,
              utxo,
              outputScript
            )
          )

        await expect(tx).to.not.emit(rebateStaking, "RebateReceived")
        expect(
          await rebateStaking.getAvailableRebate(newStaker.address)
        ).to.equal(availableBefore)
        expect(await rebateStaking.getRebateLength(newStaker.address)).to.equal(
          rebatesBefore
        )

        const request = await bridge.pendingRedemptions(
          buildRedemptionKey(pubKeyHash, outputScript)
        )
        expect(request.treasuryFee).to.equal(treasuryFee)
      } finally {
        await restoreSnapshot()
      }
    })

    it("covers the victim-delegates-to-former-staker attack chain without consuming victim rebate cap", async () => {
      await createSnapshot()
      try {
        const accounts = await getUnnamedAccounts()
        const formerStaker = await impersonateAccount(accounts[21], {
          from: deployer,
          value: 10,
        })
        const victim = await impersonateAccount(accounts[22], {
          from: deployer,
          value: 10,
        })
        const attacker = thirdParty

        await stakeTokens(t, rebateStaking, deployer, formerStaker)
        await rebateStaking
          .connect(formerStaker)
          .setRebateAuthorization(attacker.address, true)
        await rebateStaking.connect(formerStaker).startUnstaking(stakeAmount)
        await increaseTime(await rebateStaking.unstakingPeriod())
        await rebateStaking
          .connect(formerStaker)
          .finalizeUnstaking(formerStaker.address)

        await stakeTokens(t, rebateStaking, deployer, victim)
        await rebateStaking.connect(victim).setDelegatee(formerStaker.address)

        const capBefore = await rebateStaking.getRebateCap(victim.address)
        const availableBefore = await rebateStaking.getAvailableRebate(
          victim.address
        )
        const rebatesBefore = await rebateStaking.getRebateLength(
          victim.address
        )

        const pubKeyHash = "0xcccccccccccccccccccccccccccccccccccccccc"
        const outputScript = "0x1600143333333333333333333333333333333333333333"
        const utxo = {
          txHash:
            "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          txOutputIndex: 0,
          txOutputValue: 10000000,
        }

        await setupWallet(bridge, pubKeyHash, utxo)
        await bank.setBalance(attacker.address, requestedAmount)

        const tx = await bank
          .connect(attacker)
          .approveBalanceAndCall(
            bridge.address,
            requestedAmount,
            encodeRedemptionData(
              formerStaker.address,
              pubKeyHash,
              utxo,
              outputScript
            )
          )

        await expect(tx).to.not.emit(rebateStaking, "RebateReceived")
        expect(await rebateStaking.getRebateLength(victim.address)).to.equal(
          rebatesBefore
        )
        expect(await rebateStaking.getRebateCap(victim.address)).to.equal(
          capBefore
        )
        expect(await rebateStaking.getAvailableRebate(victim.address)).to.equal(
          availableBefore
        )
      } finally {
        await restoreSnapshot()
      }
    })

    it("preserves direct-path delegation rebate accounting for a non-staker delegatee", async () => {
      await createSnapshot()
      try {
        const accounts = await getUnnamedAccounts()
        const staker = await impersonateAccount(accounts[23], {
          from: deployer,
          value: 10,
        })
        const delegatee = await impersonateAccount(accounts[24], {
          from: deployer,
          value: 10,
        })

        await stakeTokens(t, rebateStaking, deployer, staker)
        await rebateStaking.connect(staker).setDelegatee(delegatee.address)

        const stakerAvailableBefore = await rebateStaking.getAvailableRebate(
          staker.address
        )
        const stakerRebatesBefore = await rebateStaking.getRebateLength(
          staker.address
        )

        const pubKeyHash = "0xdddddddddddddddddddddddddddddddddddddddd"
        const outputScript = "0x1600144444444444444444444444444444444444444444"
        const utxo = {
          txHash:
            "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          txOutputIndex: 0,
          txOutputValue: 10000000,
        }

        await setupWallet(bridge, pubKeyHash, utxo)
        await bank.setBalance(delegatee.address, requestedAmount)
        await bank
          .connect(delegatee)
          .approveBalance(bridge.address, requestedAmount)

        const tx = await bridge
          .connect(delegatee)
          .requestRedemption(pubKeyHash, utxo, outputScript, requestedAmount)

        await expect(tx)
          .to.emit(rebateStaking, "RebateReceived")
          .withArgs(staker.address, treasuryFee)

        expect(await rebateStaking.getRebateLength(staker.address)).to.equal(
          stakerRebatesBefore.add(1)
        )
        expect(
          (await rebateStaking.getAvailableRebate(staker.address)).lt(
            stakerAvailableBefore
          )
        ).to.be.true

        const request = await bridge.pendingRedemptions(
          buildRedemptionKey(pubKeyHash, outputScript)
        )
        expect(request.treasuryFee).to.equal(0)
      } finally {
        await restoreSnapshot()
      }
    })
  })
})

function buildRedemptionKey(
  walletPubKeyHash: string,
  redeemerOutputScript: string
): string {
  return ethers.utils.solidityKeccak256(
    ["bytes32", "bytes20"],
    [
      ethers.utils.solidityKeccak256(["bytes"], [redeemerOutputScript]),
      walletPubKeyHash,
    ]
  )
}
