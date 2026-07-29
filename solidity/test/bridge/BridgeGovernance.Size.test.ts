import { expect } from "chai"
import { artifacts } from "hardhat"

describe("BridgeGovernance deployed bytecode size", () => {
  it("keeps at least 1 KiB of EIP-170 headroom", async () => {
    const artifact = await artifacts.readArtifact("BridgeGovernance")
    const deployedSize = (artifact.deployedBytecode.length - 2) / 2

    expect(deployedSize).to.be.lte(24_576 - 1_024)
  })
})
