import { expect } from "chai"
import { 
  StarkNetDepositorInterface,
  StarkNetAddress,
  StarkNetCrossChainExtraDataEncoder 
} from "../../../src/lib/starknet"
import { 
  STARKNET_ERROR_MESSAGES,
  createMockDepositTx,
  createMockDeposit 
} from "./test-helpers"

describe("StarkNetDepositorInterface", () => {
  let depositorInterface: StarkNetDepositorInterface

  beforeEach(() => {
    depositorInterface = new StarkNetDepositorInterface()
  })

  describe("getChainIdentifier", () => {
    it("should throw error indicating no chain identifier", () => {
      expect(() => depositorInterface.getChainIdentifier()).to.throw(
        STARKNET_ERROR_MESSAGES.NO_CHAIN_IDENTIFIER
      )
    })
  })

  describe("getDepositOwner", () => {
    it("should return undefined when no deposit owner is set", () => {
      const owner = depositorInterface.getDepositOwner()
      expect(owner).to.be.undefined
    })

    it("should return the deposit owner after setting", () => {
      const starkNetAddress = StarkNetAddress.from("0x1234")
      depositorInterface.setDepositOwner(starkNetAddress)
      
      const owner = depositorInterface.getDepositOwner()
      expect(owner).to.equal(starkNetAddress)
    })
  })

  describe("setDepositOwner", () => {
    it("should accept valid StarkNet address", () => {
      const starkNetAddress = StarkNetAddress.from("0xabcdef")
      
      expect(() => depositorInterface.setDepositOwner(starkNetAddress))
        .to.not.throw()
      
      expect(depositorInterface.getDepositOwner()).to.equal(starkNetAddress)
    })


    it("should throw error for non-StarkNet address", () => {
      // Using a mock non-StarkNet address instead of EthereumAddress
      const mockNonStarkNetAddress = {
        identifierHex: "0x742d35Cc6634C0532925a3b844Bc9e7595f7FACE"
      }
      
      expect(() => depositorInterface.setDepositOwner(mockNonStarkNetAddress as any)).to.throw(
        STARKNET_ERROR_MESSAGES.MUST_BE_STARKNET_ADDRESS
      )
    })

    it("should clear deposit owner when set to undefined", () => {
      // First set an owner
      const starkNetAddress = StarkNetAddress.from("0x1234")
      depositorInterface.setDepositOwner(starkNetAddress)
      expect(depositorInterface.getDepositOwner()).to.equal(starkNetAddress)
      
      // Then clear it
      depositorInterface.setDepositOwner(undefined)
      expect(depositorInterface.getDepositOwner()).to.be.undefined
    })

    it("should accept null as undefined", () => {
      // First set an owner
      const starkNetAddress = StarkNetAddress.from("0x5678")
      depositorInterface.setDepositOwner(starkNetAddress)
      expect(depositorInterface.getDepositOwner()).to.equal(starkNetAddress)
      
      // Then clear it with null
      depositorInterface.setDepositOwner(null as any)
      expect(depositorInterface.getDepositOwner()).to.be.undefined
    })
  })

  describe("initializeDeposit", () => {
    it("should throw error indicating unsupported operation", async () => {
      const mockDepositTx = createMockDepositTx()
      const mockDeposit = createMockDeposit()
      
      await expect(
        depositorInterface.initializeDeposit(mockDepositTx, 0, mockDeposit)
      ).to.be.rejectedWith(
        STARKNET_ERROR_MESSAGES.CANNOT_INITIALIZE
      )
    })

    it("should throw unsupported operation error when deposit transaction is null", async () => {
      const invalidDepositTx = null as any
      const mockDeposit = createMockDeposit()
      
      await expect(
        depositorInterface.initializeDeposit(invalidDepositTx, 0, mockDeposit)
      ).to.be.rejectedWith(
        STARKNET_ERROR_MESSAGES.CANNOT_INITIALIZE
      )
    })

    it("should throw unsupported operation error when deposit receipt is malformed", async () => {
      const mockDepositTx = createMockDepositTx()
      const malformedDeposit = {} as any // Missing required fields
      
      await expect(
        depositorInterface.initializeDeposit(mockDepositTx, 0, malformedDeposit)
      ).to.be.rejectedWith(
        STARKNET_ERROR_MESSAGES.CANNOT_INITIALIZE
      )
    })

    it("should throw unsupported operation error when output index is negative", async () => {
      const mockDepositTx = createMockDepositTx()
      const mockDeposit = createMockDeposit()
      
      await expect(
        depositorInterface.initializeDeposit(mockDepositTx, -1, mockDeposit)
      ).to.be.rejectedWith(
        STARKNET_ERROR_MESSAGES.CANNOT_INITIALIZE
      )
    })
  })

  describe("extraDataEncoder", () => {
    it("should return StarkNetCrossChainExtraDataEncoder instance", () => {
      const encoder = depositorInterface.extraDataEncoder()
      
      expect(encoder).to.be.instanceOf(StarkNetCrossChainExtraDataEncoder)
    })

    it("should return the same encoder instance on multiple calls", () => {
      const encoder1 = depositorInterface.extraDataEncoder()
      const encoder2 = depositorInterface.extraDataEncoder()
      
      expect(encoder1).to.equal(encoder2)
    })
  })
})