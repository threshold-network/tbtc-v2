import { expect } from "chai"
import { StarkNetBitcoinDepositor } from "../../../src/lib/starknet/starknet-depositor"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import { BitcoinRawTxVectors } from "../../../src/lib/bitcoin"
import { DepositReceipt } from "../../../src/lib/contracts/bridge"
import { Hex } from "../../../src/lib/utils"
import { EthereumAddress } from "../../../src/lib/ethereum"
import sinon from "sinon"
import axios from "axios"

describe("StarkNetDepositor Payload Format", () => {
  let depositor: StarkNetBitcoinDepositor
  let axiosStub: sinon.SinonStub

  const mockProvider = {} // Mock StarkNet provider
  const testAddress =
    "0x02c68f380a5232144f34e7b7acf86b73ce1419eec641804823f66ce071482605"

  beforeEach(() => {
    depositor = new StarkNetBitcoinDepositor(
      { chainId: "0x534e5f4d41494e" },
      "StarkNet",
      mockProvider as any
    )

    depositor.setDepositOwner(StarkNetAddress.from(testAddress))
    axiosStub = sinon.stub(axios, "post")
  })

  afterEach(() => {
    axiosStub.restore()
  })

  it("should include destinationChainDepositOwner in payload", async () => {
    // Mock response
    axiosStub.resolves({
      data: {
        receipt: {
          transactionHash: "0x123456",
          blockNumber: 12345,
        },
      },
    })

    // Test data
    const depositTx: BitcoinRawTxVectors = {
      version: Hex.from("02000000"),
      inputs: Hex.from("01" + "a".repeat(64)),
      outputs: Hex.from("02" + "e".repeat(64)),
      locktime: Hex.from("00000000"),
    }

    const deposit: DepositReceipt = {
      depositor: EthereumAddress.from("0x" + "0".repeat(40)),
      walletPublicKeyHash: Hex.from("ef5a2946f294f1742a779c9ac034bc3fa5d417b8"),
      refundPublicKeyHash: Hex.from("b4f19a044feea3aa4a7d3f494433a11d0f1c400e"),
      blindingFactor: Hex.from("b3460f26eda61ad1"),
      refundLocktime: Hex.from("a1faa569"),
      extraData: Hex.from(testAddress),
    }

    await depositor.initializeDeposit(depositTx, 0, deposit)

    // Verify payload
    const call = axiosStub.getCall(0)
    const payload = call.args[1]

    expect(payload).to.have.property("destinationChainDepositOwner")
    expect(payload.destinationChainDepositOwner).to.equal(
      testAddress.toLowerCase()
    )
    expect(payload).to.have.property("l2DepositOwner")
    expect(payload).to.have.property("l2Sender")
    expect(payload).to.have.property("fundingTx")
    expect(payload).to.have.property("reveal")
  })

  it("should validate StarkNet address format", () => {
    const invalidAddress = "0x123" // Too short

    expect(() => {
      // @ts-ignore - accessing private method for testing
      depositor["formatStarkNetAddressAsBytes32"](invalidAddress)
    }).to.throw("Invalid StarkNet address length")
  })

  it("should format addresses as lowercase", async () => {
    axiosStub.resolves({
      data: {
        receipt: {
          transactionHash: "0xabc123",
          blockNumber: 12345,
        },
      },
    })

    const depositTx: BitcoinRawTxVectors = {
      version: Hex.from("02000000"),
      inputs: Hex.from("01" + "a".repeat(64)),
      outputs: Hex.from("02" + "e".repeat(64)),
      locktime: Hex.from("00000000"),
    }

    const deposit: DepositReceipt = {
      depositor: EthereumAddress.from("0x" + "0".repeat(40)),
      walletPublicKeyHash: Hex.from("ef5a2946f294f1742a779c9ac034bc3fa5d417b8"),
      refundPublicKeyHash: Hex.from("b4f19a044feea3aa4a7d3f494433a11d0f1c400e"),
      blindingFactor: Hex.from("b3460f26eda61ad1"),
      refundLocktime: Hex.from("a1faa569"),
      extraData: Hex.from(
        "0x02C68F380A5232144F34E7B7ACF86B73CE1419EEC641804823F66CE071482605"
      ), // Uppercase
    }

    await depositor.initializeDeposit(depositTx, 0, deposit)

    const call = axiosStub.getCall(0)
    const payload = call.args[1]

    // Should be lowercase
    expect(payload.destinationChainDepositOwner).to.equal(
      testAddress.toLowerCase()
    )
  })

  it("should handle addresses without 0x prefix", () => {
    const addressWithoutPrefix =
      "02c68f380a5232144f34e7b7acf86b73ce1419eec641804823f66ce071482605"
    // @ts-ignore - accessing private method for testing
    const formatted =
      depositor["formatStarkNetAddressAsBytes32"](addressWithoutPrefix)

    expect(formatted).to.equal("0x" + addressWithoutPrefix)
  })

  it("should reject addresses with invalid hex characters", () => {
    const invalidHexAddress = "0x" + "g".repeat(64) // 'g' is not valid hex

    expect(() => {
      // @ts-ignore - accessing private method for testing
      depositor["formatStarkNetAddressAsBytes32"](invalidHexAddress)
    }).to.throw("Invalid StarkNet address format")
  })

  it("should include all required fields in payload", async () => {
    axiosStub.resolves({
      data: {
        receipt: {
          transactionHash: "0xdef456",
          blockNumber: 67890,
        },
      },
    })

    const depositTx: BitcoinRawTxVectors = {
      version: Hex.from("02000000"),
      inputs: Hex.from(
        "011b045727f188ac8be3a781ae26ca393ef3dd93300612065062d3f85385c493d70100000000fdffffff"
      ),
      outputs: Hex.from(
        "0240420f000000000022002053b2b402c03f5504ef1dc8bb5b240fbab444ce0016e6c94db614bbfabdd642c17c869201000000001600143168346aaa50d4828f5033bf7736cdb89680587a"
      ),
      locktime: Hex.from("00000000"),
    }

    const deposit: DepositReceipt = {
      depositor: EthereumAddress.from(
        "0x7c71e3Be59267EF9d87a624ad0419a5bb8E96477".toLowerCase()
      ),
      walletPublicKeyHash: Hex.from("ef5a2946f294f1742a779c9ac034bc3fa5d417b8"),
      refundPublicKeyHash: Hex.from("b4f19a044feea3aa4a7d3f494433a11d0f1c400e"),
      blindingFactor: Hex.from("b3460f26eda61ad1"),
      refundLocktime: Hex.from("a1faa569"),
      extraData: Hex.from(testAddress),
    }

    const vault = EthereumAddress.from(
      "0xB5679dE944A79732A75CE556191DF11F489448d5"
    )

    await depositor.initializeDeposit(depositTx, 0, deposit, vault)

    const call = axiosStub.getCall(0)
    const payload = call.args[1]

    // Check fundingTx structure
    expect(payload.fundingTx).to.have.property("version")
    expect(payload.fundingTx).to.have.property("inputVector")
    expect(payload.fundingTx).to.have.property("outputVector")
    expect(payload.fundingTx).to.have.property("locktime")

    // Check reveal structure
    expect(payload.reveal).to.have.property("fundingOutputIndex")
    expect(payload.reveal).to.have.property("blindingFactor")
    expect(payload.reveal).to.have.property("walletPubKeyHash")
    expect(payload.reveal).to.have.property("refundPubKeyHash")
    expect(payload.reveal).to.have.property("refundLocktime")
    expect(payload.reveal).to.have.property("vault")

    // Check StarkNet-specific fields
    expect(payload).to.have.property("destinationChainDepositOwner")
    expect(payload).to.have.property("l2DepositOwner")
    expect(payload).to.have.property("l2Sender")
  })

  it("should calculate deposit ID correctly", async () => {
    // Mock console.log to capture deposit ID
    const consoleLogStub = sinon.stub(console, "log")

    axiosStub.resolves({
      data: {
        receipt: {
          transactionHash:
            "0x366220f9853aa8ad83376bcb3fd9377da7b55f03fc3a3aa4aed7b57f7cc60745",
          blockNumber: 8486402,
        },
      },
    })

    const depositTx: BitcoinRawTxVectors = {
      version: Hex.from("02000000"),
      inputs: Hex.from("01" + "a".repeat(64)),
      outputs: Hex.from("02" + "e".repeat(64)),
      locktime: Hex.from("00000000"),
    }

    const deposit: DepositReceipt = {
      depositor: EthereumAddress.from("0x" + "0".repeat(40)),
      walletPublicKeyHash: Hex.from("ef5a2946f294f1742a779c9ac034bc3fa5d417b8"),
      refundPublicKeyHash: Hex.from("b4f19a044feea3aa4a7d3f494433a11d0f1c400e"),
      blindingFactor: Hex.from("b3460f26eda61ad1"),
      refundLocktime: Hex.from("a1faa569"),
      extraData: Hex.from(testAddress),
    }

    await depositor.initializeDeposit(depositTx, 0, deposit)

    // Verify deposit ID was logged
    expect(consoleLogStub.calledOnce).to.be.true
    expect(consoleLogStub.firstCall.args[0]).to.include(
      "Deposit initialized with ID:"
    )

    consoleLogStub.restore()
  })
})
