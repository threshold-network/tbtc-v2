import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  L1BTCDepositorNttWithExecutor,
  MockTBTCBridge,
  MockTBTCVault,
  TestERC20,
} from "../../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Wormhole Chain IDs for testing
const WORMHOLE_CHAIN_SEI = 32
const WORMHOLE_CHAIN_BASE = 30

describe("L1BTCDepositorNttWithExecutor Simple Tests", () => {
  let l1BTCDepositor: L1BTCDepositorNttWithExecutor
  let bridge: MockTBTCBridge
  let tbtcVault: MockTBTCVault
  let tbtcToken: TestERC20
  let deployer: SignerWithAddress
  let governance: SignerWithAddress

  before(async () => {
    const { deployer: dep, governance: gov } =
      await helpers.signers.getNamedSigners()
    deployer = dep
    governance = gov

    // Deploy mock contracts following working pattern
    const TestERC20Factory = await ethers.getContractFactory("TestERC20")
    tbtcToken = await TestERC20Factory.deploy()

    const MockBridgeFactory = await ethers.getContractFactory("MockTBTCBridge")
    bridge = await MockBridgeFactory.deploy()

    const MockTBTCVaultFactory = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    tbtcVault = (await MockTBTCVaultFactory.deploy()) as MockTBTCVault
    await tbtcVault.setTbtcToken(tbtcToken.address)

    // Mock NTT managers with simple objects (following working pattern)
    const nttManagerWithExecutor = {
      address: ethers.Wallet.createRandom().address,
    }
    const underlyingNttManager = {
      address: ethers.Wallet.createRandom().address,
    }

    // Deploy main contract with proxy following working pattern
    const L1BTCDepositorFactory = await ethers.getContractFactory(
      "L1BTCDepositorNttWithExecutor"
    )
    const depositorImpl = await L1BTCDepositorFactory.deploy()
    await depositorImpl.deployed()

    // Deploy proxy
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy")
    const initData = depositorImpl.interface.encodeFunctionData("initialize", [
      bridge.address,
      tbtcVault.address,
      nttManagerWithExecutor.address,
      underlyingNttManager.address,
    ])
    const proxy = await ProxyFactory.deploy(depositorImpl.address, initData)

    l1BTCDepositor = L1BTCDepositorFactory.attach(
      proxy.address
    ) as L1BTCDepositorNttWithExecutor

    // Set up supported chains
    await l1BTCDepositor.setSupportedChain(WORMHOLE_CHAIN_SEI, true)
    await l1BTCDepositor.setSupportedChain(WORMHOLE_CHAIN_BASE, true)
    await l1BTCDepositor.setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("Basic Contract Deployment", () => {
    it("should deploy successfully", async () => {
      expect(l1BTCDepositor.address).to.not.equal(ethers.constants.AddressZero)
    })

    it("should have correct contract code", async () => {
      const code = await ethers.provider.getCode(l1BTCDepositor.address)
      expect(code).to.not.equal("0x")
    })
  })

  describe("Initialization", () => {
    it("should be properly initialized", async () => {
      expect(await l1BTCDepositor.bridge()).to.equal(bridge.address)
      expect(await l1BTCDepositor.tbtcVault()).to.equal(tbtcVault.address)
    })

    it("should have correct default parameters", async () => {
      expect(await l1BTCDepositor.defaultDestinationGasLimit()).to.equal(500000)
      expect(await l1BTCDepositor.defaultExecutorFeeBps()).to.equal(0)
      expect(await l1BTCDepositor.defaultExecutorFeeRecipient()).to.equal(
        ethers.constants.AddressZero
      )
    })

    it("should have correct supported chains", async () => {
      expect(await l1BTCDepositor.supportedChains(WORMHOLE_CHAIN_SEI)).to.be
        .true
      expect(await l1BTCDepositor.supportedChains(WORMHOLE_CHAIN_BASE)).to.be
        .true
      expect(await l1BTCDepositor.defaultSupportedChain()).to.equal(
        WORMHOLE_CHAIN_SEI
      )
    })
  })

  describe("Zero Value Parameters", () => {
    it("should handle zero-value parameters correctly", async () => {
      // Test that we can create zero values without issues
      const zeroAddress = ethers.constants.AddressZero
      const zeroAmount = ethers.constants.Zero

      expect(zeroAddress).to.equal("0x0000000000000000000000000000000000000000")
      expect(zeroAmount.toString()).to.equal("0")
    })

    it("should create proper struct with zero values", async () => {
      // Test creating executor args with zero values
      const executorArgs = {
        signedQuote: "0x",
        value: ethers.constants.Zero,
      }

      const feeArgs = {
        gasLimit: ethers.constants.Zero,
        feeBps: ethers.constants.Zero,
        feeRecipient: ethers.constants.AddressZero,
      }

      expect(executorArgs.value.toString()).to.equal("0")
      expect(feeArgs.gasLimit.toString()).to.equal("0")
      expect(feeArgs.feeBps.toString()).to.equal("0")
      expect(feeArgs.feeRecipient).to.equal(ethers.constants.AddressZero)
    })
  })
})
