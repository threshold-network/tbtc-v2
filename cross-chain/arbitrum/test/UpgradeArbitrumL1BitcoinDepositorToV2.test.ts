import { artifacts, ethers } from "hardhat"
import { assert } from "chai"
import fs from "fs"
import path from "path"

import func from "../deploy_l1/01_upgrade_arbitrum_l1_bitcoin_depositor_to_v2"

type ArtifactJson = {
  bytecode?: string
  deployedBytecode?: string
}

type AbiEntry = {
  type?: string
  name?: string
}

async function readArtifactJson(artifactPath: string): Promise<ArtifactJson> {
  const artifactContents = await fs.promises.readFile(artifactPath, "utf8")

  try {
    return JSON.parse(artifactContents) as ArtifactJson
  } catch (error) {
    throw new Error(
      `Failed to parse artifact JSON at ${artifactPath}: ${String(error)}`
    )
  }
}

async function artifactExists(artifactPath: string): Promise<boolean> {
  try {
    await fs.promises.access(artifactPath)
    return true
  } catch {
    return false
  }
}

function getFunctionNames(abi: AbiEntry[]): string[] {
  return abi.flatMap((entry) => {
    if (entry.type !== "function" || typeof entry.name !== "string") {
      return []
    }

    return [entry.name]
  })
}

describe("UpgradeArbitrumL1BitcoinDepositorToV2 - Deploy Script Structure", () => {
  it("should export a default deploy function", () => {
    assert.isFunction(func)
  })

  it("should define tags with the correct upgrade tag", () => {
    assert.isArray(func.tags)
    assert.include(func.tags, "UpgradeArbitrumL1BitcoinDepositorToV2")
  })

  it("should define a skip function", () => {
    assert.isFunction(func.skip)
  })

  it("should have skip return true after deployment", async () => {
    const shouldSkip = await func.skip!({} as any)

    assert.isTrue(shouldSkip)
  })
})

describe("UpgradeArbitrumL1BitcoinDepositorToV2 - Artifact Resolution", () => {
  const artifactRelativePath = path.join(
    "L1BTCDepositorWormholeV2Arbitrum.sol",
    "L1BTCDepositorWormholeV2Arbitrum.json"
  )
  const sourceArtifactPath = path.resolve(
    __dirname,
    "../../../solidity/build/contracts/cross-chain/wormhole",
    artifactRelativePath
  )
  const copiedArtifactPath = path.resolve(
    __dirname,
    "../build/contracts",
    artifactRelativePath
  )
  const requiredAbiFunctions = [
    "initializeDeposit",
    "finalizeDeposit",
    "quoteFinalizeDeposit",
    "initialize",
  ]

  it("should copy the latest V2 artifact from the solidity package", async () => {
    assert.isTrue(await artifactExists(sourceArtifactPath))
    assert.isTrue(await artifactExists(copiedArtifactPath))

    const sourceArtifact = await readArtifactJson(sourceArtifactPath)
    const copiedArtifact = await readArtifactJson(copiedArtifactPath)

    assert.equal(copiedArtifact.bytecode, sourceArtifact.bytecode)
    assert.equal(
      copiedArtifact.deployedBytecode,
      sourceArtifact.deployedBytecode
    )
  })

  it("should resolve the L1BTCDepositorWormholeV2Arbitrum artifact", () => {
    const artifact = artifacts.readArtifactSync(
      "L1BTCDepositorWormholeV2Arbitrum"
    )

    assert.equal(artifact.contractName, "L1BTCDepositorWormholeV2Arbitrum")
    assert.isArray(artifact.abi)
    assert.isAbove(artifact.abi.length, 0)
  })

  it("should resolve V2 via ethers.getContractFactory without HH700", async () => {
    const factory = await ethers.getContractFactory(
      "L1BTCDepositorWormholeV2Arbitrum"
    )
    const initializeFragment = factory.interface.getFunction("initialize")

    assert.exists(factory)
    assert.exists(initializeFragment)
    assert.equal(initializeFragment.name, "initialize")
  })

  requiredAbiFunctions.forEach((fnName) => {
    it(`should include ${fnName} in the resolved artifact ABI`, () => {
      const artifact = artifacts.readArtifactSync(
        "L1BTCDepositorWormholeV2Arbitrum"
      )
      const functionNames = getFunctionNames(artifact.abi as AbiEntry[])

      assert.include(functionNames, fnName)
    })
  })

  it("should expose source metadata for the copied V2 artifact", () => {
    const artifact = artifacts.readArtifactSync(
      "L1BTCDepositorWormholeV2Arbitrum"
    )

    assert.equal(
      artifact.sourceName,
      "contracts/cross-chain/wormhole/L1BTCDepositorWormholeV2Arbitrum.sol"
    )
    assert.notEqual(artifact.bytecode, "0x")
  })
})
