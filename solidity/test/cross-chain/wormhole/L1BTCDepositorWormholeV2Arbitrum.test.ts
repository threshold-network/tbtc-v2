import { ethers, getUnnamedAccounts, helpers, upgrades, waffle } from "hardhat"
import { randomBytes } from "crypto"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, Contract, ContractTransaction } from "ethers"
import * as fs from "fs"
import * as path from "path"
import {
  IBridge,
  IWormholeGateway,
  ITBTCVault,
  IWormhole,
  IWormholeRelayer,
  IWormholeTokenBridge,
  L1BTCDepositorWormholeV2Arbitrum,
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

const STORAGE_LAYOUT_INVARIANTS: Array<{
  label: string
  slot: string
  offset: number
  typeCategory: string
}> = [
  { label: "_initialized", slot: "0", offset: 0, typeCategory: "t_uint8" },
  { label: "_initializing", slot: "0", offset: 1, typeCategory: "t_bool" },
  {
    label: "bridge",
    slot: "0",
    offset: 2,
    typeCategory: "t_contract(IBridge)",
  },
  { label: "deposits", slot: "199", offset: 0, typeCategory: "t_mapping" },
  {
    label: "l2WormholeGateway",
    slot: "204",
    offset: 0,
    typeCategory: "t_address",
  },
  { label: "l2ChainId", slot: "204", offset: 20, typeCategory: "t_uint16" },
  {
    label: "l2BitcoinDepositor",
    slot: "205",
    offset: 0,
    typeCategory: "t_address",
  },
  {
    label: "reimburseTxMaxFee",
    slot: "211",
    offset: 0,
    typeCategory: "t_bool",
  },
]

async function getV2StorageLayout(): Promise<
  Array<{
    label: string
    slot: string
    offset: number
    type: string
  }>
> {
  const parseJson = <T>(serialized: string, filePath: string): T => {
    try {
      return JSON.parse(serialized) as T
    } catch {
      throw new Error(`Failed to parse JSON artifact: ${filePath}`)
    }
  }

  const debugArtifactPath = path.resolve(
    __dirname,
    "../../../build/contracts/cross-chain/wormhole/" +
      "L1BTCDepositorWormholeV2Arbitrum.sol/L1BTCDepositorWormholeV2Arbitrum.dbg.json"
  )
  const debugArtifact = parseJson<{ buildInfo: string }>(
    await fs.promises.readFile(debugArtifactPath, "utf8"),
    debugArtifactPath
  )
  const buildInfoPath = path.resolve(
    path.dirname(debugArtifactPath),
    debugArtifact.buildInfo
  )
  const buildInfo = parseJson<Record<string, any>>(
    await fs.promises.readFile(buildInfoPath, "utf8"),
    buildInfoPath
  )
  const layout =
    buildInfo?.output?.contracts?.[
      "contracts/cross-chain/wormhole/L1BTCDepositorWormholeV2Arbitrum.sol"
    ]?.L1BTCDepositorWormholeV2Arbitrum?.storageLayout

  if (!layout?.storage) {
    throw new Error(
      "storageLayout not found for L1BTCDepositorWormholeV2Arbitrum. " +
        "Run `yarn build` first."
    )
  }

  return layout.storage
}

describe("L1BTCDepositorWormholeV2Arbitrum", () => {
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
    const l2BitcoinDepositor = "0xeE6F5f69860f310114185677D017576aed0dEC83"
    const reimbursementPool = await smock.fake<ReimbursementPool>(
      "ReimbursementPool"
    )

    const deployment = await helpers.upgrades.deployProxy(
      `L1BTCDepositorWormholeV2Arbitrum_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L1BTCDepositorWormholeV2Arbitrum",
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
    const l1BtcDepositor = deployment[0] as L1BTCDepositorWormholeV2Arbitrum

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
      l2BitcoinDepositor,
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
  let l2BitcoinDepositor: string
  let reimbursementPool: FakeContract<ReimbursementPool>
  let l1BtcDepositor: L1BTCDepositorWormholeV2Arbitrum

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
      l2BitcoinDepositor,
      reimbursementPool,
      l1BtcDepositor,
    } = await waffle.loadFixture(contractsFixture))
  })

  describe("storage layout invariants", () => {
    let compiledLayout: Array<{
      label: string
      slot: string
      offset: number
      type: string
    }>

    before(async () => {
      compiledLayout = await getV2StorageLayout()
    })

    it("should load the compiled storage layout from the debug artifact", () => {
      if (compiledLayout.length === 0) {
        throw new Error("Compiled storage layout should not be empty")
      }

      if (compiledLayout[0]?.label !== "_initialized") {
        throw new Error("First compiled storage entry should be _initialized")
      }
    })

    STORAGE_LAYOUT_INVARIANTS.forEach((expected) => {
      it(`should have '${expected.label}' at slot ${expected.slot} offset ${expected.offset}`, () => {
        const compiled = compiledLayout.find(
          (entry) =>
            entry.label === expected.label &&
            entry.slot === expected.slot &&
            entry.offset === expected.offset
        )

        if (!compiled) {
          throw new Error(
            `Expected '${expected.label}' at slot ${expected.slot}:${expected.offset} ` +
              "but it was not found in the compiled layout"
          )
        }

        if (expected.typeCategory.startsWith("t_mapping")) {
          if (!compiled.type.startsWith("t_mapping")) {
            throw new Error(
              `Type mismatch for '${expected.label}': ` +
                `expected mapping type but got '${compiled.type}'`
            )
          }
        } else if (expected.typeCategory.startsWith("t_contract")) {
          const expectedPrefix = expected.typeCategory
          if (!compiled.type.startsWith(expectedPrefix)) {
            throw new Error(
              `Type mismatch for '${expected.label}': ` +
                `expected type starting with '${expectedPrefix}' ` +
                `but got '${compiled.type}'`
            )
          }
        } else if (compiled.type !== expected.typeCategory) {
          throw new Error(
            `Type mismatch for '${expected.label}': ` +
              `expected '${expected.typeCategory}' but got '${compiled.type}'`
          )
        }
      })
    })

    it("should keep the deployed-family field naming for l2BitcoinDepositor", () => {
      const entry = compiledLayout.find((e) => e.label === "l2BitcoinDepositor")
      if (!entry) {
        throw new Error(
          "l2BitcoinDepositor not found -- " +
            "variable may still use 'l2BtcDepositor' naming"
        )
      }

      if (entry.slot !== "205") {
        throw new Error(
          `l2BitcoinDepositor should remain at slot 205, got ${entry.slot}`
        )
      }
    })

    it("should NOT have l2BtcDepositor (local family naming)", () => {
      const entry = compiledLayout.find((e) => e.label === "l2BtcDepositor")
      if (entry) {
        throw new Error(
          "l2BtcDepositor should not exist -- " +
            "must be renamed to l2BitcoinDepositor"
        )
      }
    })
  })

  describe("copied function accessibility", () => {
    it("should expose updateGasOffsetParameters", async () => {
      // Verify the function exists on the contract interface.
      // Call from governance (owner) to update gas offset parameters.
      await createSnapshot()
      try {
        await l1BtcDepositor
          .connect(governance)
          .updateGasOffsetParameters(70000, 25000)

        expect(await l1BtcDepositor.initializeDepositGasOffset()).to.equal(
          70000
        )
        expect(await l1BtcDepositor.finalizeDepositGasOffset()).to.equal(25000)
      } finally {
        await restoreSnapshot()
      }
    })

    it("should emit GasOffsetParametersUpdated on updateGasOffsetParameters", async () => {
      await createSnapshot()
      try {
        await expect(
          l1BtcDepositor
            .connect(governance)
            .updateGasOffsetParameters(70000, 25000)
        )
          .to.emit(l1BtcDepositor, "GasOffsetParametersUpdated")
          .withArgs(70000, 25000)
      } finally {
        await restoreSnapshot()
      }
    })

    it("should expose updateReimbursementAuthorization", async () => {
      await createSnapshot()
      try {
        const addr = "0x1234567890123456789012345678901234567890"
        await l1BtcDepositor
          .connect(governance)
          .updateReimbursementAuthorization(addr, true)

        expect(await l1BtcDepositor.reimbursementAuthorizations(addr)).to.equal(
          true
        )
      } finally {
        await restoreSnapshot()
      }
    })

    it("should emit ReimbursementAuthorizationUpdated on updateReimbursementAuthorization", async () => {
      await createSnapshot()
      try {
        const addr = "0x1234567890123456789012345678901234567890"
        await expect(
          l1BtcDepositor
            .connect(governance)
            .updateReimbursementAuthorization(addr, true)
        )
          .to.emit(l1BtcDepositor, "ReimbursementAuthorizationUpdated")
          .withArgs(addr, true)
      } finally {
        await restoreSnapshot()
      }
    })

    it("should expose setReimburseTxMaxFee", async () => {
      await createSnapshot()
      try {
        await l1BtcDepositor.connect(governance).setReimburseTxMaxFee(true)
        expect(await l1BtcDepositor.reimburseTxMaxFee()).to.equal(true)
      } finally {
        await restoreSnapshot()
      }
    })

    it("should emit ReimburseTxMaxFeeUpdated on setReimburseTxMaxFee", async () => {
      await createSnapshot()
      try {
        await expect(
          l1BtcDepositor.connect(governance).setReimburseTxMaxFee(true)
        )
          .to.emit(l1BtcDepositor, "ReimburseTxMaxFeeUpdated")
          .withArgs(true)
      } finally {
        await restoreSnapshot()
      }
    })

    it("should restrict updateGasOffsetParameters to owner", async () => {
      await expect(
        l1BtcDepositor.connect(relayer).updateGasOffsetParameters(70000, 25000)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should restrict updateReimbursementAuthorization to owner", async () => {
      const addr = "0x1234567890123456789012345678901234567890"
      await expect(
        l1BtcDepositor
          .connect(relayer)
          .updateReimbursementAuthorization(addr, true)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should restrict setReimburseTxMaxFee to owner", async () => {
      await expect(
        l1BtcDepositor.connect(relayer).setReimburseTxMaxFee(true)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should restrict updateReimbursementPool to owner via onlyReimbursableAdmin", async () => {
      await expect(
        l1BtcDepositor
          .connect(relayer)
          .updateReimbursementPool(reimbursementPool.address)
      ).to.be.revertedWith("Caller is not the owner")
    })
  })

  describe("storage layout compatibility", () => {
    it("should have wormhole at the correct storage position", async () => {
      expect(await l1BtcDepositor.wormhole()).to.equal(wormhole.address)
    })

    it("should have wormholeRelayer at the correct storage position", async () => {
      expect(await l1BtcDepositor.wormholeRelayer()).to.equal(
        wormholeRelayer.address
      )
    })

    it("should have wormholeTokenBridge at the correct storage position", async () => {
      expect(await l1BtcDepositor.wormholeTokenBridge()).to.equal(
        wormholeTokenBridge.address
      )
    })

    it("should have l2WormholeGateway at the correct storage position", async () => {
      expect(await l1BtcDepositor.l2WormholeGateway()).to.equal(
        l2WormholeGateway.address
      )
    })

    it("should have l2ChainId at the correct storage position", async () => {
      expect(await l1BtcDepositor.l2ChainId()).to.equal(l2ChainId)
    })

    it("should have l2FinalizeDepositGasLimit initialized correctly", async () => {
      expect(await l1BtcDepositor.l2FinalizeDepositGasLimit()).to.equal(500000)
    })
  })

  describe("constructor", () => {
    it("should call _disableInitializers", async () => {
      // Deploying a new V2 implementation directly (not behind proxy)
      // should leave it in a state where initialize() cannot be called.
      const { deployer } = await helpers.signers.getNamedSigners()
      const factory = await ethers.getContractFactory(
        "L1BTCDepositorWormholeV2Arbitrum",
        deployer
      )
      const impl = await factory.deploy()
      await impl.deployed()

      // The initializer should be disabled on the implementation contract.
      const bridge2 = await smock.fake<IBridge>("IBridge")
      const tbtcVault2 = await smock.fake<ITBTCVault>("ITBTCVault")
      const wh = await smock.fake<IWormhole>("IWormhole")
      const whRelayer = await smock.fake<IWormholeRelayer>("IWormholeRelayer")
      const whBridge = await smock.fake<IWormholeTokenBridge>(
        "IWormholeTokenBridge"
      )
      const l2Gw = await smock.fake<IWormholeGateway>("IWormholeGateway")

      await expect(
        impl.initialize(
          bridge2.address,
          tbtcVault2.address,
          wh.address,
          whRelayer.address,
          whBridge.address,
          l2Gw.address,
          20
        )
      ).to.be.revertedWith("Initializable: contract is already initialized")
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
        .attachL2BitcoinDepositor(l2BitcoinDepositor)
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
        ).to.be.revertedWith("msg.value must equal wormhole.messageFee()")
      })

      it("should revert when msg.value is greater than messageFee", async () => {
        await expect(
          l1BtcDepositor
            .connect(relayer)
            .finalizeDeposit(initializeDepositFixture.depositKey, {
              value: messageFee + 1,
            })
        ).to.be.revertedWith("msg.value must equal wormhole.messageFee()")
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

      it("should encode the payload in the format expected by L2WormholeGateway", async () => {
        const payload =
          wormholeTokenBridge.transferTokensWithPayload.getCall(0).args[5]
        const [l2Receiver] = ethers.utils.defaultAbiCoder.decode(
          ["bytes32"],
          payload
        )

        expect(l2Receiver.toLowerCase()).to.equal(
          initializeDepositFixture.destinationChainDepositOwner.toLowerCase()
        )
        expect(ethers.utils.getAddress(`0x${l2Receiver.slice(26)}`)).to.equal(
          ethers.utils.getAddress(
            `0x${initializeDepositFixture.destinationChainDepositOwner.slice(
              26
            )}`
          )
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

  describe("proxy upgrade mechanics", () => {
    it("should pass OpenZeppelin prepareUpgrade validation for a fresh V2 proxy", async () => {
      await createSnapshot()

      try {
        const { deployer } = await helpers.signers.getNamedSigners()

        const proxyName = `L1BTCDepositorWormholeV2Arbitrum_prepare_${randomBytes(
          8
        ).toString("hex")}`
        const v2Deployment = await helpers.upgrades.deployProxy(proxyName, {
          contractName: "L1BTCDepositorWormholeV2Arbitrum",
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
        })

        const proxy = v2Deployment[0] as L1BTCDepositorWormholeV2Arbitrum
        const v2Factory = await ethers.getContractFactory(
          "L1BTCDepositorWormholeV2Arbitrum",
          deployer
        )

        const implementationAddress = await upgrades.prepareUpgrade(
          proxy.address,
          v2Factory,
          {
            kind: "transparent",
          }
        )

        if (!ethers.utils.isAddress(implementationAddress)) {
          throw new Error(
            `prepareUpgrade returned invalid address ${implementationAddress}`
          )
        }

        if (implementationAddress === proxy.address) {
          throw new Error("prepareUpgrade should deploy a new implementation")
        }
      } finally {
        await restoreSnapshot()
      }
    })

    // V2 is a monolithic contract designed to match the storage layout of the
    // deployed L1BitcoinDepositor family on Arbitrum mainnet (proxy
    // 0x75A6...9A). The local V1 (L1BTCDepositorWormhole) uses a different
    // inheritance chain (AbstractL1BTCDepositor) which produces a different
    // storage layout. As a result, V1-to-V2 is intentionally NOT a
    // storage-compatible upgrade.
    //
    // The focused storage layout invariants above keep the key deployed slots
    // stable without mirroring the entire manifest in this test file. This
    // block verifies that V2 can be deployed behind a fresh proxy and that the
    // proxy upgrade mechanism itself works correctly.

    it("should deploy V2 behind a fresh proxy and upgrade to a new V2 impl", async () => {
      await createSnapshot()

      try {
        const { deployer } = await helpers.signers.getNamedSigners()

        // Deploy V2 behind a fresh transparent proxy.
        const proxyName = `L1BTCDepositorWormholeV2Arbitrum_upgrade_${randomBytes(
          8
        ).toString("hex")}`
        const v2Deployment = await helpers.upgrades.deployProxy(proxyName, {
          contractName: "L1BTCDepositorWormholeV2Arbitrum",
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
        })
        const proxy = v2Deployment[0] as L1BTCDepositorWormholeV2Arbitrum

        // Verify proxy reads all initialized state correctly.
        expect(await proxy.wormhole()).to.equal(wormhole.address)
        expect(await proxy.wormholeRelayer()).to.equal(wormholeRelayer.address)
        expect(await proxy.wormholeTokenBridge()).to.equal(
          wormholeTokenBridge.address
        )
        expect(await proxy.l2WormholeGateway()).to.equal(
          l2WormholeGateway.address
        )
        expect(await proxy.l2ChainId()).to.equal(l2ChainId)
        expect(await proxy.l2FinalizeDepositGasLimit()).to.equal(500000)

        // Deploy a second V2 implementation and upgrade.
        const proxyAdmin: Contract = await upgrades.admin.getInstance()
        const proxyAdminOwner = await proxyAdmin.owner()
        const ownerSigner = await ethers.getSigner(proxyAdminOwner)

        const v2Factory = await ethers.getContractFactory(
          "L1BTCDepositorWormholeV2Arbitrum",
          deployer
        )
        const v2Impl = await v2Factory.deploy()
        await v2Impl.deployed()

        await proxyAdmin
          .connect(ownerSigner)
          .upgrade(proxy.address, v2Impl.address)

        // After V2-to-V2 upgrade, all state should be preserved since the
        // storage layout is identical.
        const upgraded = (await ethers.getContractAt(
          "L1BTCDepositorWormholeV2Arbitrum",
          proxy.address
        )) as L1BTCDepositorWormholeV2Arbitrum

        expect(await upgraded.wormhole()).to.equal(wormhole.address)
        expect(await upgraded.wormholeRelayer()).to.equal(
          wormholeRelayer.address
        )
        expect(await upgraded.wormholeTokenBridge()).to.equal(
          wormholeTokenBridge.address
        )
        expect(await upgraded.l2WormholeGateway()).to.equal(
          l2WormholeGateway.address
        )
        expect(await upgraded.l2ChainId()).to.equal(l2ChainId)
        expect(await upgraded.l2FinalizeDepositGasLimit()).to.equal(500000)
      } finally {
        await restoreSnapshot()
      }
    })

    it("should preserve V2 state across V2-to-V2 implementation upgrades", async () => {
      await createSnapshot()

      try {
        const { deployer, governance: gov } =
          await helpers.signers.getNamedSigners()
        const depositorAddr = "0xeE6F5f69860f310114185677D017576aed0dEC83"

        // Deploy V2 behind proxy and populate state.
        const proxyName = `L1BTCDepositorWormholeV2Arbitrum_state_${randomBytes(
          8
        ).toString("hex")}`
        const v2Deployment = await helpers.upgrades.deployProxy(proxyName, {
          contractName: "L1BTCDepositorWormholeV2Arbitrum",
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
        })
        const proxy = v2Deployment[0] as L1BTCDepositorWormholeV2Arbitrum
        await proxy.connect(deployer).transferOwnership(gov.address)

        // Set additional state on V2.
        await proxy.connect(gov).attachL2BitcoinDepositor(depositorAddr)
        await proxy.connect(gov).updateL2FinalizeDepositGasLimit(750000)
        await proxy.connect(gov).updateGasOffsetParameters(80000, 30000)
        await proxy.connect(gov).setReimburseTxMaxFee(true)

        // Upgrade to a fresh V2 implementation.
        const proxyAdmin: Contract = await upgrades.admin.getInstance()
        const proxyAdminOwner = await proxyAdmin.owner()
        const ownerSigner = await ethers.getSigner(proxyAdminOwner)

        const v2Factory = await ethers.getContractFactory(
          "L1BTCDepositorWormholeV2Arbitrum",
          deployer
        )
        const v2Impl = await v2Factory.deploy()
        await v2Impl.deployed()

        await proxyAdmin
          .connect(ownerSigner)
          .upgrade(proxy.address, v2Impl.address)

        const upgraded = (await ethers.getContractAt(
          "L1BTCDepositorWormholeV2Arbitrum",
          proxy.address
        )) as L1BTCDepositorWormholeV2Arbitrum

        // All V2 state (including fields from flattened AbstractL1BTCDepositor
        // logic) should be preserved across the upgrade.
        expect(await upgraded.wormhole()).to.equal(wormhole.address)
        expect(await upgraded.l2BitcoinDepositor()).to.equal(depositorAddr)
        expect(await upgraded.l2FinalizeDepositGasLimit()).to.equal(750000)
        expect(await upgraded.l2ChainId()).to.equal(l2ChainId)
        expect(await upgraded.initializeDepositGasOffset()).to.equal(80000)
        expect(await upgraded.finalizeDepositGasOffset()).to.equal(30000)
        expect(await upgraded.reimburseTxMaxFee()).to.equal(true)
      } finally {
        await restoreSnapshot()
      }
    })
  })
})
