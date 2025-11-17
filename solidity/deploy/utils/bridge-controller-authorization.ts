/* eslint-disable no-await-in-loop, no-continue, no-restricted-syntax, prefer-destructuring, no-console */

import type { Contract } from "ethers"
import type { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

export interface BridgeControllerAuthorizationSyncOptions {
  bridgeAddress?: string
  bridgeGovernanceAddress?: string
  increaserAddresses?: string[]
  governancePrivateKey?: string
  // When true, allows revoking all existing authorizations when
  // `increaserAddresses` is empty or omitted. If false/omitted, a completely
  // empty desired set will leave existing authorizations untouched unless the
  // `BRIDGE_ALLOW_MASS_CONTROLLER_REVOKE` env var is set to "true".
  allowMassRevoke?: boolean
}

const BRIDGE_ABI = [
  "function authorizedBalanceIncreasers(address) view returns (bool)",
  "event AuthorizedBalanceIncreaserUpdated(address indexed increaser, bool authorized)",
]

const BRIDGE_GOVERNANCE_ABI = [
  "function setAuthorizedBalanceIncreaser(address,bool)",
]

async function getDesiredIncreasers(
  hre: HardhatRuntimeEnvironment,
  rawAddresses: string[] | undefined
): Promise<string[]> {
  const { ethers } = hre
  const increaserAddresses =
    rawAddresses
      ?.map((addr) => addr.trim())
      .filter((addr) => addr.length > 0) ?? []

  return Array.from(
    new Set(
      increaserAddresses.map((addr) => {
        try {
          return ethers.utils.getAddress(addr)
        } catch (error) {
          throw new Error(`Invalid increaser address provided: ${addr}`)
        }
      })
    )
  )
}

async function resolveBridgeContracts(
  hre: HardhatRuntimeEnvironment,
  bridgeAddress?: string,
  bridgeGovernanceAddress?: string
): Promise<{
  bridge: Contract
  bridgeGovernance: Contract
}> {
  const { ethers, deployments } = hre
  const provider = ethers.provider

  let resolvedBridgeAddress = bridgeAddress
  if (!resolvedBridgeAddress) {
    resolvedBridgeAddress = (await deployments.getOrNull("Bridge"))?.address
  }

  if (!resolvedBridgeAddress) {
    console.log("⚠️  Bridge address not provided; skipping controller setup.")
    throw new Error("Bridge address not provided")
  }

  let resolvedBridgeGovernanceAddress = bridgeGovernanceAddress
  if (!resolvedBridgeGovernanceAddress) {
    resolvedBridgeGovernanceAddress = (
      await deployments.getOrNull("BridgeGovernance")
    )?.address
  }

  if (!resolvedBridgeGovernanceAddress) {
    console.log(
      "⚠️  BridgeGovernance address not provided; cannot perform authorization."
    )
    throw new Error("BridgeGovernance address not provided")
  }

  const bridge = new ethers.Contract(
    resolvedBridgeAddress,
    BRIDGE_ABI,
    provider
  )
  const bridgeGovernance = new ethers.Contract(
    resolvedBridgeGovernanceAddress,
    BRIDGE_GOVERNANCE_ABI,
    provider
  )

  return { bridge, bridgeGovernance }
}

async function getGovernanceSigner(
  hre: HardhatRuntimeEnvironment,
  governancePrivateKey?: string
) {
  const { ethers, getNamedAccounts } = hre
  const provider = ethers.provider

  let resolvedPrivateKey = governancePrivateKey
  if (!resolvedPrivateKey) {
    const envKey = process.env.BRIDGE_GOVERNANCE_PK
    if (envKey && envKey.trim().length > 0) {
      resolvedPrivateKey = envKey.trim()
    }
  }

  if (resolvedPrivateKey) {
    return new ethers.Wallet(resolvedPrivateKey, provider)
  }

  const { governance } = await getNamedAccounts()
  if (!governance) {
    console.log(
      "⚠️  No governance account configured and no private key supplied; skipping."
    )
    return undefined
  }

  return ethers.getSigner(governance)
}

async function readExistingAuthorizedIncreasers(
  hre: HardhatRuntimeEnvironment,
  bridge: Contract
): Promise<Set<string> | undefined> {
  const { deployments, ethers } = hre

  try {
    const bridgeDeployment = await deployments.getOrNull("Bridge")
    const fromBlock =
      (bridgeDeployment?.receipt?.blockNumber as number | undefined) ?? 0
    const events = await bridge.queryFilter(
      bridge.filters.AuthorizedBalanceIncreaserUpdated(),
      fromBlock,
      "latest"
    )

    const existingIncreasers = new Set<string>()
    for (const event of events) {
      const increaser = event.args?.increaser
      const authorized = event.args?.authorized
      if (!increaser || authorized === undefined) {
        continue
      }
      const normalized = ethers.utils.getAddress(increaser)
      if (authorized) {
        existingIncreasers.add(normalized)
      } else {
        existingIncreasers.delete(normalized)
      }
    }

    return existingIncreasers
  } catch (error) {
    console.warn(
      "⚠️  Failed to fetch existing authorized increasers; revocations will be skipped.",
      error
    )
    return undefined
  }
}

interface AuthorizationPlan {
  desiredIncreasers: string[]
  existingIncreasers?: Set<string>
  increasersToRevoke: string[]
}

function computeAuthorizationPlan(
  desiredIncreasers: string[],
  existingIncreasers: Set<string> | undefined,
  allowMassRevoke: boolean
): AuthorizationPlan | undefined {
  if (desiredIncreasers.length === 0) {
    if (!existingIncreasers) {
      console.log(
        "ℹ️  No increaser addresses provided and existing authorizations could not be determined; nothing to configure."
      )
      return undefined
    }

    if (existingIncreasers.size === 0) {
      console.log("ℹ️  No increaser addresses provided; nothing to configure.")
      return undefined
    }

    if (!allowMassRevoke) {
      console.log(
        "ℹ️  No increaser addresses provided; existing authorizations will be left unchanged (mass revoke disabled). Set BRIDGE_ALLOW_MASS_CONTROLLER_REVOKE=true or pass allowMassRevoke to enable revocation."
      )
      return undefined
    }

    console.log(
      "ℹ️  No increaser addresses provided; existing authorizations will be revoked."
    )
  }

  const increasersToRevoke: string[] = []
  if (existingIncreasers) {
    const desiredIncreaserSet = new Set(desiredIncreasers)
    for (const addr of existingIncreasers) {
      if (!desiredIncreaserSet.has(addr)) {
        increasersToRevoke.push(addr)
      }
    }
  }

  return {
    desiredIncreasers,
    existingIncreasers,
    increasersToRevoke,
  }
}

async function applyAuthorizationPlan(
  bridge: Contract,
  bridgeGovernanceWithSigner: Contract,
  plan: AuthorizationPlan
): Promise<void> {
  const { desiredIncreasers, existingIncreasers, increasersToRevoke } = plan

  for (const addr of desiredIncreasers) {
    try {
      const alreadyAuthorized = await bridge.authorizedBalanceIncreasers(addr)
      if (alreadyAuthorized) {
        console.log(`   ♻️  ${addr} already authorized`)
        continue
      }

      const tx = await bridgeGovernanceWithSigner.setAuthorizedBalanceIncreaser(
        addr,
        true
      )
      console.log(
        `   ⛓️  Submitted authorization for ${addr}. Tx hash: ${tx.hash}`
      )
      await tx.wait()
      console.log(`   ✅ Authorized ${addr}`)
    } catch (error) {
      console.error(`   ❌ Failed to authorize ${addr}`, error)
    }
  }

  if (!existingIncreasers || increasersToRevoke.length === 0) {
    return
  }

  for (const addr of increasersToRevoke) {
    try {
      const stillAuthorized = await bridge.authorizedBalanceIncreasers(addr)
      if (!stillAuthorized) {
        console.log(`   ♻️  ${addr} already deauthorized`)
        continue
      }

      const tx = await bridgeGovernanceWithSigner.setAuthorizedBalanceIncreaser(
        addr,
        false
      )
      console.log(
        `   ⛔  Submitted deauthorization for ${addr}. Tx hash: ${tx.hash}`
      )
      await tx.wait()
      console.log(`   ✅ Deauthorized ${addr}`)
    } catch (error) {
      console.error(`   ❌ Failed to revoke ${addr}`, error)
    }
  }
}

export async function syncBridgeControllerAuthorizations(
  hre: HardhatRuntimeEnvironment,
  options: BridgeControllerAuthorizationSyncOptions = {}
): Promise<void> {
  const desiredIncreasers = await getDesiredIncreasers(
    hre,
    options.increaserAddresses
  )

  const allowMassRevokeEnv =
    process.env.BRIDGE_ALLOW_MASS_CONTROLLER_REVOKE === "true"
  const allowMassRevoke = options.allowMassRevoke === true || allowMassRevokeEnv

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
  const existingIncreasers = await readExistingAuthorizedIncreasers(hre, bridge)

  const plan = computeAuthorizationPlan(
    desiredIncreasers,
    existingIncreasers,
    allowMassRevoke
  )
  if (!plan) {
    return
  }

  await applyAuthorizationPlan(bridge, bridgeGovernanceWithSigner, plan)
}

const noopDeploy: DeployFunction = async () => {}
noopDeploy.skip = async () => true

export default noopDeploy
