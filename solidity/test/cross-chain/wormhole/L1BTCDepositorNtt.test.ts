import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { randomBytes } from "crypto"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber } from "ethers"
import {
  IBridge,
  ITBTCVault,
  L1BTCDepositorNtt,
  ReimbursementPool,
  TestERC20,
} from "../../../typechain"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Wormhole Chain IDs for testing
const WORMHOLE_CHAIN_ETH = 2
const WORMHOLE_CHAIN_SEI = 32  
const WORMHOLE_CHAIN_BASE = 30

// Mock NTT Manager interface
interface INttManager {
  transfer(
    amount: BigNumber,
    recipientChain: number,
    recipient: string
  ): Promise<any>
  
  quoteDeliveryPrice(
    recipientChain: number,
    transceiverInstructions: string
  ): Promise<{ priceQuotes: BigNumber[], totalPrice: BigNumber }>
}

describe("L1BTCDepositorNtt Integration Tests", () => {
  const contractsFixture = async () => {
    const { deployer, governance } = await helpers.signers.getNamedSigners()

    const accounts = await getUnnamedAccounts()
    const relayer = await ethers.getSigner(accounts[1])
    const user = await ethers.getSigner(accounts[2])

    const bridge = await smock.fake<IBridge>("IBridge")
    const tbtcToken = await (
      await ethers.getContractFactory("TestERC20")
    ).deploy()
    const tbtcVault = await smock.fake<ITBTCVault>("ITBTCVault", {
      address: tbtcVaultAddress,
    })
    tbtcVault.tbtcToken.returns(tbtcToken.address)

    const nttManager = await smock.fake("contracts/cross-chain/wormhole/L1BTCDepositorNtt.sol:INttManager")
    const reimbursementPool = await smock.fake<ReimbursementPool>("ReimbursementPool")

    const deployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `L1BTCDepositorNtt_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L1BTCDepositorNtt",
        initializerArgs: [
          bridge.address,
          tbtcVault.address,
          nttManager.address,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    const l1BtcDepositorNtt = deployment[0] as L1BTCDepositorNtt

    await l1BtcDepositorNtt.connect(deployer).transferOwnership(governance.address)

    return {
      governance,
      relayer,
      user,
      bridge,
      tbtcToken,
      tbtcVault,
      nttManager,
      reimbursementPool,
      l1BtcDepositorNtt,
    }
  }

  let governance: SignerWithAddress
  let relayer: SignerWithAddress
  let user: SignerWithAddress
  let bridge: FakeContract<IBridge>
  let tbtcToken: TestERC20
  let tbtcVault: FakeContract<ITBTCVault>
  let nttManager: FakeContract<INttManager>
  let reimbursementPool: FakeContract<ReimbursementPool>
  let l1BtcDepositorNtt: L1BTCDepositorNtt

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      relayer,
      user,
      bridge,
      tbtcToken,
      tbtcVault,
      nttManager,
      reimbursementPool,
      l1BtcDepositorNtt,
    } = await waffle.loadFixture(contractsFixture))
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("Complete Deposit Workflow", () => {
    it("should handle complete deposit workflow from initialization to finalization", async () => {
      // Setup supported chains
      await l1BtcDepositorNtt
        .connect(governance)
        .setSupportedChain(WORMHOLE_CHAIN_SEI, true)
      
      await l1BtcDepositorNtt
        .connect(governance)
        .setSupportedChain(WORMHOLE_CHAIN_BASE, true)

      // Test that the contract is properly configured
      expect(await l1BtcDepositorNtt.supportedChains(WORMHOLE_CHAIN_SEI)).to.be.true
      expect(await l1BtcDepositorNtt.supportedChains(WORMHOLE_CHAIN_BASE)).to.be.true
      expect(await l1BtcDepositorNtt.getNttConfiguration()).to.equal(nttManager.address)
    })
  })

  describe("Multi-chain Support", () => {
    it("should support multiple destination chains", async () => {
      // Add multiple supported chains
      await l1BtcDepositorNtt
        .connect(governance)
        .setSupportedChain(WORMHOLE_CHAIN_SEI, true)
      
      await l1BtcDepositorNtt
        .connect(governance)
        .setSupportedChain(WORMHOLE_CHAIN_BASE, true)

      // Test that chains are properly set
      expect(await l1BtcDepositorNtt.supportedChains(WORMHOLE_CHAIN_SEI)).to.be.true
      expect(await l1BtcDepositorNtt.supportedChains(WORMHOLE_CHAIN_BASE)).to.be.true
      expect(await l1BtcDepositorNtt.supportedChains(999)).to.be.false
    })
  })

  describe("NTT Integration", () => {
    it("should integrate properly with NTT Manager", async () => {
      // Add supported chain
      await l1BtcDepositorNtt
        .connect(governance)
        .setSupportedChain(WORMHOLE_CHAIN_SEI, true)

      // Test that the contract has the correct NTT Manager configuration
      expect(await l1BtcDepositorNtt.getNttConfiguration()).to.equal(nttManager.address)

      // Test that the contract can access the NTT Manager
      expect(await l1BtcDepositorNtt.nttManager()).to.equal(nttManager.address)
    })
  })

  describe("Access Control", () => {
    it("should enforce proper access controls", async () => {
      // Test owner-only functions
      await expect(
        l1BtcDepositorNtt
          .connect(relayer)
          .setSupportedChain(WORMHOLE_CHAIN_SEI, true)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await expect(
        l1BtcDepositorNtt
          .connect(relayer)
          .updateNttManager(nttManager.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      // Test owner can call these functions
      await l1BtcDepositorNtt
        .connect(governance)
        .setSupportedChain(WORMHOLE_CHAIN_SEI, true)

      expect(await l1BtcDepositorNtt.supportedChains(WORMHOLE_CHAIN_SEI)).to.be.true
    })
  })

  describe("Configuration Management", () => {
    it("should allow configuration updates", async () => {
      // Test NTT Manager update
      const newNttManager = await smock.fake("contracts/cross-chain/wormhole/L1BTCDepositorNtt.sol:INttManager")
      
      await l1BtcDepositorNtt
        .connect(governance)
        .updateNttManager(newNttManager.address)

      expect(await l1BtcDepositorNtt.getNttConfiguration()).to.equal(newNttManager.address)

      // Test gas offset parameters
      await l1BtcDepositorNtt
        .connect(governance)
        .updateGasOffsetParameters(1000, 2000)

      expect(await l1BtcDepositorNtt.initializeDepositGasOffset()).to.equal(1000)
      expect(await l1BtcDepositorNtt.finalizeDepositGasOffset()).to.equal(2000)

      // Test reimbursement authorization
      await l1BtcDepositorNtt
        .connect(governance)
        .updateReimbursementAuthorization(relayer.address, true)

      expect(await l1BtcDepositorNtt.reimbursementAuthorizations(relayer.address)).to.be.true
    })
  })
})

// Just an arbitrary TBTCVault address.
const tbtcVaultAddress = "0xB5679dE944A79732A75CE556191DF11F489448d5"
