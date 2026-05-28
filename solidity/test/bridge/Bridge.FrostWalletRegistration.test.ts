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

describe("Bridge - FROST Wallet Registration", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let frostRegistry: FrostWalletRegistryStub
  let walletRegistry: FakeContract<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, walletRegistry, bridge, bridgeGovernance } =
      await waffle.loadFixture(bridgeFixture))

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

    // Bridge.registerNewFrostWallet checks lifecycleRouter BEFORE the
    // CallerIsNotFrostWalletRegistry / xOnlyOutputKey checks, so the
    // negative `__frostWalletCreatedCallback` tests below need a
    // non-zero lifecycleRouter to reach the assertion they actually
    // care about. The canonical deploy chain does not wire
    // lifecycleRouter (no deploy script calls Bridge.setLifecycleRouter),
    // so the slot is address(0) after the fixture. Wire it via the
    // governance path; any non-zero address works for these tests
    // since the lifecycle callback path itself is not exercised here.
    await bridgeGovernance
      .connect(governance)
      .setLifecycleRouter(thirdParty.address)
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
      await frostRegistry.resetRequestNewWalletCalled()
    })

    afterEach(async () => {
      await restoreSnapshot()
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

  describe("ECDSA-ID-non-zero guard (via test-stub helper)", () => {
    // The ECDSA wallet creation path now reserves bytes32(0) as
    // the on-chain marker for FROST wallets. Before D-2 the
    // Bridge enforced this at the registration boundary via
    // `__ecdsaWalletCreatedCallback`; D-2 removed that
    // callback entirely (no new ECDSA wallets ever again), so
    // this test now validates the same guard via the
    // `BridgeStub.__ecdsaWalletCreatedCallbackForTest` helper
    // — which mirrors the `Wallets.registerNewWallet` body
    // including the `EcdsaWalletIdIsZero` custom error.
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
