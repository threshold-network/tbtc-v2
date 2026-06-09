import * as fs from "fs"
import * as path from "path"

import type { Artifact, HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { Contract, ContractFactory, providers } from "ethers"

// The implementation compiled for the swap. NativeBTCDepositor inherits the
// patched AbstractL1BTCDepositor base, so its bytecode carries the best-effort
// fee-reimbursement behavior. No constructor arguments are taken beyond the
// disabled initializer, which is why verification uses an empty argument list.
const CONTRACT_NAME = "NativeBTCDepositor"

// Flip to `true` once the best-effort-reimbursement upgrade has been broadcast
// on mainnet. Combined with the mainnet-only network guard below, this prevents
// a second mainnet run from deploying a fresh (and unused) implementation and
// overwriting the deployment artifact with an address that no longer matches
// the on-chain implementation.
const ALREADY_EXECUTED = false

// The Native transparent proxy under upgrade (unchanged across the swap). The
// Native rail has no committed deployment artifact and the proxy is absent from
// the OpenZeppelin upgrades manifest, so the address is supplied literally here
// instead of being resolved through `deployments.get`.
const NATIVE_PROXY = "0xad7c6d46F4a4bc2D3A227067d03218d6D7c9aaa5"

// The real on-chain ProxyAdmin that administers the Native proxy (read from the
// proxy's EIP-1967 admin slot). The OpenZeppelin upgrades plugin resolves a
// DIFFERENT, manifest-wide default ProxyAdmin for this rail via
// `upgrades.admin.getInstance()`; addressing that default would emit upgrade
// calldata whose `to:` the Council Safe could not execute. The ProxyAdmin is
// therefore resolved explicitly to this on-chain address.
const NATIVE_PROXY_ADMIN = "0x92FcBD0b9D22bd2659c09A9aCD6E645F228b9A21"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments, upgrades, artifacts, run } = hre

  // Patch ethers.js v5 Formatter to handle an empty-string `to` field returned
  // by some RPC providers for contract-creation transactions. Without this
  // patch, `prepareUpgrade` fails with "invalid address" after the
  // implementation has already been deployed on-chain. Same pattern used in the
  // cross-chain Wormhole upgrade scripts and the TIP-109 hotfix deployment.
  const originalFormat = providers.Formatter.prototype.transactionResponse
  providers.Formatter.prototype.transactionResponse = function (tx: any): any {
    const patched = tx.to === "" ? { ...tx, to: null } : tx
    return originalFormat.call(this, patched)
  }

  const { deployer } = await helpers.signers.getNamedSigners()

  const implementationContractFactory: ContractFactory =
    await ethers.getContractFactory(CONTRACT_NAME, {
      signer: deployer,
    })

  // The Native proxy is absent from the OpenZeppelin manifest, so its current
  // implementation's storage layout must be registered via `forceImport` before
  // `prepareUpgrade` can diff the new layout against a baseline. A bare
  // `prepareUpgrade` would fail the manifest storage-layout lookup. This ordering
  // (forceImport BEFORE prepareUpgrade) is mandatory.
  //
  // forceImport registers the CURRENT implementation under the bytecode version
  // of the supplied factory. Because #968 is a logic-only change, that version
  // equals the one `prepareUpgrade` would deploy under — so a bare
  // forceImport+prepareUpgrade SHORT-CIRCUITS to the already-registered current
  // implementation and emits a NO-OP `upgrade(proxy, currentImpl)` while never
  // deploying the #968 bytecode. To prevent that, the entries forceImport
  // injects are re-keyed off the version slot afterwards: the upgrade-safety
  // baseline is resolved by address scan (so it still finds the re-keyed entry),
  // while the version slot is freed so `prepareUpgrade` deploys the new
  // implementation. Mirrors the workaround proven in
  // test/depositor/UpgradeNativeBTCDepositorTo968.test.ts.
  const manifestPath = path.join(
    hre.config.paths.root,
    ".openzeppelin",
    "mainnet.json"
  )
  const implKeysBeforeImport = new Set<string>(
    fs.existsSync(manifestPath)
      ? Object.keys(
          JSON.parse(fs.readFileSync(manifestPath, "utf8")).impls ?? {}
        )
      : []
  )

  await upgrades.forceImport(NATIVE_PROXY, implementationContractFactory, {
    kind: "transparent",
  })

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  Object.keys(manifest.impls ?? {})
    .filter((version) => !implKeysBeforeImport.has(version))
    .forEach((version) => {
      manifest.impls[`imported-baseline-${version}`] = manifest.impls[version]
      delete manifest.impls[version]
    })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  // Deploy the new implementation contract (no broadcast of any upgrade — only
  // the implementation is deployed here).
  const newImplementationAddress: string = (await upgrades.prepareUpgrade(
    NATIVE_PROXY,
    implementationContractFactory,
    {
      kind: "transparent",
    }
  )) as string

  // Self-protecting guard: refuse to emit a no-op. If the version-slot re-keying
  // above ever fails to clear the collision, `prepareUpgrade` returns the
  // current on-chain implementation and governance would execute
  // `upgrade(proxy, currentImpl)` — a no-op — believing #968 shipped. Read the
  // live implementation from the proxy's EIP-1967 slot and fail loudly if the
  // deploy did not advance it.
  const EIP1967_IMPLEMENTATION_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
  const currentImplementationRaw: string = await ethers.provider.getStorageAt(
    NATIVE_PROXY,
    EIP1967_IMPLEMENTATION_SLOT
  )
  const currentImplementation: string = ethers.utils.getAddress(
    ethers.utils.hexDataSlice(currentImplementationRaw, 12)
  )
  if (
    ethers.utils.getAddress(newImplementationAddress) === currentImplementation
  ) {
    throw new Error(
      "Refusing to emit a no-op upgrade: prepareUpgrade returned the current " +
        `implementation ${currentImplementation}. The forceImport version-slot ` +
        "collision was not cleared — #968 bytecode was not deployed."
    )
  }

  deployments.log(
    `new implementation contract deployed at: ${newImplementationAddress}`
  )

  // Resolve the ProxyAdmin EXPLICITLY from the known on-chain admin address.
  // `upgrades.admin.getInstance()` is intentionally NOT used: for the Native
  // rail it returns the plugin's manifest-wide default ProxyAdmin rather than
  // the proxy's real administrator, which would target the emitted calldata at
  // the wrong contract.
  const proxyAdmin: Contract = await ethers.getContractAt(
    "ProxyAdmin",
    NATIVE_PROXY_ADMIN
  )
  const proxyAdminOwner: string = await proxyAdmin.owner()

  // Assemble the proxy upgrade transaction. The selector is the OpenZeppelin
  // `upgrade(address,address)` — NOT `upgradeAndCall` — because the upgrade
  // requires no re-initialization; `upgradeAndCall` would force a delegatecall
  // even with empty data.
  const upgradeTxData: string = proxyAdmin.interface.encodeFunctionData(
    "upgrade",
    [NATIVE_PROXY, newImplementationAddress]
  )

  // Emit the governance calldata; never broadcast the upgrade. The Council Safe
  // (ProxyAdmin.owner()) executes this transaction out-of-band against the
  // ProxyAdmin contract.
  deployments.log(
    `proxy admin owner ${proxyAdminOwner} is required to upgrade proxy implementation with transaction:\n` +
      `\t\tfrom: ${proxyAdminOwner}\n` +
      `\t\tto: ${proxyAdmin.address}\n` +
      `\t\tdata: ${upgradeTxData}`
  )

  // Persist the governance calldata to a tracked JSON file alongside the
  // log. The log line is ephemeral (stdout-scraped); the JSON is the durable
  // hand-off artifact the Council Safe proposer can verify against — and the
  // file diff doubles as a code-review surface for the upgrade proposal.
  // Written outside `deployments/` because hardhat-deploy treats that
  // directory as its own deployment-artifact namespace.
  const calldataDir = path.join(hre.config.paths.root, "governance-calldata")
  fs.mkdirSync(calldataDir, { recursive: true })
  const calldataPath = path.join(calldataDir, `968-${CONTRACT_NAME}.json`)
  const calldataPayload = {
    network: hre.network.name,
    contract: CONTRACT_NAME,
    proxy: NATIVE_PROXY,
    newImpl: newImplementationAddress,
    proxyAdmin: proxyAdmin.address,
    proxyAdminOwner,
    upgradeTx: {
      from: proxyAdminOwner,
      to: proxyAdmin.address,
      data: upgradeTxData,
    },
  }
  fs.writeFileSync(
    calldataPath,
    `${JSON.stringify(calldataPayload, null, 2)}\n`
  )
  deployments.log(`governance calldata written to ${calldataPath}`)

  // The Native rail has no prior committed deployment artifact to update, so a
  // record is written (rather than updated) with the freshly compiled ABI and
  // the new implementation address for downstream tooling.
  const contractArtifact: Artifact = artifacts.readArtifactSync(CONTRACT_NAME)

  await deployments.save(CONTRACT_NAME, {
    address: NATIVE_PROXY,
    abi: contractArtifact.abi,
    implementation: newImplementationAddress,
  })

  // Verify the new implementation source on Etherscan. The contract takes no
  // constructor arguments, so the parameter list is empty.
  await run("verify", {
    address: newImplementationAddress,
    constructorArgsParams: [],
  })
}

export default func

func.tags = ["UpgradeNativeBTCDepositorTo968"]

// Implementation-swap tooling for the live mainnet Native proxy. Guarded on
// two axes: only mainnet (never auto-runs against sepolia/hardhat during a
// full deploy) AND a post-execution sentinel (ALREADY_EXECUTED above), so a
// re-run on mainnet after governance has upgraded does not deploy a fresh
// implementation and overwrite the deployment artifact.
func.skip = async (hre: HardhatRuntimeEnvironment) =>
  hre.network.name !== "mainnet" || ALREADY_EXECUTED
