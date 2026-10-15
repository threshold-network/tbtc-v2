import { expect } from "chai"
import { requireValue } from "../../helpers/require-value"

describe("requireValue", () => {
  it("rejects missing RPC or ABI data with context", () => {
    expect(() => requireValue(null, "Transaction receipt")).to.throw(
      "Transaction receipt is not available"
    )
    expect(() => requireValue(undefined, "ABI fragment")).to.throw(
      "ABI fragment is not available"
    )
  })

  it("preserves defined values, including zero and false", () => {
    expect(requireValue(0, "Block number")).to.equal(0)
    expect(requireValue(false, "Flag")).to.equal(false)
    expect(requireValue("", "String")).to.equal("")
    const receipt = { blockNumber: 0 }
    expect(requireValue(receipt, "Transaction receipt")).to.equal(receipt)
  })
})
