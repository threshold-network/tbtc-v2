import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import type {
  MockNttManager,
  MockNttManagerWithExecutor,
  MockTBTCBridge,
  MockTBTCVault,
  TestERC20,
  TestL1BTCDepositorNttWithExecutor,
} from "../../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const WORMHOLE_CHAIN_SEI = 32
const DEFAULT_NONCE = ethers.utils.formatBytes32String("nonce")

const encodeDestinationChainReceiver = (
  chainId: number,
  recipient: string
): string =>
  ethers.utils.hexConcat([
    ethers.utils.hexZeroPad(ethers.utils.hexlify(chainId), 2),
    ethers.utils.hexZeroPad(recipient, 30),
  ])

describe("L1BTCDepositorNttWithExecutor - hardening", () => {
  let depositor: TestL1BTCDepositorNttWithExecutor
  let bridge: MockTBTCBridge
  let tbtcVault: MockTBTCVault
  let tbtcToken: TestERC20
  let nttManagerWithExecutor: MockNttManagerWithExecutor
  let underlyingNttManager: MockNttManager

  before(async () => {
    const TestERC20Factory = await ethers.getContractFactory("TestERC20")
    tbtcToken = await TestERC20Factory.deploy()

    const MockBridgeFactory = await ethers.getContractFactory("MockTBTCBridge")
    bridge = await MockBridgeFactory.deploy()

    const MockTBTCVaultFactory = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    tbtcVault = (await MockTBTCVaultFactory.deploy()) as MockTBTCVault
    await tbtcVault.setTbtcToken(tbtcToken.address)

    const MockNttManagerWithExecutorFactory = await ethers.getContractFactory(
      "MockNttManagerWithExecutor"
    )
    nttManagerWithExecutor = await MockNttManagerWithExecutorFactory.deploy()

    const MockNttManagerFactory = await ethers.getContractFactory(
      "MockNttManager"
    )
    underlyingNttManager = await MockNttManagerFactory.deploy()

    const TestDepositorFactory = await ethers.getContractFactory(
      "TestL1BTCDepositorNttWithExecutor"
    )
    const depositorImpl = await TestDepositorFactory.deploy()

    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy")
    const initData = depositorImpl.interface.encodeFunctionData("initialize", [
      bridge.address,
      tbtcVault.address,
      nttManagerWithExecutor.address,
      underlyingNttManager.address,
    ])
    const proxy = await ProxyFactory.deploy(depositorImpl.address, initData)

    depositor = TestDepositorFactory.attach(
      proxy.address
    ) as TestL1BTCDepositorNttWithExecutor

    await depositor.setSupportedChain(WORMHOLE_CHAIN_SEI, true)
    await depositor.setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  const executorArgs = (refundAddress: string) => ({
    value: ethers.utils.parseEther("0.01"),
    refundAddress,
    signedQuote: `0x${"a".repeat(64)}`,
    instructions: `0x${"b".repeat(32)}`,
  })

  const zeroFeeArgs = {
    dbps: 0,
    payee: ethers.constants.AddressZero,
  }

  it("should require exact executor payment", async () => {
    const [, user] = await ethers.getSigners()
    const args = executorArgs(user.address)
    const receiver = encodeDestinationChainReceiver(
      WORMHOLE_CHAIN_SEI,
      user.address
    )
    const requiredPayment = await nttManagerWithExecutor.quoteDeliveryPrice(
      underlyingNttManager.address,
      WORMHOLE_CHAIN_SEI,
      "0x",
      args,
      zeroFeeArgs
    )

    await expect(
      depositor
        .connect(user)
        .transferTbtcWithExecutor(
          ethers.utils.parseEther("1"),
          receiver,
          args,
          zeroFeeArgs,
          DEFAULT_NONCE,
          { value: requiredPayment.add(1) }
        )
    ).to.be.revertedWith("Incorrect payment for executor service")

    await expect(
      depositor
        .connect(user)
        .transferTbtcWithExecutor(
          ethers.utils.parseEther("1"),
          receiver,
          args,
          zeroFeeArgs,
          DEFAULT_NONCE,
          { value: requiredPayment }
        )
    ).to.emit(depositor, "TokensTransferredNttWithExecutor")
  })

  it("should reject executor refunds to a different address", async () => {
    const [, user, attacker] = await ethers.getSigners()
    const args = executorArgs(attacker.address)
    const receiver = encodeDestinationChainReceiver(
      WORMHOLE_CHAIN_SEI,
      user.address
    )
    const requiredPayment = await nttManagerWithExecutor.quoteDeliveryPrice(
      underlyingNttManager.address,
      WORMHOLE_CHAIN_SEI,
      "0x",
      args,
      zeroFeeArgs
    )

    await expect(
      depositor
        .connect(user)
        .transferTbtcWithExecutor(
          ethers.utils.parseEther("1"),
          receiver,
          args,
          zeroFeeArgs,
          DEFAULT_NONCE,
          { value: requiredPayment }
        )
    ).to.be.revertedWith("Executor refund address must be caller")
  })

  it("should reject unconfigured fee recipients", async () => {
    const [, user] = await ethers.getSigners()
    const args = executorArgs(user.address)
    const receiver = encodeDestinationChainReceiver(
      WORMHOLE_CHAIN_SEI,
      user.address
    )
    const feeArgs = {
      dbps: 0,
      payee: user.address,
    }
    const requiredPayment = await nttManagerWithExecutor.quoteDeliveryPrice(
      underlyingNttManager.address,
      WORMHOLE_CHAIN_SEI,
      "0x",
      args,
      feeArgs
    )

    await expect(
      depositor
        .connect(user)
        .transferTbtcWithExecutor(
          ethers.utils.parseEther("1"),
          receiver,
          args,
          feeArgs,
          DEFAULT_NONCE,
          { value: requiredPayment }
        )
    ).to.be.revertedWith("Fee payee must be zero when fee is zero")
  })
})
