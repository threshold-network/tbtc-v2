/* eslint-disable no-console */
import { config as dotenvConfig } from "dotenv"
import fs from "fs"
import path from "path"
import os from "os"
import { Contract } from "ethers"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

import {
  resolveLibrary,
  verifyLibraryBytecodes,
} from "./utils/library-resolution"

dotenvConfig({ override: true })

interface UpgradePrerequisites {
  bridgeAddress: string
  bridgeGovernanceAddress: string
  bankAddress: string
  lightRelayAddress: string
  walletRegistryAddress: string
  reimbursementPoolAddress: string
  mintBurnGuardAddress?: string
}

async function verifyUpgradePrerequisites(
  hre: HardhatRuntimeEnvironment,
  prereqs: UpgradePrerequisites
): Promise<void> {
  console.log("🧪  Running pre-upgrade verification gate…")

  const requiredContracts = [
    { label: "Bridge", address: prereqs.bridgeAddress },
    { label: "BridgeGovernance", address: prereqs.bridgeGovernanceAddress },
    { label: "Bank", address: prereqs.bankAddress },
    { label: "LightRelay", address: prereqs.lightRelayAddress },
    { label: "WalletRegistry", address: prereqs.walletRegistryAddress },
    { label: "ReimbursementPool", address: prereqs.reimbursementPoolAddress },
  ]

  for (const { label, address } of requiredContracts) {
    await assertContractDeployed(hre, address, label)
  }

  if (prereqs.mintBurnGuardAddress) {
    await assertContractDeployed(
      hre,
      prereqs.mintBurnGuardAddress,
      "MintBurnGuard (optional)"
    )
  }

  console.log("✅  Pre-upgrade verification successful.")
}

const proxyAdminAbi = ["function owner() view returns (address)"]

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  console.log("🚀 Starting Bridge upgrade script (UpgradeBridge tag)")
  const { ethers, helpers, deployments, getNamedAccounts, upgrades } = hre
  const { deployer, treasury: namedTreasury } = await getNamedAccounts()

  // Prefer cached deployment; fall back to env if cache missing.
  const cachedBridge = await deployments.getOrNull("Bridge")
  const bridgeAddress = cachedBridge?.address ?? process.env.BRIDGE_ADDRESS
  if (!bridgeAddress) {
    throw new Error(
      "Bridge address not found. Provide BRIDGE_ADDRESS or ensure deployments cache exists."
    )
  }

  // Use only the ProxyAdmin key for proxy operations; do not mix with
  // governance key to avoid role confusion.
  const proxyAdminPrivateKey = process.env.PROXY_ADMIN_PK

  let signer = await ethers.getSigner(deployer)
  let signerAddress = await signer.getAddress()
  if (proxyAdminPrivateKey) {
    signer = new ethers.Wallet(proxyAdminPrivateKey, ethers.provider)
    signerAddress = await signer.getAddress()
  } else {
    deployments.log(
      "⚠️  PROXY_ADMIN_PK not set; using deployer signer for proxy upgrade. Ensure deployer controls ProxyAdmin."
    )
  }

  const bankAddress = await resolveCoreAddress(
    deployments,
    "Bank",
    "BANK_ADDRESS"
  )
  const lightRelayAddress = await resolveCoreAddress(
    deployments,
    "LightRelay",
    "LIGHT_RELAY_ADDRESS"
  )
  const walletRegistryAddress = await resolveCoreAddress(
    deployments,
    "WalletRegistry",
    "WALLET_REGISTRY_ADDRESS"
  )
  const reimbursementPoolAddress = await resolveCoreAddress(
    deployments,
    "ReimbursementPool",
    "REIMBURSEMENT_POOL_ADDRESS"
  )

  const treasuryAddress =
    process.env.BRIDGE_TREASURY_ADDRESS ??
    namedTreasury ??
    ethers.constants.AddressZero

  const txProofDifficultyFactor = 6

  const bridgeGovernanceAddress = await resolveBridgeGovernanceAddress(
    deployments
  )

  const bridgeContract = await ethers.getContractAt("Bridge", bridgeAddress)
  const previousGovernance = await bridgeContract.governance()
  const previousController = await bridgeContract.controllerBalanceIncreaser()

  const bridgeProxyAdminAddress = await upgrades.erc1967.getAdminAddress(
    bridgeAddress
  )
  const proxyAdminContract = new Contract(
    bridgeProxyAdminAddress,
    proxyAdminAbi,
    ethers.provider
  )
  const proxyAdminOwner = await proxyAdminContract.owner()
  deployments.log(
    `Bridge ProxyAdmin ${bridgeProxyAdminAddress} owned by ${proxyAdminOwner}`
  )
  if (proxyAdminOwner.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(
      `ProxyAdmin owner mismatch: on-chain ${proxyAdminOwner} vs signer ${signerAddress}. Set PROXY_ADMIN_PK to the owner key.`
    )
  }

  await validateBridgeGovernanceState(
    hre,
    bridgeContract,
    bridgeGovernanceAddress,
    previousGovernance
  )

  await verifyUpgradePrerequisites(hre, {
    bridgeAddress,
    bridgeGovernanceAddress,
    bankAddress,
    lightRelayAddress,
    walletRegistryAddress,
    reimbursementPoolAddress,
    mintBurnGuardAddress: process.env.MINTBURN_GUARD_ADDRESS,
  })

  // WARNING: This script expects no changes in the external libraries and uses
  // `get` function to load the ones that were already published before.
  // If there are any changes in the external libraries make sure to deploy fresh
  // versions of the libraries and link them to the implementation.
  const depositLib = await resolveLibrary(deployments, signerAddress, "Deposit")
  const depositSweepLib = await resolveLibrary(
    deployments,
    signerAddress,
    "DepositSweep"
  )
  const redemptionLib = await resolveLibrary(
    deployments,
    signerAddress,
    "Redemption"
  )
  const walletsLib = await resolveLibrary(deployments, signerAddress, "Wallets")
  const fraudLib = await resolveLibrary(deployments, signerAddress, "Fraud")
  const movingFundsLib = await resolveLibrary(
    deployments,
    signerAddress,
    "MovingFunds"
  )

  await ensureDeploymentRecord(deployments, "Bridge", bridgeAddress, "Bridge")

  const libraryAddresses = {
    Deposit: depositLib,
    DepositSweep: depositSweepLib,
    Redemption: redemptionLib,
    Wallets: walletsLib,
    Fraud: fraudLib,
    MovingFunds: movingFundsLib,
  }

  // Verify on-chain library bytecodes match compiled artifacts.
  await verifyLibraryBytecodes(hre, libraryAddresses)

  const [bridge, proxyDeployment] = await helpers.upgrades.upgradeProxy(
    "Bridge",
    "Bridge",
    {
      contractName: "Bridge",
      initializerArgs: [
        bankAddress,
        lightRelayAddress,
        treasuryAddress,
        walletRegistryAddress,
        reimbursementPoolAddress,
        txProofDifficultyFactor,
      ],
      factoryOpts: {
        signer,
        libraries: libraryAddresses,
      },
      proxyOpts: {
        kind: "transparent",
        // Allow external libraries linking. We need to ensure manually that the
        // external libraries we link are upgrade safe, as the OpenZeppelin plugin
        // doesn't perform such validation yet.
        // See: https://docs.openzeppelin.com/upgrades-plugins/1.x/faq#why-cant-i-use-external-libraries
        unsafeAllow: getUnsafeAllows(),
        unsafeSkipStorageCheck: shouldSkipStorageCheck(),
      },
    }
  )

  if (hre.network.tags.etherscan) {
    // We use `verify` instead of `verify:verify` as the `verify` task is defined
    // in "@openzeppelin/hardhat-upgrades" to perform Etherscan verification
    // of Proxy and Implementation contracts.
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  if (hre.network.tags.tenderly) {
    const tenderlyConfigPath = path.join(
      os.homedir(),
      ".tenderly",
      "config.yaml"
    )
    if (fs.existsSync(tenderlyConfigPath)) {
      await hre.tenderly.verify({
        name: "Bridge",
        address: bridge.address,
      })
    } else {
      deployments.log(
        "Skipping Tenderly verification; /.tenderly/config.yaml not found."
      )
    }
  }

  // Post-upgrade governance configuration
  await verifyBridgePostUpgradeState(
    hre,
    bridge,
    bridgeGovernanceAddress,
    previousGovernance,
    previousController
  )
  const upgradeTxHash =
    proxyDeployment?.txHash ??
    proxyDeployment?.transactionHash ??
    proxyDeployment?.tx?.hash ??
    "unknown"
  const newImplementation = await hre.upgrades.erc1967.getImplementationAddress(
    bridge.address
  )
  console.log(`🔁 Bridge upgrade tx: ${upgradeTxHash}`)
  console.log(`    Bridge implementation after upgrade: ${newImplementation}`)

  const enablePostUpgradeGovernance =
    process.env.ENABLE_POST_UPGRADE_GOVERNANCE === "true"
  if (enablePostUpgradeGovernance) {
    await configurePostUpgradeGovernance(hre, bridge, deployments)
  } else {
    deployments.log(
      "⏭️  Skipping post-upgrade governance mutations (set ENABLE_POST_UPGRADE_GOVERNANCE=true to enable)."
    )
  }
}

async function ensureDeploymentRecord(
  deployments: HardhatRuntimeEnvironment["deployments"],
  name: string,
  address: string,
  artifactName: string
): Promise<void> {
  const existing = await deployments.getOrNull(name)
  if (existing?.address) {
    return
  }
  const artifact = await deployments.getArtifact(artifactName)
  await deployments.save(name, {
    address,
    abi: artifact.abi,
  })
}

async function resolveBridgeGovernanceAddress(
  deployments: HardhatRuntimeEnvironment["deployments"]
): Promise<string> {
  const envAddress = process.env.BRIDGE_GOVERNANCE_ADDRESS
  if (envAddress && envAddress.length > 0) {
    return envAddress
  }

  const cached = await deployments.getOrNull("BridgeGovernance")
  if (cached?.address) {
    return cached.address
  }

  throw new Error(
    "BridgeGovernance address not found. Provide BRIDGE_GOVERNANCE_ADDRESS or deployments cache."
  )
}

async function validateBridgeGovernanceState(
  hre: HardhatRuntimeEnvironment,
  bridge: Contract,
  bridgeGovernanceAddress: string,
  expectedGovernance: string
): Promise<void> {
  const { deployments, ethers } = hre

  await ensureDeploymentRecord(
    deployments,
    "BridgeGovernance",
    bridgeGovernanceAddress,
    "BridgeGovernance"
  )

  const currentGovernance = await bridge.governance()
  if (
    currentGovernance.toLowerCase() !== bridgeGovernanceAddress.toLowerCase()
  ) {
    throw new Error(
      `Bridge governance mismatch: on-chain ${currentGovernance} vs expected ${bridgeGovernanceAddress}`
    )
  }

  if (
    expectedGovernance &&
    currentGovernance.toLowerCase() !== expectedGovernance.toLowerCase()
  ) {
    deployments.log(
      `   ⚠️  Bridge governance differs from earlier state: ${currentGovernance} vs ${expectedGovernance}`
    )
  }

  const governanceContract = await hre.ethers.getContractAt(
    "BridgeGovernance",
    bridgeGovernanceAddress
  )
  const owner = await governanceContract.owner()
  if (owner === ethers.constants.AddressZero) {
    throw new Error("BridgeGovernance owner is zero address; aborting upgrade.")
  }
  deployments.log(`   🧭 Bridge governance contract owner: ${owner}`)
}

async function verifyBridgePostUpgradeState(
  hre: HardhatRuntimeEnvironment,
  bridge: Contract,
  bridgeGovernanceAddress: string,
  previousGovernance: string,
  previousController: string
): Promise<void> {
  const { deployments } = hre

  const currentGovernance = await bridge.governance()
  if (
    currentGovernance.toLowerCase() !== bridgeGovernanceAddress.toLowerCase()
  ) {
    throw new Error(
      `Post-upgrade governance mismatch: ${currentGovernance} vs ${bridgeGovernanceAddress}`
    )
  }

  if (
    previousGovernance &&
    currentGovernance.toLowerCase() !== previousGovernance.toLowerCase()
  ) {
    deployments.log(
      `   ⚠️  Governance address changed during upgrade (${previousGovernance} → ${currentGovernance})`
    )
  }

  const currentController = await bridge.controllerBalanceIncreaser()
  if (
    previousController &&
    currentController.toLowerCase() !== previousController.toLowerCase()
  ) {
    deployments.log(
      `   ⚠️  Controller changed during upgrade (${previousController} → ${currentController})`
    )
  } else {
    deployments.log(`   ✅ Controller address preserved: ${currentController}`)
  }
}

async function assertContractDeployed(
  hre: HardhatRuntimeEnvironment,
  address: string,
  label: string
): Promise<void> {
  const code = await hre.ethers.provider.getCode(address)
  if (!code || code === "0x") {
    throw new Error(`${label} not deployed at ${address}`)
  }
}

export default func

func.tags = ["UpgradeBridge"]
func.dependencies = []
// This script is normally skipped to avoid accidental upgrades; set ENABLE_UPGRADE_BRIDGE=true
// when you actually need to run it.
func.skip = async (hre: HardhatRuntimeEnvironment) => {
  const enabled = process.env.ENABLE_UPGRADE_BRIDGE === "true"
  const allowLocal = process.env.ALLOW_LOCAL_UPGRADE === "true"
  const isLocal =
    hre.network.name === "hardhat" || hre.network.name === "localhost"

  if (!enabled) {
    console.log(
      "⏭️  Skipping UpgradeBridge deploy (ENABLE_UPGRADE_BRIDGE != 'true')"
    )
    return true
  }

  if (isLocal && !allowLocal) {
    console.log(
      "⏭️  Skipping UpgradeBridge on local network (set ALLOW_LOCAL_UPGRADE=true to dry-run locally)."
    )
    return true
  }

  return false
}

async function configurePostUpgradeGovernance(
  hre: HardhatRuntimeEnvironment,
  bridge: any,
  deployments: HardhatRuntimeEnvironment["deployments"]
): Promise<void> {
  const { ethers, getNamedAccounts } = hre
  const { deployer, governance } = await getNamedAccounts()

  deployments.log("🏛️  Configuring post-upgrade governance...")

  // Check if MintBurnGuard is deployed and needs controller configuration
  const mintBurnGuardDeployment = await deployments.getOrNull("MintBurnGuard")
  if (mintBurnGuardDeployment) {
    const mintBurnGuard = await ethers.getContractAt(
      "MintBurnGuard",
      mintBurnGuardDeployment.address
    )

    const currentController = await mintBurnGuard.controller()
    deployments.log(`MintBurnGuard current controller: ${currentController}`)

    // If controller is not set (0x0) and governance is available, configure it
    if (
      currentController === ethers.constants.AddressZero &&
      governance &&
      governance !== ethers.constants.AddressZero
    ) {
      deployments.log("🔧 Setting MintBurnGuard controller to governance...")

      const owner = await mintBurnGuard.owner()
      const signer = await ethers.getSigner(
        owner.toLowerCase() === deployer.toLowerCase() ? deployer : governance
      )

      try {
        const setControllerTx = await mintBurnGuard
          .connect(signer)
          .setController(governance)
        deployments.log(`   Transaction submitted: ${setControllerTx.hash}`)
        await setControllerTx.wait()
        deployments.log("   ✅ MintBurnGuard controller set to governance")
      } catch (error) {
        deployments.log(`   ⚠️  Failed to set controller: ${error.message}`)
        deployments.log("   💡 Manual governance configuration may be required")
      }
    } else {
      deployments.log("   ✅ MintBurnGuard controller already configured")
    }
  }

  // Additional post-upgrade governance tasks can be added here
  // e.g., parameter updates, role configurations, etc.

  deployments.log("✅ Post-upgrade governance configuration completed")
}

function shouldSkipStorageCheck(): boolean {
  const presetRelaxed = isRelaxedPreset()
  const allowSkip = presetRelaxed || process.env.ALLOW_STORAGE_SKIP === "true"
  if (allowSkip) {
    console.warn(
      "⚠️  Storage layout checks are disabled (ALLOW_STORAGE_SKIP=true or UPGRADE_SAFETY_PRESET=relaxed). Proceed with extreme caution."
    )
  }
  return allowSkip
}

function getUnsafeAllows(): ("external-library-linking" | "renamed-storage")[] {
  const allow: ("external-library-linking" | "renamed-storage")[] = [
    "external-library-linking",
  ]
  const presetRelaxed = isRelaxedPreset()
  if (presetRelaxed || process.env.ALLOW_RENAMED_STORAGE === "true") {
    allow.push("renamed-storage")
    console.warn(
      "⚠️  Storage rename allowance enabled (ALLOW_RENAMED_STORAGE=true or UPGRADE_SAFETY_PRESET=relaxed). Ensure storage layout was reviewed."
    )
  }
  return allow
}

function isRelaxedPreset(): boolean {
  return process.env.UPGRADE_SAFETY_PRESET === "relaxed"
}

async function resolveCoreAddress(
  deployments: HardhatRuntimeEnvironment["deployments"],
  name: string,
  envVar: string
): Promise<string> {
  const envAddress = process.env[envVar]
  if (!envAddress || envAddress.length === 0) {
    const deployment = await deployments.getOrNull(name)
    if (deployment?.address) {
      return deployment.address
    }
    throw new Error(
      `Address for ${name} not found in deployments cache. Provide ${envVar}.`
    )
  }
  return envAddress
}
