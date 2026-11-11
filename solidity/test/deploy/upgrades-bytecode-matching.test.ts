import fs from "fs"
import path from "path"
import { expect } from "chai"
import { artifacts, config } from "hardhat"
import { getUnlinkedBytecode, getVersion } from "@openzeppelin/upgrades-core"

describe("OpenZeppelin bytecode matching", () => {
  let validations: Parameters<typeof getUnlinkedBytecode>[0]

  before(() => {
    validations = JSON.parse(
      fs.readFileSync(path.join(config.paths.cache, "validations.json"), "utf8")
    )
  })

  it("matches unlinked contracts in a build containing unrelated library link maps", async () => {
    const artifact = await artifacts.readArtifact("BTCDepositorWormhole")
    expect(artifact.linkReferences).to.deep.equal({})

    // BridgeGovernance's unrelated link offsets overlap this contract's CBOR
    // metadata. Matching must compare full hashes before interpreting metadata.
    expect(getUnlinkedBytecode(validations, artifact.bytecode)).to.equal(
      artifact.bytecode
    )
    expect(() => getVersion(artifact.bytecode)).not.to.throw()
  })

  it("still identifies the correct library-linked bytecode", async () => {
    const artifact = await artifacts.readArtifact("BridgeGovernance")
    const placeholder = /__\$[0-9a-fA-F]{34}\$__/g
    expect(artifact.bytecode).to.match(placeholder)
    const linked = artifact.bytecode.replace(placeholder, "11".repeat(20))

    expect(getUnlinkedBytecode(validations, linked)).to.equal(artifact.bytecode)
  })

  it("still rejects malformed bytecode instead of hiding validation errors", () => {
    expect(() =>
      getVersion(getUnlinkedBytecode(validations, "0xnothex"))
    ).to.throw("Bytecode is not a valid hex string")
  })
})
