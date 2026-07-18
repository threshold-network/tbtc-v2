import fs from "fs"
import path from "path"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import {
  assertLegacyGovernanceReadyForHandoff,
  BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH,
  buildLegacyInventorySourcePreflight,
  HandoffManifest,
  LEGACY_GOVERNANCE_STORAGE_LAYOUT_HASH,
} from "../scripts/ecdsa-fraud-router-cutover-lib"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers, getNamedAccounts, network } = hre
  const { deploy, get, save } = deployments
  const { deployer } = await getNamedAccounts()

  const bridgeDeployment = await get("Bridge")
  const canonicalGovernanceDeployment = await get("BridgeGovernance")
  const bridge = await ethers.getContractAt("Bridge", bridgeDeployment.address)
  const oldGovernanceAddress = await bridge.governance()
  const outputPath =
    process.env.ECDSA_CUTOVER_MANIFEST_OUT ??
    path.join(
      hre.config.paths.deployments,
      network.name,
      "ecdsa-fraud-router-cutover-manifest.json"
    )
  const historicalGovernanceDeployment = await deployments.getOrNull(
    "BridgeGovernanceBeforeEcdsaCutover"
  )
  const historicalRouterDeployment = await deployments.getOrNull(
    "EcdsaFraudRouterBeforeEcdsaCutover"
  )
  if (fs.existsSync(outputPath)) {
    const existing = JSON.parse(
      fs.readFileSync(outputPath, "utf8")
    ) as HandoffManifest
    if (
      existing.chainId !== (await ethers.provider.getNetwork()).chainId ||
      existing.bridge.toLowerCase() !== bridge.address.toLowerCase() ||
      existing.oldGovernance.toLowerCase() !==
        historicalGovernanceDeployment?.address.toLowerCase() ||
      (oldGovernanceAddress.toLowerCase() !==
        existing.oldGovernance.toLowerCase() &&
        oldGovernanceAddress.toLowerCase() !==
          existing.newGovernance.toLowerCase()) ||
      historicalRouterDeployment?.address.toLowerCase() !==
        existing.oldRouter.toLowerCase()
    ) {
      throw new Error(`existing cutover manifest ${outputPath} is inconsistent`)
    }
    console.log(
      `cutover manifest already exists at ${outputPath}; preserving all ` +
        "historical/canonical deployment aliases and resuming through the CLI"
    )
    return
  }
  if (
    canonicalGovernanceDeployment.address.toLowerCase() !==
    oldGovernanceAddress.toLowerCase()
  ) {
    throw new Error(
      `canonical BridgeGovernance deployment ${canonicalGovernanceDeployment.address} ` +
        `is not live Bridge.governance() ${oldGovernanceAddress}; repair the ` +
        "deployment record before preparing handoff"
    )
  }

  // Preserve the incumbent record under a permanent name before creating any
  // replacement. The canonical alias is intentionally untouched until the
  // delayed handoff has finalized and Bridge.governance() is read back.
  if (historicalGovernanceDeployment) {
    if (
      historicalGovernanceDeployment.address.toLowerCase() !==
      oldGovernanceAddress.toLowerCase()
    ) {
      throw new Error(
        "historical BridgeGovernance record already pins a different address"
      )
    }
  } else {
    await save("BridgeGovernanceBeforeEcdsaCutover", {
      ...canonicalGovernanceDeployment,
      address: oldGovernanceAddress,
    })
  }

  const oldGovernance = await ethers.getContractAt(
    "BridgeGovernance",
    oldGovernanceAddress
  )
  const [governanceOwner, governanceDelay, oldRouter] = await Promise.all([
    oldGovernance.owner(),
    oldGovernance.governanceDelays(0),
    bridge.ecdsaFraudRouter(),
  ])
  const canonicalRouterDeployment = await get("EcdsaFraudRouter")
  if (
    canonicalRouterDeployment.address.toLowerCase() !== oldRouter.toLowerCase()
  ) {
    throw new Error(
      `canonical EcdsaFraudRouter ${canonicalRouterDeployment.address} is not ` +
        `live Bridge router ${oldRouter}`
    )
  }
  if (historicalRouterDeployment) {
    if (
      historicalRouterDeployment.address.toLowerCase() !==
      oldRouter.toLowerCase()
    ) {
      throw new Error("historical EcdsaFraudRouter record pins another address")
    }
  } else {
    await save("EcdsaFraudRouterBeforeEcdsaCutover", {
      ...canonicalRouterDeployment,
      address: oldRouter,
    })
  }
  const expectedOldGovernanceCodeHash =
    process.env.ECDSA_CUTOVER_OLD_GOVERNANCE_CODE_HASH
  if (!expectedOldGovernanceCodeHash) {
    throw new Error(
      "ECDSA_CUTOVER_OLD_GOVERNANCE_CODE_HASH is required and must come " +
        "from the reviewed handoff manifest"
    )
  }

  const parameters = await deploy(
    "BridgeGovernanceParametersEcdsaFraudCutover",
    {
      contract: "BridgeGovernanceParameters",
      from: deployer,
      log: true,
      waitConfirmations: 1,
    }
  )
  const coordinator = await deploy("EcdsaFraudRouterCutoverGovernanceLibrary", {
    contract: "EcdsaFraudRouterCutover",
    from: deployer,
    log: true,
    waitConfirmations: 1,
  })
  const newGovernanceDeployment = await deploy(
    "BridgeGovernanceEcdsaFraudCutover",
    {
      contract: "BridgeGovernance",
      from: deployer,
      args: [bridge.address, governanceDelay],
      libraries: {
        BridgeGovernanceParameters: parameters.address,
        EcdsaFraudRouterCutover: coordinator.address,
      },
      log: true,
      waitConfirmations: 1,
    }
  )
  const newGovernance = await ethers.getContractAt(
    "BridgeGovernance",
    newGovernanceDeployment.address
  )
  if (!(await newGovernance.governanceDelays(0)).eq(governanceDelay)) {
    throw new Error(
      "new BridgeGovernance did not preserve the exact live delay"
    )
  }

  const currentNewOwner = await newGovernance.owner()
  if (currentNewOwner.toLowerCase() !== governanceOwner.toLowerCase()) {
    if (currentNewOwner.toLowerCase() !== deployer.toLowerCase()) {
      throw new Error(
        `unexpected new BridgeGovernance owner ${currentNewOwner}`
      )
    }
    const tx = await newGovernance.transferOwnership(governanceOwner)
    await tx.wait(1)
  }
  if (
    (await newGovernance.owner()).toLowerCase() !==
    governanceOwner.toLowerCase()
  ) {
    throw new Error("new BridgeGovernance ownership transfer/readback failed")
  }

  const replacementDeployment = await deploy(
    "EcdsaFraudRouterEcdsaCutoverReplacement",
    {
      contract: "EcdsaFraudRouter",
      from: deployer,
      args: [bridge.address, oldRouter],
      log: true,
      waitConfirmations: 1,
    }
  )
  const requestedReplacement = process.env.ECDSA_CUTOVER_REPLACEMENT
  if (
    requestedReplacement &&
    requestedReplacement.toLowerCase() !==
      replacementDeployment.address.toLowerCase()
  ) {
    throw new Error(
      `ECDSA_CUTOVER_REPLACEMENT ${requestedReplacement} does not match ` +
        `distinct deployment ${replacementDeployment.address}`
    )
  }
  const replacement = ethers.utils.getAddress(replacementDeployment.address)
  const replacementContract = await ethers.getContractAt(
    "EcdsaFraudRouter",
    replacement
  )
  const [
    replacementBridge,
    replacementProtocol,
    replacementOpenCount,
    replacementUnattributedCount,
    replacementEscrow,
    replacementMigratedChallengesActivatedAt,
    replacementPredecessor,
    replacementPredecessorCodeHash,
    replacementAncestryDepth,
    oldRouterRuntimeCode,
  ] = await Promise.all([
    replacementContract.bridge(),
    replacementContract.fraudProtocolID(),
    replacementContract.openFraudChallengeCount(),
    replacementContract.unattributedOpenFraudChallengeCount(),
    replacementContract.openFraudChallengeEscrow(),
    replacementContract.migratedChallengesActivatedAt(),
    replacementContract.predecessor(),
    replacementContract.predecessorCodeHash(),
    replacementContract.ancestryDepth(),
    ethers.provider.getCode(oldRouter),
  ])
  const oldRouterRuntimeCodeHash = ethers.utils.keccak256(oldRouterRuntimeCode)
  if (
    replacementBridge.toLowerCase() !== bridge.address.toLowerCase() ||
    replacementProtocol.toLowerCase() !==
      ethers.utils
        .id("tbtc/ecdsa-signature-fraud/router/current-v3")
        .toLowerCase() ||
    replacementPredecessor.toLowerCase() !== oldRouter.toLowerCase() ||
    replacementPredecessorCodeHash.toLowerCase() !==
      oldRouterRuntimeCodeHash.toLowerCase() ||
    replacementAncestryDepth === 0 ||
    replacementAncestryDepth > 8 ||
    !replacementOpenCount.isZero() ||
    !replacementUnattributedCount.isZero() ||
    !replacementEscrow.isZero() ||
    !replacementMigratedChallengesActivatedAt.isZero()
  ) {
    throw new Error(
      "replacement router is not an empty, Bridge-bound current router"
    )
  }
  const reconciler = process.env.ECDSA_CUTOVER_RECONCILER
  if (!reconciler) throw new Error("ECDSA_CUTOVER_RECONCILER is required")
  const bridgeDeploymentBlock = bridgeDeployment.receipt?.blockNumber
  if (bridgeDeploymentBlock === undefined) {
    throw new Error("Bridge deployment receipt block is required")
  }
  const sourcePreflightFinalizedBlock =
    (await ethers.provider.getBlockNumber()) - 64
  if (sourcePreflightFinalizedBlock < bridgeDeploymentBlock) {
    throw new Error(
      "Bridge deployment must be at least 64 confirmations deep before " +
        "the signed legacy-inventory source preflight can be prepared"
    )
  }
  const legacyInventorySourcePreflight =
    await buildLegacyInventorySourcePreflight(
      ethers.provider,
      bridge.address,
      bridgeDeploymentBlock,
      sourcePreflightFinalizedBlock
    )
  const manifest: HandoffManifest = {
    version: 1,
    chainId: (await ethers.provider.getNetwork()).chainId,
    bridge: bridge.address,
    bridgeDeploymentBlock,
    oldGovernance: oldGovernanceAddress,
    oldGovernanceRuntimeCodeHash: expectedOldGovernanceCodeHash,
    oldGovernanceStorageLayoutHash: LEGACY_GOVERNANCE_STORAGE_LAYOUT_HASH,
    bridgeLegacyFraudStorageLayoutHash: BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH,
    newGovernance: newGovernance.address,
    newGovernanceRuntimeCodeHash: ethers.utils.keccak256(
      await ethers.provider.getCode(newGovernance.address)
    ),
    governanceOwner,
    governanceDelay: governanceDelay.toString(),
    oldRouter,
    oldRouterRuntimeCodeHash,
    replacementRouter: replacement,
    replacementRouterRuntimeCodeHash: ethers.utils.keccak256(
      await ethers.provider.getCode(replacement)
    ),
    // The canonical floor is immutable and cannot be shortened by a later
    // staging action. Reconciler tooling rejects any inventory with another
    // start block.
    scanStartBlock: bridgeDeploymentBlock,
    legacyInventorySourcePreflight,
    reconciler: ethers.utils.getAddress(reconciler),
    phase: "new-governance-owned",
  }
  await assertLegacyGovernanceReadyForHandoff(ethers.provider, manifest)

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  })
  console.log(`wrote resumable handoff manifest: ${outputPath}`)
  console.log(
    "BridgeGovernance canonical alias remains the incumbent; use the cutover " +
      "CLI begin/finalize-governance-handoff actions next"
  )
}

export default func

func.tags = ["DeployEcdsaCutoverBridgeGovernance"]
func.dependencies = ["Bridge"]
func.skip = async () => process.env.ECDSA_CUTOVER_DEPLOY_GOVERNANCE !== "true"
