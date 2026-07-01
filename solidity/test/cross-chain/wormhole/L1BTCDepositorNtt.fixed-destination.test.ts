import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import type {
  L1BTCDepositorNtt,
  MockNttManager,
  MockTBTCBridgeWithSweep,
  MockTBTCVault,
  TestERC20,
} from "../../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const WORMHOLE_CHAIN_DESTINATION = 32
const UPDATED_WORMHOLE_CHAIN_DESTINATION = 40
const TBTC_SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)
const DEPOSITS_STORAGE_SLOT = 200
const DEPOSIT_STATE_INITIALIZED = 1
const destinationChainDepositOwner =
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
const legacyEncodedDestinationChainDepositOwner = `0x0020${"11".repeat(30)}`
const legacyDecodedDestinationChainDepositOwner = `0x0000${"11".repeat(30)}`

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

describe("L1BTCDepositorNtt fixed destination", () => {
  let bridge: MockTBTCBridgeWithSweep
  let tbtcToken: TestERC20
  let tbtcVault: MockTBTCVault
  let nttManager: MockNttManager
  let l1BtcDepositorNtt: L1BTCDepositorNtt
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
    nttManager = (await MockNttManager.deploy()) as MockNttManager

    fixture = loadFixture(tbtcVault.address)

    const L1BTCDepositorNtt = await ethers.getContractFactory(
      "L1BTCDepositorNtt"
    )
    const implementation = await L1BTCDepositorNtt.deploy()

    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy")
    const initData = implementation.interface.encodeFunctionData("initialize", [
      bridge.address,
      tbtcVault.address,
      nttManager.address,
      WORMHOLE_CHAIN_DESTINATION,
    ])
    const proxy = await ProxyFactory.deploy(implementation.address, initData)
    l1BtcDepositorNtt = L1BTCDepositorNtt.attach(
      proxy.address
    ) as L1BTCDepositorNtt
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  it("initializes the fixed destination chain", async () => {
    expect(await l1BtcDepositorNtt.destinationChainId()).to.equal(
      WORMHOLE_CHAIN_DESTINATION
    )
    expect(await l1BtcDepositorNtt.nttManager()).to.equal(nttManager.address)
  })

  it("does not retarget an initialized fixed destination chain", async () => {
    const [, nonOwner] = await ethers.getSigners()

    await expect(
      l1BtcDepositorNtt
        .connect(nonOwner)
        .initializeV2DestinationChain(UPDATED_WORMHOLE_CHAIN_DESTINATION)
    ).to.be.revertedWith("Ownable: caller is not the owner")

    await expect(
      l1BtcDepositorNtt.initializeV2DestinationChain(
        UPDATED_WORMHOLE_CHAIN_DESTINATION
      )
    ).to.be.revertedWith("Destination chain already configured")

    expect(await l1BtcDepositorNtt.destinationChainId()).to.equal(
      WORMHOLE_CHAIN_DESTINATION
    )
  })

  it("backfills an unset fixed destination chain once during upgrade", async () => {
    await clearDestinationChainIdSlot(
      l1BtcDepositorNtt.address,
      WORMHOLE_CHAIN_DESTINATION
    )

    expect(await l1BtcDepositorNtt.destinationChainId()).to.equal(0)

    await expect(
      l1BtcDepositorNtt.initializeV2DestinationChain(0)
    ).to.be.revertedWith("Chain ID cannot be zero")

    await expect(
      l1BtcDepositorNtt.initializeV2DestinationChain(
        UPDATED_WORMHOLE_CHAIN_DESTINATION
      )
    )
      .to.emit(l1BtcDepositorNtt, "DestinationChainUpdated")
      .withArgs(0, UPDATED_WORMHOLE_CHAIN_DESTINATION)

    expect(await l1BtcDepositorNtt.destinationChainId()).to.equal(
      UPDATED_WORMHOLE_CHAIN_DESTINATION
    )

    const quote = await l1BtcDepositorNtt.quoteFinalizeDeposit()
    const expectedQuote = (await nttManager.MOCK_DELIVERY_PRICE()).add(
      await nttManager.chainSpecificPrices(UPDATED_WORMHOLE_CHAIN_DESTINATION)
    )

    expect(quote).to.equal(expectedQuote)

    await expect(
      l1BtcDepositorNtt.initializeV2DestinationChain(WORMHOLE_CHAIN_DESTINATION)
    ).to.be.reverted
  })

  it("quotes the configured destination chain", async () => {
    const quote = await l1BtcDepositorNtt.quoteFinalizeDeposit()
    const expectedQuote = (await nttManager.MOCK_DELIVERY_PRICE()).add(
      await nttManager.chainSpecificPrices(WORMHOLE_CHAIN_DESTINATION)
    )

    expect(quote).to.equal(expectedQuote)
  })

  it("passes the full 32-byte deposit owner to NTT without masking", async () => {
    await bridge.setNextDepositKey(fixture.expectedDepositKey)

    await l1BtcDepositorNtt.initializeDeposit(
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

    await tbtcToken.mint(l1BtcDepositorNtt.address, tbtcAmount)

    const quote = await l1BtcDepositorNtt.quoteFinalizeDeposit()
    await expect(
      l1BtcDepositorNtt.finalizeDeposit(fixture.expectedDepositKey, {
        value: quote,
      })
    )
      .to.emit(nttManager, "MockTransferExecuted")
      .withArgs(
        1,
        WORMHOLE_CHAIN_DESTINATION,
        destinationChainDepositOwner,
        tbtcAmount,
        quote
      )

    expect(await nttManager.lastAmount()).to.equal(tbtcAmount)
    expect(await nttManager.lastRecipientChain()).to.equal(
      WORMHOLE_CHAIN_DESTINATION
    )
    expect(await nttManager.lastRecipient()).to.equal(
      destinationChainDepositOwner
    )
  })

  it("preserves fixed-destination recipients with a legacy-shaped prefix", async () => {
    await bridge.setNextDepositKey(fixture.expectedDepositKey)

    await l1BtcDepositorNtt.initializeDeposit(
      fixture.fundingTx,
      fixture.reveal,
      legacyEncodedDestinationChainDepositOwner
    )
    await bridge.sweepDeposit(fixture.expectedDepositKey)

    const tbtcAmount = await calculateTbtcAmount(
      bridge,
      fixture.expectedDepositKey
    )
    await tbtcToken.mint(l1BtcDepositorNtt.address, tbtcAmount)

    const quote = await l1BtcDepositorNtt.quoteFinalizeDeposit()
    await expect(
      l1BtcDepositorNtt.finalizeDeposit(fixture.expectedDepositKey, {
        value: quote,
      })
    )
      .to.emit(nttManager, "MockTransferExecuted")
      .withArgs(
        1,
        WORMHOLE_CHAIN_DESTINATION,
        legacyEncodedDestinationChainDepositOwner,
        tbtcAmount,
        quote
      )

    expect(await nttManager.lastRecipient()).to.equal(
      legacyEncodedDestinationChainDepositOwner
    )
  })

  it("decodes legacy encoded recipients for unmarked pre-upgrade deposits", async () => {
    await bridge.setNextDepositKey(fixture.expectedDepositKey)

    await bridge.revealDepositWithExtraData(
      fixture.fundingTx,
      fixture.reveal,
      legacyEncodedDestinationChainDepositOwner
    )
    await markDepositInitialized(
      l1BtcDepositorNtt.address,
      fixture.expectedDepositKey
    )
    await bridge.sweepDeposit(fixture.expectedDepositKey)

    const tbtcAmount = await calculateTbtcAmount(
      bridge,
      fixture.expectedDepositKey
    )
    await tbtcToken.mint(l1BtcDepositorNtt.address, tbtcAmount)

    const quote = await l1BtcDepositorNtt.quoteFinalizeDeposit()
    await expect(
      l1BtcDepositorNtt.finalizeDeposit(fixture.expectedDepositKey, {
        value: quote,
      })
    )
      .to.emit(nttManager, "MockTransferExecuted")
      .withArgs(
        1,
        WORMHOLE_CHAIN_DESTINATION,
        legacyDecodedDestinationChainDepositOwner,
        tbtcAmount,
        quote
      )

    expect(await nttManager.lastRecipient()).to.equal(
      legacyDecodedDestinationChainDepositOwner
    )
  })

  it("reverts when payment exceeds the quoted NTT cost", async () => {
    await bridge.setNextDepositKey(fixture.expectedDepositKey)

    await l1BtcDepositorNtt.initializeDeposit(
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

    await tbtcToken.mint(l1BtcDepositorNtt.address, tbtcAmount)

    const quote = await l1BtcDepositorNtt.quoteFinalizeDeposit()
    await expect(
      l1BtcDepositorNtt.finalizeDeposit(fixture.expectedDepositKey, {
        value: quote.add(1),
      })
    ).to.be.revertedWith("Payment for Wormhole NTT has incorrect value")
  })
})

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

async function markDepositInitialized(
  contractAddress: string,
  depositKey: string
) {
  const depositStateSlot = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["uint256", "uint256"],
      [depositKey, DEPOSITS_STORAGE_SLOT]
    )
  )

  await ethers.provider.send("hardhat_setStorageAt", [
    contractAddress,
    ethers.BigNumber.from(depositStateSlot).toHexString(),
    ethers.utils.hexZeroPad(
      ethers.BigNumber.from(DEPOSIT_STATE_INITIALIZED).toHexString(),
      32
    ),
  ])
}

async function clearDestinationChainIdSlot(
  contractAddress: string,
  currentDestinationChainId: number
) {
  const destinationChainIdSlot = await findStorageSlot(
    contractAddress,
    currentDestinationChainId
  )

  await ethers.provider.send("hardhat_setStorageAt", [
    contractAddress,
    ethers.utils.hexValue(destinationChainIdSlot),
    ethers.constants.HashZero,
  ])
}

async function findStorageSlot(contractAddress: string, expectedValue: number) {
  const slots = Array.from({ length: 21 }, (_, index) => 200 + index)
  const values = await Promise.all(
    slots.map((slot) => ethers.provider.getStorageAt(contractAddress, slot))
  )
  const slotIndex = values.findIndex((value) =>
    ethers.BigNumber.from(value).eq(expectedValue)
  )

  if (slotIndex >= 0) {
    return slots[slotIndex]
  }

  throw new Error("destinationChainId storage slot not found")
}
