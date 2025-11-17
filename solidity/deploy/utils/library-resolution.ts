/* eslint-disable no-console */

import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

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
  const deployment = await deployments.deploy(libName, {
    from: signerAddress,
    log: true,
    skipIfAlreadyDeployed: true,
    contract: fqn,
    library: true,
  })
  if (!deployment.address) {
    throw new Error(`Failed to deploy library ${libName}`)
  }
  return deployment.address
}

export async function verifyLibraryBytecodes(
  hre: HardhatRuntimeEnvironment,
  libs: Record<string, string>
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
        deployments.log(
          `⚠️  Library ${name} at ${address} has no code on-chain. Check address.`
        )
        continue
      }

      // Some toolchains include metadata; direct equality is fine here since we
      // compare runtime bytecode to on-chain code. Warn if mismatch.
      if (expected && expected !== "0x" && onchain !== expected) {
        deployments.log(
          `⚠️  Bytecode mismatch for ${name} at ${address}. Using on-chain code; verify library compatibility.`
        )
      }
    } catch (error) {
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
