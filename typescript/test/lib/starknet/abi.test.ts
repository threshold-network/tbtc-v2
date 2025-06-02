import { expect } from "chai"

describe("StarkNet tBTC ABI", () => {
  let tbtcABI: any[]

  before(() => {
    try {
      const abiModule = require("../../../src/lib/starknet/abi")
      tbtcABI = abiModule.tbtcABI
    } catch {
      tbtcABI = [] // Will cause tests to fail appropriately
    }
  })

  describe("ABI structure", () => {
    it("should be an array of ABI entries", () => {
      expect(tbtcABI).to.be.an("array")
      expect(tbtcABI.length).to.be.greaterThan(0)
    })
  })

  describe("balanceOf function", () => {
    it("should contain balanceOf function", () => {
      const balanceOfFunction = tbtcABI.find(
        (item) => item.name === "balanceOf" && item.type === "function"
      )
      
      expect(balanceOfFunction).to.exist
      expect(balanceOfFunction).to.have.property("inputs")
      expect(balanceOfFunction.inputs).to.have.lengthOf(1)
      expect(balanceOfFunction.inputs[0]).to.have.property("name", "account")
      expect(balanceOfFunction.inputs[0]).to.have.property("type", "felt")
    })

    it("should have correct output type for balanceOf", () => {
      const balanceOfFunction = tbtcABI.find(
        (item) => item.name === "balanceOf" && item.type === "function"
      )
      
      expect(balanceOfFunction).to.have.property("outputs")
      expect(balanceOfFunction.outputs).to.have.lengthOf(1)
      expect(balanceOfFunction.outputs[0]).to.have.property("type", "Uint256")
    })
  })

  describe("transfer function", () => {
    it("should contain transfer function", () => {
      const transferFunction = tbtcABI.find(
        (item) => item.name === "transfer" && item.type === "function"
      )
      
      expect(transferFunction).to.exist
      expect(transferFunction).to.have.property("inputs")
      expect(transferFunction.inputs).to.have.lengthOf(2)
      
      // Check recipient parameter
      expect(transferFunction.inputs[0]).to.have.property("name", "recipient")
      expect(transferFunction.inputs[0]).to.have.property("type", "felt")
      
      // Check amount parameter
      expect(transferFunction.inputs[1]).to.have.property("name", "amount")
      expect(transferFunction.inputs[1]).to.have.property("type", "Uint256")
    })

    it("should have correct output type for transfer", () => {
      const transferFunction = tbtcABI.find(
        (item) => item.name === "transfer" && item.type === "function"
      )
      
      expect(transferFunction).to.have.property("outputs")
      expect(transferFunction.outputs).to.have.lengthOf(1)
      expect(transferFunction.outputs[0]).to.have.property("type", "felt")
      expect(transferFunction.outputs[0]).to.have.property("name", "success")
    })
  })

  describe("transferFrom function", () => {
    it("should contain transferFrom function", () => {
      const transferFromFunction = tbtcABI.find(
        (item) => item.name === "transferFrom" && item.type === "function"
      )
      
      expect(transferFromFunction).to.exist
      expect(transferFromFunction).to.have.property("inputs")
      expect(transferFromFunction.inputs).to.have.lengthOf(3)
      
      // Check sender parameter
      expect(transferFromFunction.inputs[0]).to.have.property("name", "sender")
      expect(transferFromFunction.inputs[0]).to.have.property("type", "felt")
      
      // Check recipient parameter
      expect(transferFromFunction.inputs[1]).to.have.property("name", "recipient")
      expect(transferFromFunction.inputs[1]).to.have.property("type", "felt")
      
      // Check amount parameter
      expect(transferFromFunction.inputs[2]).to.have.property("name", "amount")
      expect(transferFromFunction.inputs[2]).to.have.property("type", "Uint256")
    })
  })

  describe("TypeScript typing", () => {
    it("should have proper TypeScript types", () => {
      // This test validates that the ABI is properly typed
      tbtcABI.forEach((entry) => {
        expect(entry).to.have.property("name")
        expect(entry).to.have.property("type")
        
        if (entry.type === "function") {
          expect(entry).to.have.property("inputs")
          expect(entry).to.have.property("outputs")
          expect(entry.inputs).to.be.an("array")
          expect(entry.outputs).to.be.an("array")
        }
      })
    })
  })
})