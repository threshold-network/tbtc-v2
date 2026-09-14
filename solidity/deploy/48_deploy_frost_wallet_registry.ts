import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import {
  abortLiveBridgeUpgradeWithoutVettedCompleteV2,
  isEphemeralLocalNetwork,
} from "./45_deploy_p2tr_signature_fraud_router"

// Returns a signer for `address` only when that account is configured for the
// current network. Used to decide whether a governance-gated call can be sent by
// this deployment, or must instead be emitted as calldata for manual governance
// execution (the governance owner -- e.g. a Safe -- is not a deployer-controlled
// signer in production). Mirrors 49_deploy_bridge_lifecycle_router.
async function getConfiguredSigner(
  hre: HardhatRuntimeEnvironment,
  address: string
) {
  const configuredAccounts = (await hre.ethers.provider.listAccounts()).map(
    (account) => account.toLowerCase()
  )

  if (!configuredAccounts.includes(address.toLowerCase())) {
    return undefined
  }

  return hre.ethers.getSigner(address)
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { getNamedAccounts, deployments, ethers, helpers } = hre
  const { deployer } = await getNamedAccounts()

  if (!isEphemeralLocalNetwork(hre.network.name)) {
    await abortLiveBridgeUpgradeWithoutVettedCompleteV2(
      hre,
      "48_deploy_frost_wallet_registry"
    )
  }

  const FrostSortitionPool = await deployments.get("FrostSortitionPool")
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
        // Initial authorization source is zero — the registry is
        // deployed before the FrostAllowlist contract exists in the
        // shipped deploy order; deploy script 51 wires the source via
        // `updateAuthorizationSource` immediately after the allowlist
        // is deployed. Passing a non-zero address here atomically binds
        // the source at initialize() time for deploy orders that DO
        // have the allowlist available first.
        ethers.constants.AddressZero,
      ],
      factoryOpts: {
        signer: await ethers.getSigner(deployer),
        libraries: {
          FrostInactivity: FrostInactivity.address,
        },
      },
      proxyOpts: {
        constructorArgs: [FrostSortitionPool.address],
        unsafeAllow: ["external-library-linking"],
        kind: "transparent",
      },
    })

  // Fresh proxies atomically enter the distinct Fresh archive state inside
  // initialize. Existing proxies can only enter Pending through deploy 54's
  // ProxyAdmin upgradeAndCall initializer.
  const freshArchive = await frostWalletRegistry.getWalletArchiveMigration()
  const freshArchiveManifestHash =
    await frostWalletRegistry.getWalletArchiveMigrationManifestHash()
  if (
    freshArchive.state !== 4 ||
    freshArchiveManifestHash === ethers.constants.HashZero ||
    (await frostWalletRegistry.registered(ethers.constants.HashZero)) ||
    (await frostWalletRegistry.registered(freshArchiveManifestHash))
  ) {
    throw new Error("fresh FrostWalletRegistry archive initialization failed")
  }

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
  // through to Bridge.setFrostWalletRegistry. On dev/test, where
  // governance is still the deployer, this script sends the wiring
  // directly; once governance has been handed off it sends from the
  // BridgeGovernance owner when that owner is a configured signer, or
  // emits the calldata for manual governance execution otherwise.
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

  // Idempotency pre-check. setFrostWalletRegistry is a one-shot setter, so a
  // re-run must skip cleanly on EVERY governance configuration -- including a
  // multisig owner that is not a configured signer, where the AlreadySet revert
  // path is never reached because the wiring is emitted as calldata, not sent.
  // frostLifecycleContext returns the global frostWalletRegistry as its first
  // value regardless of the wallet argument.
  //
  // When preparing the atomic upgrade of an EXISTING Bridge, the proxy is still
  // on the pre-upgrade implementation, which has no `frostLifecycleContext`
  // selector until the governance proposal executes -- so this read reverts
  // with a CALL_EXCEPTION (no return data to decode). A plain view getter
  // cannot revert for any other reason, so tolerate ONLY that case: treat the
  // registry as unwired and fall through to emit the setter calldata the
  // operator needs for the upgrade/wiring proposal, rather than aborting before
  // that branch is reached. Any other error (e.g. an RPC failure) rethrows so
  // it is not silently swallowed (the same non-blanket-catch discipline this
  // file's setter path already follows).
  const { registry: currentFrostWalletRegistry, bridgeExposesGetter } =
    await (async (): Promise<{
      registry: string
      bridgeExposesGetter: boolean
    }> => {
      try {
        const [registry] = await bridgeContract.frostLifecycleContext(
          ethers.constants.AddressZero
        )
        return { registry, bridgeExposesGetter: true }
      } catch (err) {
        if ((err as { code?: string }).code !== "CALL_EXCEPTION") {
          throw err
        }
        console.log(
          "Bridge.frostLifecycleContext() reverted (no such selector on the " +
            "current Bridge implementation -- pre-upgrade proxy); treating the " +
            "registry as unwired and emitting wiring for the upgrade proposal"
        )
        return {
          registry: ethers.constants.AddressZero,
          bridgeExposesGetter: false,
        }
      }
    })()

  if (
    currentFrostWalletRegistry.toLowerCase() ===
    frostWalletRegistry.address.toLowerCase()
  ) {
    console.log(
      `FrostWalletRegistry already wired on this Bridge at ${frostWalletRegistry.address}; skipping`
    )
  } else if (currentFrostWalletRegistry !== ethers.constants.AddressZero) {
    throw new Error(
      "Bridge is already wired to a different FrostWalletRegistry " +
        `(${currentFrostWalletRegistry}); refusing to wire ` +
        `${frostWalletRegistry.address}`
    )
  } else {
    // Resolve the authorized caller. In the governance-wrapper case the setter
    // is `BridgeGovernance.onlyOwner`, so the call must come from the wrapper
    // owner -- which post-handoff is the governance multisig, not `deployer`.
    // When that owner is not a configured signer, emit the calldata for manual
    // governance execution and skip (mainnet) rather than sending from
    // `deployer` and reverting.
    const registrySetterContract = governanceIsDeployer
      ? bridgeContract
      : bridgeGovernance
    const registrySetterCaller = governanceIsDeployer
      ? deployer
      : await bridgeGovernance.owner()
    // A pre-upgrade Bridge has no `setFrostWalletRegistry` selector yet, so the
    // transaction cannot be sent regardless of who is a configured signer.
    // Force the calldata-emission path in that case (leave the signer
    // unresolved) rather than attempting -- and reverting -- the send.
    const registrySetterSigner = bridgeExposesGetter
      ? await getConfiguredSigner(hre, registrySetterCaller)
      : undefined

    if (!registrySetterSigner) {
      const calldata = registrySetterContract.interface.encodeFunctionData(
        "setFrostWalletRegistry",
        [frostWalletRegistry.address]
      )
      const reason = !bridgeExposesGetter
        ? `the Bridge at ${bridgeContract.address} does not yet expose ` +
          "setFrostWalletRegistry (pre-upgrade implementation); wire it as " +
          "part of the upgrade proposal"
        : `${registrySetterCaller} is not a configured signer for network ${hre.network.name}`
      const message =
        `FrostWalletRegistry wiring must be executed by governance -- ${reason}. ` +
        "Submit this call from governance:\n" +
        `  target: ${registrySetterContract.address}\n` +
        `  data:   ${calldata}`

      // A pre-upgrade Bridge genuinely cannot be wired now on ANY network, so
      // emit the calldata and continue. Otherwise keep the existing guard:
      // skip on mainnet (a non-signer governance owner is expected there) and
      // error elsewhere so an unexpected non-signer is surfaced.
      if (!bridgeExposesGetter || hre.network.name === "mainnet") {
        console.log(`${message}\nskipping for manual governance execution`)
      } else {
        throw new Error(message)
      }
    } else {
      try {
        const tx = await registrySetterContract
          .connect(registrySetterSigner)
          .setFrostWalletRegistry(frostWalletRegistry.address)
        await tx.wait(1)
        console.log(
          `wired FrostWalletRegistry at ${
            frostWalletRegistry.address
          } onto Bridge ${
            governanceIsDeployer
              ? "directly (governance is still deployer)"
              : "via BridgeGovernance"
          }`
        )
      } catch (err) {
        // Tolerate only a concurrent deployment that wired the SAME registry
        // between the pre-check read above and this call (AlreadySet revert).
        const errAny = err as {
          data?: string
          error?: { data?: string }
          message?: string
        }
        const revertData =
          errAny.data || errAny.error?.data || errAny.message || ""
        if (
          typeof revertData === "string" &&
          revertData.toLowerCase().includes(ALREADY_SET_SELECTOR.toLowerCase())
        ) {
          console.log(
            "FrostWalletRegistry already wired on this Bridge; skipping"
          )
        } else {
          console.error(
            "setFrostWalletRegistry call reverted with an unexpected error;",
            "deploy aborted so the operator can investigate:",
            errAny.message || err
          )
          throw err
        }
      }

      // Idempotent post-check: re-read the on-chain registry and assert it now
      // reflects THIS deployment's registry. Only reached in the send path (the
      // calldata-emit path skips earlier). This also closes the AlreadySet
      // race: if a concurrent deployment or governance action wired a DIFFERENT
      // FrostWalletRegistry between the pre-check and this send, the AlreadySet
      // catch above would otherwise let this deploy continue wiring/authorizing
      // its own registry while the Bridge actually points at another one.
      const [wiredRegistry] = await bridgeContract.frostLifecycleContext(
        ethers.constants.AddressZero
      )
      if (
        wiredRegistry.toLowerCase() !==
        frostWalletRegistry.address.toLowerCase()
      ) {
        throw new Error(
          "Bridge FrostWalletRegistry mismatch after deploy: " +
            `expected ${frostWalletRegistry.address}, got ${wiredRegistry}`
        )
      }
    }
  }

  // Do NOT wire the FrostWalletRegistry's lifecycleOwner here. The only
  // valid production value is the same BridgeLifecycleRouter address set
  // on Bridge via `setLifecycleRouter`, and that router is delivered by a
  // follow-up deployment. Setting `lifecycleOwner = Bridge.address` here
  // would allow FROST wallets to be registered but later orphan their
  // close/seize/isWalletMember lifecycle calls, because the Bridge routes
  // those calls through the router while the registry authorizes only
  // `lifecycleOwner`.
  //
  // Bridge.requestNewWallet and Bridge.__frostWalletCreatedCallback both
  // fail closed unless `Bridge.lifecycleRouter() ==
  // FrostWalletRegistry.lifecycleOwner()`, so leaving this unset is the
  // safe dormant state until the router deployment wires both sides.
  const frostWalletRegistryContract = await ethers.getContractAt(
    "FrostWalletRegistry",
    frostWalletRegistry.address
  )
  const currentLifecycleOwner =
    await frostWalletRegistryContract.lifecycleOwner()
  if (currentLifecycleOwner === ethers.constants.AddressZero) {
    console.log(
      "FrostWalletRegistry.lifecycleOwner left unset; BridgeLifecycleRouter deployment must wire it before FROST wallet creation"
    )
  } else {
    console.log(
      `FrostWalletRegistry.lifecycleOwner already set to ${currentLifecycleOwner}; leaving unchanged`
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
  "FrostCustodyNoGo",
  "Bridge",
  "BridgeGovernance",
  "FrostSortitionPool",
  "FrostDkgValidator",
  "ReimbursementPool",
  "RandomBeacon",
]
