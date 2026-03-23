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
      await bank.setBalance(balanceOwner.address, requestedAmount.mul(4))

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

    context("when redeemer has stake but balanceOwner does not", () => {
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
        // Here balanceOwner != redeemer, so the bug should be visible.
        tx = await bank
          .connect(balanceOwner)
          .approveBalanceAndCall(bridge.address, requestedAmount, data)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should apply rebate using the redeemer address", async () => {
        // The RebateReceived event proves applyForRebate was called
        // with the redeemer (who has stake), not the balanceOwner
        // (who has no stake). With the bug, no event is emitted
        // because balanceOwner has no stake and the function returns
        // the original treasuryFee unchanged.
        await expect(tx)
          .to.emit(rebateStaking, "RebateReceived")
          .withArgs(redeemerAddress, treasuryFee)
      })

      it("should store reduced treasury fee in the redemption request", async () => {
        const redemptionKey = buildRedemptionKey(
          walletPubKeyHash,
          redeemerOutputScript
        )

        const redemptionRequest = await bridge.pendingRedemptions(redemptionKey)

        // When rebate is properly applied to the redeemer (who has
        // stake), the stored treasury fee should be 0 because the
        // redeemer's rebate cap exceeds the fee. With the bug,
        // the fee is the full 950 because balanceOwner has no stake.
        expect(redemptionRequest.treasuryFee).to.be.equal(0)
      })

      it("should decrease available rebate for the redeemer", async () => {
        const availableRebate = await rebateStaking.getAvailableRebate(
          redeemerAddress
        )
        const rebateCap = await rebateStaking.getRebateCap(redeemerAddress)

        // After applying rebate, available rebate should be less
        // than the full cap. With the bug, the redeemer's available
        // rebate would still equal the cap (no rebate consumed).
        expect(availableRebate.lt(rebateCap)).to.be.true
      })
    })

    context("when vault-path redemption times out", () => {
      let tx: ContractTransaction
      let initialRedeemerBalance: BigNumber
      let availableRebateBeforeTimeout: BigNumber

      const walletMembersIDs = [1, 2, 3, 4, 5]

      before(async () => {
        await createSnapshot()

        // Perform vault-path redemption first (same as scenario 1).
        const data = encodeRedemptionData(
          redeemerAddress,
          walletPubKeyHash,
          mainUtxo,
          redeemerOutputScript
        )

        await bank
          .connect(balanceOwner)
          .approveBalanceAndCall(bridge.address, requestedAmount, data)

        // Capture the available rebate after redemption request but before
        // timeout. The rebate was consumed during applyForRebate.
        availableRebateBeforeTimeout = await rebateStaking.getAvailableRebate(
          redeemerAddress
        )

        // Capture the redeemer's bank balance before timeout notification.
        initialRedeemerBalance = await bank.balanceOf(redeemerAddress)

        // Advance time past the redemption timeout.
        await increaseTime(redemptionTimeout)

        // Notify the timeout. Anyone can call this after the timeout period.
        tx = await bridge
          .connect(thirdParty)
          .notifyRedemptionTimeout(
            walletPubKeyHash,
            walletMembersIDs,
            redeemerOutputScript
          )
      })

      after(async () => {
        walletRegistry.seize.reset()

        await restoreSnapshot()
      })

      it("should emit RebateCanceled for the redeemer", async () => {
        // cancelRebate is called with request.redeemer (the actual
        // redeemer address), not the vault/balanceOwner.
        await expect(tx).to.emit(rebateStaking, "RebateCanceled")
      })

      it("should restore available rebate for the redeemer", async () => {
        const availableRebateAfterTimeout =
          await rebateStaking.getAvailableRebate(redeemerAddress)

        // After cancellation, the available rebate should be greater than
        // before timeout because the consumed rebate was restored.
        expect(availableRebateAfterTimeout.gt(availableRebateBeforeTimeout)).to
          .be.true
      })

      it("should return the requested amount to the redeemer", async () => {
        const currentRedeemerBalance = await bank.balanceOf(redeemerAddress)

        // The redeemer receives back the full requestedAmount via
        // bank.transferBalance(request.redeemer, request.requestedAmount).
        expect(currentRedeemerBalance).to.be.equal(
          initialRedeemerBalance.add(requestedAmount)
        )
      })

      it("should remove the redemption from pending requests", async () => {
        const redemptionKey = buildRedemptionKey(
          walletPubKeyHash,
          redeemerOutputScript
        )
        const request = await bridge.pendingRedemptions(redemptionKey)
        expect(request.requestedAt).to.be.equal(0)
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

        // Use a different unnamed account with no T stake.
        const unnamedAccounts = await getUnnamedAccounts()
        // eslint-disable-next-line prefer-destructuring
        nonStakedRedeemerAddress = unnamedAccounts[11]

        const data = encodeRedemptionData(
          nonStakedRedeemerAddress,
          walletPubKeyHash,
          mainUtxo,
          nonStakedOutputScript
        )

        // Execute vault-path redemption with a non-staked redeemer.
        tx = await bank
          .connect(balanceOwner)
          .approveBalanceAndCall(bridge.address, requestedAmount, data)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not revert", async () => {
        // The transaction succeeded in the before hook. Verify it was
        // mined by checking for a valid receipt (status = 1 means success).
        const receipt = await tx.wait()
        expect(receipt.status).to.be.equal(1)
      })

      it("should not emit RebateReceived", async () => {
        // No RebateReceived event because the non-staked redeemer has
        // no rebate cap (getRebateCap returns 0 when stakedAmount == 0).
        await expect(tx).to.not.emit(rebateStaking, "RebateReceived")
      })

      it("should store full treasury fee in the redemption request", async () => {
        const redemptionKey = buildRedemptionKey(
          walletPubKeyHash,
          nonStakedOutputScript
        )

        const redemptionRequest = await bridge.pendingRedemptions(redemptionKey)

        // Without rebate, the full treasury fee is stored unchanged.
        expect(redemptionRequest.treasuryFee).to.be.equal(treasuryFee)
      })
    })

    context("when balanceOwner equals redeemer (direct path)", () => {
      let tx: ContractTransaction
      // Use a different output script to avoid key collision.
      const directOutputScript =
        "0x160014b1c2d3e4f5a6071829304a5b6c7d8e9f0a1b2c3d"

      // Use a different wallet to avoid interference with vault-path
      // scenarios, since the existing wallet may already have pending
      // redemptions or changed state.
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

        // Set up a fresh wallet for direct-path testing.
        await setupWallet(bridge, directWalletPubKeyHash, directMainUtxo)

        // Give the redeemer Bank balance and approve the bridge to spend it.
        await bank.setBalance(redeemerAddress, requestedAmount)
        await bank
          .connect(redeemerSigner)
          .approveBalance(bridge.address, requestedAmount)

        // Perform direct redemption where the caller is both balance
        // owner and redeemer. This exercises the 6-arg overload
        // (Redemption.sol:290-306) which sets balanceOwner = redeemer.
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
        // Even in the direct path, applyForRebate should be called
        // with the redeemer address (which equals balanceOwner here).
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

        // The redeemer has stake, so the rebate covers the full fee.
        expect(redemptionRequest.treasuryFee).to.be.equal(0)
      })
    })

    context("when redeemer is a delegatee of a staker", () => {
      let tx: ContractTransaction
      let delegateeRedeemerAddress: string
      let stakerAddress: string
      let stakerSigner: SignerWithAddress

      // Use a different output script for delegation scenario.
      const delegateeOutputScript =
        "0x160014c2d3e4f5a6b7081929304a5b6c7d8e9f0a1b2c3d"

      // Use a different wallet to avoid interference with other scenarios.
      const delegateeWalletPubKeyHash =
        "0x6bc3e8479b2d58f490ecb7084ba84fc1230c3815"
      const delegateeMainUtxo = {
        txHash:
          "0x5b6c7d8e9f0a1b2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d4e5f607182930",
        txOutputIndex: 0,
        txOutputValue: 10000000,
      }

      before(async () => {
        await createSnapshot()

        const unnamedAccounts = await getUnnamedAccounts()
        // eslint-disable-next-line prefer-destructuring
        delegateeRedeemerAddress = unnamedAccounts[12]
        // eslint-disable-next-line prefer-destructuring
        stakerAddress = unnamedAccounts[13]

        stakerSigner = await impersonateAccount(stakerAddress, {
          from: deployer,
          value: 10,
        })

        // The staker stakes T tokens and sets the delegatee-redeemer as
        // their delegate. After this, getStaker(delegateeRedeemerAddress)
        // resolves to stakerAddress.
        await stakeTokens(t, rebateStaking, deployer, stakerSigner)
        await rebateStaking
          .connect(stakerSigner)
          .setDelegatee(delegateeRedeemerAddress)

        // Set up a fresh wallet for delegation scenario.
        await setupWallet(bridge, delegateeWalletPubKeyHash, delegateeMainUtxo)

        // Vault-path redemption with the delegatee as redeemer.
        const data = encodeRedemptionData(
          delegateeRedeemerAddress,
          delegateeWalletPubKeyHash,
          delegateeMainUtxo,
          delegateeOutputScript
        )

        // Give balanceOwner enough Bank balance for this redemption.
        await bank.setBalance(balanceOwner.address, requestedAmount.mul(4))

        tx = await bank
          .connect(balanceOwner)
          .approveBalanceAndCall(bridge.address, requestedAmount, data)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should apply rebate to the delegating staker", async () => {
        // getStaker(delegateeRedeemerAddress) resolves to stakerAddress
        // because the delegatee has no direct stake and delegates[delegatee]
        // points to the staker. The RebateReceived event is emitted with
        // the staker address (the resolved user in applyForRebate).
        await expect(tx)
          .to.emit(rebateStaking, "RebateReceived")
          .withArgs(stakerAddress, treasuryFee)
      })

      it("should store reduced treasury fee in the redemption request", async () => {
        const redemptionKey = buildRedemptionKey(
          delegateeWalletPubKeyHash,
          delegateeOutputScript
        )

        const redemptionRequest = await bridge.pendingRedemptions(redemptionKey)

        // The staker (resolved via delegation) has enough cap to cover
        // the full treasury fee, so the stored fee should be 0.
        expect(redemptionRequest.treasuryFee).to.be.equal(0)
      })

      it("should decrease available rebate for the staker", async () => {
        const availableRebate = await rebateStaking.getAvailableRebate(
          stakerAddress
        )
        const rebateCap = await rebateStaking.getRebateCap(stakerAddress)

        // The staker's available rebate should be less than the full cap
        // after the rebate was applied through delegation.
        expect(availableRebate.lt(rebateCap)).to.be.true
      })
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
