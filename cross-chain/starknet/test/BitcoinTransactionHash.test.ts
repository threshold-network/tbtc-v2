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

  // Anchor the byte-order interpretation to a real Bitcoin transaction: the
  // famous block-170 Satoshi -> Hal Finney payment (display txid
  // f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16). The
  // contract returns the double-SHA-256 digest in internal byte order (the
  // reverse of the display txid), matching how the Bridge stores txids.
  it("matches the known digest of a real Bitcoin transaction", async () => {
    const version = Buffer.from("01000000", "hex")
    const inputVector = Buffer.from(
      "01c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff",
      "hex"
    )
    const outputVector = Buffer.from(
      "0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac",
      "hex"
    )
    const locktime = Buffer.from("00000000", "hex")
    const expected =
      "0x169e1e83e930853391bc6f35f605c6754cfead57cf8387639d3b4096c54f18f4"

    expect(
      await harness.calculateHash({
        version,
        inputVector,
        outputVector,
        locktime,
      })
    ).to.equal(expected)
  })

  // Exercise the empty-vector case and one boundary around a SHA-256
  // block/ABI word. _calculateBitcoinTxHash has no branches and
  // abi.encodePacked emits raw bytes with no length prefix or word padding,
  // so these boundaries are the only behavior these synthetic vectors can
  // add beyond the golden vector above.
  const lengths = [
    [0, 0],
    [31, 32],
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
