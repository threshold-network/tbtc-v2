import { ethers, artifacts } from "hardhat"
import { expect } from "chai"

import func from "../deploy_l1/01_upgrade_arbitrum_l1_bitcoin_depositor_to_v2"

describe("UpgradeArbitrumL1BitcoinDepositorToV2 - Deploy Script Structure", () => {
  it("should export a default deploy function", () => {
    expect(func).to.be.a("function")
  })

  it("should define tags with the correct upgrade tag", () => {
    expect(func.tags).to.be.an("array")
    expect(func.tags).to.include("UpgradeArbitrumL1BitcoinDepositorToV2")
  })

  it("should define a skip function", () => {
    expect(func.skip).to.be.a("function")
  })

  it("should have skip return false by default", async () => {
    const shouldSkip = await func.skip!({} as any)
    expect(shouldSkip).to.equal(false)
  })
})

describe("UpgradeArbitrumL1BitcoinDepositorToV2 - Artifact Resolution", () => {
  it("should resolve the L1BTCDepositorWormholeV2 artifact", () => {
    const artifact = artifacts.readArtifactSync("L1BTCDepositorWormholeV2")

    expect(artifact.contractName).to.equal("L1BTCDepositorWormholeV2")
    expect(artifact.abi).to.be.an("array")
    expect(artifact.abi.length).to.be.greaterThan(0)
  })

  it("should resolve V2 via ethers.getContractFactory without HH700", async () => {
    const factory = await ethers.getContractFactory("L1BTCDepositorWormholeV2")
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
      const artifact = artifacts.readArtifactSync("L1BTCDepositorWormholeV2")
      const functionNames = artifact.abi
        .filter((entry: any) => entry.type === "function")
        .map((entry: any) => entry.name)

      expect(functionNames).to.include(fnName)
    })
  })
})
