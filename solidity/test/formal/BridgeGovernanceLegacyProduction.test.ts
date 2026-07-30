import fs from "fs"
import path from "path"
import { expect } from "chai"
import { ethers } from "ethers"
import {
  LEGACY_GOVERNANCE_STORAGE_LAYOUT,
  LEGACY_GOVERNANCE_STORAGE_LAYOUT_HASH,
} from "../../scripts/ecdsa-fraud-router-cutover-lib"

type ProductionFixture = {
  network: string
  chainId: number
  address: string
  deploymentBlock: number
  runtimeCodeHash: string
  storageLayoutHash: string
  storageSlots: Record<string, number>
}

describe("legacy production BridgeGovernance cutover fixture", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "BridgeGovernance.legacy-production.json"),
      "utf8"
    )
  ) as ProductionFixture
  const deployment = JSON.parse(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "../../deployments/mainnet/BridgeGovernance.json"
      ),
      "utf8"
    )
  ) as {
    address: string
    deployedBytecode: string
    receipt: { blockNumber: number }
    libraries: Record<string, string>
  }

  it("pins the exact linked mainnet runtime code hash", () => {
    expect(fixture.network).to.equal("mainnet")
    expect(fixture.chainId).to.equal(1)
    expect(deployment.address).to.equal(fixture.address)
    expect(deployment.receipt.blockNumber).to.equal(fixture.deploymentBlock)

    const libraryAddresses = Object.values(deployment.libraries)
    expect(libraryAddresses).to.have.length(1)
    const linkedRuntime = deployment.deployedBytecode.replace(
      /__\$[0-9a-f]{34}\$__/gi,
      libraryAddresses[0].slice(2).toLowerCase()
    )
    expect(linkedRuntime).not.to.include("__")
    expect(ethers.utils.keccak256(linkedRuntime)).to.equal(
      fixture.runtimeCodeHash
    )
  })

  it("pins every legacy handoff storage slot from zero through 74", () => {
    expect(LEGACY_GOVERNANCE_STORAGE_LAYOUT_HASH).to.equal(
      fixture.storageLayoutHash
    )
    expect(fixture.storageSlots).to.deep.equal({
      owner: LEGACY_GOVERNANCE_STORAGE_LAYOUT.ownerSlot,
      pendingParametersFirst:
        LEGACY_GOVERNANCE_STORAGE_LAYOUT.pendingParameterSlots.first,
      pendingParametersLast:
        LEGACY_GOVERNANCE_STORAGE_LAYOUT.pendingParameterSlots.last,
      bridge: LEGACY_GOVERNANCE_STORAGE_LAYOUT.bridgeSlot,
      governanceDelay:
        LEGACY_GOVERNANCE_STORAGE_LAYOUT.governanceDelaySlots.current,
      pendingGovernanceDelay:
        LEGACY_GOVERNANCE_STORAGE_LAYOUT.governanceDelaySlots.pending,
      governanceDelayChangeInitiated:
        LEGACY_GOVERNANCE_STORAGE_LAYOUT.governanceDelaySlots.initiatedAt,
      bridgeTransferChangeInitiated:
        LEGACY_GOVERNANCE_STORAGE_LAYOUT.bridgeTransferSlots.initiatedAt,
      newBridgeGovernance:
        LEGACY_GOVERNANCE_STORAGE_LAYOUT.bridgeTransferSlots.newGovernance,
    })
    expect(fixture.storageSlots.owner).to.equal(0)
    expect(fixture.storageSlots.newBridgeGovernance).to.equal(74)
  })
})
