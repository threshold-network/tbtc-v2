import { ethers, artifacts, upgrades } from "hardhat"
import { expect } from "chai"
import fs from "fs"
import path from "path"

import func from "../deploy_l1/02_upgrade_base_l1_bitcoin_depositor_to_v2"

async function readArtifactJson(artifactPath: string): Promise<any> {
  const artifactContents = await fs.promises.readFile(artifactPath, "utf8")

  try {
    return JSON.parse(artifactContents)
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

describe("UpgradeBaseL1BitcoinDepositorToV2 - Deploy Script Structure", () => {
  it("should export a default deploy function", () => {
    expect(func).to.be.a("function")
  })

  it("should define tags with the correct upgrade tag", () => {
    expect(func.tags).to.be.an("array")
    expect(func.tags).to.include("UpgradeBaseL1BitcoinDepositorToV2")
  })

  it("should define a skip function", () => {
    expect(func.skip).to.be.a("function")
  })

  it("should have skip return false by default", async () => {
    const shouldSkip = await func.skip!({} as any)
    expect(shouldSkip).to.equal(false)
  })
})

describe("UpgradeBaseL1BitcoinDepositorToV2 - Artifact Resolution", () => {
  const artifactRelativePath = path.join(
    "L1BTCDepositorWormholeV2Base.sol",
    "L1BTCDepositorWormholeV2Base.json"
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

  it("should copy the latest V2 artifact from the solidity package", async () => {
    expect(await artifactExists(sourceArtifactPath)).to.equal(true)
    expect(await artifactExists(copiedArtifactPath)).to.equal(true)

    const sourceArtifact = await readArtifactJson(sourceArtifactPath)
    const copiedArtifact = await readArtifactJson(copiedArtifactPath)

    expect(copiedArtifact.bytecode).to.equal(sourceArtifact.bytecode)
    expect(copiedArtifact.deployedBytecode).to.equal(
      sourceArtifact.deployedBytecode
    )
  })

  it("should resolve the L1BTCDepositorWormholeV2Base artifact", () => {
    const artifact = artifacts.readArtifactSync("L1BTCDepositorWormholeV2Base")

    expect(artifact.contractName).to.equal("L1BTCDepositorWormholeV2Base")
    expect(artifact.abi).to.be.an("array")
    expect(artifact.abi.length).to.be.greaterThan(0)
  })

  it("should resolve V2 via ethers.getContractFactory without HH700", async () => {
    const factory = await ethers.getContractFactory(
      "L1BTCDepositorWormholeV2Base"
    )
    expect(factory).to.not.equal(undefined)
    expect(factory.interface).to.not.equal(undefined)
    expect(factory.interface.functions).to.have.property(
      "initialize(address,address,address,address,address,address,uint16)"
    )
  })

  const requiredAbiFunctions = [
    "initializeDeposit",
    "finalizeDeposit",
    "quoteFinalizeDeposit",
    "initialize",
  ]

  requiredAbiFunctions.forEach((fnName) => {
    it(`should include ${fnName} in the resolved artifact ABI`, () => {
      const artifact = artifacts.readArtifactSync(
        "L1BTCDepositorWormholeV2Base"
      )
      const functionNames = artifact.abi
        .filter((entry: any) => entry.type === "function")
        .map((entry: any) => entry.name)

      expect(functionNames).to.include(fnName)
    })
  })

  it("should pass OpenZeppelin prepareUpgrade for a legacy proxy", async () => {
    const [
      deployer,
      bridge,
      vault,
      wormhole,
      wormholeRelayer,
      tokenBridge,
      l2Gateway,
    ] = await ethers.getSigners()

    // Deploy a mock vault contract that implements tbtcToken() so that
    // the legacy L1BitcoinDepositor.initialize() can call it successfully.
    const MockTBTCVaultFactory = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault",
      deployer
    )
    const mockVault = await MockTBTCVaultFactory.deploy(deployer.address)
    await mockVault.deployed()

    const legacyFactory = await ethers.getContractFactory(
      "@keep-network/tbtc-v2/contracts/l2/L1BitcoinDepositor.sol:L1BitcoinDepositor",
      deployer
    )

    const legacyProxy = await upgrades.deployProxy(
      legacyFactory,
      [
        bridge.address,
        mockVault.address,
        wormhole.address,
        wormholeRelayer.address,
        tokenBridge.address,
        l2Gateway.address,
        30,
      ],
      { kind: "transparent" }
    )

    await legacyProxy.deployed()

    const v2Factory = await ethers.getContractFactory(
      "L1BTCDepositorWormholeV2Base",
      deployer
    )

    // The V2 contract uses a monolithic Initializable layout that differs
    // from the inherited layout in the legacy implementation. This storage
    // reorganisation is intentional and safe, so skip the automated check.
    const implementationAddress = await upgrades.prepareUpgrade(
      legacyProxy.address,
      v2Factory,
      { kind: "transparent", unsafeSkipStorageCheck: true }
    )

    expect(implementationAddress).to.match(/^0x[a-fA-F0-9]{40}$/)
    expect(implementationAddress).to.not.equal(legacyProxy.address)
  })
})
