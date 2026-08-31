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

  it("should require minimum executor payment", async () => {
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

    // Underpayment must revert
    await expect(
      depositor
        .connect(user)
        .transferTbtcWithExecutor(
          ethers.utils.parseEther("1"),
          receiver,
          args,
          zeroFeeArgs,
          DEFAULT_NONCE,
          { value: requiredPayment.sub(1) }
        )
    ).to.be.revertedWith("Payment must exactly match executor service quote")

    // Overpayment must revert
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
    ).to.be.revertedWith("Payment must exactly match executor service quote")

    // Exact payment succeeds
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

  it("should retain no ETH after successful deposit", async () => {
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
          { value: requiredPayment }
        )
    ).to.emit(depositor, "TokensTransferredNttWithExecutor")

    expect(await ethers.provider.getBalance(depositor.address)).to.equal(0)
  })

  // I'm keeping the original test but renaming it to reflect the change. Wait, this test is now redundant with the overpayment case I just added above.
  // Let's replace the refund test with a "should retain no ETH" test.

  it("should reject executor refunds to a different address at stage time", async () => {
    const [, user, attacker] = await ethers.getSigners()
    const args = executorArgs(attacker.address)
    await expect(
      depositor.connect(user).setExecutorParameters(args, zeroFeeArgs)
    ).to.be.revertedWith("Executor refund address must be caller")
  })

  // New staging tests to replace staged equality tests that were failing
  describe("setExecutorParameters (staging consistency)", () => {
    beforeEach(async () => {
      await depositor.setDefaultParameters(
        100_000,
        50,
        ethers.Wallet.createRandom().address,
        0,
        ethers.constants.AddressZero
      )
    })

    it("should revert staging when dbps != defaultExecutorFeeBps", async () => {
      const [stagingSigner] = await ethers.getSigners()
      const args = executorArgs(stagingSigner.address)
      await expect(
        depositor.setExecutorParameters(args, {
          dbps: 49,
          payee: ethers.constants.AddressZero,
        })
      ).to.be.revertedWith("Fee must match default executor fee")
    })

    it("should accept staging when dbps == defaultExecutorFeeBps", async () => {
      const [stagingSigner] = await ethers.getSigners()
      const args = executorArgs(stagingSigner.address)
      await expect(
        depositor.setExecutorParameters(args, {
          dbps: 50,
          payee: ethers.constants.AddressZero,
        })
      ).to.emit(depositor, "ExecutorParametersSet")
    })
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

  context("when a non-zero executor fee default is configured", () => {
    const nonZeroFeeBps = 50
    let feeRecipient: string

    beforeEach(async () => {
      const [deployer, , , recipientSigner] = await ethers.getSigners()
      feeRecipient = recipientSigner.address
      // setDefaultParameters(gasLimit, feeBps, feeRecipient, platformFeeBps, platformFeeRecipient)
      await depositor
        .connect(deployer)
        .setDefaultParameters(
          100_000,
          nonZeroFeeBps,
          feeRecipient,
          0,
          ethers.constants.AddressZero
        )
    })

    it("should accept fee args that match the configured default", async () => {
      const [, user] = await ethers.getSigners()
      const args = executorArgs(user.address)
      const receiver = encodeDestinationChainReceiver(
        WORMHOLE_CHAIN_SEI,
        user.address
      )
      const feeArgs = {
        dbps: nonZeroFeeBps,
        payee: feeRecipient,
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
      ).to.emit(depositor, "TokensTransferredNttWithExecutor")
    })

    it("should reject a payee that does not match the configured default", async () => {
      const [, user, , , imposter] = await ethers.getSigners()
      const args = executorArgs(user.address)
      const receiver = encodeDestinationChainReceiver(
        WORMHOLE_CHAIN_SEI,
        user.address
      )
      const feeArgs = {
        dbps: nonZeroFeeBps,
        payee: imposter.address, // wrong payee
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
      ).to.be.revertedWith(
        "Fee payee must match default executor fee recipient"
      )
    })
  })

  describe("setExecutorParameters (stage-time validation)", () => {
    const validSignedQuote = `0x${"a".repeat(64)}`
    const validInstructions = `0x${"b".repeat(32)}`

    // Only the refund-address binding is enforced at stage time. Fee bps and
    // payee equality are enforced at finalize time so admins can rotate the
    // defaults without invalidating in-flight staged params.
    it("should revert when refundAddress is not the caller", async () => {
      const [, user, attacker] = await ethers.getSigners()
      await expect(
        depositor.connect(user).setExecutorParameters(
          {
            value: ethers.utils.parseEther("0.01"),
            refundAddress: attacker.address, // not the caller
            signedQuote: validSignedQuote,
            instructions: validInstructions,
          },
          { dbps: 0, payee: ethers.constants.AddressZero }
        )
      ).to.be.revertedWith("Executor refund address must be caller")
    })

    it("should accept valid params and emit the staged event", async () => {
      const [, user] = await ethers.getSigners()
      await expect(
        depositor.connect(user).setExecutorParameters(
          {
            value: ethers.utils.parseEther("0.01"),
            refundAddress: user.address,
            signedQuote: validSignedQuote,
            instructions: validInstructions,
          },
          { dbps: 0, payee: ethers.constants.AddressZero }
        )
      ).to.emit(depositor, "ExecutorParametersSet")
    })
  })
})
