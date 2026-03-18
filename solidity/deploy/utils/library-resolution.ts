/* eslint-disable no-console */

import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction, DeployOptions } from "hardhat-deploy/types"

export async function resolveLibrary(
  deployments: HardhatRuntimeEnvironment["deployments"],
  signerAddress: string,
  libName: string
): Promise<string> {
  const existing = await deployments.getOrNull(libName)
  if (existing?.address) {
    return existing.address
  }

  const envVar = `${libName.toUpperCase()}_LIB_ADDRESS`
  const envValue = process.env[envVar]
  if (envValue && envValue.length > 0) {
    return envValue
  }

  const fqn = `contracts/bridge/${libName}.sol:${libName}`
  const deployOptions = {
    from: signerAddress,
    log: true,
    skipIfAlreadyDeployed: true,
    contract: fqn,
    library: true,
  } as DeployOptions
  const deployment = await deployments.deploy(libName, deployOptions)
  if (!deployment.address) {
    throw new Error(`Failed to deploy library ${libName}`)
  }
  return deployment.address
}

export async function verifyLibraryBytecodes(
  hre: HardhatRuntimeEnvironment,
  libs: Record<string, string>,
  strict = false
): Promise<void> {
  const { deployments, ethers } = hre
  for (const [name, address] of Object.entries(libs)) {
    try {
      const artifact = await deployments.getArtifact(name)
      const expected = (
        artifact.deployedBytecode ||
        artifact.bytecode ||
        ""
      ).toLowerCase()
      const onchain = (await ethers.provider.getCode(address)).toLowerCase()

      if (!onchain || onchain === "0x") {
        const message = `Library ${name} at ${address} has no code on-chain. Check address.`
        if (strict) {
          throw new Error(message)
        }
        deployments.log(`⚠️  ${message}`)
      } else if (expected && expected !== "0x" && onchain !== expected) {
        const message = `Bytecode mismatch for ${name} at ${address}. Verify library compatibility before upgrading.`
        if (strict) {
          throw new Error(message)
        }
        deployments.log(`⚠️  ${message}`)
      }
    } catch (error) {
      if (strict) {
        throw error
      }
      deployments.log(
        `⚠️  Skipping bytecode check for ${name} at ${address}: ${String(
          error
        )}`
      )
    }
  }
}

// Expose a no-op deploy script so that hardhat-deploy can safely load this
// helper module under the `deploy/` tree without attempting to execute any
// on-chain actions.
const noopDeploy: DeployFunction = async () => {}
noopDeploy.skip = async () => true

export default noopDeploy
