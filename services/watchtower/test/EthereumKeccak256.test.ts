import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ethereumKeccak256 } from "../src/EthereumKeccak256.js"

describe("local Ethereum Keccak-256", () => {
  it("matches the canonical empty runtime-code hash", () => {
    assert.equal(
      ethereumKeccak256("0x"),
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    )
  })

  it("matches the canonical abc vector and rejects malformed hex", () => {
    assert.equal(
      ethereumKeccak256(Buffer.from("abc")),
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    )
    assert.throws(() => ethereumKeccak256("0x0"), /even-length hexadecimal/)
  })
})
