/* eslint-disable no-console */

import type { Contract } from "ethers"
import type { DeployFunction } from "hardhat-deploy/types"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import { ethers } from "hardhat"

export interface BridgeControllerAuthorizationSyncOptions {
  bridgeAddress?: string
  bridgeGovernanceAddress?: string
  controllerAddress?: string
  governancePrivateKey?: string
  dryRun?: boolean
}

const BRIDGE_ABI = [
  "function governance() view returns (address)",
  "function controllerBalanceIncreaser() view returns (address)",
  "event ControllerBalanceIncreaserUpdated(address indexed previousController, address indexed newController)",
]

const BRIDGE_GOVERNANCE_ABI = [
  "function setControllerBalanceIncreaser(address)",
]

async function resolveBridgeContracts(
  hre: HardhatRuntimeEnvironment,
  bridgeAddress?: string,
  bridgeGovernanceAddress?: string
): Promise<{
  bridge: Contract
  bridgeGovernance: Contract
}> {
  const { ethers: hardhatEthers, deployments } = hre
  const { provider } = hardhatEthers

  let resolvedBridgeAddress = bridgeAddress
  if (!resolvedBridgeAddress) {
    resolvedBridgeAddress = (await deployments.getOrNull("Bridge"))?.address
  }

  if (!resolvedBridgeAddress) {
    console.warn("⚠️  Bridge address not provided; skipping controller setup.")
    throw new Error("Bridge address not provided")
  }

  let resolvedBridgeGovernanceAddress = bridgeGovernanceAddress
  if (!resolvedBridgeGovernanceAddress) {
    resolvedBridgeGovernanceAddress = (
      await deployments.getOrNull("BridgeGovernance")
    )?.address
  }

  if (!resolvedBridgeGovernanceAddress) {
    console.warn(
      "⚠️  BridgeGovernance address not provided; cannot configure controller."
    )
    throw new Error("BridgeGovernance address not provided")
  }

  const bridge = new hardhatEthers.Contract(
    resolvedBridgeAddress,
    BRIDGE_ABI,
    provider
  )
  const bridgeGovernance = new hardhatEthers.Contract(
    resolvedBridgeGovernanceAddress,
    BRIDGE_GOVERNANCE_ABI,
    provider
  )

  const onChainGovernance = await bridge.governance()
  if (
    onChainGovernance.toLowerCase() !== bridgeGovernance.address.toLowerCase()
  ) {
    console.warn(
      "⚠️  Bridge.governance() does not match provided BridgeGovernance address."
    )
    throw new Error(
      "Bridge governance mismatch; run governance transfer before configuring controller."
    )
  }

  return { bridge, bridgeGovernance }
}

async function getGovernanceSigner(
  hre: HardhatRuntimeEnvironment,
  governancePrivateKey?: string
) {
  const { getNamedAccounts } = hre

  let resolvedPrivateKey = governancePrivateKey
  if (!resolvedPrivateKey) {
    const envKey = process.env.BRIDGE_GOVERNANCE_PK
    if (envKey && envKey.trim().length > 0) {
      resolvedPrivateKey = envKey.trim()
    }
  }

  if (resolvedPrivateKey) {
    return new ethers.Wallet(resolvedPrivateKey, hre.ethers.provider)
  }

  const { governance } = await getNamedAccounts()
  if (!governance) {
    const message =
      "No governance account configured and no private key supplied; aborting controller synchronization."
    console.warn(`⚠️  ${message}`)
    throw new Error(message)
  }

  return ethers.getSigner(governance)
}

function parseControllerAddress(raw?: string): string | undefined {
  if (!raw) {
    return undefined
  }

  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  try {
    return ethers.utils.getAddress(trimmed)
  } catch (error) {
    throw new Error(`Invalid controller address provided: ${trimmed}`)
  }
}

async function applyControllerConfiguration(
  bridge: Contract,
  bridgeGovernanceWithSigner: Contract,
  controller: string,
  dryRun: boolean
) {
  const current = await bridge.controllerBalanceIncreaser()

  console.log("\n📋 Bridge controller configuration plan:")
  console.log(`   Desired controller: ${controller}`)
  console.log(`   Current controller: ${current}`)

  if (
    current !== ethers.constants.AddressZero &&
    current.toLowerCase() === controller.toLowerCase()
  ) {
    console.log("   Controller already configured; nothing to do.")
    return
  }

  if (dryRun) {
    console.log("\nℹ️  Dry-run enabled; no on-chain changes will be submitted.")
    return
  }

  const tx = await bridgeGovernanceWithSigner.setControllerBalanceIncreaser(
    controller
  )
  console.log(
    `   ⛓️  Submitted controller update (${controller}). Tx hash: ${tx.hash}`
  )
  await tx.wait()
  console.log("   ✅ Controller configuration complete.")
}

export async function syncBridgeControllerAuthorizations(
  hre: HardhatRuntimeEnvironment,
  options: BridgeControllerAuthorizationSyncOptions = {}
): Promise<void> {
  const dryRunEnv =
    process.env.BRIDGE_CONTROLLER_SYNC_DRY_RUN === "true" ||
    process.env.BRIDGE_CONTROLLER_SYNC_DRY_RUN === "1"
  const dryRun = options.dryRun === true || dryRunEnv

  const desiredController =
    parseControllerAddress(options.controllerAddress) ??
    parseControllerAddress(process.env.BRIDGE_CONTROLLER_ADDRESS)

  if (!desiredController) {
    console.log("ℹ️  No Bridge controller address provided; skipping.")
    return
  }

  const { bridge, bridgeGovernance } = await resolveBridgeContracts(
    hre,
    options.bridgeAddress,
    options.bridgeGovernanceAddress
  )

  const signer = await getGovernanceSigner(hre, options.governancePrivateKey)
  if (!signer) {
    return
  }

  const bridgeGovernanceWithSigner = bridgeGovernance.connect(signer)

  await applyControllerConfiguration(
    bridge,
    bridgeGovernanceWithSigner,
    desiredController,
    dryRun
  )
}

const noopDeploy: DeployFunction = async () => {}
noopDeploy.skip = async () => true

export default noopDeploy
