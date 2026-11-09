import { ethers, helpers, upgrades } from "hardhat"
import { expect } from "chai"
import type { BigNumberish, BytesLike } from "ethers"
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import type {
  Bank,
  BankStub,
  Bridge,
  BridgeGovernance,
  BridgeStub,
  RebateStaking,
} from "../../typechain"

import bridgeFixture from "../fixtures/bridge"
import { constants, walletState } from "../fixtures"
import { SingleP2SHDeposit } from "../data/deposit-sweep"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { impersonateAccount } = helpers.account
const { increaseTime, lastBlockTime } = helpers.time
const { ZeroAddress: AddressZero } = ethers

describe("Bridge - Peg keeper", () => {
  let deployer: HardhatEthersSigner
  let governance: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let esdm: HardhatEthersSigner

  let bank: Bank & BankStub
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let rebateStaking: RebateStaking

  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const mainUtxo = {
    txHash:
      "0x3835ecdee2daa83c9a19b5012104ace55ecab197b5e16489c26d372e475f5d2a",
    txOutputIndex: 0,
    txOutputValue: 10000000,
  }
  const redeemerOutputScriptP2WPKH =
    "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"
  const redeemerOutputScriptP2PKH =
    "0x1976a914f4eedc8f40d4b8e30771f792b065ebec0abaddef88ac"
  const requestedAmount = 1901000n

  before(async () => {
    ;({ deployer, governance, esdm } = await helpers.signers.getNamedSigners())
    ;({ thirdParty, bank, bridge, bridgeGovernance, rebateStaking } =
      await bridgeFixture())

    await bridge.setDepositDustThreshold(10000)
    await bridge.setDepositTxMaxFee(2000)
    await bridge.setDepositRevealAheadPeriod(0)
  })

  describe("governance", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should require owner to begin peg keeper update", async () => {
      await expect(
        bridgeGovernance
          .connect(thirdParty)
          .beginPegKeeperUpdate(thirdParty.address, true)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })
    it("should require governance to update peg keeper", async () => {
      await expect(
        bridge.connect(thirdParty).updatePegKeeper(thirdParty.address, true)
      ).to.be.revertedWith("Caller is not the governance")
    })

    it("should begin peg keeper update without applying it", async () => {
      const tx = await bridgeGovernance
        .connect(governance)
        .beginPegKeeperUpdate(thirdParty.address, true)

      expect(await bridge.isPegKeeper(thirdParty.address)).to.be.false

      await expect(tx)
        .to.emit(bridgeGovernance, "PegKeeperUpdateStarted")
        .withArgs(thirdParty.address, true, await lastBlockTime())
    })

    it("should reject overwriting a pending peg keeper update", async () => {
      await bridgeGovernance
        .connect(governance)
        .beginPegKeeperUpdate(thirdParty.address, true)

      await expect(
        bridgeGovernance
          .connect(governance)
          .beginPegKeeperUpdate(deployer.address, false)
      ).to.be.revertedWith("Peg keeper update already initiated")
    })

    it("should cancel a pending peg keeper update", async () => {
      await bridgeGovernance
        .connect(governance)
        .beginPegKeeperUpdate(thirdParty.address, true)

      const tx = await bridgeGovernance
        .connect(governance)
        .cancelPegKeeperUpdate()

      await expect(tx)
        .to.emit(bridgeGovernance, "PegKeeperUpdateCanceled")
        .withArgs(thirdParty.address, true)

      await bridgeGovernance
        .connect(governance)
        .beginPegKeeperUpdate(deployer.address, true)
      await increaseTime(constants.governanceDelay)
      await bridgeGovernance.connect(governance).finalizePegKeeperUpdate()

      expect(await bridge.isPegKeeper(thirdParty.address)).to.be.false
      expect(await bridge.isPegKeeper(deployer.address)).to.be.true
    })

    it("should require owner to cancel peg keeper update", async () => {
      await bridgeGovernance
        .connect(governance)
        .beginPegKeeperUpdate(thirdParty.address, true)

      await expect(
        bridgeGovernance.connect(thirdParty).cancelPegKeeperUpdate()
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should require a pending peg keeper update to cancel", async () => {
      await expect(
        bridgeGovernance.connect(governance).cancelPegKeeperUpdate()
      ).to.be.revertedWith("Peg keeper update not initiated")
    })
    it("should require a pending peg keeper update to finalize", async () => {
      await expect(
        bridgeGovernance.connect(governance).finalizePegKeeperUpdate()
      ).to.be.revertedWith("Change not initiated")
    })

    it("should require governance delay before finalizing peg keeper update", async () => {
      await bridgeGovernance
        .connect(governance)
        .beginPegKeeperUpdate(thirdParty.address, true)

      await increaseTime(constants.governanceDelay - 60)

      await expect(
        bridgeGovernance.connect(governance).finalizePegKeeperUpdate()
      ).to.be.revertedWith("Governance delay has not elapsed")
    })

    it("should finalize peg keeper update", async () => {
      await bridgeGovernance
        .connect(governance)
        .beginPegKeeperUpdate(thirdParty.address, true)

      await increaseTime(constants.governanceDelay)

      const tx = await bridgeGovernance
        .connect(governance)
        .finalizePegKeeperUpdate()

      expect(await bridge.isPegKeeper(thirdParty.address)).to.be.true

      await expect(tx)
        .to.emit(bridgeGovernance, "PegKeeperUpdated")
        .withArgs(thirdParty.address, true)
      await expect(tx)
        .to.emit(bridge, "PegKeeperUpdated")
        .withArgs(thirdParty.address, true)
    })

    it("should allow removing a peg keeper", async () => {
      await setPegKeeper(thirdParty.address)

      await bridgeGovernance
        .connect(governance)
        .beginPegKeeperUpdate(thirdParty.address, false)
      await increaseTime(constants.governanceDelay)
      await bridgeGovernance.connect(governance).finalizePegKeeperUpdate()

      expect(await bridge.isPegKeeper(thirdParty.address)).to.be.false
    })

    it("should allow multiple peg keepers", async () => {
      await setPegKeeper(thirdParty.address)
      await setPegKeeper(deployer.address)

      expect(await bridge.isPegKeeper(thirdParty.address)).to.be.true
      expect(await bridge.isPegKeeper(deployer.address)).to.be.true

      await setPegKeeper(thirdParty.address, false)

      expect(await bridge.isPegKeeper(thirdParty.address)).to.be.false
      expect(await bridge.isPegKeeper(deployer.address)).to.be.true
    })
  })

  describe("deposits", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should waive deposit treasury fee for peg keeper", async () => {
      const deposit = SingleP2SHDeposit.deposits[0]
      const pegKeeper = await impersonateAccount(deposit.depositor, {
        from: governance,
        value: 10n,
      })

      await setPegKeeper(pegKeeper.address)
      await setLiveWallet(deposit.reveal.walletPubKeyHash as string)

      await bridge.connect(pegKeeper).revealDeposit(
        {
          version: deposit.fundingTx.version,
          inputVector: deposit.fundingTx.inputVector,
          outputVector: deposit.fundingTx.outputVector,
          locktime: deposit.fundingTx.locktime,
        },
        deposit.reveal
      )

      const depositKey = ethers.solidityPackedKeccak256(
        ["bytes32", "uint32"],
        [deposit.fundingTx.hash, deposit.reveal.fundingOutputIndex]
      )

      const depositRequest = await bridge.deposits(depositKey)
      expect(depositRequest.depositor).to.equal(pegKeeper.address)
      expect(depositRequest.treasuryFee).to.equal(0)
    })
  })

  describe("redemptions", () => {
    beforeEach(async () => {
      await createSnapshot()

      await setLiveWallet(walletPubKeyHash)
      await bridge.setWalletMainUtxo(walletPubKeyHash, mainUtxo)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should waive redemption treasury fee when balance owner and redeemer are the peg keeper", async () => {
      await setPegKeeper(thirdParty.address)
      await makeRedemptionAllowance(thirdParty, requestedAmount)

      await bridge
        .connect(thirdParty)
        .requestRedemption(
          walletPubKeyHash,
          mainUtxo,
          redeemerOutputScriptP2WPKH,
          requestedAmount
        )

      const redemptionKey = buildRedemptionKey(
        walletPubKeyHash,
        redeemerOutputScriptP2WPKH
      )
      const redemption = await bridge.pendingRedemptions(redemptionKey)
      const wallet = await bridge.wallets(walletPubKeyHash)

      expect(redemption.redeemer).to.equal(thirdParty.address)
      expect(redemption.treasuryFee).to.equal(0)
      expect(wallet.pendingRedemptionsValue).to.equal(requestedAmount)
    })

    it("should not waive redemption treasury fee when only redeemer is the peg keeper", async () => {
      await setPegKeeper(thirdParty.address)

      const balanceOwner = deployer
      await bank.setBalance(balanceOwner.address, requestedAmount)

      const redemptionData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes20", "bytes32", "uint32", "uint64", "bytes"],
        [
          thirdParty.address,
          walletPubKeyHash,
          mainUtxo.txHash,
          mainUtxo.txOutputIndex,
          mainUtxo.txOutputValue,
          redeemerOutputScriptP2PKH,
        ]
      )

      await bank
        .connect(balanceOwner)
        .approveBalanceAndCall(bridge.target, requestedAmount, redemptionData)

      const redemptionKey = buildRedemptionKey(
        walletPubKeyHash,
        redeemerOutputScriptP2PKH
      )
      const redemption = await bridge.pendingRedemptions(redemptionKey)

      expect(redemption.redeemer).to.equal(thirdParty.address)
      expect(redemption.treasuryFee).to.equal(
        requestedAmount / BigInt(constants.redemptionTreasuryFeeDivisor)
      )
    })
  })

  describe("upgrade initializer", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should reject initializer from non-proxy-admin", async () => {
      await expect(
        bridge
          .connect(thirdParty)
          .initializeV6_ConfigurePegKeeper(thirdParty.address)
      ).to.be.reverted
    })

    it("should reject zero address initial peg keeper", async () => {
      const bridgeFactory = await getBridgeFactory()
      const newImplementation = await bridgeFactory.deploy()
      await newImplementation.waitForDeployment()

      const proxyAdminWithUpgrade = await getProxyAdminWithUpgrade()
      const upgradeData = bridgeFactory.interface.encodeFunctionData(
        "initializeV6_ConfigurePegKeeper",
        [AddressZero]
      )

      await expect(
        proxyAdminWithUpgrade.upgradeAndCall(
          bridge.target,
          newImplementation.target,
          upgradeData
        )
      ).to.be.reverted
    })

    it("should configure peg keeper and disable rebate staking", async () => {
      await bridgeGovernance
        .connect(governance)
        .setRebateStaking(rebateStaking.target)

      const bridgeFactory = await getBridgeFactory()
      const newImplementation = await bridgeFactory.deploy()
      await newImplementation.waitForDeployment()

      const proxyAdminWithUpgrade = await getProxyAdminWithUpgrade()
      const upgradeData = bridgeFactory.interface.encodeFunctionData(
        "initializeV6_ConfigurePegKeeper",
        [thirdParty.address]
      )

      const tx = await proxyAdminWithUpgrade.upgradeAndCall(
        bridge.target,
        newImplementation.target,
        upgradeData
      )

      await expect(tx)
        .to.emit(bridge, "PegKeeperUpdated")
        .withArgs(thirdParty.address, true)
      await expect(tx)
        .to.emit(bridge, "RebateStakingRepaired")
        .withArgs(rebateStaking.target, AddressZero)

      expect(await bridge.isPegKeeper(thirdParty.address)).to.be.true
      expect(await bridge.getRebateStaking()).to.equal(AddressZero)
    })

    it("should prevent rebate staking from being re-enabled after initializer", async () => {
      await bridgeGovernance
        .connect(governance)
        .setRebateStaking(rebateStaking.target)

      const bridgeFactory = await getBridgeFactory()
      const newImplementation = await bridgeFactory.deploy()
      await newImplementation.waitForDeployment()

      const proxyAdminWithUpgrade = await getProxyAdminWithUpgrade()
      const upgradeData = bridgeFactory.interface.encodeFunctionData(
        "initializeV6_ConfigurePegKeeper",
        [thirdParty.address]
      )

      await proxyAdminWithUpgrade.upgradeAndCall(
        bridge.target,
        newImplementation.target,
        upgradeData
      )

      expect(await bridge.getRebateStaking()).to.equal(AddressZero)
      await expect(
        bridgeGovernance
          .connect(governance)
          .setRebateStaking(rebateStaking.target)
      ).to.be.revertedWith("Rebate staking disabled")
    })
  })

  describe("partial landing / upgrade ordering", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should not emit RebateStakingRepaired when rebateStaking is already address(0)", async () => {
      const bridgeFactory = await getBridgeFactory()
      const newImplementation = await bridgeFactory.deploy()
      await newImplementation.waitForDeployment()

      const proxyAdminWithUpgrade = await getProxyAdminWithUpgrade()
      const upgradeData = bridgeFactory.interface.encodeFunctionData(
        "initializeV6_ConfigurePegKeeper",
        [thirdParty.address]
      )

      const tx = await proxyAdminWithUpgrade.upgradeAndCall(
        bridge.target,
        newImplementation.target,
        upgradeData
      )

      await expect(tx).to.not.emit(bridge, "RebateStakingRepaired")
      await expect(tx)
        .to.emit(bridge, "RebateStakingPermanentlyDisabled")
        .withArgs(AddressZero)
    })

    it("should revert when called twice (reinitializer guard)", async () => {
      // First successful upgrade
      const bridgeFactory = await getBridgeFactory()
      const newImplementation1 = await bridgeFactory.deploy()
      await newImplementation1.waitForDeployment()

      const proxyAdminWithUpgrade = await getProxyAdminWithUpgrade()
      const upgradeData1 = bridgeFactory.interface.encodeFunctionData(
        "initializeV6_ConfigurePegKeeper",
        [thirdParty.address]
      )

      await proxyAdminWithUpgrade.upgradeAndCall(
        bridge.target,
        newImplementation1.target,
        upgradeData1
      )

      // Second attempt with fresh implementation
      const newImplementation2 = await bridgeFactory.deploy()
      await newImplementation2.waitForDeployment()

      const upgradeData2 = bridgeFactory.interface.encodeFunctionData(
        "initializeV6_ConfigurePegKeeper",
        [thirdParty.address] // same or different initialPegKeeper
      )

      await expect(
        proxyAdminWithUpgrade.upgradeAndCall(
          bridge.target,
          newImplementation2.target,
          upgradeData2
        )
      ).to.be.reverted
    })

    it("should allow deposit/redemption with full fee when RebateStaking is deprecated but Bridge not upgraded", async () => {
      // Deprecate RebateStaking using proxy admin upgrade pattern
      const rebateStakingFactory = await ethers.getContractFactory(
        "RebateStaking",
        deployer
      )
      const newImplementation = await rebateStakingFactory.deploy()
      await newImplementation.waitForDeployment()

      const proxyAdmin = await upgrades.admin.getInstance()
      const proxyAdminWithUpgrade = await ethers.getContractAt(
        [
          "function upgradeAndCall(address proxy, address implementation, bytes data)",
        ],
        await proxyAdmin.getAddress(),
        esdm
      )

      const upgradeData = rebateStakingFactory.interface.encodeFunctionData(
        "initializeV2_Deprecate"
      )

      const tx = await proxyAdminWithUpgrade.upgradeAndCall(
        rebateStaking.target,
        newImplementation.target,
        upgradeData
      )

      await expect(tx).to.emit(rebateStaking, "RebateStakingDeprecated")

      // Verify RebateStaking is deprecated
      expect(await rebateStaking.deprecated()).to.be.true

      // Now perform a deposit or redemption through the EXISTING (pre-V6) bridge instance
      // Reusing existing deposit/redemption test patterns from this file's "deposits"/"redemptions" blocks

      // Register the wallet as Live and set its main UTXO, matching the
      // "redemptions" describe block's own beforeEach setup -- this block's
      // beforeEach only takes a snapshot and does not do this itself.
      await setLiveWallet(walletPubKeyHash)
      await bridge.setWalletMainUtxo(walletPubKeyHash, mainUtxo)

      // Set up a redemption allowance
      await makeRedemptionAllowance(thirdParty, requestedAmount)

      // Execute redemption through the existing bridge (pre-V6)
      const redeemTx = await bridge
        .connect(thirdParty)
        .requestRedemption(
          walletPubKeyHash,
          mainUtxo,
          redeemerOutputScriptP2WPKH,
          requestedAmount
        )

      // Confirm redemption was accepted (already implied by not throwing
      // above, since neither the call nor .wait() would resolve on a
      // revert -- but the actual claim under test is the fee amount, not
      // mere success).
      await redeemTx.wait()

      // Since RebateStaking is deprecated, it returns early from its
      // rebate hooks and does not waive the fee. Neither the peg-keeper
      // waiver (peg keeper is not configured here) nor the (now
      // early-returning) rebate applies, so the full, non-waived treasury
      // fee must be recorded -- mirroring the "should not waive
      // redemption treasury fee" assertion pattern above.
      const redemptionKey = buildRedemptionKey(
        walletPubKeyHash,
        redeemerOutputScriptP2WPKH
      )
      const redemption = await bridge.pendingRedemptions(redemptionKey)

      expect(redemption.redeemer).to.equal(thirdParty.address)
      expect(redemption.treasuryFee).to.equal(
        requestedAmount / BigInt(constants.redemptionTreasuryFeeDivisor)
      )
    })

    it("should disable rebate staking in Bridge when upgraded first, RebateStaking unaffected", async () => {
      // Call initializeV6_ConfigurePegKeeper alone (Bridge-side only) WITHOUT deprecating RebateStaking
      const bridgeFactory = await getBridgeFactory()
      const newImplementation = await bridgeFactory.deploy()
      await newImplementation.waitForDeployment()

      const proxyAdminWithUpgrade = await getProxyAdminWithUpgrade()
      const upgradeData = bridgeFactory.interface.encodeFunctionData(
        "initializeV6_ConfigurePegKeeper",
        [thirdParty.address]
      )

      await proxyAdminWithUpgrade.upgradeAndCall(
        bridge.target,
        newImplementation.target,
        upgradeData
      )

      // Assert await bridge.isRebateStakingDisabled() is true
      expect(await bridge.isRebateStakingDisabled()).to.be.true

      // Assert await bridge.getRebateStaking() equals AddressZero
      expect(await bridge.getRebateStaking()).to.equal(AddressZero)

      // Separately assert RebateStaking's OWN state is untouched: await rebateStaking.deprecated() is still false
      expect(await rebateStaking.deprecated()).to.be.false
    })
  })
  async function setPegKeeper(pegKeeper: string, allowed = true) {
    await bridgeGovernance
      .connect(governance)
      .beginPegKeeperUpdate(pegKeeper, allowed)
    await increaseTime(constants.governanceDelay)
    await bridgeGovernance.connect(governance).finalizePegKeeperUpdate()
  }

  async function getBridgeFactory() {
    const bridgeLibraries = {
      Deposit: (await helpers.contracts.getContract("Deposit")).target,
      DepositSweep: (await helpers.contracts.getContract("DepositSweep"))
        .target,
      Redemption: (await helpers.contracts.getContract("Redemption")).target,
      Wallets: (await helpers.contracts.getContract("Wallets")).target,
      Fraud: (await helpers.contracts.getContract("Fraud")).target,
      MovingFunds: (await helpers.contracts.getContract("MovingFunds")).target,
    }

    return ethers.getContractFactory("BridgeStub", {
      signer: deployer,
      libraries: bridgeLibraries,
    })
  }

  async function getProxyAdminWithUpgrade() {
    const proxyAdmin = await upgrades.admin.getInstance()

    return ethers.getContractAt(
      [
        "function upgradeAndCall(address proxy, address implementation, bytes data)",
      ],
      await proxyAdmin.getAddress(),
      esdm
    )
  }

  async function setLiveWallet(walletPublicKeyHash: string) {
    await bridge.setWallet(walletPublicKeyHash, {
      ecdsaWalletID: ethers.ZeroHash,
      mainUtxoHash: ethers.ZeroHash,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: ethers.ZeroHash,
    })
  }

  async function makeRedemptionAllowance(
    redeemer: HardhatEthersSigner,
    amount: BigNumberish
  ) {
    await bank.setBalance(redeemer.address, amount)
    await bank.connect(redeemer).increaseBalanceAllowance(bridge.target, amount)
  }

  function buildRedemptionKey(
    redemptionWalletPubKeyHash: BytesLike,
    redeemerOutputScript: BytesLike
  ): string {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "bytes20"],
      [
        ethers.solidityPackedKeccak256(["bytes"], [redeemerOutputScript]),
        redemptionWalletPubKeyHash,
      ]
    )
  }
})
