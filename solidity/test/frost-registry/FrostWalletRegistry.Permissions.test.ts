/* eslint-disable no-underscore-dangle */
import { deployments, ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import bridgeFixture from "../fixtures/bridge"
import type { Bridge, BridgeGovernance, BridgeStub } from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

/// FROST WalletRegistry permission tests (B-1.5 final-slice subset).
///
/// Verifies the RFC v4.1 §"Bridge integration: out of scope for
/// B-1" invariant: the FrostWalletRegistry's `requestNewWallet()`
/// entry point is unreachable from anyone except the wired
/// wallet owner (Bridge). Combined with C-2's scheme-preference
/// state still defaulting to `Ecdsa`, this locks down the
/// "B-1 deployed-but-dead until C-2 flips" property.
///
/// Why this subset, not the full DKG state-machine integration:
/// the full happy-path test (request → seed → submit → approve →
/// callback) requires ~100 operators registered with stake in
/// the FrostSortitionPool, a fake random beacon driving seed
/// delivery, and operator-key generation for the 51-of-100
/// signature collection. That's a hundreds-of-LOC test fixture
/// build-out that's mostly testing inherited upstream
/// `WalletRegistry` behaviour (the state machine, beacon
/// integration, and challenge harness are all copied 1:1 from
/// the keep-network ECDSA registry; only the result struct
/// shape, digest format, and Bridge callback differ — all
/// covered by the harness-level digest binding suite).
///
/// The deferred integration slice is documented in
/// `docs/rfc/frost-migration/b1-implementation-plan.md`.

// Helper: assert a transaction reverts with a specific no-arg
// custom error by manually decoding the 4-byte selector. Mirrors
// the helper in `Bridge.FrostWalletRegistration.test.ts`.
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

describe("FrostWalletRegistry permissions (B-1.5 final-slice subset)", () => {
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let frostWalletRegistry: any
  let frostSortitionPool: any

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, governance, thirdParty, bridge, bridgeGovernance } =
      await waffle.loadFixture(bridgeFixture))

    // Use the FROST chain deployed by the production deploy scripts
    // (46_deploy_frost_sortition_pool, 47_deploy_frost_dkg_validator,
    // 48_deploy_frost_wallet_registry) — bridgeFixture now runs
    // `deployments.fixture()` with no tags, so the FROST chain is
    // already deployed + wired to Bridge by the time we get here.
    //
    // The umbrella's earlier bridgeFixture used a restricted tag list
    // that excluded FROST, which forced this test's `before` to deploy
    // the chain inline + wire it via `setFrostWalletRegistry`. Now that
    // step would conflict with the production deploy (OZ upgrades-core
    // rejects the proxy redeploy with `FrostWalletRegistry was already
    // deployed at <addr>`). Grabbing the existing deployments instead
    // keeps the test's intent intact while matching the new fixture
    // behavior.
    const frostWalletRegistryDeployment = await deployments.get(
      "FrostWalletRegistry"
    )
    frostWalletRegistry = await ethers.getContractAt(
      "FrostWalletRegistry",
      frostWalletRegistryDeployment.address
    )

    const frostSortitionPoolDeployment = await deployments.get(
      "FrostSortitionPool"
    )
    frostSortitionPool = await ethers.getContractAt(
      "@keep-network/sortition-pools/contracts/SortitionPool.sol:SortitionPool",
      frostSortitionPoolDeployment.address
    )
  })

  describe("requestNewWallet (permission gating)", () => {
    it("walletOwner is set to Bridge at initialize() time", async () => {
      // Post-Codex-P1-fix: the registry's initialize(...) now
      // sets `walletOwner = bridge` automatically. Without this,
      // the registry would be deployed-but-dead even after
      // `setFrostWalletRegistry` wired it to Bridge — every
      // entry would revert with `Caller is not the Wallet Owner`
      // because walletOwner stayed bytes32(0).
      expect(await frostWalletRegistry.walletOwner()).to.equal(bridge.address)
    })

    it("reverts when called by an unprivileged third party", async () => {
      // Only Bridge is wired as the wallet owner. Third party
      // cannot reach requestNewWallet on the registry directly.
      await expect(
        frostWalletRegistry.connect(thirdParty).requestNewWallet()
      ).to.be.revertedWith("Caller is not the Wallet Owner")
    })

    it("reverts when called by the deployer (not the wallet owner)", async () => {
      await expect(
        frostWalletRegistry.connect(deployer).requestNewWallet()
      ).to.be.revertedWith("Caller is not the Wallet Owner")
    })

    it("reverts when called by the governance signer", async () => {
      // Governance owns BridgeGovernance, but BridgeGovernance is
      // not the FROST registry's wallet owner — it's just the
      // forwarder used to call setFrostWalletRegistry on Bridge.
      // Governance MUST NOT have direct access to requestNewWallet
      // on the registry.
      await expect(
        frostWalletRegistry.connect(governance).requestNewWallet()
      ).to.be.revertedWith("Caller is not the Wallet Owner")
    })
  })

  describe("lifecycle authority is separate from walletOwner (Codex P1)", () => {
    // The lifecycle-vs-creation split is intentional. Bridge
    // routes FROST lifecycle calls (closeWallet, seize)
    // through `BridgeLifecycleRouter`, so the caller-of-record
    // on the registry is the router address — not Bridge's.
    // A single `walletOwner` address can't satisfy both call
    // patterns, so the registry exposes a separate
    // `lifecycleOwner` slot + modifier.
    //
    // The canonical deploy chain wires `lifecycleOwner = Bridge`
    // (deploy/48_deploy_frost_wallet_registry.ts) so the registry
    // is usable end-to-end immediately after deploy. These tests
    // exercise the "lifecycleOwner unset" gate semantics, so we
    // temporarily un-wire it for the duration of this describe
    // block and restore it after.
    before(async () => {
      await createSnapshot()
      await frostWalletRegistry
        .connect(deployer)
        .updateLifecycleOwner(ethers.constants.AddressZero)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("lifecycleOwner is unset before governance wires it", async () => {
      // Lifecycle ownership is wired by governance AFTER the
      // BridgeLifecycleRouter ships in a follow-up PR. Until
      // then, close/seize revert with the lifecycle-owner
      // error. Safe because no FROST wallets exist
      // immediately after deploy.
      expect(await frostWalletRegistry.lifecycleOwner()).to.equal(
        ethers.constants.AddressZero
      )
    })

    it("closeWallet reverts with 'Caller is not the Lifecycle Owner' when called by Bridge", async () => {
      // Bridge is the walletOwner but NOT the lifecycleOwner.
      // Pre-fix, walletOwner=Bridge would have allowed this
      // call; post-fix, the lifecycle modifier rejects it.
      // Impersonate Bridge + fund the impersonated signer so
      // it can pay gas.
      await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])
      const bridgeSigner = await ethers.getSigner(bridge.address)
      await ethers.provider.send("hardhat_setBalance", [
        bridge.address,
        "0x56BC75E2D63100000", // 100 ETH
      ])
      const walletID = ethers.utils.hexZeroPad("0x1234", 32)
      await expect(
        frostWalletRegistry.connect(bridgeSigner).closeWallet(walletID)
      ).to.be.revertedWith("Caller is not the Lifecycle Owner")
    })

    it("seize reverts with 'Caller is not the Lifecycle Owner' when called by Bridge", async () => {
      await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])
      const bridgeSigner = await ethers.getSigner(bridge.address)
      // Funding may have happened in the previous test (same
      // before-all scope); top up defensively.
      await ethers.provider.send("hardhat_setBalance", [
        bridge.address,
        "0x56BC75E2D63100000", // 100 ETH
      ])
      const walletID = ethers.utils.hexZeroPad("0x1234", 32)
      await expect(
        frostWalletRegistry
          .connect(bridgeSigner)
          .seize(
            ethers.utils.parseEther("100"),
            50,
            thirdParty.address,
            walletID,
            []
          )
      ).to.be.revertedWith("Caller is not the Lifecycle Owner")
    })

    it("requestNewWallet reverts with LifecycleOwnerNotSet before updateLifecycleOwner is called (Codex P2 guard)", async () => {
      // Even Bridge — the legitimate walletOwner — cannot
      // request a new FROST wallet until governance has wired
      // lifecycleOwner. This prevents a DKG from completing +
      // registering a wallet that the registry then refuses
      // to close/seize.
      await ethers.provider.send("hardhat_setBalance", [
        bridge.address,
        "0x56BC75E2D63100000",
      ])
      await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])
      const bridgeSigner = await ethers.getSigner(bridge.address)
      // At this point in the suite, prior tests may have
      // configured lifecycleOwner. Reset it to zero for this
      // assertion (registry governance is `deployer` per init).
      await frostWalletRegistry
        .connect(deployer)
        .updateLifecycleOwner(ethers.constants.AddressZero)

      await expectCustomError(
        frostWalletRegistry.connect(bridgeSigner).requestNewWallet(),
        "LifecycleOwnerNotSet"
      )
    })

    it("closeWallet succeeds (past the modifier check) when called by the configured lifecycleOwner", async () => {
      // Configure a test lifecycle owner via governance. The
      // registry's governance is `deployer` (set at init via
      // `_transferGovernance(msg.sender)`); thirdParty is
      // the simulated lifecycle router for this test.
      await frostWalletRegistry
        .connect(deployer)
        .updateLifecycleOwner(thirdParty.address)
      expect(await frostWalletRegistry.lifecycleOwner()).to.equal(
        thirdParty.address
      )

      // closeWallet now passes the modifier; it then reverts
      // on `Wallet with the given ID has not been registered`
      // because we never created one. That's fine — the test's
      // job is to verify the modifier check, not the wallet
      // lookup.
      const walletID = ethers.utils.hexZeroPad("0x1234", 32)
      await expectCustomError(
        frostWalletRegistry.connect(thirdParty).closeWallet(walletID),
        "WalletNotRegistered"
      )
    })
  })

  describe("Bridge wiring (RFC v4.1 §'Goals' #7)", () => {
    it("Bridge accepts the FROST registry address via setFrostWalletRegistry", async () => {
      // The fixture's before() block already performed the wire.
      // Re-calling must revert with FrostWalletRegistryAlreadySet
      // (the BridgeState one-time-setter pattern).
      const errSel = ethers.utils
        .id("FrostWalletRegistryAlreadySet()")
        .slice(0, 10)
      try {
        await bridgeGovernance
          .connect(governance)
          .setFrostWalletRegistry(frostWalletRegistry.address)
        throw new Error("expected re-wire to revert")
      } catch (err) {
        const errAny = err as {
          data?: string
          message?: string
          error?: { data?: string }
        }
        const revertData =
          errAny.data || errAny.error?.data || errAny.message || ""
        expect(
          typeof revertData === "string" &&
            (revertData.toLowerCase().includes(errSel.toLowerCase()) ||
              revertData.includes("FrostWalletRegistryAlreadySet"))
        ).to.equal(
          true,
          `expected FrostWalletRegistryAlreadySet revert, got: ${
            errAny.message || err
          }`
        )
      }
    })
  })
})
