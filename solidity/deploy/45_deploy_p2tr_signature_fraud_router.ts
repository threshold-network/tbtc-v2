import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { utils } from "ethers"

export const BOUNDED_V1_PROTOCOL_ID = utils.id(
  "tbtc/p2tr-signature-fraud/evidence/bounded-v1"
)
export const COMPLETE_V2_PROTOCOL_ID = utils.id(
  "tbtc/p2tr-signature-fraud/evidence/complete-v2"
)

const FROST_REGISTRATION_SCAN_PAGE_SIZE = 10000

// Formal storage layout for Bridge at this upgrade boundary:
// Bridge.self starts at absolute slot 51. Within BridgeState.Storage,
// frostWalletRegistry is relative slot 32 and p2trFraudRouter is relative slot
// 34. Reading the proxy slots directly works before the candidate getters are
// installed and proves both reserved fields are exactly zero.
export const BRIDGE_FROST_WALLET_REGISTRY_STORAGE_SLOT = 51 + 32
export const BRIDGE_P2TR_FRAUD_ROUTER_STORAGE_SLOT = 51 + 34

export interface FrostCustodyPreflightReceipt {
  schemaVersion: "tbtc/frost-custody-preflight/v1"
  networkName: string
  chainId: string
  bridge: string
  snapshotBlockNumber: number
  snapshotBlockHash: string
  scanFromBlock: 0
  scanToBlock: number
  registrationsFound: 0
  frostWalletRegistry: string
  configuredP2TRFraudRouter: string
  configuredRouterStatus: "unset"
  frostWalletRegistryStorageSlot: number
  p2trFraudRouterStorageSlot: number
  storageLayoutEvidence: "test/formal/Bridge.storage-layout.json"
}

const requireExactResultLength = (
  result: string,
  bytes: number,
  description: string
): void => {
  if (!/^0x[0-9a-fA-F]*$/.test(result) || result.length !== 2 + bytes * 2) {
    throw new Error(
      `FROST custody preflight failed: malformed ${description} result`
    )
  }
}

const readBridgePreflightState = async (
  hre: HardhatRuntimeEnvironment,
  bridgeAddress: string,
  snapshotBlockNumber: number
): Promise<{
  frostWalletRegistry: string
  configuredP2TRFraudRouter: string
  configuredRouterStatus: "unset"
}> => {
  const { ethers } = hre

  const frostWalletRegistryWord = await ethers.provider.getStorageAt(
    bridgeAddress,
    BRIDGE_FROST_WALLET_REGISTRY_STORAGE_SLOT,
    snapshotBlockNumber
  )
  requireExactResultLength(
    frostWalletRegistryWord,
    32,
    `Bridge storage slot ${BRIDGE_FROST_WALLET_REGISTRY_STORAGE_SLOT}`
  )
  if (frostWalletRegistryWord !== ethers.constants.HashZero) {
    throw new Error(
      `FROST custody preflight failed: Bridge frost registry storage slot ${BRIDGE_FROST_WALLET_REGISTRY_STORAGE_SLOT} is non-zero (${frostWalletRegistryWord})`
    )
  }

  const p2trFraudRouterWord = await ethers.provider.getStorageAt(
    bridgeAddress,
    BRIDGE_P2TR_FRAUD_ROUTER_STORAGE_SLOT,
    snapshotBlockNumber
  )
  requireExactResultLength(
    p2trFraudRouterWord,
    32,
    `Bridge storage slot ${BRIDGE_P2TR_FRAUD_ROUTER_STORAGE_SLOT}`
  )
  if (p2trFraudRouterWord !== ethers.constants.HashZero) {
    throw new Error(
      `FROST custody preflight failed: Bridge P2TR router storage slot ${BRIDGE_P2TR_FRAUD_ROUTER_STORAGE_SLOT} is non-zero (${p2trFraudRouterWord})`
    )
  }

  return {
    frostWalletRegistry: ethers.constants.AddressZero,
    configuredP2TRFraudRouter: ethers.constants.AddressZero,
    configuredRouterStatus: "unset",
  }
}

const assertNoFrostRegistrationHistory = async (
  hre: HardhatRuntimeEnvironment,
  bridgeAddress: string,
  snapshotBlockNumber: number
): Promise<void> => {
  const { ethers } = hre
  const newFrostWalletRegisteredTopic = ethers.utils.id(
    "NewFrostWalletRegistered(bytes32,bytes20,bytes32)"
  )
  const newWalletRegisteredV2Topic = ethers.utils.id(
    "NewWalletRegisteredV2(bytes32,bytes32,bytes20)"
  )

  for (
    let fromBlock = 0;
    fromBlock <= snapshotBlockNumber;
    fromBlock += FROST_REGISTRATION_SCAN_PAGE_SIZE
  ) {
    const toBlock = Math.min(
      snapshotBlockNumber,
      fromBlock + FROST_REGISTRATION_SCAN_PAGE_SIZE - 1
    )

    // Both queries are required. NewFrostWalletRegistered covers the current
    // callback, while the zero-ECDSA V2 marker covers intermediate deployments.
    // Any provider or decoding failure propagates and aborts the deployment.
    // eslint-disable-next-line no-await-in-loop
    const newFrostWalletLogs = await ethers.provider.getLogs({
      address: bridgeAddress,
      fromBlock,
      toBlock,
      topics: [newFrostWalletRegisteredTopic],
    })
    // eslint-disable-next-line no-await-in-loop
    const zeroEcdsaWalletV2Logs = await ethers.provider.getLogs({
      address: bridgeAddress,
      fromBlock,
      toBlock,
      topics: [newWalletRegisteredV2Topic, null, ethers.constants.HashZero],
    })

    if (newFrostWalletLogs.length > 0 || zeroEcdsaWalletV2Logs.length > 0) {
      const firstLog = newFrostWalletLogs[0] ?? zeroEcdsaWalletV2Logs[0]
      throw new Error(
        `FROST custody preflight failed: prior FROST wallet registration at block ${firstLog.blockNumber}`
      )
    }
  }
}

export const runFrostCustodyPreflight = async (
  hre: HardhatRuntimeEnvironment,
  bridgeAddress: string
): Promise<FrostCustodyPreflightReceipt> => {
  const snapshotBlockNumber = await hre.ethers.provider.getBlockNumber()
  const snapshotBlock = await hre.ethers.provider.getBlock(snapshotBlockNumber)
  if (!snapshotBlock?.hash) {
    throw new Error(
      "FROST custody preflight failed: snapshot block has no hash"
    )
  }

  const bridgeState = await readBridgePreflightState(
    hre,
    bridgeAddress,
    snapshotBlockNumber
  )
  await assertNoFrostRegistrationHistory(
    hre,
    bridgeAddress,
    snapshotBlockNumber
  )

  const canonicalSnapshot = await hre.ethers.provider.getBlock(
    snapshotBlockNumber
  )
  if (
    !canonicalSnapshot?.hash ||
    canonicalSnapshot.hash.toLowerCase() !== snapshotBlock.hash.toLowerCase()
  ) {
    throw new Error("FROST custody preflight failed: snapshot block reorged")
  }

  return {
    schemaVersion: "tbtc/frost-custody-preflight/v1",
    networkName: hre.network.name,
    chainId: await hre.getChainId(),
    bridge: bridgeAddress,
    snapshotBlockNumber,
    snapshotBlockHash: snapshotBlock.hash,
    scanFromBlock: 0,
    scanToBlock: snapshotBlockNumber,
    registrationsFound: 0,
    frostWalletRegistry: bridgeState.frostWalletRegistry,
    configuredP2TRFraudRouter: bridgeState.configuredP2TRFraudRouter,
    configuredRouterStatus: bridgeState.configuredRouterStatus,
    frostWalletRegistryStorageSlot: BRIDGE_FROST_WALLET_REGISTRY_STORAGE_SLOT,
    p2trFraudRouterStorageSlot: BRIDGE_P2TR_FRAUD_ROUTER_STORAGE_SLOT,
    storageLayoutEvidence: "test/formal/Bridge.storage-layout.json",
  }
}

export const abortLiveBridgeUpgradeWithoutVettedCompleteV2 = async (
  hre: HardhatRuntimeEnvironment,
  upgradePath: string
): Promise<never> => {
  const Bridge = await hre.deployments.get("Bridge")
  const receipt = await runFrostCustodyPreflight(hre, Bridge.address)

  // Machine-readable, write-free receipt for operator review. The script
  // throws immediately afterward, so no deployment or governance calldata is
  // produced on live/custom networks.
  console.log(`FROST_CUSTODY_PREFLIGHT_RECEIPT=${JSON.stringify(receipt)}`)

  throw new Error(
    `NO-GO ${upgradePath}: zero-FROST preflight passed at ${receipt.snapshotBlockNumber}/${receipt.snapshotBlockHash}, ` +
      "but no vetted immutable COMPLETE_V2 evidence router exists. Do not deploy an implementation, execute a proxy upgrade, or emit governance calldata. " +
      "The eventual governance operation must atomically validate the vetted router before enabling FROST-only replacement-wallet creation."
  )
}

export const isEphemeralLocalNetwork = (networkName: string): boolean =>
  ["hardhat", "development", "system_tests"].includes(networkName)

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, helpers, getNamedAccounts, ethers } = hre
  const { deploy, save } = deployments
  const { deployer } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")
  if (!isEphemeralLocalNetwork(hre.network.name)) {
    await abortLiveBridgeUpgradeWithoutVettedCompleteV2(
      hre,
      "45_deploy_p2tr_signature_fraud_router"
    )
  }
  const preflightReceipt = await runFrostCustodyPreflight(hre, Bridge.address)

  // P2TRSignatureFraudRouter is a plain (non-upgradeable) contract
  // that pins the Bridge address at construction. Sister sidecar to
  // EcdsaFraudRouter for the P2TR signature-fraud lifecycle.
  const p2trFraudRouter = await deploy("P2TRSignatureFraudRouter", {
    from: deployer,
    args: [Bridge.address],
    log: true,
    waitConfirmations: 1,
  })

  const routerContract = await ethers.getContractAt(
    "P2TRSignatureFraudRouter",
    p2trFraudRouter.address
  )
  if (
    (await routerContract.bridge()).toLowerCase() !==
    Bridge.address.toLowerCase()
  ) {
    throw new Error("P2TRSignatureFraudRouter is bound to the wrong Bridge")
  }
  if (
    (await routerContract.evidenceProtocolID()).toLowerCase() !==
    BOUNDED_V1_PROTOCOL_ID.toLowerCase()
  ) {
    throw new Error("Unexpected P2TR fraud evidence protocol ID")
  }

  // Re-read both reserved slots after the deployment transaction. Governance
  // ordering requires them to remain zero until an independently reviewed,
  // immutable COMPLETE_V2 router is available.
  await readBridgePreflightState(
    hre,
    Bridge.address,
    await ethers.provider.getBlockNumber()
  )

  await save("P2TRSignatureFraudRouter", {
    ...p2trFraudRouter,
    linkedData: {
      ...(p2trFraudRouter.linkedData ?? {}),
      frostCustodyPreflight: preflightReceipt,
    },
  })

  // NO-GO: BOUNDED_V1 cannot adjudicate every valid Bitcoin transaction
  // shape, so wiring it would make an unchallengeable FROST spend possible.
  // Do not call the one-shot setter and do not emit governance calldata. The
  // slot must remain available for a future COMPLETE_V2 implementation.
  console.log(
    `NO-GO: deployed bounded P2TR fraud router ${p2trFraudRouter.address}; ` +
      "leaving Bridge.p2trFraudRouter unset. Zero-FROST receipt: " +
      `${preflightReceipt.snapshotBlockNumber}/${preflightReceipt.snapshotBlockHash}. ` +
      "Do not upgrade this Bridge until a vetted immutable COMPLETE_V2 router exists."
  )

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(p2trFraudRouter)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "P2TRSignatureFraudRouter",
      address: p2trFraudRouter.address,
    })
  }
}

export default func

func.tags = ["P2TRSignatureFraudRouter"]
func.dependencies = ["FrostCustodyNoGo", "Bridge", "BridgeGovernance"]
