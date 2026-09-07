import { expect } from "chai"
import { EthereumAddress } from "../../../src/lib/ethereum/address"

describe("EthereumAddress", () => {
  const checksummed = "f39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

  for (const [name, address] of [
    ["checksummed", checksummed],
    ["lowercase", checksummed.toLowerCase()],
    ["uppercase", checksummed.toUpperCase()],
  ]) {
    for (const prefix of ["", "0x"]) {
      it(`should accept a ${name} address ${
        prefix ? "with" : "without"
      } a prefix`, () => {
        expect(EthereumAddress.from(prefix + address).identifierHex).to.equal(
          checksummed.toLowerCase()
        )
      })
    }
  }

  for (const prefix of ["", "0x"]) {
    it(`should reject an invalid mixed-case checksum ${
      prefix ? "with" : "without"
    } a prefix`, () => {
      const mistyped = "F" + checksummed.slice(1)

      expect(() => EthereumAddress.from(prefix + mistyped)).to.throw(
        "Invalid Ethereum address"
      )
    })
  }

  it("should reject malformed addresses", () => {
    for (const address of ["", "0x1234", "0x" + "g".repeat(40)]) {
      expect(() => EthereumAddress.from(address)).to.throw(
        "Invalid Ethereum address"
      )
    }
  })
})
