/* eslint-disable no-underscore-dangle */
import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import chai, { expect } from "chai"
import { smock, FakeContract } from "@defi-wonderland/smock"
import type { ContractTransaction } from "ethers"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  FrostWalletRegistryStub,
  IWalletRegistry,
} from "../../typechain"
import { walletState } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"
import { rebindCompleteP2TRFraudRouter } from "../utils/p2trCoverage"
import { ecdsaWalletTestData } from "../data/ecdsa"
import { NO_MAIN_UTXO } from "../data/deposit-sweep"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time

// A representative 32-byte x-only Taproot output key for tests. The high
// 12 bytes are deliberately non-zero so the `bytes12 != 0` shape guard
// passes; this matches what a real FROST DKG output looks like (a uniform
// 32-byte x-only key) and matters because `walletID = xOnlyOutputKey`
// must be structurally distinguishable from a left-padded legacy alias.
const frostXOnlyOutputKey =
  "0xb1de1afa17e1cbb20d8a4f8e54f8a55fbf5c8d2da9e1c6c4d1f0c7b3a2e5d4c8"
const boundedEvidenceProtocolID = ethers.utils.id(
  "tbtc/p2tr-signature-fraud/evidence/bounded-v1"
)
const completeEvidenceProtocolID = ethers.utils.id(
  "tbtc/p2tr-signature-fraud/evidence/complete-v2"
)

async function deployBoundedP2TRFraudRouter(
  bridgeAddress: string
): Promise<string> {
  const factory = await ethers.getContractFactory("P2TRSignatureFraudRouter")
  const router = await factory.deploy(bridgeAddress)
  await router.deployed()
  return router.address
}

async function deployEvidenceProtocolStub(
  bridgeAddress: string,
  protocolID: string
): Promise<string> {
  const factory = await ethers.getContractFactory(
    "P2TRFraudEvidenceProtocolStub"
  )
  const router = await factory.deploy(bridgeAddress, protocolID)
  await router.deployed()
  return router.address
}

async function deployMalformedEvidenceProtocolStub(
  bridgeAddress: string
): Promise<string> {
  const factory = await ethers.getContractFactory(
    "MalformedP2TRFraudEvidenceProtocolStub"
  )
  const router = await factory.deploy(bridgeAddress)
  await router.deployed()
  return router.address
}

// Local helper: assert a transaction reverts with a specific no-arg
// custom error. The project's test toolchain (hardhat-waffle 2.x +
// smock) does not register the `revertedWithCustomError` chai matcher,
// so we check the revert data manually by comparing the 4-byte
// selector. This also avoids needing to mirror library-declared error
// types on Bridge.sol's ABI, which would otherwise be required for the
// missing matcher and would emit duplicate-declaration warnings from
// solc when the error already comes from a `using` library.
async function expectCustomError(
  promise: Promise<unknown>,
  errorName: string
): Promise<void> {
  // Solidity custom-error selector for a no-arg error:
  //   bytes4(keccak256("ErrorName()"))
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

async function expectFrostActivationRejectedWithoutStateChanges(
  bridge: Bridge & BridgeStub,
  action: () => Promise<unknown>
): Promise<void> {
  const activeWalletPubKeyHash = await bridge.activeWalletPubKeyHash()
  const activeWalletID = await bridge.activeWalletID()
  const liveWalletsCount = await bridge.liveWalletsCount()

  await expectCustomError(action(), "P2TRFraudEvidenceUnavailable")

  expect(await bridge.activeWalletPubKeyHash()).to.equal(activeWalletPubKeyHash)
  expect(await bridge.activeWalletID()).to.equal(activeWalletID)
  expect(await bridge.liveWalletsCount()).to.equal(liveWalletsCount)
  expect(
    await bridge.walletPubKeyHashForWalletID(frostXOnlyOutputKey)
  ).to.equal(ethers.constants.AddressZero)
}

describe("Bridge - FROST Wallet Registration", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let frostRegistry: FrostWalletRegistryStub
  let walletRegistry: FakeContract<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let deployer: SignerWithAddress

  // The bridge fixture installs a COMPLETE_V2 router whose authorization
  // registry has an immutable `frostRegistry` pointing at the canonical
  // FrostWalletRegistry. Every `resetFrostWalletRegistryForTest(frostRegistry)`
  // below breaks that handshake, so `registerNewFrostWallet` would fail closed
  // with P2TRFraudEvidenceUnavailable() before reaching the LifecycleRouterNotSet
  // / LifecycleOwnerMismatch / FrostWalletIdIsZero / FrostWalletIdNotNative
  // condition the test is asserting. Rebind the pair to the stub instead of
  // relaxing the guard.
  const rebindFraudRouterToStubRegistry = async (): Promise<void> => {
    await rebindCompleteP2TRFraudRouter(
      bridge,
      frostRegistry.address,
      (
        await helpers.contracts.getContract("WalletProposalValidator")
      ).address,
      deployer,
      ethers
    )
  }

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      thirdParty,
      walletRegistry,
      bridge,
      bridgeGovernance,
      deployer,
    } = await waffle.loadFixture(bridgeFixture))

    const FrostRegistryStubFactory = await ethers.getContractFactory(
      "FrostWalletRegistryStub"
    )
    frostRegistry =
      (await FrostRegistryStubFactory.deploy()) as FrostWalletRegistryStub
    await frostRegistry.deployed()

    // Reset Bridge.frostWalletRegistry to address(0). The production
    // deploy chain in bridgeFixture wires it to the canonical FROST
    // registry, but these tests cover the setter's input-validation
    // paths (AddressZero check, AlreadySet idempotency) which require
    // a fresh unset baseline. `BridgeStub.resetFrostWalletRegistry-
    // ForTest` (added in round 21) bypasses the one-time-setter guard
    // for exactly this purpose.
    await bridge.resetFrostWalletRegistryForTest(ethers.constants.AddressZero)

    // Bridge.registerNewFrostWallet checks lifecycleRouter before the
    // CallerIsNotFrostWalletRegistry / xOnlyOutputKey checks, so the
    // negative `__frostWalletCreatedCallback` tests below need a
    // non-zero lifecycleRouter to reach the assertion they actually
    // care about. The production deploy chain now sets the one-time
    // router slot; use the test-only reset helper to point it at the
    // local stub lifecycle owner for these isolated callback tests.
    await bridge.resetLifecycleRouterForTest(thirdParty.address)
    await frostRegistry.setLifecycleOwner(thirdParty.address)
  })

  describe("setFrostWalletRegistry", () => {
    context("when called directly on the Bridge by a third party", () => {
      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .setFrostWalletRegistry(frostRegistry.address)
        ).to.be.revertedWith("Caller is not the governance")
      })
    })

    context(
      "when called directly on the Bridge by the governance signer",
      () => {
        it("should revert (governance has been transferred to BridgeGovernance)", async () => {
          // The fixture transfers Bridge.governance() to the
          // BridgeGovernance contract, so the governance signer can
          // no longer call Bridge directly. All governance actions
          // must go through BridgeGovernance.
          await expect(
            bridge
              .connect(governance)
              .setFrostWalletRegistry(frostRegistry.address)
          ).to.be.revertedWith("Caller is not the governance")
        })
      }
    )

    context("when called through BridgeGovernance by non-owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .setFrostWalletRegistry(frostRegistry.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context(
      "when called through BridgeGovernance with the zero address",
      () => {
        it("should revert with FrostWalletRegistryAddressZero", async () =>
          expectCustomError(
            bridgeGovernance
              .connect(governance)
              .setFrostWalletRegistry(ethers.constants.AddressZero),
            "FrostWalletRegistryAddressZero"
          ))
      }
    )

    context(
      "when called through BridgeGovernance with a non-zero address",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()
          tx = await bridgeGovernance
            .connect(governance)
            .setFrostWalletRegistry(frostRegistry.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit FrostWalletRegistrySet recording the registry address", async () => {
          // No dedicated getter for frostWalletRegistry on the Bridge
          // contract (omitted to keep the implementation under the
          // 24 KiB EIP-170 deploy limit). The address is set exactly
          // once via governance, so the FrostWalletRegistrySet event is
          // the canonical record. The "second call reverts" assertion
          // below independently confirms the stored value is non-zero.
          await expect(tx)
            .to.emit(bridge, "FrostWalletRegistrySet")
            .withArgs(frostRegistry.address)
        })

        context("when called a second time", () => {
          it("should revert with FrostWalletRegistryAlreadySet", async () =>
            expectCustomError(
              bridgeGovernance
                .connect(governance)
                .setFrostWalletRegistry(frostRegistry.address),
              "FrostWalletRegistryAlreadySet"
            ))
        })
      }
    )
  })

  describe("requestNewWallet lifecycle wiring", () => {
    beforeEach(async () => {
      await createSnapshot()
      await bridge.resetFrostWalletRegistryForTest(frostRegistry.address)
      await rebindFraudRouterToStubRegistry()
      await frostRegistry.resetRequestNewWalletCalled()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should fail closed before DKG when the router is unset without changing state", async () => {
      await bridge.resetP2TRFraudRouterForTest(ethers.constants.AddressZero)

      await expectFrostActivationRejectedWithoutStateChanges(bridge, async () =>
        bridge.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO)
      )
      expect(await frostRegistry.requestNewWalletCalled()).to.equal(false)
    })

    it("should reject the bounded V1 router before DKG", async () => {
      const routerAddress = await deployBoundedP2TRFraudRouter(bridge.address)
      const router = await ethers.getContractAt(
        "P2TRSignatureFraudRouter",
        routerAddress
      )
      expect(await router.evidenceProtocolID()).to.equal(
        boundedEvidenceProtocolID
      )
      await bridge.resetP2TRFraudRouterForTest(routerAddress)

      await expectFrostActivationRejectedWithoutStateChanges(bridge, async () =>
        bridge.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO)
      )
      expect(await frostRegistry.requestNewWalletCalled()).to.equal(false)
    })

    it("should reject malformed protocol data before DKG", async () => {
      await bridge.resetP2TRFraudRouterForTest(
        await deployMalformedEvidenceProtocolStub(bridge.address)
      )

      await expectFrostActivationRejectedWithoutStateChanges(bridge, async () =>
        bridge.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO)
      )
      expect(await frostRegistry.requestNewWalletCalled()).to.equal(false)
    })

    it("should reject a complete protocol bound to another Bridge before DKG", async () => {
      await bridge.resetP2TRFraudRouterForTest(
        await deployEvidenceProtocolStub(
          thirdParty.address,
          completeEvidenceProtocolID
        )
      )

      await expectFrostActivationRejectedWithoutStateChanges(bridge, async () =>
        bridge.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO)
      )
      expect(await frostRegistry.requestNewWalletCalled()).to.equal(false)
    })

    it("should fail before DKG when lifecycle router is unset", async () => {
      await bridge.resetLifecycleRouterForTest(ethers.constants.AddressZero)
      await frostRegistry.setLifecycleOwner(thirdParty.address)

      await expectCustomError(
        bridge.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO),
        "LifecycleRouterNotSet"
      )
      expect(await frostRegistry.requestNewWalletCalled()).to.equal(false)
    })

    it("should fail before DKG when registry lifecycle owner does not match Bridge lifecycle router", async () => {
      await frostRegistry.setLifecycleOwner(bridge.address)

      await expectCustomError(
        bridge.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO),
        "LifecycleOwnerMismatch"
      )
      expect(await frostRegistry.requestNewWalletCalled()).to.equal(false)
    })

    it("should dispatch when registry lifecycle owner matches Bridge lifecycle router", async () => {
      await frostRegistry.setLifecycleOwner(thirdParty.address)

      const router = await ethers.getContractAt(
        "P2TRSignatureFraudRouter",
        await bridge.p2trFraudRouter()
      )
      expect(await router.evidenceProtocolID()).to.equal(
        completeEvidenceProtocolID
      )

      await expect(
        bridge.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO)
      ).to.emit(bridge, "NewWalletRequested")
      expect(await frostRegistry.requestNewWalletCalled()).to.equal(true)
    })
  })

  describe("__frostWalletCreatedCallback", () => {
    context("when the FROST wallet registry is not set", () => {
      // No setFrostWalletRegistry call has been made on the fresh
      // fixture state; the entry point must reject before any caller
      // check so an attacker cannot probe by sending traffic.
      it("should revert with FrostWalletRegistryNotSet", async () =>
        expectCustomError(
          bridge
            .connect(thirdParty)
            .__frostWalletCreatedCallback(frostXOnlyOutputKey),
          "FrostWalletRegistryNotSet"
        ))
    })

    context("when the FROST wallet registry is set", () => {
      before(async () => {
        await createSnapshot()
        await bridgeGovernance
          .connect(governance)
          .setFrostWalletRegistry(frostRegistry.address)
        // Same handshake as the reset-based swaps above: pointing the Bridge
        // at the stub registry orphans the fixture's authorization registry,
        // whose `frostRegistry` is immutable. The nested "complete P2TR fraud
        // evidence is unavailable" cases install their own deliberately bad
        // routers on top of this, so they still exercise the guard firing.
        await rebindFraudRouterToStubRegistry()
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when called by a non-registry account", () => {
        it("should revert with CallerIsNotFrostWalletRegistry", async () =>
          expectCustomError(
            bridge
              .connect(thirdParty)
              .__frostWalletCreatedCallback(frostXOnlyOutputKey),
            "CallerIsNotFrostWalletRegistry"
          ))
      })

      context("when complete P2TR fraud evidence is unavailable", () => {
        beforeEach(async () => {
          await createSnapshot()
        })

        afterEach(async () => {
          await restoreSnapshot()
        })

        const callRegistration = async () =>
          frostRegistry.callBridgeFrostWalletCreatedCallback(
            bridge.address,
            frostXOnlyOutputKey
          )

        it("should reject an unset router without registering a Live wallet", async () => {
          await bridge.resetP2TRFraudRouterForTest(ethers.constants.AddressZero)
          await expectFrostActivationRejectedWithoutStateChanges(
            bridge,
            callRegistration
          )
        })

        it("should reject bounded V1 without registering a Live wallet", async () => {
          await bridge.resetP2TRFraudRouterForTest(
            await deployBoundedP2TRFraudRouter(bridge.address)
          )
          await expectFrostActivationRejectedWithoutStateChanges(
            bridge,
            callRegistration
          )
        })

        it("should reject malformed protocol data without registering a Live wallet", async () => {
          await bridge.resetP2TRFraudRouterForTest(
            await deployMalformedEvidenceProtocolStub(bridge.address)
          )
          await expectFrostActivationRejectedWithoutStateChanges(
            bridge,
            callRegistration
          )
        })

        it("should reject a protocol bound to another Bridge without registering a Live wallet", async () => {
          await bridge.resetP2TRFraudRouterForTest(
            await deployEvidenceProtocolStub(
              thirdParty.address,
              completeEvidenceProtocolID
            )
          )
          await expectFrostActivationRejectedWithoutStateChanges(
            bridge,
            callRegistration
          )
        })
      })

      context(
        "when registry lifecycle owner does not match Bridge lifecycle router",
        () => {
          before(async () => {
            await createSnapshot()
            await frostRegistry.setLifecycleOwner(bridge.address)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert with LifecycleOwnerMismatch before registering a Live wallet", async () =>
            expectCustomError(
              frostRegistry.callBridgeFrostWalletCreatedCallback(
                bridge.address,
                frostXOnlyOutputKey
              ),
              "LifecycleOwnerMismatch"
            ))
        }
      )

      context("when xOnlyOutputKey is zero", () => {
        it("should revert with FrostWalletIdIsZero", async () =>
          expectCustomError(
            frostRegistry.callBridgeFrostWalletCreatedCallback(
              bridge.address,
              ethers.constants.HashZero
            ),
            "FrostWalletIdIsZero"
          ))
      })

      context("when xOnlyOutputKey is left-padded legacy-shaped", () => {
        // High 12 bytes are zero, so this looks like a legacy alias.
        // The shape guard exists specifically to prevent the SDK
        // stale-ABI fallback from misclassifying the wallet.
        it("should revert with FrostWalletIdNotNative", async () => {
          const legacyShapedID =
            "0x000000000000000000000000aabbccddeeff112233445566778899aabbccddee"
          await expectCustomError(
            frostRegistry.callBridgeFrostWalletCreatedCallback(
              bridge.address,
              legacyShapedID
            ),
            "FrostWalletIdNotNative"
          )
        })
      })

      context("when called with a valid xOnlyOutputKey", () => {
        let tx: ContractTransaction
        let derivedWalletPubKeyHash: string

        before(async () => {
          await createSnapshot()
          const router = await ethers.getContractAt(
            "P2TRSignatureFraudRouter",
            await bridge.p2trFraudRouter()
          )
          expect(await router.evidenceProtocolID()).to.equal(
            completeEvidenceProtocolID
          )
          tx = await frostRegistry.callBridgeFrostWalletCreatedCallback(
            bridge.address,
            frostXOnlyOutputKey
          )
          // Source of truth for the derived pubKeyHash is the on-chain
          // mapping populated by the registration write. This avoids
          // baking a HASH160 result into a TypeScript constant that
          // could drift from BitcoinTx.deriveWalletPubKeyHashFromXOnly.
          derivedWalletPubKeyHash = await bridge.walletPubKeyHashForWalletID(
            frostXOnlyOutputKey
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should derive a non-zero walletPubKeyHash via HASH160(0x02 || xOnly)", () => {
          expect(derivedWalletPubKeyHash).to.not.equal(
            "0x0000000000000000000000000000000000000000"
          )
        })

        it("should transition the new wallet to Live state", async () => {
          const wallet = await bridge.wallets(derivedWalletPubKeyHash)
          expect(wallet.state).to.equal(walletState.Live)
        })

        it("should set ecdsaWalletID to bytes32(0) as the FROST marker", async () => {
          const wallet = await bridge.wallets(derivedWalletPubKeyHash)
          expect(wallet.ecdsaWalletID).to.equal(ethers.constants.HashZero)
        })

        it("should initialise mainUtxoHash to zero (clean state)", async () => {
          const wallet = await bridge.wallets(derivedWalletPubKeyHash)
          expect(wallet.mainUtxoHash).to.equal(ethers.constants.HashZero)
        })

        it("should set the created-at timestamp", async () => {
          const wallet = await bridge.wallets(derivedWalletPubKeyHash)
          expect(wallet.createdAt).to.equal(await lastBlockTime())
        })

        it("should set the new wallet as active", async () => {
          expect(await bridge.activeWalletPubKeyHash()).to.equal(
            derivedWalletPubKeyHash
          )
          expect(await bridge.activeWalletID()).to.equal(frostXOnlyOutputKey)
        })

        it("should set walletID = xOnlyOutputKey directly (not the legacy derivation)", async () => {
          // The canonical FROST walletID is the raw x-only key, NOT
          // bytes32(uint256(uint160(pubKeyHash))). This is what keeps
          // the Fraud.sol legacy-ECDSA guard correct: when the active
          // wallet is FROST, activeWalletID ≠ deriveLegacyWalletID(
          // walletPubKeyHash), so the guard rejects ECDSA fraud paths.
          const legacyDerived = ethers.utils.hexZeroPad(
            derivedWalletPubKeyHash,
            32
          )
          expect(await bridge.activeWalletID()).to.not.equal(legacyDerived)
        })

        it("should expose the xOnlyOutputKey through walletID(pubKeyHash)", async () => {
          expect(await bridge.walletID(derivedWalletPubKeyHash)).to.equal(
            frostXOnlyOutputKey
          )
        })

        it("should emit NewFrostWalletRegistered", async () => {
          await expect(tx)
            .to.emit(bridge, "NewFrostWalletRegistered")
            .withArgs(
              frostXOnlyOutputKey,
              derivedWalletPubKeyHash,
              frostXOnlyOutputKey
            )
        })

        it("should emit NewWalletRegisteredV2 with zero ecdsaWalletID", async () => {
          await expect(tx)
            .to.emit(bridge, "NewWalletRegisteredV2")
            .withArgs(
              frostXOnlyOutputKey,
              ethers.constants.HashZero,
              derivedWalletPubKeyHash
            )
        })

        it("should NOT emit the legacy NewWalletRegistered event", async () => {
          // FROST wallets do not surface through the V1 event because
          // its ecdsaWalletID semantics would be misleading. Indexers
          // subscribing only to V1 will not see them.
          await expect(tx).to.not.emit(bridge, "NewWalletRegistered")
        })

        context("when called again with the same xOnlyOutputKey", () => {
          it("should revert with FrostWalletAlreadyRegistered", async () =>
            expectCustomError(
              frostRegistry.callBridgeFrostWalletCreatedCallback(
                bridge.address,
                frostXOnlyOutputKey
              ),
              "FrostWalletAlreadyRegistered"
            ))
        })
      })
    })
  })

  describe("__frostWalletHeartbeatFailedCallback", () => {
    let frostWalletPubKeyHash: string

    beforeEach(async () => {
      await createSnapshot()
      await bridge.resetFrostWalletRegistryForTest(frostRegistry.address)
      await rebindFraudRouterToStubRegistry()
      await bridge.resetLifecycleRouterForTest(thirdParty.address)
      await frostRegistry.setLifecycleOwner(thirdParty.address)
      await frostRegistry.callBridgeFrostWalletCreatedCallback(
        bridge.address,
        frostXOnlyOutputKey
      )
      frostWalletPubKeyHash = await bridge.walletPubKeyHashForWalletID(
        frostXOnlyOutputKey
      )
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("rejects a caller other than the configured FROST registry", async () => {
      await expectCustomError(
        bridge
          .connect(thirdParty)
          .__frostWalletHeartbeatFailedCallback(frostXOnlyOutputKey),
        "CallerIsNotFrostWalletRegistry"
      )

      expect((await bridge.wallets(frostWalletPubKeyHash)).state).to.equal(
        walletState.Live
      )
    })

    it("rejects an x-only key that is not the wallet's canonical reverse mapping", async () => {
      await bridge.setWalletIDForWalletPubKeyHash(
        frostWalletPubKeyHash,
        ethers.constants.HashZero
      )

      await expectCustomError(
        frostRegistry.callBridgeFrostWalletHeartbeatFailedCallback(
          bridge.address,
          frostXOnlyOutputKey
        ),
        "FrostWalletIdMissing"
      )

      expect((await bridge.wallets(frostWalletPubKeyHash)).state).to.equal(
        walletState.Live
      )
      expect(await bridge.activeWalletID()).to.equal(frostXOnlyOutputKey)
    })

    it("moves a funded Live wallet and atomically clears both active identifiers", async () => {
      await bridge.setWalletMainUtxo(frostWalletPubKeyHash, {
        txHash:
          "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
        txOutputIndex: 0,
        txOutputValue: 1,
      })

      const tx =
        await frostRegistry.callBridgeFrostWalletHeartbeatFailedCallback(
          bridge.address,
          frostXOnlyOutputKey
        )

      const wallet = await bridge.wallets(frostWalletPubKeyHash)
      expect(wallet.state).to.equal(walletState.MovingFunds)
      expect(wallet.movingFundsRequestedAt).to.equal(await lastBlockTime())
      await expect(tx)
        .to.emit(bridge, "WalletMovingFunds")
        .withArgs(ethers.constants.HashZero, frostWalletPubKeyHash)
      expect(await bridge.activeWalletPubKeyHash()).to.equal(
        "0x0000000000000000000000000000000000000000"
      )
      expect(await bridge.activeWalletID()).to.equal(ethers.constants.HashZero)
      expect(await bridge.liveWalletsCount()).to.equal(0)
    })

    it("begins closing an empty Live wallet and atomically clears both active identifiers", async () => {
      const tx =
        await frostRegistry.callBridgeFrostWalletHeartbeatFailedCallback(
          bridge.address,
          frostXOnlyOutputKey
        )

      const wallet = await bridge.wallets(frostWalletPubKeyHash)
      expect(wallet.state).to.equal(walletState.Closing)
      expect(wallet.closingStartedAt).to.equal(await lastBlockTime())
      await expect(tx)
        .to.emit(bridge, "WalletClosing")
        .withArgs(ethers.constants.HashZero, frostWalletPubKeyHash)
      expect(await bridge.activeWalletPubKeyHash()).to.equal(
        "0x0000000000000000000000000000000000000000"
      )
      expect(await bridge.activeWalletID()).to.equal(ethers.constants.HashZero)
      expect(await bridge.liveWalletsCount()).to.equal(0)
    })

    it("rejects replay after the wallet has left Live without changing accounting again", async () => {
      await frostRegistry.callBridgeFrostWalletHeartbeatFailedCallback(
        bridge.address,
        frostXOnlyOutputKey
      )

      await expect(
        frostRegistry.callBridgeFrostWalletHeartbeatFailedCallback(
          bridge.address,
          frostXOnlyOutputKey
        )
      ).to.be.revertedWith("Wallet must be in Live state")

      expect((await bridge.wallets(frostWalletPubKeyHash)).state).to.equal(
        walletState.Closing
      )
      expect(await bridge.liveWalletsCount()).to.equal(0)
    })
  })

  describe("late ECDSA callback after FROST activation", () => {
    let frostWalletPubKeyHash: string
    let lateEcdsaCallbackTx: ContractTransaction

    before(async () => {
      await createSnapshot()
      await bridge.resetFrostWalletRegistryForTest(frostRegistry.address)
      await rebindFraudRouterToStubRegistry()

      await frostRegistry.callBridgeFrostWalletCreatedCallback(
        bridge.address,
        frostXOnlyOutputKey
      )
      frostWalletPubKeyHash = await bridge.walletPubKeyHashForWalletID(
        frostXOnlyOutputKey
      )

      lateEcdsaCallbackTx = await bridge
        .connect(walletRegistry.wallet)
        .__ecdsaWalletCreatedCallback(
          ecdsaWalletTestData.walletID,
          ecdsaWalletTestData.publicKeyX,
          ecdsaWalletTestData.publicKeyY
        )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should preserve the newer FROST wallet as active", async () => {
      expect(await bridge.activeWalletPubKeyHash()).to.equal(
        frostWalletPubKeyHash
      )
      expect(await bridge.activeWalletID()).to.equal(frostXOnlyOutputKey)
    })

    it("should still register the in-flight ECDSA wallet", async () => {
      const wallet = await bridge.wallets(ecdsaWalletTestData.pubKeyHash160)
      const legacyWalletID = ethers.utils.hexZeroPad(
        ecdsaWalletTestData.pubKeyHash160,
        32
      )

      expect(wallet.ecdsaWalletID).to.equal(ecdsaWalletTestData.walletID)
      expect(wallet.state).to.equal(walletState.Live)
      expect(await bridge.walletPubKeyHashForWalletID(legacyWalletID)).to.equal(
        ecdsaWalletTestData.pubKeyHash160
      )
      expect(await bridge.liveWalletsCount()).to.equal(2)
      await expect(lateEcdsaCallbackTx)
        .to.emit(bridge, "NewWalletRegisteredV2")
        .withArgs(
          legacyWalletID,
          ecdsaWalletTestData.walletID,
          ecdsaWalletTestData.pubKeyHash160
        )
    })
  })

  describe("ECDSA registration while P2TR evidence is unavailable", () => {
    before(async () => {
      await createSnapshot()
      await bridge.resetP2TRFraudRouterForTest(ethers.constants.AddressZero)
      await bridge
        .connect(walletRegistry.wallet)
        .__ecdsaWalletCreatedCallback(
          ecdsaWalletTestData.walletID,
          ecdsaWalletTestData.publicKeyX,
          ecdsaWalletTestData.publicKeyY
        )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should preserve the legacy ECDSA callback path", async () => {
      const wallet = await bridge.wallets(ecdsaWalletTestData.pubKeyHash160)
      expect(wallet.ecdsaWalletID).to.equal(ecdsaWalletTestData.walletID)
      expect(wallet.state).to.equal(walletState.Live)
    })
  })

  describe("ECDSA callback with an active ECDSA wallet", () => {
    const previousEcdsaWalletID =
      "0x1111111111111111111111111111111111111111111111111111111111111111"
    // Valid secp256k1 public key for private key 1.
    const previousPublicKeyX =
      "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    const previousPublicKeyY =
      "0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
    let previousWalletPubKeyHash: string

    before(async () => {
      await createSnapshot()

      await bridge
        .connect(walletRegistry.wallet)
        .__ecdsaWalletCreatedCallback(
          previousEcdsaWalletID,
          previousPublicKeyX,
          previousPublicKeyY
        )
      previousWalletPubKeyHash = await bridge.activeWalletPubKeyHash()

      await bridge
        .connect(walletRegistry.wallet)
        .__ecdsaWalletCreatedCallback(
          ecdsaWalletTestData.walletID,
          ecdsaWalletTestData.publicKeyX,
          ecdsaWalletTestData.publicKeyY
        )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should preserve legacy ECDSA active-wallet replacement", async () => {
      expect(
        (await bridge.wallets(previousWalletPubKeyHash)).ecdsaWalletID
      ).to.equal(previousEcdsaWalletID)
      expect(await bridge.activeWalletPubKeyHash()).to.equal(
        ecdsaWalletTestData.pubKeyHash160
      )
      expect(await bridge.activeWalletPubKeyHash()).to.not.equal(
        previousWalletPubKeyHash
      )
      expect(await bridge.activeWalletID()).to.equal(
        ethers.utils.hexZeroPad(ecdsaWalletTestData.pubKeyHash160, 32)
      )
      expect(await bridge.liveWalletsCount()).to.equal(2)
    })
  })

  describe("ECDSA-ID-non-zero guard (via test-stub helper)", () => {
    // The ECDSA wallet creation path now reserves bytes32(0) as
    // the on-chain marker for FROST wallets. Before D-2 the
    // Bridge enforces this at the authenticated production
    // `__ecdsaWalletCreatedCallback`. This isolated boundary test uses the
    // BridgeStub helper to bypass registry authentication while preserving the
    // `Wallets.registerNewWallet` body and `EcdsaWalletIdIsZero` error.
    it("should revert with EcdsaWalletIdIsZero", async () =>
      expectCustomError(
        bridge.__ecdsaWalletCreatedCallbackForTest(
          ethers.constants.HashZero,
          ecdsaWalletTestData.publicKeyX,
          ecdsaWalletTestData.publicKeyY
        ),
        "EcdsaWalletIdIsZero"
      ))
  })
})
