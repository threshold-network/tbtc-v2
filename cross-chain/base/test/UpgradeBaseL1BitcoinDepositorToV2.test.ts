import { ethers, artifacts, upgrades } from "hardhat"
import { expect } from "chai"

import func from "../deploy_l1/02_upgrade_base_l1_bitcoin_depositor_to_v2"

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

  it("should pass OpenZeppelin prepareUpgrade for a legacy proxy", async () => {
    const [deployer, bridge, vault, wormhole, wormholeRelayer, tokenBridge, l2Gateway] =
      await ethers.getSigners()

    const legacyFactory = await ethers.getContractFactory(
      "@keep-network/tbtc-v2/contracts/l2/L1BitcoinDepositor.sol:L1BitcoinDepositor",
      deployer
    )

    const legacyProxy = await upgrades.deployProxy(
      legacyFactory,
      [
        bridge.address,
        vault.address,
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
      "L1BTCDepositorWormholeV2",
      deployer
    )

    const implementationAddress = await upgrades.prepareUpgrade(
      legacyProxy.address,
      v2Factory,
      { kind: "transparent" }
    )

    expect(implementationAddress).to.match(/^0x[a-fA-F0-9]{40}$/)
    expect(implementationAddress).to.not.equal(legacyProxy.address)
  })
})
