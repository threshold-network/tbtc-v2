import { artifacts, ethers, helpers, run } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import type {
  L1BTCDepositorNttWithExecutor,
  MaliciousReentrantRefundReceiver,
  MockNttManager,
  MockNttManagerWithExecutor,
  MockTBTCBridgeWithSweep,
  MockTBTCVault,
  TestERC20,
} from "../../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const WORMHOLE_CHAIN_DESTINATION = 32
const UPDATED_WORMHOLE_CHAIN_DESTINATION = 40
const TBTC_SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)
const destinationChainDepositOwner =
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
const chainLikePrefixedDestinationChainDepositOwner = `0x0020${"11".repeat(30)}`
const legacyDecodedDestinationChainDepositOwner = `0x0000${"11".repeat(30)}`
const wrongChainLegacyDestinationChainDepositOwner = `0x0021${"22".repeat(30)}`

const loadFixture = (vault: string) => ({
  fundingTx: {
    version: "0x01000000",
    inputVector:
      "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20d" +
      "c2b952f0100000000ffffffff",
    outputVector:
      "0x021027000000000000220020bfaeddba12b0de6feeb649af76376876bc1" +
      "feb6c2248fbfef9293ba3ac51bb4a10d73b00000000001600147ac2d9378a" +
      "1c47e589dfb8095ca95ed2140d2726",
    locktime: "0x00000000",
  },
  reveal: {
    fundingOutputIndex: 0,
    blindingFactor: "0xf9f0c90d00039523",
    walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
    refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
    refundLocktime: "0x60bcea61",
    vault,
  },
  expectedDepositKey:
    "0xebff13c2304229ab4a97bfbfabeac82c9c0704e4aae2acf022252ac8dc1101d1",
})

describe("L1BTCDepositorNttWithExecutor fixed destination", () => {
  let bridge: MockTBTCBridgeWithSweep
  let tbtcToken: TestERC20
  let tbtcVault: MockTBTCVault
  let nttManagerWithExecutor: MockNttManagerWithExecutor
  let underlyingNttManager: MockNttManager
  let depositor: L1BTCDepositorNttWithExecutor
  let fixture: ReturnType<typeof loadFixture>

  before(async () => {
    const TestERC20 = await ethers.getContractFactory("TestERC20")
    tbtcToken = (await TestERC20.deploy()) as TestERC20

    const MockBridge = await ethers.getContractFactory(
      "MockTBTCBridgeWithSweep"
    )
    bridge = (await MockBridge.deploy()) as MockTBTCBridgeWithSweep

    const MockTBTCVault = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    tbtcVault = (await MockTBTCVault.deploy()) as MockTBTCVault
    await tbtcVault.setTbtcToken(tbtcToken.address)
    await tbtcVault.setOptimisticMintingFeeDivisor(0)

    const MockNttManager = await ethers.getContractFactory("MockNttManager")
    underlyingNttManager = (await MockNttManager.deploy()) as MockNttManager

    const MockNttManagerWithExecutor = await ethers.getContractFactory(
      "MockNttManagerWithExecutor"
    )
    nttManagerWithExecutor =
      (await MockNttManagerWithExecutor.deploy()) as MockNttManagerWithExecutor

    fixture = loadFixture(tbtcVault.address)

    const L1BTCDepositorNttWithExecutor = await ethers.getContractFactory(
      "L1BTCDepositorNttWithExecutor"
    )
    const implementation = await L1BTCDepositorNttWithExecutor.deploy()

    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy")
    const initData = implementation.interface.encodeFunctionData("initialize", [
      bridge.address,
      tbtcVault.address,
      nttManagerWithExecutor.address,
      underlyingNttManager.address,
      WORMHOLE_CHAIN_DESTINATION,
    ])
    const proxy = await ProxyFactory.deploy(implementation.address, initData)
    depositor = L1BTCDepositorNttWithExecutor.attach(
      proxy.address
    ) as L1BTCDepositorNttWithExecutor
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  it("initializes the fixed destination chain", async () => {
    expect(await depositor.destinationChainId()).to.equal(
      WORMHOLE_CHAIN_DESTINATION
    )
    expect(await depositor.nttManagerWithExecutor()).to.equal(
      nttManagerWithExecutor.address
    )
    expect(await depositor.underlyingNttManager()).to.equal(
      underlyingNttManager.address
    )
  })

  it("quotes the configured destination chain", async () => {
    const [, relayer] = await ethers.getSigners()
    const executorArgs = buildExecutorArgs(
      BigNumber.from(70000),
      relayer.address
    )
    const feeArgs = buildFeeArgs()

    await depositor
      .connect(relayer)
      .setExecutorParameters(executorArgs, feeArgs)

    const quote = await depositor.connect(relayer).quoteFinalizeDeposit()
    const expectedQuote = (await nttManagerWithExecutor.MOCK_DELIVERY_PRICE())
      .add(await nttManagerWithExecutor.MOCK_WRAPPER_SURCHARGE())
      .add(BigNumber.from("2000000000000000"))
      .add(executorArgs.value)

    expect(quote).to.equal(expectedQuote)
  })

  it("does not retarget an initialized fixed destination chain", async () => {
    const [, nonOwner] = await ethers.getSigners()

    await expect(
      depositor
        .connect(nonOwner)
        .initializeV2DestinationChain(UPDATED_WORMHOLE_CHAIN_DESTINATION)
    ).to.be.revertedWith("Ownable: caller is not the owner")

    await expect(
      depositor.initializeV2DestinationChain(UPDATED_WORMHOLE_CHAIN_DESTINATION)
    ).to.be.revertedWith("Destination chain already configured")

    expect(await depositor.destinationChainId()).to.equal(
      WORMHOLE_CHAIN_DESTINATION
    )
  })

  it("backfills an unset fixed destination chain once during upgrade", async () => {
    const [, relayer] = await ethers.getSigners()
    const executorArgs = buildExecutorArgs(
      BigNumber.from(70000),
      relayer.address
    )
    const feeArgs = buildFeeArgs()

    await clearDestinationChainIdSlot(
      depositor.address,
      WORMHOLE_CHAIN_DESTINATION
    )
    expect(await depositor.destinationChainId()).to.equal(0)

    await expect(depositor.initializeV2DestinationChain(0)).to.be.revertedWith(
      "Chain ID cannot be zero"
    )

    await expect(
      depositor.initializeV2DestinationChain(UPDATED_WORMHOLE_CHAIN_DESTINATION)
    )
      .to.emit(depositor, "DestinationChainUpdated")
      .withArgs(0, UPDATED_WORMHOLE_CHAIN_DESTINATION)

    expect(await depositor.destinationChainId()).to.equal(
      UPDATED_WORMHOLE_CHAIN_DESTINATION
    )

    await depositor
      .connect(relayer)
      .setExecutorParameters(executorArgs, feeArgs)

    const quote = await depositor.connect(relayer).quoteFinalizeDeposit()
    const expectedQuote = (await nttManagerWithExecutor.MOCK_DELIVERY_PRICE())
      .add(await nttManagerWithExecutor.MOCK_WRAPPER_SURCHARGE())
      .add(BigNumber.from("2000000000000000"))
      .add(executorArgs.value)
    expect(quote).to.equal(expectedQuote)

    await expect(
      depositor.initializeV2DestinationChain(WORMHOLE_CHAIN_DESTINATION)
    ).to.be.revertedWith("Initializable: contract is already initialized")
  })

  it("requires a destination chain before initializing deposits", async () => {
    const [, relayer] = await ethers.getSigners()

    await clearDestinationChainIdSlot(
      depositor.address,
      WORMHOLE_CHAIN_DESTINATION
    )

    await expect(
      depositor
        .connect(relayer)
        .initializeDeposit(
          fixture.fundingTx,
          fixture.reveal,
          destinationChainDepositOwner
        )
    ).to.be.revertedWith("Destination chain not configured")
  })

  it("sets only active default parameters", async () => {
    const [, , platformFeeRecipient] = await ethers.getSigners()
    const gasLimit = BigNumber.from(800000)
    const platformFeeDbps = 100

    await expect(
      depositor.setDefaultParameters(
        gasLimit,
        platformFeeDbps,
        platformFeeRecipient.address
      )
    )
      .to.emit(depositor, "DefaultParametersUpdated")
      .withArgs(gasLimit, platformFeeDbps, platformFeeRecipient.address)

    expect(await depositor.defaultDestinationGasLimit()).to.equal(gasLimit)
    expect(await depositor.defaultPlatformFeeDbps()).to.equal(platformFeeDbps)
    expect(await depositor.defaultPlatformFeeRecipient()).to.equal(
      platformFeeRecipient.address
    )
  })

  it("uses dbps units for platform fee updates", async () => {
    const [, , platformFeeRecipient] = await ethers.getSigners()
    const platformFeeDbps = 100

    expect(await depositor.MAX_PLATFORM_FEE_DBPS()).to.equal(10000)

    await depositor.setDefaultPlatformFeeRecipient(platformFeeRecipient.address)

    await expect(depositor.setDefaultPlatformFeeDbps(platformFeeDbps))
      .to.emit(depositor, "DefaultPlatformFeeDbpsUpdated")
      .withArgs(0, platformFeeDbps)

    expect(await depositor.defaultPlatformFeeDbps()).to.equal(platformFeeDbps)
  })

  it("passes the full 32-byte deposit owner to NTT with executor", async () => {
    const [, relayer] = await ethers.getSigners()
    const executorValue = BigNumber.from(70000)
    const executorArgs = buildExecutorArgs(executorValue, relayer.address)
    const feeArgs = buildFeeArgs()

    await bridge.setNextDepositKey(fixture.expectedDepositKey)
    await depositor
      .connect(relayer)
      .initializeDeposit(
        fixture.fundingTx,
        fixture.reveal,
        destinationChainDepositOwner
      )
    expect(
      await depositor.fixedDestinationDeposits(fixture.expectedDepositKey)
    ).to.equal(true)
    await bridge.sweepDeposit(fixture.expectedDepositKey)

    const deposit = await bridge.deposits(fixture.expectedDepositKey)
    const [, , depositTxMaxFee] = await bridge.depositParameters()
    const tbtcAmount = BigNumber.from(deposit.amount)
      .sub(deposit.treasuryFee)
      .sub(depositTxMaxFee)
      .mul(TBTC_SATOSHI_MULTIPLIER)

    await tbtcToken.mint(depositor.address, tbtcAmount)
    await depositor
      .connect(relayer)
      .setExecutorParameters(executorArgs, feeArgs)

    const quote = await depositor.connect(relayer).quoteFinalizeDeposit()
    await depositor
      .connect(relayer)
      .finalizeDeposit(fixture.expectedDepositKey, {
        value: quote,
      })

    expect(await nttManagerWithExecutor.lastNttManager()).to.equal(
      underlyingNttManager.address
    )
    expect(await nttManagerWithExecutor.lastAmount()).to.equal(tbtcAmount)
    expect(await nttManagerWithExecutor.lastRecipientChain()).to.equal(
      WORMHOLE_CHAIN_DESTINATION
    )
    expect(await nttManagerWithExecutor.lastRecipientAddress()).to.equal(
      destinationChainDepositOwner
    )
  })

  it("passes the full 32-byte deposit owner with a chain-like prefix", async () => {
    const [, relayer] = await ethers.getSigners()
    const executorValue = BigNumber.from(70000)
    const executorArgs = buildExecutorArgs(executorValue, relayer.address)
    const feeArgs = buildFeeArgs()

    await bridge.setNextDepositKey(fixture.expectedDepositKey)
    await depositor
      .connect(relayer)
      .initializeDeposit(
        fixture.fundingTx,
        fixture.reveal,
        chainLikePrefixedDestinationChainDepositOwner
      )
    expect(
      await depositor.fixedDestinationDeposits(fixture.expectedDepositKey)
    ).to.equal(true)
    await bridge.sweepDeposit(fixture.expectedDepositKey)

    const tbtcAmount = await calculateTbtcAmount(
      bridge,
      fixture.expectedDepositKey
    )
    await tbtcToken.mint(depositor.address, tbtcAmount)
    await depositor
      .connect(relayer)
      .setExecutorParameters(executorArgs, feeArgs)

    const quote = await depositor.connect(relayer).quoteFinalizeDeposit()
    await depositor
      .connect(relayer)
      .finalizeDeposit(fixture.expectedDepositKey, {
        value: quote,
      })

    expect(await nttManagerWithExecutor.lastRecipientAddress()).to.equal(
      chainLikePrefixedDestinationChainDepositOwner
    )
  })

  it("decodes unmarked legacy packed recipients with executor", async () => {
    const [, relayer] = await ethers.getSigners()
    const executorValue = BigNumber.from(70000)
    const executorArgs = buildExecutorArgs(executorValue, relayer.address)
    const feeArgs = buildFeeArgs()

    await bridge.setNextDepositKey(fixture.expectedDepositKey)
    await depositor
      .connect(relayer)
      .initializeDeposit(
        fixture.fundingTx,
        fixture.reveal,
        chainLikePrefixedDestinationChainDepositOwner
      )
    await clearFixedDestinationDepositMarker(
      depositor,
      fixture.expectedDepositKey
    )
    await bridge.sweepDeposit(fixture.expectedDepositKey)

    const tbtcAmount = await calculateTbtcAmount(
      bridge,
      fixture.expectedDepositKey
    )
    await tbtcToken.mint(depositor.address, tbtcAmount)
    await depositor
      .connect(relayer)
      .setExecutorParameters(executorArgs, feeArgs)

    const quote = await depositor.connect(relayer).quoteFinalizeDeposit()
    await depositor
      .connect(relayer)
      .finalizeDeposit(fixture.expectedDepositKey, { value: quote })

    expect(await nttManagerWithExecutor.lastRecipientAddress()).to.equal(
      legacyDecodedDestinationChainDepositOwner
    )
    expect(await nttManagerWithExecutor.lastRefundAddress()).to.equal(
      legacyDecodedDestinationChainDepositOwner
    )
  })

  it("rejects unmarked legacy packed recipients for a different chain with executor", async () => {
    const [, relayer] = await ethers.getSigners()
    const executorValue = BigNumber.from(70000)
    const executorArgs = buildExecutorArgs(executorValue, relayer.address)
    const feeArgs = buildFeeArgs()

    await bridge.setNextDepositKey(fixture.expectedDepositKey)
    await depositor
      .connect(relayer)
      .initializeDeposit(
        fixture.fundingTx,
        fixture.reveal,
        wrongChainLegacyDestinationChainDepositOwner
      )
    await clearFixedDestinationDepositMarker(
      depositor,
      fixture.expectedDepositKey
    )
    await bridge.sweepDeposit(fixture.expectedDepositKey)

    const tbtcAmount = await calculateTbtcAmount(
      bridge,
      fixture.expectedDepositKey
    )
    await tbtcToken.mint(depositor.address, tbtcAmount)
    await depositor
      .connect(relayer)
      .setExecutorParameters(executorArgs, feeArgs)

    const quote = await depositor.connect(relayer).quoteFinalizeDeposit()
    await expect(
      depositor
        .connect(relayer)
        .finalizeDeposit(fixture.expectedDepositKey, { value: quote })
    ).to.be.revertedWith("Legacy destination chain mismatch")
  })

  it("reverts when executor payment omits the NTT delivery price", async () => {
    const [, relayer] = await ethers.getSigners()
    const executorValue = BigNumber.from(70000)
    const executorArgs = buildExecutorArgs(executorValue, relayer.address)
    const feeArgs = buildFeeArgs()

    await bridge.setNextDepositKey(fixture.expectedDepositKey)
    await depositor
      .connect(relayer)
      .initializeDeposit(
        fixture.fundingTx,
        fixture.reveal,
        destinationChainDepositOwner
      )
    await bridge.sweepDeposit(fixture.expectedDepositKey)

    const deposit = await bridge.deposits(fixture.expectedDepositKey)
    const [, , depositTxMaxFee] = await bridge.depositParameters()
    const tbtcAmount = BigNumber.from(deposit.amount)
      .sub(deposit.treasuryFee)
      .sub(depositTxMaxFee)
      .mul(TBTC_SATOSHI_MULTIPLIER)

    await tbtcToken.mint(depositor.address, tbtcAmount)
    await depositor
      .connect(relayer)
      .setExecutorParameters(executorArgs, feeArgs)

    await expect(
      depositor.connect(relayer).finalizeDeposit(fixture.expectedDepositKey, {
        value: executorValue,
      })
    ).to.be.revertedWith("Payment for Wormhole NTT has incorrect value")
  })

  it("forces platform fee payments to the configured platform recipient", async () => {
    const [, relayer, platformFeeRecipient] = await ethers.getSigners()
    const executorValue = BigNumber.from(70000)
    const executorArgs = buildExecutorArgs(executorValue, relayer.address)
    const feeArgs = {
      dbps: 100,
      payee: relayer.address,
    }

    await depositor.setDefaultPlatformFeeRecipient(platformFeeRecipient.address)
    await depositor.setDefaultPlatformFeeDbps(feeArgs.dbps)

    await bridge.setNextDepositKey(fixture.expectedDepositKey)
    await depositor
      .connect(relayer)
      .initializeDeposit(
        fixture.fundingTx,
        fixture.reveal,
        destinationChainDepositOwner
      )
    await bridge.sweepDeposit(fixture.expectedDepositKey)

    const deposit = await bridge.deposits(fixture.expectedDepositKey)
    const [, , depositTxMaxFee] = await bridge.depositParameters()
    const tbtcAmount = BigNumber.from(deposit.amount)
      .sub(deposit.treasuryFee)
      .sub(depositTxMaxFee)
      .mul(TBTC_SATOSHI_MULTIPLIER)

    await tbtcToken.mint(depositor.address, tbtcAmount)
    await depositor
      .connect(relayer)
      .setExecutorParameters(executorArgs, feeArgs)

    const quote = await depositor.connect(relayer).quoteFinalizeDeposit()
    await depositor
      .connect(relayer)
      .finalizeDeposit(fixture.expectedDepositKey, {
        value: quote,
      })

    expect(await nttManagerWithExecutor.lastFeeDbps()).to.equal(feeArgs.dbps)
    expect(await nttManagerWithExecutor.lastFeePayee()).to.equal(
      platformFeeRecipient.address
    )
  })

  it("defaults the destination refund to the deposit recipient", async () => {
    const [, relayer] = await ethers.getSigners()
    const executorValue = BigNumber.from(70000)
    const executorArgs = buildExecutorArgs(executorValue, relayer.address)
    const feeArgs = buildFeeArgs()

    expect(await depositor.destinationRefundAddress()).to.equal(
      ethers.constants.HashZero
    )

    await bridge.setNextDepositKey(fixture.expectedDepositKey)
    await depositor
      .connect(relayer)
      .initializeDeposit(
        fixture.fundingTx,
        fixture.reveal,
        destinationChainDepositOwner
      )
    await bridge.sweepDeposit(fixture.expectedDepositKey)

    const tbtcAmount = await calculateTbtcAmount(
      bridge,
      fixture.expectedDepositKey
    )
    await tbtcToken.mint(depositor.address, tbtcAmount)
    await depositor
      .connect(relayer)
      .setExecutorParameters(executorArgs, feeArgs)

    const quote = await depositor.connect(relayer).quoteFinalizeDeposit()
    await depositor
      .connect(relayer)
      .finalizeDeposit(fixture.expectedDepositKey, { value: quote })

    // With no configured refund address, the refund falls back to the full
    // 32-byte recipient, which is always a controllable account on the
    // destination chain (including non-EVM chains).
    expect(await nttManagerWithExecutor.lastRefundAddress()).to.equal(
      destinationChainDepositOwner
    )
  })

  it("routes the destination refund to the configured refund address", async () => {
    const [, relayer] = await ethers.getSigners()
    const executorValue = BigNumber.from(70000)
    const executorArgs = buildExecutorArgs(executorValue, relayer.address)
    const feeArgs = buildFeeArgs()

    const configuredRefund = `0x${"ab".repeat(32)}`
    await expect(depositor.setDestinationRefundAddress(configuredRefund))
      .to.emit(depositor, "DestinationRefundAddressUpdated")
      .withArgs(ethers.constants.HashZero, configuredRefund)
    expect(await depositor.destinationRefundAddress()).to.equal(
      configuredRefund
    )

    await bridge.setNextDepositKey(fixture.expectedDepositKey)
    await depositor
      .connect(relayer)
      .initializeDeposit(
        fixture.fundingTx,
        fixture.reveal,
        destinationChainDepositOwner
      )
    await bridge.sweepDeposit(fixture.expectedDepositKey)

    const tbtcAmount = await calculateTbtcAmount(
      bridge,
      fixture.expectedDepositKey
    )
    await tbtcToken.mint(depositor.address, tbtcAmount)
    await depositor
      .connect(relayer)
      .setExecutorParameters(executorArgs, feeArgs)

    const quote = await depositor.connect(relayer).quoteFinalizeDeposit()
    await depositor
      .connect(relayer)
      .finalizeDeposit(fixture.expectedDepositKey, { value: quote })

    expect(await nttManagerWithExecutor.lastRefundAddress()).to.equal(
      configuredRefund
    )
  })

  it("restricts setting the destination refund address to the owner", async () => {
    const [, nonOwner] = await ethers.getSigners()
    await expect(
      depositor
        .connect(nonOwner)
        .setDestinationRefundAddress(`0x${"cd".repeat(32)}`)
    ).to.be.revertedWith("Ownable: caller is not the owner")
  })
  describe("executor parameter management", () => {
    it("refreshes existing nonce for same user before expiry", async () => {
      const [, user] = await ethers.getSigners()
      const executorArgs = buildExecutorArgs(
        BigNumber.from(70000),
        user.address
      )
      const feeArgs = buildFeeArgs()

      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      const [, nonce1] = await depositor
        .connect(user)
        .areExecutorParametersSet()

      await expect(
        depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      )
        .to.emit(depositor, "ExecutorParametersRefreshed")
        .withArgs(
          user.address,
          nonce1,
          ethers.utils.arrayify(executorArgs.signedQuote).length,
          executorArgs.value
        )

      const [, nonce2] = await depositor
        .connect(user)
        .areExecutorParametersSet()
      expect(nonce2).to.equal(nonce1)
    })

    it("mints new nonce for same user after expiry", async () => {
      const [owner, user] = await ethers.getSigners()
      const executorArgs = buildExecutorArgs(
        BigNumber.from(70000),
        user.address
      )
      const feeArgs = buildFeeArgs()

      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)

      const expiry = await depositor.parameterExpirationTime()
      await helpers.time.increaseTime(expiry.add(1).toNumber())
      await ethers.provider.send("evm_mine", [])

      await expect(
        depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      ).to.emit(depositor, "ExecutorParametersSet")
    })

    it("reverts finalize if parameters expired", async () => {
      const [, user] = await ethers.getSigners()
      const executorArgs = buildExecutorArgs(
        BigNumber.from(70000),
        user.address
      )
      const feeArgs = buildFeeArgs()

      await bridge.setNextDepositKey(fixture.expectedDepositKey)
      await depositor
        .connect(user)
        .initializeDeposit(
          fixture.fundingTx,
          fixture.reveal,
          destinationChainDepositOwner
        )
      await bridge.sweepDeposit(fixture.expectedDepositKey)

      const tbtcAmount = await calculateTbtcAmount(
        bridge,
        fixture.expectedDepositKey
      )
      await tbtcToken.mint(depositor.address, tbtcAmount)
      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)

      const expiry = await depositor.parameterExpirationTime()
      await helpers.time.increaseTime(expiry.add(1).toNumber())
      await ethers.provider.send("evm_mine", [])

      await expect(
        depositor.connect(user).finalizeDeposit(fixture.expectedDepositKey)
      ).to.be.revertedWith("Executor parameters expired")
    })

    it("isolates nonce state between different users", async () => {
      const [, user1, user2] = await ethers.getSigners()
      const executorArgs1 = buildExecutorArgs(
        BigNumber.from(70000),
        user1.address
      )
      const executorArgs2 = buildExecutorArgs(
        BigNumber.from(80000),
        user2.address
      )
      const feeArgs = buildFeeArgs()

      await depositor
        .connect(user1)
        .setExecutorParameters(executorArgs1, feeArgs)
      await depositor
        .connect(user2)
        .setExecutorParameters(executorArgs2, feeArgs)

      const [isSet1, nonce1] = await depositor
        .connect(user1)
        .areExecutorParametersSet()
      const [isSet2, nonce2] = await depositor
        .connect(user2)
        .areExecutorParametersSet()

      expect(isSet1).to.be.true
      expect(isSet2).to.be.true
      expect(nonce1).to.not.equal(nonce2)
      expect(await depositor.connect(user1).getStoredExecutorValue()).to.equal(
        executorArgs1.value
      )
      expect(await depositor.connect(user2).getStoredExecutorValue()).to.equal(
        executorArgs2.value
      )

      // Clearing one user's parameters must not disturb the other user's.
      await depositor.connect(user1).clearExecutorParameters()
      const [isSet1After] = await depositor
        .connect(user1)
        .areExecutorParametersSet()
      const [isSet2After] = await depositor
        .connect(user2)
        .areExecutorParametersSet()
      expect(isSet1After).to.be.false
      expect(isSet2After).to.be.true
    })

    it("clears own executor parameters", async () => {
      const [, user] = await ethers.getSigners()
      const executorArgs = buildExecutorArgs(
        BigNumber.from(70000),
        user.address
      )
      const feeArgs = buildFeeArgs()

      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      const [isSetBefore] = await depositor
        .connect(user)
        .areExecutorParametersSet()
      expect(isSetBefore).to.be.true

      await depositor.connect(user).clearExecutorParameters()
      const [isSetAfter] = await depositor
        .connect(user)
        .areExecutorParametersSet()
      expect(isSetAfter).to.be.false

      await expect(depositor.connect(user).clearExecutorParameters()).to.not.be
        .reverted
    })
  })

  describe("retrieveTokens", () => {
    it("allows owner to retrieve tokens", async () => {
      const [owner, , recipient] = await ethers.getSigners()
      await tbtcToken.mint(depositor.address, BigNumber.from(1000))

      const initialBalance = await tbtcToken.balanceOf(recipient.address)
      await depositor
        .connect(owner)
        .retrieveTokens(
          tbtcToken.address,
          recipient.address,
          BigNumber.from(1000)
        )
      expect(await tbtcToken.balanceOf(recipient.address)).to.equal(
        initialBalance.add(1000)
      )
    })

    it("reverts retrieveTokens for non-owner", async () => {
      const [, , nonOwner] = await ethers.getSigners()
      await expect(
        depositor
          .connect(nonOwner)
          .retrieveTokens(
            tbtcToken.address,
            nonOwner.address,
            BigNumber.from(1000)
          )
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })
  })

  describe("NTT manager address setters", () => {
    it("updates underlying ntt manager", async () => {
      const [owner, , , newManager] = await ethers.getSigners()
      await expect(
        depositor.connect(owner).updateUnderlyingNttManager(newManager.address)
      )
        .to.emit(depositor, "UnderlyingNttManagerUpdated")
        .withArgs(underlyingNttManager.address, newManager.address)

      expect(await depositor.underlyingNttManager()).to.equal(
        newManager.address
      )

      await expect(
        depositor
          .connect(owner)
          .updateUnderlyingNttManager(ethers.constants.AddressZero)
      ).to.be.revertedWith("NTT Manager address cannot be zero")
    })

    it("updates ntt manager with executor", async () => {
      const [owner, , , newManager] = await ethers.getSigners()
      await expect(
        depositor
          .connect(owner)
          .updateNttManagerWithExecutor(newManager.address)
      )
        .to.emit(depositor, "NttManagerWithExecutorUpdated")
        .withArgs(nttManagerWithExecutor.address, newManager.address)

      expect(await depositor.nttManagerWithExecutor()).to.equal(
        newManager.address
      )

      await expect(
        depositor
          .connect(owner)
          .updateNttManagerWithExecutor(ethers.constants.AddressZero)
      ).to.be.revertedWith("Address cannot be zero")
    })

    it("reverts setters for non-owner", async () => {
      const [, , nonOwner] = await ethers.getSigners()
      await expect(
        depositor.connect(nonOwner).updateUnderlyingNttManager(nonOwner.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
      await expect(
        depositor
          .connect(nonOwner)
          .updateNttManagerWithExecutor(nonOwner.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })
  })

  describe("setExecutorParameters input validation", () => {
    it("reverts if empty signed quote", async () => {
      const [, user] = await ethers.getSigners()
      const executorArgs = buildExecutorArgs(
        BigNumber.from(70000),
        user.address
      )
      executorArgs.signedQuote = "0x"
      const feeArgs = buildFeeArgs()

      await expect(
        depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      ).to.be.revertedWith(
        "Real signed quote from Wormhole Executor API is required"
      )
    })

    it("reverts if refund address mismatch", async () => {
      const [, user, other] = await ethers.getSigners()
      const executorArgs = buildExecutorArgs(
        BigNumber.from(70000),
        other.address
      )
      const feeArgs = buildFeeArgs()

      await expect(
        depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      ).to.be.revertedWith("Executor refund address must be caller")
    })

    it("reverts if fee exceeds maximum", async () => {
      const [, user] = await ethers.getSigners()
      const executorArgs = buildExecutorArgs(
        BigNumber.from(70000),
        user.address
      )
      const feeArgs = buildFeeArgs()
      feeArgs.dbps = 10001 // Assuming MAX is 10000

      await expect(
        depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      ).to.be.revertedWith("Fee exceeds maximum")
    })

    it("reverts if fee does not equal default", async () => {
      const [, user] = await ethers.getSigners()
      const executorArgs = buildExecutorArgs(
        BigNumber.from(70000),
        user.address
      )
      const feeArgs = buildFeeArgs()
      feeArgs.dbps += 1

      await expect(
        depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      ).to.be.revertedWith("Fee must equal the default platform fee")
    })

    it("reverts if insufficient payment", async () => {
      const [, user] = await ethers.getSigners()
      // The mock's quote normally includes executorArgs.value additively, so
      // it can never under-quote a claimed value. Force an undervalued quote
      // (pinned below MOCK_DELIVERY_PRICE regardless of the claimed value) to
      // exercise the requiredPayment >= executorArgs.value check.
      await nttManagerWithExecutor.setUndervalueQuote(true)
      const executorArgs = buildExecutorArgs(
        ethers.utils.parseEther("1"),
        user.address
      )
      const feeArgs = buildFeeArgs()

      await expect(
        depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      ).to.be.revertedWith("Quote below executor declared value")
    })
  })

  describe("owner-only setter boundary/revert tests", () => {
    it("reverts on zero gas limit for setDefaultDestinationGasLimit", async () => {
      const [owner] = await ethers.getSigners()
      await expect(
        depositor.connect(owner).setDefaultDestinationGasLimit(0)
      ).to.be.revertedWith("Gas limit must be greater than zero")
    })

    it("reverts when fee exceeds max for setDefaultPlatformFeeDbps", async () => {
      const [owner] = await ethers.getSigners()
      await expect(
        depositor.connect(owner).setDefaultPlatformFeeDbps(10001)
      ).to.be.revertedWith("Fee exceeds maximum")
    })

    it("reverts on zero recipient for setDefaultPlatformFeeRecipient", async () => {
      const [owner, , platformFeeRecipient] = await ethers.getSigners()
      // A non-zero fee requires a recipient to already be set, so set the
      // recipient first, then the fee, to reach the state under test.
      await depositor
        .connect(owner)
        .setDefaultPlatformFeeRecipient(platformFeeRecipient.address)
      await depositor.connect(owner).setDefaultPlatformFeeDbps(100)

      await expect(
        depositor
          .connect(owner)
          .setDefaultPlatformFeeRecipient(ethers.constants.AddressZero)
      ).to.be.revertedWith(
        "Recipient address cannot be zero when platform fee is set"
      )
    })

    it("reverts on zero gas limit for setDefaultParameters", async () => {
      const [owner, , platformFeeRecipient] = await ethers.getSigners()
      await expect(
        depositor
          .connect(owner)
          .setDefaultParameters(0, 0, platformFeeRecipient.address)
      ).to.be.revertedWith("Gas limit must be greater than zero")
    })

    it("reverts when fee exceeds max for setDefaultParameters", async () => {
      const [owner, , platformFeeRecipient] = await ethers.getSigners()
      await expect(
        depositor
          .connect(owner)
          .setDefaultParameters(800000, 10001, platformFeeRecipient.address)
      ).to.be.revertedWith("Platform fee exceeds maximum")
    })

    it("reverts on zero recipient with nonzero fee for setDefaultParameters", async () => {
      const [owner] = await ethers.getSigners()
      await expect(
        depositor
          .connect(owner)
          .setDefaultParameters(800000, 100, ethers.constants.AddressZero)
      ).to.be.revertedWith(
        "Platform fee recipient cannot be zero when platform fee is set"
      )
    })
  })

  describe("setDestinationChainId", () => {
    it("reverts for non-owner", async () => {
      const [, , nonOwner] = await ethers.getSigners()
      await expect(
        depositor
          .connect(nonOwner)
          .setDestinationChainId(UPDATED_WORMHOLE_CHAIN_DESTINATION)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("reverts for a zero chain id", async () => {
      await expect(depositor.setDestinationChainId(0)).to.be.revertedWith(
        "Chain ID cannot be zero"
      )
    })

    it("retargets the fixed destination chain before any deposit exists", async () => {
      await expect(
        depositor.setDestinationChainId(UPDATED_WORMHOLE_CHAIN_DESTINATION)
      )
        .to.emit(depositor, "DestinationChainUpdated")
        .withArgs(
          WORMHOLE_CHAIN_DESTINATION,
          UPDATED_WORMHOLE_CHAIN_DESTINATION
        )

      expect(await depositor.destinationChainId()).to.equal(
        UPDATED_WORMHOLE_CHAIN_DESTINATION
      )
    })

    it("locks once the first deposit has been initialized", async () => {
      const [, relayer] = await ethers.getSigners()

      await bridge.setNextDepositKey(fixture.expectedDepositKey)
      await depositor
        .connect(relayer)
        .initializeDeposit(
          fixture.fundingTx,
          fixture.reveal,
          destinationChainDepositOwner
        )

      await expect(
        depositor.setDestinationChainId(UPDATED_WORMHOLE_CHAIN_DESTINATION)
      ).to.be.revertedWith("Deposits already initialized")
    })
  })

  describe("executor finalize path revalidation", () => {
    it("reverts finalization when the destination chain was retargeted after staging", async () => {
      const [, relayer] = await ethers.getSigners()
      const executorValue = BigNumber.from(70000)
      const executorArgs = buildExecutorArgs(executorValue, relayer.address)
      const feeArgs = buildFeeArgs()

      await depositor
        .connect(relayer)
        .setExecutorParameters(executorArgs, feeArgs)

      // Retarget the destination chain before any deposit has been
      // initialized -- setDestinationChainId locks permanently once the
      // first deposit exists.
      await depositor.setDestinationChainId(UPDATED_WORMHOLE_CHAIN_DESTINATION)

      await bridge.setNextDepositKey(fixture.expectedDepositKey)
      await depositor
        .connect(relayer)
        .initializeDeposit(
          fixture.fundingTx,
          fixture.reveal,
          destinationChainDepositOwner
        )
      await bridge.sweepDeposit(fixture.expectedDepositKey)

      const tbtcAmount = await calculateTbtcAmount(
        bridge,
        fixture.expectedDepositKey
      )
      await tbtcToken.mint(depositor.address, tbtcAmount)

      const quote = await depositor.connect(relayer).quoteFinalizeDeposit()
      await expect(
        depositor
          .connect(relayer)
          .finalizeDeposit(fixture.expectedDepositKey, { value: quote })
      ).to.be.revertedWith(
        "Executor parameters bound to a different destination chain"
      )
    })

    it("reverts finalization when the default platform fee changed after staging", async () => {
      const [owner, relayer, platformFeeRecipient] = await ethers.getSigners()
      const executorValue = BigNumber.from(70000)
      const executorArgs = buildExecutorArgs(executorValue, relayer.address)
      const feeArgs = buildFeeArgs()

      await depositor
        .connect(relayer)
        .setExecutorParameters(executorArgs, feeArgs)

      // Owner changes the live default platform fee after parameters were
      // staged, so the staged fee no longer matches the current default.
      await depositor
        .connect(owner)
        .setDefaultPlatformFeeRecipient(platformFeeRecipient.address)
      await depositor.connect(owner).setDefaultPlatformFeeDbps(100)

      await bridge.setNextDepositKey(fixture.expectedDepositKey)
      await depositor
        .connect(relayer)
        .initializeDeposit(
          fixture.fundingTx,
          fixture.reveal,
          destinationChainDepositOwner
        )
      await bridge.sweepDeposit(fixture.expectedDepositKey)

      const tbtcAmount = await calculateTbtcAmount(
        bridge,
        fixture.expectedDepositKey
      )
      await tbtcToken.mint(depositor.address, tbtcAmount)

      const quote = await depositor.connect(relayer).quoteFinalizeDeposit()
      await expect(
        depositor
          .connect(relayer)
          .finalizeDeposit(fixture.expectedDepositKey, { value: quote })
      ).to.be.revertedWith("Fee no longer matches current default")
    })
  })

  describe("Deposit Finalization & Checks-Effects-Interactions Security", () => {
    // Reentrancy attack surface: the mock executor manager refunds unused
    // executor value via a raw ETH transfer mid-`finalizeDeposit`. These
    // tests confirm that refund cannot be used to re-enter `finalizeDeposit`
    // and either double-finalize the same deposit or replay staged executor
    // parameters against a second one.
    const decodeRevertReason = (data: string): string => {
      if (!data || data.length < 138) return ""
      const reasonData = `0x${data.slice(10)}`
      return ethers.utils.defaultAbiCoder.decode(["string"], reasonData)[0]
    }

    const signedQuote = `0x${"1".repeat(128)}`
    const instructions = `0x${"2".repeat(64)}`
    const executorValue = ethers.utils.parseEther("0.01")

    // The depositor computes the real deposit key on-chain as
    // `keccak256(hash256(fundingTx) | fundingOutputIndex)` (see
    // `AbstractBTCDepositor._calculateDepositKey`); the mock bridge's
    // `setNextDepositKey` must be primed with that same value so
    // `bridge.deposits(depositKey)` resolves for `_finalizeDeposit`. These
    // are precomputed for `fixture.fundingTx` at fundingOutputIndex 1 and 2
    // (index 0 is already used by `fixture.expectedDepositKey` elsewhere in
    // this file), keeping each deposit key here distinct from that one.
    const DEPOSIT_KEY_OUTPUT_INDEX_1 =
      "0x2edac88e52814978b282061d3d3fccb845ca402ead8ab9009be8ef8fe34f8e6f"
    const DEPOSIT_KEY_OUTPUT_INDEX_2 =
      "0x4d2c8826c99ea50c88057cd4e783bcf22f29f2dab1e7f5259c43e5a8d6302315"

    const deployMaliciousReceiver = async () => {
      const MaliciousFactory = await ethers.getContractFactory(
        "MaliciousReentrantRefundReceiver"
      )
      const maliciousReceiver = (await MaliciousFactory.deploy(
        depositor.address
      )) as MaliciousReentrantRefundReceiver
      await maliciousReceiver.deployed()
      return maliciousReceiver
    }

    const quoteRequiredPayment = async (refundAddress: string) =>
      nttManagerWithExecutor.quoteDeliveryPrice(
        underlyingNttManager.address,
        WORMHOLE_CHAIN_DESTINATION,
        "0x",
        { value: executorValue, refundAddress, signedQuote, instructions },
        { dbps: 0, payee: ethers.constants.AddressZero }
      )

    const initializeAndFundDeposit = async (
      fundingOutputIndex: number,
      depositKey: string,
      recipient = destinationChainDepositOwner
    ) => {
      const [, relayer] = await ethers.getSigners()
      await bridge.setNextDepositKey(depositKey)
      await depositor
        .connect(relayer)
        .initializeDeposit(
          fixture.fundingTx,
          { ...fixture.reveal, fundingOutputIndex },
          recipient
        )
      await bridge.sweepDeposit(depositKey)
      const tbtcAmount = await calculateTbtcAmount(bridge, depositKey)
      await tbtcToken.mint(depositor.address, tbtcAmount)
    }

    it("should prevent reentrancy during ETH refund step when attacking same deposit", async () => {
      const maliciousReceiver = await deployMaliciousReceiver()
      const depositKey = DEPOSIT_KEY_OUTPUT_INDEX_1

      await maliciousReceiver.stageExecutorParameters(
        executorValue,
        signedQuote,
        instructions
      )
      const requiredPayment = await quoteRequiredPayment(
        maliciousReceiver.address
      )
      await initializeAndFundDeposit(1, depositKey)

      // Configure the malicious receiver to re-enter finalizeDeposit on the
      // same depositKey during the refund it receives mid-finalization.
      await maliciousReceiver.setAttackConfig(depositKey, 0, false)

      await maliciousReceiver.finalize(depositKey, {
        value: requiredPayment,
        gasLimit: 2_000_000,
      })

      expect(await maliciousReceiver.attackAttempted()).to.be.true
      expect(await maliciousReceiver.attackSucceeded()).to.be.false
      const revertReason = decodeRevertReason(
        await maliciousReceiver.lastRevertData()
      )
      expect(revertReason).to.equal("Wrong deposit state")
    })

    it("should prevent reentrancy parameter reuse during ETH refund step on second deposit", async () => {
      const maliciousReceiver = await deployMaliciousReceiver()
      const depositKey1 = DEPOSIT_KEY_OUTPUT_INDEX_1
      const depositKey2 = DEPOSIT_KEY_OUTPUT_INDEX_2

      await maliciousReceiver.stageExecutorParameters(
        executorValue,
        signedQuote,
        instructions
      )
      const requiredPayment = await quoteRequiredPayment(
        maliciousReceiver.address
      )
      await initializeAndFundDeposit(1, depositKey1)
      await initializeAndFundDeposit(2, depositKey2)

      // Configure the malicious receiver to attempt finalizing depositKey2
      // during depositKey1's refund, replaying the same staged parameters.
      await maliciousReceiver.setAttackConfig(depositKey2, 0, false)

      await maliciousReceiver.finalize(depositKey1, {
        value: requiredPayment,
        gasLimit: 2_000_000,
      })

      // Blocked because the staged parameters are deleted before the
      // external call that triggers the refund (checks-effects-interactions).
      expect(await maliciousReceiver.attackAttempted()).to.be.true
      expect(await maliciousReceiver.attackSucceeded()).to.be.false
      const revertReason = decodeRevertReason(
        await maliciousReceiver.lastRevertData()
      )
      expect(revertReason).to.equal("Executor parameters not set")
    })

    it("should revert top-level finalizeDeposit when reentrant call bubbles up revert on refund", async () => {
      const maliciousReceiver = await deployMaliciousReceiver()
      const depositKey = DEPOSIT_KEY_OUTPUT_INDEX_1

      await maliciousReceiver.stageExecutorParameters(
        executorValue,
        signedQuote,
        instructions
      )
      const requiredPayment = await quoteRequiredPayment(
        maliciousReceiver.address
      )
      await initializeAndFundDeposit(1, depositKey)

      // bubbleUp = true: the reentrant attempt's failure is re-thrown from
      // `receive`, so the mock manager's refund call fails.
      await maliciousReceiver.setAttackConfig(depositKey, 0, true)

      await expect(
        maliciousReceiver.finalize(depositKey, {
          value: requiredPayment,
          gasLimit: 2_000_000,
        })
      ).to.be.revertedWith("Refund failed")
    })
  })
})

function buildExecutorArgs(
  value: BigNumber,
  refundAddress = ethers.constants.AddressZero
) {
  return {
    value,
    refundAddress,
    signedQuote: `0x${"11".repeat(32)}`,
    instructions: "0x",
  }
}

function buildFeeArgs() {
  return {
    dbps: 0,
    payee: ethers.constants.AddressZero,
  }
}

async function calculateTbtcAmount(
  bridge: MockTBTCBridgeWithSweep,
  depositKey: string
) {
  const deposit = await bridge.deposits(depositKey)
  const [, , depositTxMaxFee] = await bridge.depositParameters()

  return BigNumber.from(deposit.amount)
    .sub(deposit.treasuryFee)
    .sub(depositTxMaxFee)
    .mul(TBTC_SATOSHI_MULTIPLIER)
}

async function clearDestinationChainIdSlot(
  contractAddress: string,
  currentDestinationChainId: number
) {
  const destinationChainIdSlot = await findStorageSlot(
    contractAddress,
    ethers.utils.hexZeroPad(
      BigNumber.from(currentDestinationChainId).toHexString(),
      32
    )
  )

  await ethers.provider.send("hardhat_setStorageAt", [
    contractAddress,
    destinationChainIdSlot,
    ethers.constants.HashZero,
  ])
}

async function findStorageSlot(contractAddress: string, expectedValue: string) {
  const storageSlots = await Promise.all(
    Array.from({ length: 300 }, async (_, slot) => {
      const slotKey = ethers.utils.hexValue(slot)
      const value = await ethers.provider.getStorageAt(contractAddress, slotKey)

      return { slotKey, value }
    })
  )

  const matchingSlot = storageSlots.find(
    ({ value }) => value.toLowerCase() === expectedValue.toLowerCase()
  )

  if (matchingSlot) {
    return matchingSlot.slotKey
  }

  throw new Error(`Storage slot not found for value ${expectedValue}`)
}

interface StorageLayoutEntry {
  label: string
  slot: string
}

interface CompilerOutputContractWithStorageLayout {
  storageLayout?: { storage: StorageLayoutEntry[] }
}

async function getStorageSlotNumber(
  contractName: string,
  variableName: string
): Promise<number> {
  const sourceName = `contracts/cross-chain/wormhole/${contractName}.sol`
  const buildInfo = await artifacts.getBuildInfo(
    `${sourceName}:${contractName}`
  )
  if (!buildInfo) {
    throw new Error(`Build info not found for ${contractName}`)
  }

  // Some contracts in this project use a per-file compiler override (e.g.
  // to minimize bytecode size) that does not request `storageLayout`
  // output. Recompile the exact same input (identical solc version and
  // settings) with that output selection added, instead of guessing
  // storage slots by brute-force scanning candidates.
  const input = JSON.parse(JSON.stringify(buildInfo.input))
  const existingSelection: string[] =
    input.settings.outputSelection["*"]["*"] ?? []
  input.settings.outputSelection["*"]["*"] = existingSelection.includes(
    "storageLayout"
  )
    ? existingSelection
    : [...existingSelection, "storageLayout"]

  const solcBuild = await run("compile:solidity:solc:get-build", {
    quiet: true,
    solcVersion: buildInfo.solcVersion,
  })
  const output = solcBuild.isSolcJs
    ? await run("compile:solidity:solcjs:run", {
        input,
        solcJsPath: solcBuild.compilerPath,
      })
    : await run("compile:solidity:solc:run", {
        input,
        solcPath: solcBuild.compilerPath,
        solcVersion: buildInfo.solcVersion,
      })

  const contractOutput = output.contracts[sourceName][
    contractName
  ] as unknown as CompilerOutputContractWithStorageLayout
  const entry = contractOutput.storageLayout?.storage.find(
    ({ label }) => label === variableName
  )
  if (!entry) {
    throw new Error(
      `Storage variable ${variableName} not found in ${contractName}`
    )
  }

  return Number(entry.slot)
}

// Computes the deterministic mapping-entry storage slot for
// `fixedDestinationDeposits[depositKey]` from the contract's compiled
// storage layout, instead of brute-force scanning candidate slots.
async function clearFixedDestinationDepositMarker(
  contract: L1BTCDepositorNttWithExecutor,
  depositKey: string
) {
  expect(await contract.fixedDestinationDeposits(depositKey)).to.equal(true)

  const mappingSlot = await getStorageSlotNumber(
    "L1BTCDepositorNttWithExecutor",
    "fixedDestinationDeposits"
  )
  const storageSlotKey = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["uint256", "uint256"],
      [depositKey, mappingSlot]
    )
  )

  await ethers.provider.send("hardhat_setStorageAt", [
    contract.address,
    storageSlotKey,
    ethers.constants.HashZero,
  ])

  expect(await contract.fixedDestinationDeposits(depositKey)).to.equal(false)
}
