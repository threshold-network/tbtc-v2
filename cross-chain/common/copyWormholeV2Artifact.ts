import type { HardhatRuntimeEnvironment } from "hardhat/types"
import * as fs from "fs"
import * as path from "path"

export async function copyWormholeV2Artifact(
  hre: HardhatRuntimeEnvironment,
  packageDir: string
): Promise<void> {
  const contractName = "L1BTCDepositorWormholeV2"
  const sourceArtifactDir = path.resolve(
    packageDir,
    `../../solidity/build/contracts/cross-chain/wormhole/${contractName}.sol`
  )
  const targetArtifactDir = path.resolve(
    hre.config.paths.artifacts,
    `contracts/${contractName}.sol`
  )

  await fs.promises.rm(targetArtifactDir, { recursive: true, force: true })

  try {
    await fs.promises.access(sourceArtifactDir)
  } catch {
    throw new Error(
      `Missing ${contractName} artifact at ${sourceArtifactDir}. ` +
        "Build the solidity package before compiling this cross-chain package."
    )
  }

  await fs.promises.mkdir(targetArtifactDir, { recursive: true })

  const files = await fs.promises.readdir(sourceArtifactDir)

  for (const file of files) {
    await fs.promises.copyFile(
      path.join(sourceArtifactDir, file),
      path.join(targetArtifactDir, file)
    )
  }
}
