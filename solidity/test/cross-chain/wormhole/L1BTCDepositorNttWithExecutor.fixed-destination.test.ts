import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import type {
  L1BTCDepositorNttWithExecutor,
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

  it("uses the executor wrapper quote for the detailed total cost", async () => {
    const [, relayer] = await ethers.getSigners()
    const executorArgs = buildExecutorArgs(
      BigNumber.from(70000),
      relayer.address
    )
    const feeArgs = buildFeeArgs()

    await depositor
      .connect(relayer)
      .setExecutorParameters(executorArgs, feeArgs)

    const [nttDeliveryPrice, executorCost, totalCost] = await depositor
      .connect(relayer)
      .quoteFinalizeDepositBreakdown()
    const wrapperQuote = await depositor.connect(relayer).quoteFinalizeDeposit()
    const expectedNttDeliveryPrice = (
      await underlyingNttManager.MOCK_DELIVERY_PRICE()
    ).add(
      await underlyingNttManager.chainSpecificPrices(WORMHOLE_CHAIN_DESTINATION)
    )

    expect(nttDeliveryPrice).to.equal(expectedNttDeliveryPrice)
    expect(executorCost).to.equal(
      executorArgs.value.add(
        await nttManagerWithExecutor.MOCK_WRAPPER_SURCHARGE()
      )
    )
    expect(totalCost).to.equal(wrapperQuote)
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
      ).to.be.revertedWith("Insufficient payment for executor service")
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

async function clearFixedDestinationDepositMarker(
  contract: L1BTCDepositorNttWithExecutor,
  depositKey: string
) {
  expect(await contract.fixedDestinationDeposits(depositKey)).to.equal(true)

  const encodedTrue = ethers.utils.hexZeroPad("0x01", 32)
  const candidateSlots = await Promise.all(
    Array.from({ length: 400 }, async (_, slot) => {
      const slotKey = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["uint256", "uint256"],
          [depositKey, slot]
        )
      )
      const storageSlotKey = ethers.utils.hexStripZeros(slotKey)
      const value = await ethers.provider.getStorageAt(
        contract.address,
        storageSlotKey
      )

      return { storageSlotKey, value }
    })
  )
  const matchingSlots = candidateSlots.filter(
    ({ value }) => value.toLowerCase() === encodedTrue.toLowerCase()
  )

  async function clearMatchingSlot(index: number): Promise<void> {
    const matchingSlot = matchingSlots[index]
    if (!matchingSlot) {
      throw new Error("Fixed destination marker storage slot not found")
    }

    await ethers.provider.send("hardhat_setStorageAt", [
      contract.address,
      matchingSlot.storageSlotKey,
      ethers.constants.HashZero,
    ])

    if (!(await contract.fixedDestinationDeposits(depositKey))) {
      return
    }

    await ethers.provider.send("hardhat_setStorageAt", [
      contract.address,
      matchingSlot.storageSlotKey,
      matchingSlot.value,
    ])

    await clearMatchingSlot(index + 1)
  }

  await clearMatchingSlot(0)
}
