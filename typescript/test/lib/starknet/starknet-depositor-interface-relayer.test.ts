import { expect } from "chai"
import { StarkNetDepositorInterface } from "../../../src/lib/starknet/starknet-depositor-interface"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import { BitcoinRawTxVectors } from "../../../src/lib/bitcoin"
import { DepositReceipt } from "../../../src/lib/contracts/bridge"
import { Hex } from "../../../src/lib/utils"
import { TransactionReceipt } from "@ethersproject/providers"
import { constants } from "ethers"

// We need to mock axios globally since it's not injected
const axios = require("axios")

describe("StarkNet Depositor Interface - Relayer Integration", () => {
  let depositor: StarkNetDepositorInterface
  let originalPost: any

  beforeEach(() => {
    depositor = new StarkNetDepositorInterface()
    originalPost = axios.post
  })

  afterEach(() => {
    axios.post = originalPost
  })

  describe("initializeDeposit with relayer endpoint", () => {
    it("should send deposit to relayer endpoint", async () => {
      // Arrange
      const starknetAddress = "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
      depositor.setDepositOwner(StarkNetAddress.from(starknetAddress))
      
      const depositTx: BitcoinRawTxVectors = {
        version: Hex.from("02000000"),
        inputs: Hex.from("0101234567890abcdef01234567890abcdef"),
        outputs: Hex.from("01fedcba098765432101fedcba0987654321"),
        locktime: Hex.from("00000000"),
      }
      
      const deposit: DepositReceipt = {
        depositor: StarkNetAddress.from(starknetAddress),
        walletPublicKeyHash: Hex.from("1234567890abcdef1234567890abcdef12345678"),
        refundPublicKeyHash: Hex.from("abcdef1234567890abcdef1234567890abcdef12"),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: Hex.from("60920000"),
        extraData: depositor.extraDataEncoder().encodeDepositOwner(
          StarkNetAddress.from(starknetAddress)
        ),
      }
      
      const mockReceipt: TransactionReceipt = {
        transactionHash: "0x123abc",
        blockNumber: 12345,
        blockHash: "0xdef456",
        from: "0xSender",
        to: "0xReceiver",
        transactionIndex: 0,
        gasUsed: { _hex: "0x5208", _isBigNumber: true } as any,
        cumulativeGasUsed: { _hex: "0x5208", _isBigNumber: true } as any,
        status: 1,
        logs: [],
        logsBloom: "",
        effectiveGasPrice: { _hex: "0x174876e800", _isBigNumber: true } as any,
        type: 2,
        contractAddress: null as any,
        root: undefined,
        confirmations: 1,
        byzantium: true,
      }
      
      let capturedUrl: string
      let capturedPayload: any
      axios.post = async (url: string, payload: any) => {
        capturedUrl = url
        capturedPayload = payload
        return { data: { receipt: mockReceipt } }
      }
      
      // Act
      const receipt = await depositor.initializeDeposit(
        depositTx,
        0,
        deposit,
        undefined
      )
      
      // Assert
      expect(capturedUrl!).to.equal("http://relayer.tbtcscan.com/api/reveal")
      const payload = capturedPayload!
      
      expect(payload).to.have.property("fundingTx")
      expect(payload.fundingTx).to.deep.equal({
        version: "0x02000000",
        inputVector: "0x0101234567890abcdef01234567890abcdef",
        outputVector: "0x01fedcba098765432101fedcba0987654321",
        locktime: "0x00000000",
      })
      expect(payload).to.have.property("reveal")
      expect(payload.reveal).to.deep.equal({
        fundingOutputIndex: 0,
        blindingFactor: "0xf9f0c90d00039523",
        walletPubKeyHash: "0x1234567890abcdef1234567890abcdef12345678",
        refundPubKeyHash: "0xabcdef1234567890abcdef1234567890abcdef12",
        refundLocktime: "0x60920000",
        vault: constants.AddressZero,
      })
      expect(payload).to.have.property("l2DepositOwner")
      expect(payload.l2DepositOwner).to.equal(deposit.extraData!.toPrefixedString())
      expect(payload).to.have.property("l2Sender")
      expect(payload.l2Sender).to.equal(starknetAddress)
    })

    it("should handle relayer response correctly", async () => {
      // Arrange
      const starknetAddress = "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
      depositor.setDepositOwner(StarkNetAddress.from(starknetAddress))
      
      const depositTx: BitcoinRawTxVectors = {
        version: Hex.from("02000000"),
        inputs: Hex.from("0101234567890abcdef01234567890abcdef"),
        outputs: Hex.from("01fedcba098765432101fedcba0987654321"),
        locktime: Hex.from("00000000"),
      }
      
      const deposit: DepositReceipt = {
        depositor: StarkNetAddress.from(starknetAddress),
        walletPublicKeyHash: Hex.from("1234567890abcdef1234567890abcdef12345678"),
        refundPublicKeyHash: Hex.from("abcdef1234567890abcdef1234567890abcdef12"),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: Hex.from("60920000"),
        extraData: depositor.extraDataEncoder().encodeDepositOwner(
          StarkNetAddress.from(starknetAddress)
        ),
      }
      
      const mockReceipt: TransactionReceipt = {
        transactionHash: "0x123abc",
        blockNumber: 12345,
        blockHash: "0xdef456",
        from: "0xSender",
        to: "0xReceiver",
        transactionIndex: 0,
        gasUsed: { _hex: "0x5208", _isBigNumber: true } as any,
        cumulativeGasUsed: { _hex: "0x5208", _isBigNumber: true } as any,
        status: 1,
        logs: [],
        logsBloom: "",
        effectiveGasPrice: { _hex: "0x174876e800", _isBigNumber: true } as any,
        type: 2,
        contractAddress: null as any,
        root: undefined,
        confirmations: 1,
        byzantium: true,
      }
      
      axios.post = async () => ({ data: { receipt: mockReceipt } })
      
      // Act
      const receipt = await depositor.initializeDeposit(
        depositTx,
        0,
        deposit,
        undefined
      )
      
      // Assert
      expect(receipt).to.be.instanceOf(Hex)
      expect(receipt.toString()).to.equal("123abc")
    })

    it("should throw error if extra data is missing", async () => {
      // Arrange
      const starknetAddress = "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
      depositor.setDepositOwner(StarkNetAddress.from(starknetAddress))
      
      const depositTx: BitcoinRawTxVectors = {
        version: Hex.from("02000000"),
        inputs: Hex.from("0101234567890abcdef01234567890abcdef"),
        outputs: Hex.from("01fedcba098765432101fedcba0987654321"),
        locktime: Hex.from("00000000"),
      }
      
      const deposit: DepositReceipt = {
        depositor: StarkNetAddress.from(starknetAddress),
        walletPublicKeyHash: Hex.from("1234567890abcdef1234567890abcdef12345678"),
        refundPublicKeyHash: Hex.from("abcdef1234567890abcdef1234567890abcdef12"),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: Hex.from("60920000"),
        extraData: undefined, // Missing extra data
      }
      
      // Act & Assert
      try {
        await depositor.initializeDeposit(depositTx, 0, deposit, undefined)
        expect.fail("Should have thrown error")
      } catch (error: any) {
        expect(error.message).to.equal("Extra data is required.")
      }
    })

    it("should handle relayer errors properly", async () => {
      // Arrange
      const starknetAddress = "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
      depositor.setDepositOwner(StarkNetAddress.from(starknetAddress))
      
      const depositTx: BitcoinRawTxVectors = {
        version: Hex.from("02000000"),
        inputs: Hex.from("0101234567890abcdef01234567890abcdef"),
        outputs: Hex.from("01fedcba098765432101fedcba0987654321"),
        locktime: Hex.from("00000000"),
      }
      
      const deposit: DepositReceipt = {
        depositor: StarkNetAddress.from(starknetAddress),
        walletPublicKeyHash: Hex.from("1234567890abcdef1234567890abcdef12345678"),
        refundPublicKeyHash: Hex.from("abcdef1234567890abcdef1234567890abcdef12"),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: Hex.from("60920000"),
        extraData: depositor.extraDataEncoder().encodeDepositOwner(
          StarkNetAddress.from(starknetAddress)
        ),
      }
      
      axios.post = async () => {
        throw new Error("Network error")
      }
      
      // Act & Assert
      try {
        await depositor.initializeDeposit(depositTx, 0, deposit, undefined)
        expect.fail("Should have thrown error")
      } catch (error: any) {
        expect(error.message).to.equal("Network error")
      }
    })

    it("should handle unexpected relayer response", async () => {
      // Arrange
      const starknetAddress = "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
      depositor.setDepositOwner(StarkNetAddress.from(starknetAddress))
      
      const depositTx: BitcoinRawTxVectors = {
        version: Hex.from("02000000"),
        inputs: Hex.from("0101234567890abcdef01234567890abcdef"),
        outputs: Hex.from("01fedcba098765432101fedcba0987654321"),
        locktime: Hex.from("00000000"),
      }
      
      const deposit: DepositReceipt = {
        depositor: StarkNetAddress.from(starknetAddress),
        walletPublicKeyHash: Hex.from("1234567890abcdef1234567890abcdef12345678"),
        refundPublicKeyHash: Hex.from("abcdef1234567890abcdef1234567890abcdef12"),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: Hex.from("60920000"),
        extraData: depositor.extraDataEncoder().encodeDepositOwner(
          StarkNetAddress.from(starknetAddress)
        ),
      }
      
      // Missing receipt in response
      axios.post = async () => ({ data: { error: "Invalid request" } })
      
      // Act & Assert
      try {
        await depositor.initializeDeposit(depositTx, 0, deposit, undefined)
        expect.fail("Should have thrown error")
      } catch (error: any) {
        expect(error.message).to.include("Unexpected response from /api/reveal")
      }
    })
  })
})