/* eslint-disable no-await-in-loop, no-continue, no-restricted-syntax, prefer-destructuring, no-console */

import type { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

export interface BridgeControllerAuthorizationSyncOptions {
  bridgeAddress?: string
  bridgeGovernanceAddress?: string
  increaserAddresses?: string[]
  governancePrivateKey?: string
}

const BRIDGE_ABI = [
  "function authorizedBalanceIncreasers(address) view returns (bool)",
  "event AuthorizedBalanceIncreaserUpdated(address indexed increaser, bool authorized)",
]

const BRIDGE_GOVERNANCE_ABI = [
  "function setAuthorizedBalanceIncreaser(address,bool)",
]

export async function syncBridgeControllerAuthorizations(
  hre: HardhatRuntimeEnvironment,
  options: BridgeControllerAuthorizationSyncOptions = {}
): Promise<void> {
  const { ethers, deployments, getNamedAccounts } = hre
  const provider = ethers.provider

  const increaserAddresses =
    options.increaserAddresses
      ?.map((addr) => addr.trim())
      .filter((addr) => addr.length > 0) ?? []

  const desiredIncreasers = Array.from(
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

  let bridgeAddress = options.bridgeAddress
  if (!bridgeAddress) {
    bridgeAddress = (await deployments.getOrNull("Bridge"))?.address
  }

  if (!bridgeAddress) {
    console.log("⚠️  Bridge address not provided; skipping controller setup.")
    return
  }

  let bridgeGovernanceAddress = options.bridgeGovernanceAddress
  if (!bridgeGovernanceAddress) {
    bridgeGovernanceAddress = (await deployments.getOrNull("BridgeGovernance"))
      ?.address
  }

  if (!bridgeGovernanceAddress) {
    console.log(
      "⚠️  BridgeGovernance address not provided; cannot perform authorization."
    )
    return
  }

  const bridge = new ethers.Contract(bridgeAddress, BRIDGE_ABI, provider)
  const bridgeGovernance = new ethers.Contract(
    bridgeGovernanceAddress,
    BRIDGE_GOVERNANCE_ABI,
    provider
  )

  let governancePrivateKey = options.governancePrivateKey
  if (!governancePrivateKey) {
    const envKey = process.env.BRIDGE_GOVERNANCE_PK
    if (envKey && envKey.trim().length > 0) {
      governancePrivateKey = envKey.trim()
    }
  }

  let signer = governancePrivateKey
    ? new ethers.Wallet(governancePrivateKey, provider)
    : undefined

  if (!signer) {
    const { governance } = await getNamedAccounts()
    if (!governance) {
      console.log(
        "⚠️  No governance account configured and no private key supplied; skipping."
      )
      return
    }
    signer = await ethers.getSigner(governance)
  }

  const bridgeGovernanceWithSigner = bridgeGovernance.connect(signer)

  let existingIncreasers: Set<string> | undefined
  try {
    const bridgeDeployment = await deployments.getOrNull("Bridge")
    const fromBlock =
      (bridgeDeployment?.receipt?.blockNumber as number | undefined) ?? 0
    const events = await bridge.queryFilter(
      bridge.filters.AuthorizedBalanceIncreaserUpdated(),
      fromBlock,
      "latest"
    )

    existingIncreasers = new Set<string>()
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
  } catch (error) {
    console.warn(
      "⚠️  Failed to fetch existing authorized increasers; revocations will be skipped.",
      error
    )
  }

  if (desiredIncreasers.length === 0) {
    if (!existingIncreasers) {
      console.log(
        "ℹ️  No increaser addresses provided and existing authorizations could not be determined; nothing to configure."
      )
      return
    }

    if (existingIncreasers.size === 0) {
      console.log("ℹ️  No increaser addresses provided; nothing to configure.")
      return
    }

    console.log(
      "ℹ️  No increaser addresses provided; existing authorizations will be revoked."
    )
  }

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

  if (!existingIncreasers) {
    return
  }

  const desiredIncreaserSet = new Set(desiredIncreasers)
  const increasersToRevoke = Array.from(existingIncreasers).filter(
    (addr) => !desiredIncreaserSet.has(addr)
  )

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

const noopDeploy: DeployFunction = async () => {}
noopDeploy.skip = async () => true

export default noopDeploy
