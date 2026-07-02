import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

// Returns a signer for `address` only when that account is configured for the
// current network. Used to decide whether the governance-gated
// `transferGovernance` call can be sent by this deployment, or must instead be
// emitted as calldata for manual governance execution (the current governance
// owner is not always a deployer-controlled signer -- e.g. once handed off to a
// Safe). Mirrors 48/49/50/51's `getConfiguredSigner`.
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

// Hands FrostWalletRegistry governance off the deployer to the protocol
// governance account (mainnet: the Threshold Council; dev/sepolia: a local
// account) -- the `governance` named account resolved from `getNamedAccounts()`.
//
// WHY THIS STEP EXISTS
// --------------------
// `FrostWalletRegistry.initialize` calls `_transferGovernance(msg.sender)`, so
// immediately after deployment the registry's governance is the DEPLOYER. Every
// `onlyGovernance` control on the registry (`upgradeRandomBeacon`,
// `updateWalletOwner`, `updateLifecycleOwner`, `initializeV2`, the DKG /
// authorization / reward / slashing / gas parameter setters, and
// `withdrawIneligibleRewards`) therefore sits under the deployer key until it is
// explicitly moved. This script performs that move so the launched system is
// governed by the protocol governance account rather than the deploy key.
//
// CRITICAL ORDERING
// -----------------
// This transfer MUST run AFTER every deploy step that itself calls one of the
// registry's OWN `onlyGovernance` methods, because those steps need the deployer
// to still be governance. In the current deploy chain those consumers are:
//   * 49_deploy_bridge_lifecycle_router.ts -> `updateLifecycleOwner(router)`
//   * 51_deploy_frost_allowlist.ts         -> `initializeV2(frostAllowlist)`
// plus the registry deploy/init itself (48). Ordering is enforced two ways: this
// script is numbered 53 (after all frost scripts 48-52), and `func.dependencies`
// lists every one of those tags so hardhat-deploy runs them first. No
// `runAtTheEnd` script consumes registry governance, so this script does not need
// `runAtTheEnd`; it mirrors the frost siblings (48-52) which rely on numeric
// ordering + dependencies. Do NOT add a later step that calls a registry
// `onlyGovernance` method without also making it a dependency of this script and
// re-checking the ordering.
const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { getNamedAccounts, deployments, ethers } = hre
  const { deployer, governance } = await getNamedAccounts()

  if (!governance) {
    throw new Error(
      "`governance` named account is not configured for network " +
        `${hre.network.name}; cannot transfer FrostWalletRegistry governance`
    )
  }

  const FrostWalletRegistry = await deployments.get("FrostWalletRegistry")
  const frostWalletRegistry = await ethers.getContractAt(
    "FrostWalletRegistry",
    FrostWalletRegistry.address
  )

  const currentGovernance = await frostWalletRegistry.governance()

  // Idempotent: already at the target -> nothing to do. This also covers
  // networks where the deployer IS the governance account (e.g. sepolia, where
  // both resolve to account 0): initialize already left governance at the
  // target, so the transfer is a no-op.
  if (currentGovernance.toLowerCase() === governance.toLowerCase()) {
    console.log(
      `FrostWalletRegistry governance already set to ${governance}; skipping`
    )
    return
  }

  // Safety: the only address `initialize` can leave as governance is the
  // deployer. If governance is neither the deployer nor the target, something
  // outside this deploy chain moved it -- refuse to guess and abort so an
  // operator can investigate.
  if (currentGovernance.toLowerCase() !== deployer.toLowerCase()) {
    throw new Error(
      `FrostWalletRegistry governance is ${currentGovernance}, which is neither ` +
        `the deployer ${deployer} nor the target governance ${governance}; ` +
        "refusing to transfer"
    )
  }

  // Normal path: post-init governance is the deployer, so the deployer sends
  // `transferGovernance(governance)`. If the deployer is not a configured signer
  // for this network (e.g. governance was already moved to a Safe that the
  // deployer does not control), emit the exact calldata for manual governance
  // execution -- skipping on mainnet, erroring elsewhere -- consistent with the
  // sibling frost scripts' calldata-emit pattern.
  const signer = await getConfiguredSigner(hre, deployer)
  if (!signer) {
    const calldata = frostWalletRegistry.interface.encodeFunctionData(
      "transferGovernance",
      [governance]
    )
    const message =
      "FrostWalletRegistry governance transfer must be executed by the current " +
      `governance ${deployer}, which is not a configured signer for network ` +
      `${hre.network.name}. Submit this call from governance:\n` +
      `  target: ${frostWalletRegistry.address}\n` +
      `  data:   ${calldata}`

    if (hre.network.name === "mainnet") {
      console.log(`${message}\nskipping for manual governance execution`)
      return
    }
    throw new Error(message)
  }

  const tx = await frostWalletRegistry
    .connect(signer)
    .transferGovernance(governance)
  await tx.wait(1)

  // Idempotent post-check: confirm the on-chain governance now reflects the
  // target before considering the step successful.
  const finalGovernance = await frostWalletRegistry.governance()
  if (finalGovernance.toLowerCase() !== governance.toLowerCase()) {
    throw new Error(
      "FrostWalletRegistry governance mismatch after transfer: expected " +
        `${governance}, got ${finalGovernance}`
    )
  }

  console.log(
    `transferred FrostWalletRegistry governance from deployer ${deployer} ` +
      `to governance ${governance}`
  )
}

export default func

func.tags = ["TransferFrostWalletRegistryGovernance"]
// Depend on the registry deploy AND every registry-governance-consuming step so
// hardhat-deploy runs them before this transfer. See the CRITICAL ORDERING note
// above. FrostWalletRegistryRandomBeaconAuthorization (50) and
// AuthorizeFrostWalletRegistryInReimbursementPool (52) do not consume registry
// governance, but are listed so this transfer is the final action in the frost
// deploy chain.
func.dependencies = [
  "FrostWalletRegistry",
  "BridgeLifecycleRouter",
  "FrostWalletRegistryRandomBeaconAuthorization",
  "FrostAllowlist",
  "AuthorizeFrostWalletRegistryInReimbursementPool",
]
