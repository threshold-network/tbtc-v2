import type { HardhatRuntimeEnvironment } from "hardhat/types"
import * as fs from "fs"
import * as path from "path"

async function copySingleArtifact(
  hre: HardhatRuntimeEnvironment,
  packageDir: string,
  contractName: string
): Promise<void> {
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

  // Merge the V2 contract's OpenZeppelin upgrade validation data from the
  // solidity package into this package's cache. The OZ upgrades plugin
  // populates validations.json only for locally-compiled contracts. Since
  // the V2 artifact is copied (not compiled here), its validation entry
  // must be merged so that prepareUpgrade() can resolve the contract.
  await mergeV2ValidationData(hre, packageDir, contractName)
}

async function mergeV2ValidationData(
  hre: HardhatRuntimeEnvironment,
  packageDir: string,
  contractName: string
): Promise<void> {
  const sourceCachePath = path.resolve(
    packageDir,
    "../../solidity/cache/validations.json"
  )
  const targetCachePath = path.resolve(
    hre.config.paths.cache,
    "validations.json"
  )

  let sourceData: any
  try {
    sourceData = JSON.parse(await fs.promises.readFile(sourceCachePath, "utf8"))
  } catch {
    // Solidity package validation cache not available; skip silently.
    return
  }

  // Ensure a target validation log exists to merge into. Packages that compile
  // no local upgradeable source (they only consume staged artifacts) never have
  // the OZ plugin create this file, so default to an empty log rather than
  // skipping the merge.
  let targetData: any
  try {
    targetData = JSON.parse(await fs.promises.readFile(targetCachePath, "utf8"))
  } catch {
    targetData = { log: [] }
  }

  const sourceLog: any[] = sourceData.log || []
  const targetLog: any[] = targetData.log || []

  // Bring EVERY source log entry describing this contract into the target, not
  // just the first. A re-upgrade (same contract name, new build) produces a new
  // validation entry keyed by a new bytecode hash; skipping whenever ANY
  // same-named entry was already present left a stale entry in place and
  // prevented `prepareUpgrade` from resolving the freshly staged
  // implementation. Dedupe by serialized identity so repeated compiles stay
  // idempotent; the OZ plugin selects the matching entry by bytecode hash, so
  // carrying older entries alongside the new one is harmless.
  const seen = new Set(targetLog.map((entry: any) => JSON.stringify(entry)))
  let changed = false
  for (const entry of sourceLog) {
    const describesContract = Object.keys(entry).some((key) =>
      key.includes(contractName)
    )
    if (!describesContract) continue
    const serialized = JSON.stringify(entry)
    if (seen.has(serialized)) continue
    targetLog.push(entry)
    seen.add(serialized)
    changed = true
  }

  if (!changed) return

  targetData.log = targetLog

  await fs.promises.mkdir(hre.config.paths.cache, { recursive: true })
  await fs.promises.writeFile(
    targetCachePath,
    JSON.stringify(targetData, null, 2)
  )
}

export async function copyWormholeV2Artifact(
  hre: HardhatRuntimeEnvironment,
  packageDir: string
): Promise<void> {
  // Arbitrum variant (Initializable first in inheritance, tbtcToken at slot 200)
  await copySingleArtifact(hre, packageDir, "L1BTCDepositorWormholeV2Arbitrum")
  // Base variant (Initializable implicit via OwnableUpgradeable, tbtcToken at slot 201)
  await copySingleArtifact(hre, packageDir, "L1BTCDepositorWormholeV2Base")
}

// Stages the shared `BTCDepositorWormhole` implementation for packages (such as
// Sui) that consume it directly rather than through an L1-variant wrapper. This
// is intentionally distinct from `copyWormholeV2Artifact`, which stages the
// Arbitrum/Base L1 variants; a consumer of the shared implementation must not
// pull in those variants.
//
// The OpenZeppelin upgrades plugin only writes `validations.json` for contracts
// it compiles locally. A package that compiles no local upgradeable source has
// no `validations.json` for `mergeV2ValidationData` to merge the staged entry
// into, so the merge would silently no-op. Seeding an empty validation log
// before the copy gives the merge a target to write into, ensuring the staged
// contract's validation entry lands so `prepareUpgrade()` can resolve it.
export async function copyBTCDepositorWormholeArtifact(
  hre: HardhatRuntimeEnvironment,
  packageDir: string
): Promise<void> {
  await seedEmptyValidationLog(hre)
  await copySingleArtifact(hre, packageDir, "BTCDepositorWormhole")
}

async function seedEmptyValidationLog(
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const targetCachePath = path.resolve(
    hre.config.paths.cache,
    "validations.json"
  )

  try {
    await fs.promises.access(targetCachePath)
    return
  } catch {
    // No validation cache exists yet; create an empty log below.
  }

  await fs.promises.mkdir(hre.config.paths.cache, { recursive: true })
  await fs.promises.writeFile(
    targetCachePath,
    JSON.stringify({ log: [] }, null, 2)
  )
}
