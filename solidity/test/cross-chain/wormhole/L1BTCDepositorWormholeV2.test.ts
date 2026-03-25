import { ethers, getUnnamedAccounts, helpers, upgrades, waffle } from "hardhat"
import { randomBytes } from "crypto"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, Contract, ContractTransaction } from "ethers"
import {
  IBridge,
  IWormholeGateway,
  ITBTCVault,
  IWormhole,
  IWormholeRelayer,
  IWormholeTokenBridge,
  L1BTCDepositorWormholeV2,
  L1BTCDepositorWormhole,
  ReimbursementPool,
  TestERC20,
} from "../../../typechain"
import { to1ePrecision } from "../../helpers/contract-test-helpers"
import {
  initializeDepositFixture,
  toWormholeAddress,
} from "./L1BTCDepositorWormhole.test"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time
// Arbitrary chain IDs matching the V1 test.
const l1ChainId = 10
const l2ChainId = 20
// Arbitrary TBTCVault address matching the V1 test.
const tbtcVaultAddress = "0xB5679dE944A79732A75CE556191DF11F489448d5"

describe("L1BTCDepositorWormholeV2", () => {
  const contractsFixture = async () => {
    const { deployer, governance } = await helpers.signers.getNamedSigners()

    const accounts = await getUnnamedAccounts()
    const relayer = await ethers.getSigner(accounts[1])

    const bridge = await smock.fake<IBridge>("IBridge")
    const tbtcToken = await (
      await ethers.getContractFactory("TestERC20")
    ).deploy()
    const tbtcVault = await smock.fake<ITBTCVault>("ITBTCVault", {
      address: tbtcVaultAddress,
    })
    tbtcVault.tbtcToken.returns(tbtcToken.address)

    const wormhole = await smock.fake<IWormhole>("IWormhole")
    wormhole.chainId.returns(l1ChainId)

    const wormholeRelayer = await smock.fake<IWormholeRelayer>(
      "IWormholeRelayer"
    )
    const wormholeTokenBridge = await smock.fake<IWormholeTokenBridge>(
      "IWormholeTokenBridge"
    )
    const l2WormholeGateway = await smock.fake<IWormholeGateway>(
      "IWormholeGateway"
    )
    const l2BtcDepositor = "0xeE6F5f69860f310114185677D017576aed0dEC83"
    const reimbursementPool = await smock.fake<ReimbursementPool>(
      "ReimbursementPool"
    )

    const deployment = await helpers.upgrades.deployProxy(
      `L1BTCDepositorWormholeV2_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L1BTCDepositorWormholeV2",
        initializerArgs: [
          bridge.address,
          tbtcVault.address,
          wormhole.address,
          wormholeRelayer.address,
          wormholeTokenBridge.address,
          l2WormholeGateway.address,
          l2ChainId,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    const l1BtcDepositor = deployment[0] as L1BTCDepositorWormholeV2

    await l1BtcDepositor.connect(deployer).transferOwnership(governance.address)

    return {
      governance,
      relayer,
      bridge,
      tbtcToken,
      tbtcVault,
      wormhole,
      wormholeRelayer,
      wormholeTokenBridge,
      l2WormholeGateway,
      l2BtcDepositor,
      reimbursementPool,
      l1BtcDepositor,
    }
  }

  let governance: SignerWithAddress
  let relayer: SignerWithAddress

  let bridge: FakeContract<IBridge>
  let tbtcToken: TestERC20
  let tbtcVault: FakeContract<ITBTCVault>
  let wormhole: FakeContract<IWormhole>
  let wormholeRelayer: FakeContract<IWormholeRelayer>
  let wormholeTokenBridge: FakeContract<IWormholeTokenBridge>
  let l2WormholeGateway: FakeContract<IWormholeGateway>
  let l2BtcDepositor: string
  let reimbursementPool: FakeContract<ReimbursementPool>
  let l1BtcDepositor: L1BTCDepositorWormholeV2

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      relayer,
      bridge,
      tbtcToken,
      tbtcVault,
      wormhole,
      wormholeRelayer,
      wormholeTokenBridge,
      l2WormholeGateway,
      l2BtcDepositor,
      reimbursementPool,
      l1BtcDepositor,
    } = await waffle.loadFixture(contractsFixture))
  })

  describe("storage layout compatibility", () => {
    it("should have wormhole at the same storage position as V1", async () => {
      expect(await l1BtcDepositor.wormhole()).to.equal(wormhole.address)
    })

    it("should have wormholeRelayer at the same storage position as V1", async () => {
      expect(await l1BtcDepositor.wormholeRelayer()).to.equal(
        wormholeRelayer.address
      )
    })

    it("should have wormholeTokenBridge at the same storage position as V1", async () => {
      expect(await l1BtcDepositor.wormholeTokenBridge()).to.equal(
        wormholeTokenBridge.address
      )
    })

    it("should have l2WormholeGateway at the same storage position as V1", async () => {
      expect(await l1BtcDepositor.l2WormholeGateway()).to.equal(
        l2WormholeGateway.address
      )
    })

    it("should have l2ChainId at the same storage position as V1", async () => {
      expect(await l1BtcDepositor.l2ChainId()).to.equal(l2ChainId)
    })

    it("should have l2FinalizeDepositGasLimit initialized as V1", async () => {
      expect(await l1BtcDepositor.l2FinalizeDepositGasLimit()).to.equal(500000)
    })
  })

  describe("quoteFinalizeDeposit", () => {
    const messageFee = 1000

    before(async () => {
      await createSnapshot()
      wormhole.messageFee.returns(messageFee)
    })

    after(async () => {
      wormhole.messageFee.reset()
      await restoreSnapshot()
    })

    it("should return only wormhole.messageFee", async () => {
      const cost = await l1BtcDepositor.quoteFinalizeDeposit()
      expect(cost).to.be.equal(messageFee)
    })
  })

  describe("finalizeDeposit", () => {
    before(async () => {
      await createSnapshot()

      await l1BtcDepositor
        .connect(governance)
        .attachL2BtcDepositor(l2BtcDepositor)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when normalized amount is too low to bridge", () => {
      before(async () => {
        await createSnapshot()

        await l1BtcDepositor
          .connect(relayer)
          .initializeDeposit(
            initializeDepositFixture.fundingTx,
            initializeDepositFixture.reveal,
            initializeDepositFixture.destinationChainDepositOwner
          )

        const revealedAt = (await lastBlockTime()) - 7200
        const finalizedAt = await lastBlockTime()
        bridge.deposits
          .whenCalledWith(initializeDepositFixture.depositKey)
          .returns({
            depositor: ethers.constants.AddressZero,
            amount: BigNumber.from(0),
            revealedAt,
            vault: ethers.constants.AddressZero,
            treasuryFee: BigNumber.from(0),
            sweptAt: finalizedAt,
            extraData: ethers.constants.HashZero,
          })

        tbtcVault.optimisticMintingRequests
          .whenCalledWith(initializeDepositFixture.depositKey)
          .returns([revealedAt, finalizedAt])
      })

      after(async () => {
        bridge.revealDepositWithExtraData.reset()
        bridge.deposits.reset()
        tbtcVault.optimisticMintingRequests.reset()

        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          l1BtcDepositor
            .connect(relayer)
            .finalizeDeposit(initializeDepositFixture.depositKey)
        ).to.be.revertedWith("Amount too low to bridge")
      })
    })

    context("when msg.value does not match messageFee", () => {
      // V2 uses strict equality (msg.value == messageFee) so both
      // underpayment and overpayment must revert.
      const messageFee = 1000

      before(async () => {
        await createSnapshot()

        await l1BtcDepositor
          .connect(relayer)
          .initializeDeposit(
            initializeDepositFixture.fundingTx,
            initializeDepositFixture.reveal,
            initializeDepositFixture.destinationChainDepositOwner
          )

        const revealedAt = (await lastBlockTime()) - 7200
        const finalizedAt = await lastBlockTime()
        bridge.deposits
          .whenCalledWith(initializeDepositFixture.depositKey)
          .returns({
            depositor: ethers.constants.AddressZero,
            amount: BigNumber.from(100000),
            revealedAt,
            vault: ethers.constants.AddressZero,
            treasuryFee: BigNumber.from(0),
            sweptAt: finalizedAt,
            extraData: ethers.constants.HashZero,
          })

        tbtcVault.optimisticMintingRequests
          .whenCalledWith(initializeDepositFixture.depositKey)
          .returns([revealedAt, finalizedAt])

        wormhole.messageFee.returns(messageFee)
        wormholeTokenBridge.transferTokensWithPayload.returns(0)
      })

      after(async () => {
        bridge.revealDepositWithExtraData.reset()
        bridge.deposits.reset()
        tbtcVault.optimisticMintingRequests.reset()
        wormhole.messageFee.reset()
        wormholeTokenBridge.transferTokensWithPayload.reset()

        await restoreSnapshot()
      })

      it("should revert when msg.value is less than messageFee", async () => {
        await expect(
          l1BtcDepositor
            .connect(relayer)
            .finalizeDeposit(initializeDepositFixture.depositKey, {
              value: messageFee - 1,
            })
        ).to.be.revertedWith("Payment for Wormhole Relayer is too low")
      })

      it("should revert when msg.value is greater than messageFee", async () => {
        await expect(
          l1BtcDepositor
            .connect(relayer)
            .finalizeDeposit(initializeDepositFixture.depositKey, {
              value: messageFee + 1,
            })
        ).to.be.revertedWith("Payment for Wormhole Relayer is too low")
      })
    })

    context("when deposit finalization succeeds", () => {
      const satoshiMultiplier = to1ePrecision(1, 10)
      const messageFee = 1000
      const transferSequence = 555
      const depositAmount = BigNumber.from(100000)
      const treasuryFee = BigNumber.from(500)
      const optimisticMintingFeeDivisor = 20
      const depositTxMaxFee = BigNumber.from(1000)

      // amountSubTreasury = (depositAmount - treasuryFee) * satoshiMultiplier = 99500 * 1e10
      // omFee = amountSubTreasury / optimisticMintingFeeDivisor = 4975 * 1e10
      // txMaxFee = depositTxMaxFee * satoshiMultiplier = 1000 * 1e10
      // tbtcAmount = amountSubTreasury - omFee - txMaxFee = 93525 * 1e10
      const expectedTbtcAmount = to1ePrecision(93525, 10)

      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await l1BtcDepositor
          .connect(relayer)
          .initializeDeposit(
            initializeDepositFixture.fundingTx,
            initializeDepositFixture.reveal,
            initializeDepositFixture.destinationChainDepositOwner
          )

        bridge.depositParameters.returns({
          depositDustThreshold: 0,
          depositTreasuryFeeDivisor: 0,
          depositTxMaxFee,
          depositRevealAheadPeriod: 0,
        })
        tbtcVault.optimisticMintingFeeDivisor.returns(
          optimisticMintingFeeDivisor
        )

        const revealedAt = (await lastBlockTime()) - 7200
        const finalizedAt = await lastBlockTime()
        bridge.deposits
          .whenCalledWith(initializeDepositFixture.depositKey)
          .returns({
            depositor: l1BtcDepositor.address,
            amount: depositAmount,
            revealedAt,
            vault: initializeDepositFixture.reveal.vault,
            treasuryFee,
            sweptAt: finalizedAt,
            extraData: initializeDepositFixture.destinationChainDepositOwner,
          })

        tbtcVault.optimisticMintingRequests
          .whenCalledWith(initializeDepositFixture.depositKey)
          .returns([revealedAt, finalizedAt])

        // V2 mocks: only messageFee and transferTokensWithPayload.
        // No wormholeRelayer.quoteEVMDeliveryPrice or sendVaasToEvm.
        wormhole.messageFee.returns(messageFee)
        wormholeTokenBridge.transferTokensWithPayload.returns(transferSequence)

        // V2 requires only messageFee as msg.value (no delivery cost).
        tx = await l1BtcDepositor
          .connect(relayer)
          .finalizeDeposit(initializeDepositFixture.depositKey, {
            value: messageFee,
          })
      })

      after(async () => {
        bridge.depositParameters.reset()
        tbtcVault.optimisticMintingFeeDivisor.reset()
        bridge.revealDepositWithExtraData.reset()
        bridge.deposits.reset()
        tbtcVault.optimisticMintingRequests.reset()
        wormhole.messageFee.reset()
        wormholeTokenBridge.transferTokensWithPayload.reset()

        await restoreSnapshot()
      })

      it("should set the deposit state to Finalized", async () => {
        expect(
          await l1BtcDepositor.deposits(initializeDepositFixture.depositKey)
        ).to.equal(2)
      })

      it("should increase TBTC allowance for Wormhole Token Bridge", async () => {
        expect(
          await tbtcToken.allowance(
            l1BtcDepositor.address,
            wormholeTokenBridge.address
          )
        ).to.equal(expectedTbtcAmount)
      })

      it("should call transferTokensWithPayload with correct args", async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(wormholeTokenBridge.transferTokensWithPayload).to.have.been
          .calledOnce

        const call = wormholeTokenBridge.transferTokensWithPayload.getCall(0)
        expect(call.value).to.equal(messageFee)
        expect(call.args[0]).to.equal(tbtcToken.address)
        expect(call.args[1]).to.equal(expectedTbtcAmount)
        expect(call.args[2]).to.equal(await l1BtcDepositor.l2ChainId())
        expect(call.args[3]).to.equal(
          toWormholeAddress(l2WormholeGateway.address.toLowerCase())
        )
        expect(call.args[4]).to.equal(0)
        // V2 uses abi.encode(l2Receiver) matching V1 (not encodePacked).
        expect(call.args[5]).to.equal(
          initializeDepositFixture.destinationChainDepositOwner.toLowerCase()
        )
      })

      it("should NOT call sendVaasToEvm", async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(wormholeRelayer.sendVaasToEvm).to.not.have.been.called
      })

      it("should emit TokensTransferredWithPayload event", async () => {
        // The V2 event emits `address` (not `bytes32`). Extract the
        // 20-byte address from the 32-byte Wormhole-padded value.
        const l2ReceiverAddress = ethers.utils.getAddress(
          `0x${initializeDepositFixture.destinationChainDepositOwner.slice(26)}`
        )
        await expect(tx)
          .to.emit(l1BtcDepositor, "TokensTransferredWithPayload")
          .withArgs(expectedTbtcAmount, l2ReceiverAddress, transferSequence)
      })
    })
  })

  describe("proxy upgrade from V1 to V2", () => {
    let v1Proxy: L1BTCDepositorWormhole
    let v2Proxy: L1BTCDepositorWormholeV2

    const l2BtcDepositorAddr = "0xeE6F5f69860f310114185677D017576aed0dEC83"
    const gasLimit = 750000

    before(async () => {
      await createSnapshot()

      const { deployer, governance: gov } =
        await helpers.signers.getNamedSigners()

      const bridge2 = await smock.fake<IBridge>("IBridge")
      const tbtcToken2 = await (
        await ethers.getContractFactory("TestERC20")
      ).deploy()
      const tbtcVault2 = await smock.fake<ITBTCVault>("ITBTCVault", {
        address: "0xB5679dE944A79732A75CE556191DF11F489448d5",
      })
      tbtcVault2.tbtcToken.returns(tbtcToken2.address)

      const wh = await smock.fake<IWormhole>("IWormhole")
      wh.chainId.returns(l1ChainId)
      const whRelayer = await smock.fake<IWormholeRelayer>("IWormholeRelayer")
      const whBridge = await smock.fake<IWormholeTokenBridge>(
        "IWormholeTokenBridge"
      )
      const l2Gateway = await smock.fake<IWormholeGateway>("IWormholeGateway")

      // Deploy V1 behind proxy.
      const proxyName = `L1BTCDepositorWormhole_upgrade_${randomBytes(
        8
      ).toString("hex")}`
      const v1Deployment = await helpers.upgrades.deployProxy(proxyName, {
        contractName: "L1BTCDepositorWormhole",
        initializerArgs: [
          bridge2.address,
          tbtcVault2.address,
          wh.address,
          whRelayer.address,
          whBridge.address,
          l2Gateway.address,
          l2ChainId,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      })
      v1Proxy = v1Deployment[0] as L1BTCDepositorWormhole

      await v1Proxy.connect(deployer).transferOwnership(gov.address)

      // Populate additional state fields on V1.
      await v1Proxy.connect(gov).attachL2BtcDepositor(l2BtcDepositorAddr)
      await v1Proxy.connect(gov).updateL2FinalizeDepositGasLimit(gasLimit)

      // Verify V1 state before upgrade.
      expect(await v1Proxy.wormhole()).to.equal(wh.address)
      expect(await v1Proxy.wormholeRelayer()).to.equal(whRelayer.address)
      expect(await v1Proxy.wormholeTokenBridge()).to.equal(whBridge.address)
      expect(await v1Proxy.l2WormholeGateway()).to.equal(l2Gateway.address)
      expect(await v1Proxy.l2ChainId()).to.equal(l2ChainId)
      expect(await v1Proxy.l2BtcDepositor()).to.equal(l2BtcDepositorAddr)
      expect(await v1Proxy.l2FinalizeDepositGasLimit()).to.equal(gasLimit)

      // Upgrade proxy implementation from V1 to V2 via the shared
      // ProxyAdmin. In the full test suite, deploy script 26 transfers
      // ProxyAdmin ownership to the "esdm" named signer, so we look up the
      // actual owner and impersonate them to perform the upgrade.
      const proxyAdmin: Contract = await upgrades.admin.getInstance()
      const proxyAdminOwner = await proxyAdmin.owner()
      const ownerSigner = await ethers.getSigner(proxyAdminOwner)

      const v2Factory = await ethers.getContractFactory(
        "L1BTCDepositorWormholeV2",
        deployer
      )
      const v2Impl = await v2Factory.deploy()
      await v2Impl.deployed()

      await proxyAdmin
        .connect(ownerSigner)
        .upgrade(v1Proxy.address, v2Impl.address)

      v2Proxy = (await ethers.getContractAt(
        "L1BTCDepositorWormholeV2",
        v1Proxy.address
      )) as L1BTCDepositorWormholeV2
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should preserve wormhole address after upgrade", async () => {
      expect(await v2Proxy.wormhole()).to.equal(await v1Proxy.wormhole())
    })

    it("should preserve wormholeRelayer address after upgrade", async () => {
      expect(await v2Proxy.wormholeRelayer()).to.equal(
        await v1Proxy.wormholeRelayer()
      )
    })

    it("should preserve wormholeTokenBridge address after upgrade", async () => {
      expect(await v2Proxy.wormholeTokenBridge()).to.equal(
        await v1Proxy.wormholeTokenBridge()
      )
    })

    it("should preserve l2WormholeGateway address after upgrade", async () => {
      expect(await v2Proxy.l2WormholeGateway()).to.equal(
        await v1Proxy.l2WormholeGateway()
      )
    })

    it("should preserve l2ChainId after upgrade", async () => {
      expect(await v2Proxy.l2ChainId()).to.equal(l2ChainId)
    })

    it("should preserve l2BtcDepositor after upgrade", async () => {
      expect(await v2Proxy.l2BtcDepositor()).to.equal(l2BtcDepositorAddr)
    })

    it("should preserve l2FinalizeDepositGasLimit after upgrade", async () => {
      expect(await v2Proxy.l2FinalizeDepositGasLimit()).to.equal(gasLimit)
    })
  })
})
