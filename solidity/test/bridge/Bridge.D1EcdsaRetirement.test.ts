/* eslint-disable no-underscore-dangle */
import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import chai, { expect } from "chai"
import { smock } from "@defi-wonderland/smock"
import type { FakeContract } from "@defi-wonderland/smock"
import type { ContractTransaction } from "ethers"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  IWalletRegistry,
} from "../../typechain"
import { NO_MAIN_UTXO } from "../data/deposit-sweep"
import { ecdsaWalletTestData } from "../data/ecdsa"
import { ecdsaDkgState } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// D-1 ECDSA soft-retirement guards.
//
// This suite ships the `ecdsaRetired` storage flag plus its
// governance setter (`Bridge.retireEcdsa`) and public getter
// (`Bridge.ecdsaRetired`). Unit tests reach the flag via a
// test-only `BridgeStub.setEcdsaRetiredForTest` helper that
// mirrors how mainnet would activate it through a
// storage-layout-compatible upgrade.
//
// The flag is purely an on-chain audit-trail marker and is NOT
// load-bearing: no code path reads it (only the getter returns
// it, for off-chain observation). `Wallets.requestNewWallet`
// does NOT inspect it — the originally planned D-1 read-side
// guard, and the unconditional ECDSA-registry IDLE precheck it
// depended on, were both dropped when D-2.2 slice 3 removed the
// scheme-enum dispatch branch. Post-slice-3 the dispatcher
// always targets the FROST registry, so dispatch behavior is
// independent of the flag. The tests below pin exactly that
// invariant: `requestNewWallet` reverts identically whether the
// flag is set or not (FROST-only dispatch, unwired registry).
//
// New ECDSA requests are blocked structurally because the scheme
// branch is gone. The authenticated callback remains deliberately
// ungated so a DKG started before the proxy upgrade can still finish.
describe("Bridge - ECDSA retirement (informational flag + D-2 setter)", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress

  let walletRegistry: FakeContract<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, walletRegistry, bridge, bridgeGovernance } =
      await waffle.loadFixture(bridgeFixture))
  })

  describe("Wallets.requestNewWallet (FROST-only dispatch)", () => {
    before(async () => {
      await createSnapshot()
      walletRegistry.getWalletCreationState.returns(ecdsaDkgState.IDLE)
    })

    after(async () => {
      walletRegistry.getWalletCreationState.reset()
      walletRegistry.requestNewWallet.reset()
      await restoreSnapshot()
    })

    // D-2.2 slice 3 removed the scheme-enum dispatch branch
    // from `Wallets.requestNewWallet`. Pre-slice-3 the
    // function always-reverted on `scheme == Ecdsa` (per
    // PR #444 review). Post-slice-3 the dispatcher always
    // targets the FROST registry; if it's unwired, the
    // call reverts with `FrostWalletRegistryNotSet()`. The
    // `ecdsaRetired` flag is preserved (observable via the
    // public getter) but has no dispatch effect — the
    // tests below pin the new invariant: dispatch behavior
    // is independent of the flag state, because there's no
    // ECDSA branch left to gate.

    context("when ecdsaRetired is false (default)", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        walletRegistry.requestNewWallet.reset()
        await restoreSnapshot()
      })

      it("reverts FrostWalletRegistryNotSet when registry unwired", async () => {
        const selector = ethers.utils
          .id("FrostWalletRegistryNotSet()")
          .slice(0, 10)
        await expect(bridge.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO))
          .to.be.reverted
        expect(walletRegistry.requestNewWallet).to.not.have.been.called
        void selector
      })
    })

    context("when ecdsaRetired is true", () => {
      before(async () => {
        await createSnapshot()
        await bridge.setEcdsaRetiredForTest(true)
      })

      after(async () => {
        walletRegistry.requestNewWallet.reset()
        await restoreSnapshot()
      })

      it("reverts identically (flag has no dispatch effect post-slice-3)", async () => {
        await expect(bridge.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO))
          .to.be.reverted
        expect(walletRegistry.requestNewWallet).to.not.have.been.called
      })
    })
  })

  describe("legacy ECDSA creation callback continuity", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("preserves the production callback selector", async () => {
      expect(
        bridge.interface.getSighash(
          "__ecdsaWalletCreatedCallback(bytes32,bytes32,bytes32)"
        )
      ).to.equal("0xa8fa0f42")
    })

    it("accepts a registry callback after ecdsaRetired is set", async () => {
      await bridgeGovernance.connect(governance).retireEcdsa()

      await bridge
        .connect(walletRegistry.wallet)
        .__ecdsaWalletCreatedCallback(
          ecdsaWalletTestData.walletID,
          ecdsaWalletTestData.publicKeyX,
          ecdsaWalletTestData.publicKeyY
        )

      expect(await bridge.ecdsaRetired()).to.equal(true)
      expect(
        (await bridge.wallets(ecdsaWalletTestData.pubKeyHash160)).state
      ).to.equal(1)
    })
  })

  describe("retireEcdsa (D-2 canonical setter)", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by governance", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await bridgeGovernance.connect(governance).retireEcdsa()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("flips the on-chain flag (asserted via public getter)", async () => {
        // D-2.2 added the public ecdsaRetired() getter on
        // Bridge (replaces the indirect "flag flipped via
        // behavior" assertion D-2.1 had to use because no
        // getter existed). Also note D-2.2 dropped the
        // `emit EcdsaRetired()` from `retireEcdsa()` for
        // EIP-170 budget reasons — see `Bridge.sol` rationale
        // block — so an event-based assertion would fail
        // here. The getter is the canonical observation
        // path post-D-2.2.
        expect(await bridge.ecdsaRetired()).to.equal(true)
      })

      it("is idempotent on re-call", async () => {
        // Second call writes the same value (warm SSTORE
        // no-op). The flag stays true; no event is emitted
        // post-D-2.2 (see rationale above).
        await bridgeGovernance.connect(governance).retireEcdsa()
        expect(await bridge.ecdsaRetired()).to.equal(true)
      })
    })

    context("when called by a non-governance address", () => {
      it("reverts via BridgeGovernance.onlyOwner", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).retireEcdsa()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("reverts via Bridge.onlyGovernance when called directly", async () => {
        await expect(
          bridge.connect(thirdParty).retireEcdsa()
        ).to.be.revertedWith("Caller is not the governance")
      })
    })
  })
})
