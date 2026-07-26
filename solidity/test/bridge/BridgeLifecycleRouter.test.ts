/* eslint-disable no-underscore-dangle */
import { ethers, waffle, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import type {
  Bridge,
  BridgeGovernance,
  BridgeLifecycleRouter,
  BridgeStub,
  FrostWalletRegistryStub,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { rebindCompleteP2TRFraudRouter } from "../utils/p2trCoverage"
import { walletState } from "../fixtures"

const frostXOnlyOutputKey =
  "0xb1de1afa17e1cbb20d8a4f8e54f8a55fbf5c8d2da9e1c6c4d1f0c7b3a2e5d4c8"

async function expectCustomError(
  promise: Promise<unknown>,
  errorName: string
): Promise<void> {
  const expectedSelector = ethers.utils.id(`${errorName}()`).slice(0, 10)
  try {
    await promise
  } catch (err) {
    const errAny = err as {
      data?: string
      message?: string
      error?: { data?: string }
    }
    const revertData = errAny.data || errAny.error?.data || ""
    const errMsg = errAny.message || String(err)

    if (
      (revertData && revertData.toLowerCase().startsWith(expectedSelector)) ||
      errMsg.toLowerCase().includes(expectedSelector) ||
      errMsg.includes(errorName)
    ) {
      return
    }
    throw new Error(
      `expected revert with custom error ${errorName} ` +
        `(selector ${expectedSelector}), got: ${errMsg}`
    )
  }
  throw new Error(
    `expected revert with custom error ${errorName} but tx succeeded`
  )
}

function hardhatQuantity(value: string): string {
  const stripped = value.replace(/^0x0+/, "0x")
  return stripped === "0x" ? "0x0" : stripped
}

describe("BridgeLifecycleRouter", () => {
  let thirdParty: SignerWithAddress
  let governance: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let bridgeSigner: SignerWithAddress
  let frostRegistry: FrostWalletRegistryStub
  let router: BridgeLifecycleRouter
  let walletPubKeyHash: string

  beforeEach(async () => {
    const fixture = await waffle.loadFixture(bridgeFixture)
    thirdParty = fixture.thirdParty
    governance = fixture.governance
    bridge = fixture.bridge
    bridgeGovernance = fixture.bridgeGovernance

    const FrostRegistryStubFactory = await ethers.getContractFactory(
      "FrostWalletRegistryStub"
    )
    frostRegistry =
      (await FrostRegistryStubFactory.deploy()) as FrostWalletRegistryStub
    await frostRegistry.deployed()

    const RouterFactory = await ethers.getContractFactory(
      "BridgeLifecycleRouter"
    )
    router = (await RouterFactory.deploy(
      bridge.address
    )) as BridgeLifecycleRouter
    await router.deployed()

    await bridge.resetFrostWalletRegistryForTest(frostRegistry.address)
    // The bridge fixture installs a COMPLETE_V2 router whose authorization
    // registry has an immutable `frostRegistry` pointing at the canonical
    // FrostWalletRegistry. Swapping the Bridge's registry above breaks that
    // handshake, so FROST wallet registration would fail closed with
    // P2TRFraudEvidenceUnavailable() before reaching what these tests assert.
    await rebindCompleteP2TRFraudRouter(
      bridge,
      frostRegistry.address,
      (
        await helpers.contracts.getContract("WalletProposalValidator")
      ).address,
      fixture.deployer,
      ethers
    )
    await bridge.resetLifecycleRouterForTest(router.address)
    await frostRegistry.setLifecycleOwner(router.address)
    await frostRegistry.callBridgeFrostWalletCreatedCallback(
      bridge.address,
      frostXOnlyOutputKey
    )
    walletPubKeyHash = await bridge.walletPubKeyHashForWalletID(
      frostXOnlyOutputKey
    )

    await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])
    await ethers.provider.send("hardhat_setBalance", [
      bridge.address,
      hardhatQuantity(ethers.utils.parseEther("100").toHexString()),
    ])
    bridgeSigner = await ethers.getSigner(bridge.address)
  })

  it("should pin the Bridge address at construction", async () => {
    expect(await router.bridge()).to.equal(bridge.address)
  })

  it("should reject a zero Bridge constructor argument", async () => {
    const RouterFactory = await ethers.getContractFactory(
      "BridgeLifecycleRouter"
    )

    await expectCustomError(
      RouterFactory.deploy(ethers.constants.AddressZero),
      "BridgeAddressZero"
    )
  })

  it("should reject mutating calls not sent by Bridge", async () => {
    await expectCustomError(
      router.connect(thirdParty).closeWallet(walletPubKeyHash),
      "CallerIsNotBridge"
    )
  })

  it("should reject when the FROST wallet registry is not set", async () => {
    await bridge.resetFrostWalletRegistryForTest(ethers.constants.AddressZero)

    await expectCustomError(
      router.connect(bridgeSigner).closeWallet(walletPubKeyHash),
      "FrostWalletRegistryNotSet"
    )
  })

  it("should reject when the wallet pubKeyHash has no FROST walletID", async () => {
    const unknownWalletPubKeyHash = "0x0102030405060708090a0b0c0d0e0f1011121314"

    await expectCustomError(
      router.connect(bridgeSigner).closeWallet(unknownWalletPubKeyHash),
      "FrostWalletIdIsZero"
    )
  })

  it("should reject when the registry lifecycle owner does not match the router", async () => {
    await frostRegistry.setLifecycleOwner(thirdParty.address)

    await expectCustomError(
      router.connect(bridgeSigner).closeWallet(walletPubKeyHash),
      "LifecycleOwnerMismatch"
    )
  })

  it("should resolve the FROST walletID and forward closeWallet", async () => {
    await router.connect(bridgeSigner).closeWallet(walletPubKeyHash)

    expect(await frostRegistry.closeWalletCalled()).to.equal(true)
    expect(await frostRegistry.lastClosedWalletID()).to.equal(
      frostXOnlyOutputKey
    )
  })

  it("should resolve the FROST walletID and forward seize", async () => {
    const walletMembersIDs = [11, 12, 13]

    await router
      .connect(bridgeSigner)
      .seize(walletPubKeyHash, 123, 17, thirdParty.address, walletMembersIDs)

    expect(await frostRegistry.seizeCalled()).to.equal(true)
    expect(await frostRegistry.lastSeizeAmount()).to.equal(123)
    expect(await frostRegistry.lastSeizeRewardMultiplier()).to.equal(17)
    expect(await frostRegistry.lastSeizeNotifier()).to.equal(thirdParty.address)
    expect(await frostRegistry.lastSeizeWalletID()).to.equal(
      frostXOnlyOutputKey
    )

    const recordedMembers = await frostRegistry.getLastSeizeWalletMembersIDs()
    expect(
      recordedMembers.map((member) => ethers.BigNumber.from(member).toNumber())
    ).to.deep.equal(walletMembersIDs)
  })

  it("should resolve the FROST walletID and forward isWalletMember", async () => {
    const walletMembersIDs = [21, 22, 23]
    await frostRegistry.setExpectedIsWalletMember(
      frostXOnlyOutputKey,
      walletMembersIDs,
      thirdParty.address,
      1,
      true
    )

    expect(
      await router
        .connect(thirdParty)
        .isWalletMember(
          walletPubKeyHash,
          walletMembersIDs,
          thirdParty.address,
          1
        )
    ).to.equal(true)
  })

  it("fires the FROST misbehavior report on a Bridge timeout even when slashing is inactive", async () => {
    // The FROST router `seize` is an event-only misbehavior report
    // (FrostWalletRegistry.seize -> FrostAllowlist.reportMaliciousBehavior ->
    // MaliciousBehaviorIdentified), the live DAO-enforcement signal with no
    // economic effect. It must fire regardless of the economic-slashing gate,
    // so turn the gate off (the shared fixture enables it) and confirm a
    // Bridge timeout on a FROST wallet still reaches the router seize.
    await bridgeGovernance.connect(governance).setSlashingActive(false)

    // Place the FROST wallet (ecdsaWalletID == 0) into MovingFunds so the
    // moving-funds-timeout handler dispatches through the lifecycle router.
    const now = await helpers.time.lastBlockTime()
    await bridge.setWallet(walletPubKeyHash, {
      ecdsaWalletID: ethers.constants.HashZero,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: now,
      movingFundsRequestedAt: now,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.MovingFunds,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })

    // Advance past the moving-funds timeout so the handler proceeds to seize.
    const { movingFundsTimeout } = await bridge.movingFundsParameters()
    await helpers.time.increaseTime(movingFundsTimeout)

    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await frostRegistry.seizeCalled()).to.equal(false)

    await bridge
      .connect(thirdParty)
      .notifyMovingFundsTimeout(walletPubKeyHash, [11, 12, 13])

    // The misbehavior report fired even though economic slashing is off.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await frostRegistry.seizeCalled()).to.equal(true)
  })
})
