import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { getNamedAccounts, deployments, ethers, helpers } = hre
  const { deployer } = await getNamedAccounts()

  const FrostSortitionPool = await deployments.get("FrostSortitionPool")
  const TokenStaking = await deployments.get("TokenStaking")
  const ReimbursementPool = await deployments.get("ReimbursementPool")
  const RandomBeacon = await deployments.get("RandomBeacon")
  const FrostDkgValidator = await deployments.get("FrostDkgValidator")
  const Bridge = await deployments.get("Bridge")

  // Only FrostInactivity needs separate deployment + linking
  // (it has `external` functions, the linkable subset). The
  // other libraries (FrostAuthorization, FrostDkg,
  // FrostRegistryWallets) are internal-only and get inlined by
  // the compiler. If a future change exposes `external` surface
  // on any of them, deploy them here and add to
  // `factoryOpts.libraries`.
  const FrostInactivity = await deployments.deploy("FrostInactivity", {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  })

  const [frostWalletRegistry, proxyDeployment] =
    await helpers.upgrades.deployProxy("FrostWalletRegistry", {
      contractName: "FrostWalletRegistry",
      initializerArgs: [
        FrostDkgValidator.address,
        RandomBeacon.address,
        ReimbursementPool.address,
        Bridge.address,
      ],
      factoryOpts: {
        signer: await ethers.getSigner(deployer),
        libraries: {
          FrostInactivity: FrostInactivity.address,
        },
      },
      proxyOpts: {
        constructorArgs: [FrostSortitionPool.address, TokenStaking.address],
        unsafeAllow: ["external-library-linking"],
        kind: "transparent",
      },
    })

  // Transfer FrostSortitionPool ownership to the registry so the
  // registry can lock/unlock + selectGroup. Mirrors the upstream
  // ECDSA registry's deploy pattern.
  await helpers.ownable.transferOwnership(
    "FrostSortitionPool",
    frostWalletRegistry.address,
    deployer
  )

  // Wire the registry to Bridge via the one-time governance
  // setter (`setFrostWalletRegistry`). The setter was added in
  // PR #431; until this call lands, `Bridge.__frostWalletCreatedCallback`
  // reverts with `FrostWalletRegistryNotSet`. The setter cannot be
  // re-called, so this is a one-shot wiring at deploy time.
  //
  // Bridge governance lives on BridgeGovernance which forwards
  // through to Bridge.setFrostWalletRegistry. Production deploys
  // call BridgeGovernance from the governance multisig; this
  // script wires directly via the helper for dev/test flows. A
  // separate later deploy script will repeat the call on
  // production networks under the governance multisig.
  //
  // NOTE: B-1 ships the registry deployed-but-dead from Bridge's
  // perspective: until C-2 governance flips
  // `currentNewWalletScheme` to FROST, the registry's
  // `requestNewWallet()` is unreachable through Bridge. The
  // setFrostWalletRegistry call below establishes the address;
  // the scheme-flip is governance's separate decision per the
  // cutover playbook documented in
  // `docs/frost-migration/wallet-lifecycle-migration-plan.md`.
  const bridgeContract = await ethers.getContractAt("Bridge", Bridge.address)
  const bridgeGovernance = await ethers.getContractAt(
    "BridgeGovernance",
    (
      await deployments.get("BridgeGovernance")
    ).address
  )

  // Wire the registry idempotently. The setter is one-time per
  // RFC and PR #431, so re-running this deploy must NOT fail when
  // the same address has already been wired. Distinguish the
  // benign "already wired" case from operational failures
  // (ownership mismatch, network error, etc.) by selector — only
  // swallow the specific `FrostWalletRegistryAlreadySet()` custom
  // error. Anything else rethrows so an operator can investigate
  // (Codex P2 review on PR #441: a blanket catch hid the
  // production-governance-ownership-mismatch case, which would
  // have left Bridge silently unwired).
  //
  // Route the call based on current Bridge.governance: the
  // governance handoff to BridgeGovernance lives in
  // `21_transfer_bridge_governance.ts` which has
  // `runAtTheEnd = true`, so on a fresh deploy chain (test/local)
  // this script runs while `Bridge.governance` is still the
  // `deployer` named account. In that window, the only address
  // that can pass `Bridge.onlyGovernance` is `deployer` itself —
  // going through `BridgeGovernance` would have
  // `msg.sender == bridgeGovernance.address`, which fails the
  // governance check and reverts with
  // "Caller is not the governance". On a network where governance
  // has already been transferred, `Bridge.governance` is the
  // `BridgeGovernance` contract, and we route through the
  // governance wrapper (deployer must be the `BridgeGovernance`
  // owner; production deploys substitute the governance multisig
  // signer here).
  const currentBridgeGovernance = await bridgeContract.governance()
  const governanceIsDeployer =
    currentBridgeGovernance.toLowerCase() === deployer.toLowerCase()
  const ALREADY_SET_SELECTOR = ethers.utils
    .id("FrostWalletRegistryAlreadySet()")
    .slice(0, 10)
  try {
    if (governanceIsDeployer) {
      await bridgeContract
        .connect(await ethers.getSigner(deployer))
        .setFrostWalletRegistry(frostWalletRegistry.address)
      console.log(
        `wired FrostWalletRegistry at ${frostWalletRegistry.address} onto Bridge directly (governance is still deployer)`
      )
    } else {
      await bridgeGovernance
        .connect(await ethers.getSigner(deployer))
        .setFrostWalletRegistry(frostWalletRegistry.address)
      console.log(
        `wired FrostWalletRegistry at ${frostWalletRegistry.address} onto Bridge via BridgeGovernance`
      )
    }
  } catch (err) {
    const errAny = err as {
      data?: string
      error?: { data?: string }
      message?: string
    }
    const revertData = errAny.data || errAny.error?.data || errAny.message || ""
    if (
      typeof revertData === "string" &&
      revertData.toLowerCase().includes(ALREADY_SET_SELECTOR.toLowerCase())
    ) {
      console.log("FrostWalletRegistry already wired on this Bridge; skipping")
    } else {
      console.error(
        "setFrostWalletRegistry call reverted with an unexpected error;",
        "deploy aborted so the operator can investigate:",
        errAny.message || err
      )
      throw err
    }
  }

  // Wire the FrostWalletRegistry's lifecycleOwner. Until this is set,
  // FrostWalletRegistry.requestNewWallet reverts with `LifecycleOwnerNotSet`
  // (FrostWalletRegistry.sol:803-805) — the registry refuses to lock DKG
  // unless a lifecycle owner is registered, per RFC v4's "no orphaned
  // wallets" guarantee. Production wires `lifecycleOwner` to a dedicated
  // `BridgeLifecycleRouter`, but that contract is not deployed in this
  // canonical mirror. Bridge itself is the natural lifecycle owner — it
  // has the close/seize call sites and is governance-controlled — so we
  // wire `lifecycleOwner = Bridge.address` here. A future PR that
  // introduces BridgeLifecycleRouter can rewire via
  // `FrostWalletRegistry.updateLifecycleOwner(router)` (governance-only,
  // not one-time, so re-binding is supported).
  //
  // Idempotent like setFrostWalletRegistry above: skip if already set to
  // the desired value, otherwise log and update.
  const frostWalletRegistryContract = await ethers.getContractAt(
    "FrostWalletRegistry",
    frostWalletRegistry.address
  )
  const currentLifecycleOwner =
    await frostWalletRegistryContract.lifecycleOwner()
  if (currentLifecycleOwner.toLowerCase() !== Bridge.address.toLowerCase()) {
    await frostWalletRegistryContract
      .connect(await ethers.getSigner(deployer))
      .updateLifecycleOwner(Bridge.address)
    console.log(
      `wired FrostWalletRegistry.lifecycleOwner = ${Bridge.address} (Bridge)`
    )
  } else {
    console.log(
      `FrostWalletRegistry.lifecycleOwner already = Bridge (${Bridge.address}); skipping`
    )
  }

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(FrostInactivity)

    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "FrostWalletRegistry",
      address: frostWalletRegistry.address,
    })
  }
}

export default func

func.tags = ["FrostWalletRegistry"]
func.dependencies = [
  "Bridge",
  "BridgeGovernance",
  "FrostSortitionPool",
  "FrostDkgValidator",
  "ReimbursementPool",
  "RandomBeacon",
  "TokenStaking",
]
