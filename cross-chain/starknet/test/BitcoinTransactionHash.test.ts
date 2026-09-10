import { createHash } from "crypto"
import { expect } from "chai"
import { ethers } from "hardhat"
import type { Contract } from "ethers"

describe("Bitcoin transaction hash", () => {
  let harness: Contract

  before(async () => {
    harness = await (
      await ethers.getContractFactory("BitcoinTransactionHashTest")
    ).deploy()
    await harness.deployed()
  })

  // Exercise empty vectors and boundaries in ABI memory words, SHA-256
  // blocks/padding, and Bitcoin's compact-size encoding. This helper hashes
  // the serialized fields; validating their transaction structure is the
  // Bridge's responsibility.
  const lengths = [
    [0, 0],
    [1, 1],
    [23, 24],
    [24, 24],
    [31, 32],
    [32, 33],
    [252, 253],
    [253, 254],
    [1024, 257],
  ]

  for (const [inputLength, outputLength] of lengths) {
    it(`double-hashes ${inputLength}/${outputLength}-byte vectors without reversing bytes`, async () => {
      const inputVector = Buffer.from(
        Array.from({ length: inputLength }, (_, i) => i % 256)
      )
      const outputVector = Buffer.from(
        Array.from({ length: outputLength }, (_, i) => (255 - i) & 255)
      )
      const version = Buffer.from("02000000", "hex")
      const locktime = Buffer.from("78563412", "hex")
      const serialized = Buffer.concat([
        version,
        inputVector,
        outputVector,
        locktime,
      ])
      const firstHash = createHash("sha256").update(serialized).digest()
      const expected = `0x${createHash("sha256")
        .update(firstHash)
        .digest("hex")}`

      expect(
        await harness.calculateHash({
          version,
          inputVector,
          outputVector,
          locktime,
        })
      ).to.equal(expected)
    })
  }
})
