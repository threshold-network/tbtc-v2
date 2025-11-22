import { expect } from "chai"
import { GaslessDepositResult, GaslessRevealPayload } from "../../src"

describe("Gasless Types Exports", () => {
  describe("GaslessDepositResult", () => {
    it("should be importable from SDK root", () => {
      // Type assertion - TypeScript compilation validates export exists
      const result: GaslessDepositResult = {} as GaslessDepositResult
      expect(result).to.exist
    })

    it("should have correct structure with all required properties", () => {
      // Type-level validation through compilation
      // This test verifies the interface has the expected shape
      const validResult: GaslessDepositResult = {
        deposit: {} as any,
        receipt: {} as any,
        destinationChainName: "L1",
      }
      expect(validResult.destinationChainName).to.equal("L1")
    })

    it("should accept L2 chain names", () => {
      const l2Result: GaslessDepositResult = {
        deposit: {} as any,
        receipt: {} as any,
        destinationChainName: "Arbitrum",
      }
      expect(l2Result.destinationChainName).to.equal("Arbitrum")
    })
  })

  describe("GaslessRevealPayload", () => {
    it("should be importable from SDK root", () => {
      // Type assertion - TypeScript compilation validates export exists
      const payload: GaslessRevealPayload = {} as GaslessRevealPayload
      expect(payload).to.exist
    })

    it("should have correct structure with all required properties", () => {
      // Type-level validation through compilation
      const validPayload: GaslessRevealPayload = {
        fundingTx: {
          version: "0x01000000",
          inputVector: "0x01",
          outputVector: "0x01",
          locktime: "0x00000000",
        },
        reveal: {
          fundingOutputIndex: 0,
          blindingFactor: "0xf9f0c90d00039523",
          walletPubKeyHash: "0x" + "a".repeat(40),
          refundPubKeyHash: "0x" + "b".repeat(40),
          refundLocktime: "0x12345678",
          vault: "0x" + "c".repeat(40),
        },
        destinationChainDepositOwner: "0x" + "d".repeat(40),
        destinationChainName: "L1",
      }
      expect(validPayload.destinationChainName).to.equal("L1")
      expect(validPayload.reveal.fundingOutputIndex).to.equal(0)
    })

    it("should accept bytes32 owner for L1 deposits", () => {
      const l1Payload: GaslessRevealPayload = {
        fundingTx: {
          version: "0x01000000",
          inputVector: "0x01",
          outputVector: "0x01",
          locktime: "0x00000000",
        },
        reveal: {
          fundingOutputIndex: 0,
          blindingFactor: "0xf9f0c90d00039523",
          walletPubKeyHash: "0x" + "a".repeat(40),
          refundPubKeyHash: "0x" + "b".repeat(40),
          refundLocktime: "0x12345678",
          vault: "0x" + "c".repeat(40),
        },
        destinationChainDepositOwner: "0x" + "1".repeat(64), // bytes32
        destinationChainName: "L1",
      }
      expect(l1Payload.destinationChainDepositOwner.length).to.equal(66) // 0x + 64 hex chars
    })

    it("should accept 20-byte address owner for L2 deposits", () => {
      const l2Payload: GaslessRevealPayload = {
        fundingTx: {
          version: "0x01000000",
          inputVector: "0x01",
          outputVector: "0x01",
          locktime: "0x00000000",
        },
        reveal: {
          fundingOutputIndex: 0,
          blindingFactor: "0xf9f0c90d00039523",
          walletPubKeyHash: "0x" + "a".repeat(40),
          refundPubKeyHash: "0x" + "b".repeat(40),
          refundLocktime: "0x12345678",
          vault: "0x" + "c".repeat(40),
        },
        destinationChainDepositOwner: "0x" + "2".repeat(40), // address
        destinationChainName: "Arbitrum",
      }
      expect(l2Payload.destinationChainDepositOwner.length).to.equal(42) // 0x + 40 hex chars
    })
  })

  describe("Combined Import", () => {
    it("should allow importing both types together in single statement", () => {
      // Compilation success validates this test
      // Both types imported at top of file demonstrate this works
      const result: GaslessDepositResult = {} as any
      const payload: GaslessRevealPayload = {} as any
      expect(result).to.exist
      expect(payload).to.exist
    })

    it("should support using both types in same scope", () => {
      // Verify types can be used together without conflicts
      const mockResult: GaslessDepositResult = {
        deposit: {} as any,
        receipt: {} as any,
        destinationChainName: "L1",
      }

      const mockPayload: GaslessRevealPayload = {
        fundingTx: {
          version: "0x01000000",
          inputVector: "0x01",
          outputVector: "0x01",
          locktime: "0x00000000",
        },
        reveal: {
          fundingOutputIndex: 0,
          blindingFactor: "0xf9f0c90d00039523",
          walletPubKeyHash: "0x" + "a".repeat(40),
          refundPubKeyHash: "0x" + "b".repeat(40),
          refundLocktime: "0x12345678",
          vault: "0x" + "c".repeat(40),
        },
        destinationChainDepositOwner: "0x" + "d".repeat(40),
        destinationChainName: mockResult.destinationChainName,
      }

      expect(mockPayload.destinationChainName).to.equal(
        mockResult.destinationChainName
      )
    })
  })
})
