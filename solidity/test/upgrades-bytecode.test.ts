import { readFileSync } from "fs"
import path from "path"
import { artifacts, config } from "hardhat"
import { expect } from "chai"
import {
  assertUpgradeSafe,
  ContractSourceNotFoundError,
  getUnlinkedBytecode,
  getVersion,
} from "@openzeppelin/upgrades-core"
import type { ValidationDataCurrent } from "@openzeppelin/upgrades-core"

describe("OpenZeppelin upgrade bytecode matching", () => {
  let validations: ValidationDataCurrent
  let depositorBytecode: string
  let governanceBytecode: string

  before(async () => {
    validations = JSON.parse(
      readFileSync(path.join(config.paths.cache, "validations.json"), "utf8")
    ) as ValidationDataCurrent
    depositorBytecode = (await artifacts.readArtifact("BTCDepositorWormhole"))
      .bytecode
    governanceBytecode = (await artifacts.readArtifact("BridgeGovernance"))
      .bytecode
  })

  it("should match an unlinked contract with unrelated library references in the cache", () => {
    // BridgeGovernance's link offsets intersect this contract's metadata.
    // Trying to parse metadata for that unrelated candidate used to throw.
    expect(
      validations.log.some((run) =>
        Object.entries(run).some(
          ([name, contract]) =>
            name.endsWith(":BridgeGovernance") &&
            contract.linkReferences.length > 0
        )
      )
    ).to.equal(true)
    expect(getUnlinkedBytecode(validations, depositorBytecode)).to.equal(
      depositorBytecode
    )
    expect(() =>
      assertUpgradeSafe(validations, getVersion(depositorBytecode), {
        kind: "transparent",
      })
    ).not.to.throw()
  })

  it("should still recover the matching contract's external library references", () => {
    const linkedBytecode = governanceBytecode.replace(
      /__\$[0-9a-f]{34}\$__/g,
      "11".repeat(20)
    )
    expect(linkedBytecode).not.to.equal(governanceBytecode)
    expect(getUnlinkedBytecode(validations, linkedBytecode)).to.equal(
      governanceBytecode
    )
  })

  it("should reject bytecode that does not match a validated contract", () => {
    const unknownBytecode = `0xfe${depositorBytecode.slice(4)}`
    expect(unknownBytecode).not.to.equal(depositorBytecode)
    const unlinkedBytecode = getUnlinkedBytecode(validations, unknownBytecode)
    expect(unlinkedBytecode).to.equal(unknownBytecode)
    expect(() =>
      assertUpgradeSafe(validations, getVersion(unlinkedBytecode), {
        kind: "transparent",
      })
    ).to.throw(ContractSourceNotFoundError)
  })

  it("should reject malformed bytecode", () => {
    const malformedBytecode = `0xzz${depositorBytecode.slice(4)}`
    expect(() =>
      getVersion(getUnlinkedBytecode(validations, malformedBytecode))
    ).to.throw("Bytecode is not a valid hex string")
  })
})
