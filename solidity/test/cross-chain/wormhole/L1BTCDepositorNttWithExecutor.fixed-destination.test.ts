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
const TBTC_SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)
const destinationChainDepositOwner =
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
const chainLikePrefixedDestinationChainDepositOwner = `0x0020${"11".repeat(30)}`

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
