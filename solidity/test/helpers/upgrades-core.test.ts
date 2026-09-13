import { expect } from "chai"
import {
  getUnlinkedBytecode,
  getVersion,
  ValidationRunData,
} from "@openzeppelin/upgrades-core"

describe("upgrades-core library matching", () => {
  const placeholder = "__$1234567890123456789012345678901234$__"
  const libraryAddress = "12".repeat(20)
  const prefix = "60".repeat(23)
  const suffix = "60".repeat(30)
  const unlinkedBytecode = `0x${prefix}${placeholder}${suffix}`
  const validation: ValidationRunData = {
    LibraryLinkedContract: {
      version: getVersion(unlinkedBytecode),
      src: "Other.sol:1",
      inherit: [],
      libraries: [],
      methods: [],
      linkReferences: [
        {
          src: "Other.sol",
          name: "Lib",
          start: 23,
          length: 20,
          placeholder,
        },
      ],
      errors: [],
      layout: { storage: [], types: {} },
    },
  }

  it("ignores unrelated link references that overlap CBOR metadata", () => {
    // The CBOR trailer encodes { solc: <0x000811> } before its length. The unrelated
    // placeholder straddles the metadata boundary at byte 40, so trimming
    // metadata before checking the candidate hash would split the placeholder.
    const bytecode = `0x${"60".repeat(40)}a164736f6c6343000811000a`

    expect(getUnlinkedBytecode(validation, bytecode)).to.equal(bytecode)
  })

  it("restores library placeholders when the full bytecode hash matches", () => {
    const linkedBytecode = `0x${prefix}${libraryAddress}${suffix}`

    expect(getUnlinkedBytecode(validation, linkedBytecode)).to.equal(
      unlinkedBytecode
    )
  })

  it("still rejects malformed bytecode", () => {
    expect(() => getUnlinkedBytecode(validation, "0xnot-hex")).to.throw(
      "Bytecode is not a valid hex string"
    )
  })
})
