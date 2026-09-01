/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers, helpers, upgrades } from "hardhat"
import { expect } from "chai"
import { BigNumber, BigNumberish } from "ethers"
import { BytesLike } from "@ethersproject/bytes"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
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
const { AddressZero } = ethers.constants

describe("Bridge - Peg keeper", () => {
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let esdm: SignerWithAddress

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
  const requestedAmount = BigNumber.from(1901000)

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, governance, esdm } = await helpers.signers.getNamedSigners())
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
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
        value: 10,
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

      const depositKey = ethers.utils.solidityKeccak256(
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

      const redemptionData = ethers.utils.defaultAbiCoder.encode(
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
        .approveBalanceAndCall(bridge.address, requestedAmount, redemptionData)

      const redemptionKey = buildRedemptionKey(
        walletPubKeyHash,
        redeemerOutputScriptP2PKH
      )
      const redemption = await bridge.pendingRedemptions(redemptionKey)

      expect(redemption.redeemer).to.equal(thirdParty.address)
      expect(redemption.treasuryFee).to.equal(
        requestedAmount.div(constants.redemptionTreasuryFeeDivisor)
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
      await newImplementation.deployed()

      const proxyAdminWithUpgrade = await getProxyAdminWithUpgrade()
      const upgradeData = bridgeFactory.interface.encodeFunctionData(
        "initializeV6_ConfigurePegKeeper",
        [AddressZero]
      )

      await expect(
        proxyAdminWithUpgrade.upgradeAndCall(
          bridge.address,
          newImplementation.address,
          upgradeData
        )
      ).to.be.reverted
    })

    it("should configure peg keeper and disable rebate staking", async () => {
      await bridgeGovernance
        .connect(governance)
        .setRebateStaking(rebateStaking.address)

      const bridgeFactory = await getBridgeFactory()
      const newImplementation = await bridgeFactory.deploy()
      await newImplementation.deployed()

      const proxyAdminWithUpgrade = await getProxyAdminWithUpgrade()
      const upgradeData = bridgeFactory.interface.encodeFunctionData(
        "initializeV6_ConfigurePegKeeper",
        [thirdParty.address]
      )

      const tx = await proxyAdminWithUpgrade.upgradeAndCall(
        bridge.address,
        newImplementation.address,
        upgradeData
      )

      await expect(tx)
        .to.emit(bridge, "PegKeeperUpdated")
        .withArgs(thirdParty.address, true)
      await expect(tx)
        .to.emit(bridge, "RebateStakingRepaired")
        .withArgs(rebateStaking.address, AddressZero)

      expect(await bridge.isPegKeeper(thirdParty.address)).to.be.true
      expect(await bridge.getRebateStaking()).to.equal(AddressZero)
    })

    it("should prevent rebate staking from being re-enabled after initializer", async () => {
      await bridgeGovernance
        .connect(governance)
        .setRebateStaking(rebateStaking.address)

      const bridgeFactory = await getBridgeFactory()
      const newImplementation = await bridgeFactory.deploy()
      await newImplementation.deployed()

      const proxyAdminWithUpgrade = await getProxyAdminWithUpgrade()
      const upgradeData = bridgeFactory.interface.encodeFunctionData(
        "initializeV6_ConfigurePegKeeper",
        [thirdParty.address]
      )

      await proxyAdminWithUpgrade.upgradeAndCall(
        bridge.address,
        newImplementation.address,
        upgradeData
      )

      expect(await bridge.getRebateStaking()).to.equal(AddressZero)
      await expect(
        bridgeGovernance
          .connect(governance)
          .setRebateStaking(rebateStaking.address)
      ).to.be.revertedWith("Rebate staking disabled")
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
      Deposit: (await helpers.contracts.getContract("Deposit")).address,
      DepositSweep: (await helpers.contracts.getContract("DepositSweep"))
        .address,
      Redemption: (await helpers.contracts.getContract("Redemption")).address,
      Wallets: (await helpers.contracts.getContract("Wallets")).address,
      Fraud: (await helpers.contracts.getContract("Fraud")).address,
      MovingFunds: (await helpers.contracts.getContract("MovingFunds")).address,
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
      proxyAdmin.address,
      esdm
    )
  }

  async function setLiveWallet(walletPublicKeyHash: string) {
    await bridge.setWallet(walletPublicKeyHash, {
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
  }

  async function makeRedemptionAllowance(
    redeemer: SignerWithAddress,
    amount: BigNumberish
  ) {
    await bank.setBalance(redeemer.address, amount)
    await bank
      .connect(redeemer)
      .increaseBalanceAllowance(bridge.address, amount)
  }

  function buildRedemptionKey(
    redemptionWalletPubKeyHash: BytesLike,
    redeemerOutputScript: BytesLike
  ): string {
    return ethers.utils.solidityKeccak256(
      ["bytes32", "bytes20"],
      [
        ethers.utils.solidityKeccak256(["bytes"], [redeemerOutputScript]),
        redemptionWalletPubKeyHash,
      ]
    )
  }
})
