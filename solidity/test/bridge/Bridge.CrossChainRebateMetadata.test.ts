import { ethers, helpers } from "hardhat"
import chai, { expect } from "chai"
import { smock } from "@defi-wonderland/smock"
import { BigNumber } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  BankStub,
  Bridge,
  BridgeStub,
  RebateStaking,
} from "../../typechain"
import { walletState } from "../fixtures"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Bridge - Cross-chain redemption rebate metadata", () => {
  const sourceChainId = 8453
  const wormholeChainId = 30
  const requestedAmount = BigNumber.from(1901000)
  const treasuryFee = requestedAmount.div(2000)
  const noRebateRedemptionGasCeiling = 160000
  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const redeemerOutputScript =
    "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"
  const rebateActionId = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes("cross-chain-redemption-no-rebate")
  )
  const mainUtxo = {
    txHash:
      "0x3835ecdee2daa83c9a19b5012104ace55ecab197b5e16489c26d372e475f5d2a",
    txOutputIndex: 0,
    txOutputValue: 10000000,
  }

  let deployer: SignerWithAddress
  let integrator: SignerWithAddress
  let rebateBeneficiary: SignerWithAddress
  let bank: BankStub
  let bridge: Bridge & BridgeStub
  let rebateStaking: RebateStaking

  async function deployBridgeStub(): Promise<Bridge & BridgeStub> {
    const Deposit = await (await ethers.getContractFactory("Deposit")).deploy()
    const DepositSweep = await (
      await ethers.getContractFactory("DepositSweep")
    ).deploy()
    const Redemption = await (
      await ethers.getContractFactory("Redemption")
    ).deploy()
    const Wallets = await (
      await ethers.getContractFactory("contracts/bridge/Wallets.sol:Wallets")
    ).deploy()
    const Fraud = await (await ethers.getContractFactory("Fraud")).deploy()
    const MovingFunds = await (
      await ethers.getContractFactory("MovingFunds")
    ).deploy()

    const BridgeStubFactory = await ethers.getContractFactory("BridgeStub", {
      libraries: {
        Deposit: Deposit.address,
        DepositSweep: DepositSweep.address,
        Redemption: Redemption.address,
        Wallets: Wallets.address,
        Fraud: Fraud.address,
        MovingFunds: MovingFunds.address,
      },
    })
    const implementation = await BridgeStubFactory.deploy()
    await implementation.deployed()

    const initializerData = BridgeStubFactory.interface.encodeFunctionData(
      "initialize",
      [
        bank.address,
        deployer.address,
        deployer.address,
        deployer.address,
        deployer.address,
        1,
      ]
    )
    const ERC1967ProxyFactory = await ethers.getContractFactory("ERC1967Proxy")
    const proxy = await ERC1967ProxyFactory.deploy(
      implementation.address,
      initializerData
    )
    await proxy.deployed()

    return BridgeStubFactory.attach(proxy.address) as Bridge & BridgeStub
  }

  async function requestCrossChainRedemptionWithNoAppliedRebate() {
    const tx = await bridge
      .connect(integrator)
      .requestRedemptionWithRebate(
        walletPubKeyHash,
        mainUtxo,
        integrator.address,
        integrator.address,
        redeemerOutputScript,
        requestedAmount,
        rebateBeneficiary.address,
        {
          sourceChainId,
          l2User: rebateBeneficiary.address,
          flowType: 1,
          actionId: rebateActionId,
          maxRebateSat: 0,
          authorization: "0x",
        }
      )

    return tx.wait()
  }

  beforeEach(async () => {
    await createSnapshot()
    ;[deployer, integrator, rebateBeneficiary] = await ethers.getSigners()

    const BankStubFactory = await ethers.getContractFactory("BankStub")
    bank = (await BankStubFactory.deploy()) as BankStub
    await bank.deployed()

    bridge = await deployBridgeStub()
    await bank.updateBridge(bridge.address)

    rebateStaking = await smock.fake<RebateStaking>("RebateStaking")
    rebateStaking.applyForRebateFor.returns(treasuryFee)

    await bridge.setRebateStaking(rebateStaking.address)
    await bridge.setCrossChainIntegrator(
      integrator.address,
      true,
      sourceChainId,
      wormholeChainId
    )
    await bridge.setWallet(walletPubKeyHash, {
      ecdsaWalletID: ethers.constants.HashZero,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: 0,
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })
    await bridge.setWalletMainUtxo(walletPubKeyHash, mainUtxo)
    await bridge.setActiveWallet(walletPubKeyHash)

    await bank.setBalance(integrator.address, requestedAmount)
    await bank
      .connect(integrator)
      .approveBalance(bridge.address, requestedAmount)
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  it("does not store cancellation metadata when rebate staking applies no rebate", async () => {
    await requestCrossChainRedemptionWithNoAppliedRebate()

    const redemptionKey = ethers.utils.solidityKeccak256(
      ["bytes32", "bytes20"],
      [
        ethers.utils.solidityKeccak256(["bytes"], [redeemerOutputScript]),
        walletPubKeyHash,
      ]
    )
    const redemptionRequest = await bridge.pendingRedemptions(redemptionKey)
    const rebateRecord = await bridge.getCrossChainRedemptionRebate(
      redemptionKey
    )

    expect(redemptionRequest.treasuryFee).to.equal(treasuryFee)
    expect(rebateRecord.rebateBeneficiary).to.equal(
      ethers.constants.AddressZero
    )
    expect(rebateRecord.actionId).to.equal(ethers.constants.HashZero)
  })

  it("keeps no-rebate cross-chain redemption gas below the regression ceiling", async () => {
    const receipt = await requestCrossChainRedemptionWithNoAppliedRebate()

    expect(receipt.gasUsed.toNumber()).to.be.lessThan(
      noRebateRedemptionGasCeiling
    )
  })
})
