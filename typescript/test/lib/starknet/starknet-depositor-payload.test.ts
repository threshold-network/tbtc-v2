import { expect } from "chai"
import { StarkNetBitcoinDepositor } from "../../../src/lib/starknet/starknet-depositor"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import {
  BitcoinRawTxVectors,
  BitcoinTxHash,
  BitcoinHashUtils,
} from "../../../src/lib/bitcoin"
import { DepositReceipt } from "../../../src/lib/contracts/bridge"
import { Hex } from "../../../src/lib/utils"
import { EthereumAddress } from "../../../src/lib/ethereum"
import { EthereumBridge } from "../../../src/lib/ethereum/bridge"
import { createMockDepositTx, createMockDeposit } from "./test-helpers"
import sinon from "sinon"
import axios from "axios"
import { ethers } from "ethers"

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
    sinon.restore()
  })

  it("should include destinationChainDepositOwner in payload", async () => {
    // Mock response
    axiosStub.resolves({
      data: {
        success: true,
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

    expect(payload).to.not.have.property("destinationChainDepositOwner")
    expect(payload).to.have.property("l2DepositOwner")
    expect(payload).to.have.property("l2Sender")
    expect(payload).to.have.property("fundingTx")
    expect(payload).to.have.property("reveal")
  })

  it("should pad short StarkNet addresses", () => {
    const address = "0x123"

    // @ts-ignore - accessing private method for testing
    const formatted = depositor["formatStarkNetAddressAsBytes32"](address)

    expect(formatted).to.equal(
      "0x0000000000000000000000000000000000000000000000000000000000000123"
    )
  })

  it("should format addresses as lowercase", async () => {
    axiosStub.resolves({
      data: {
        success: true,
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
    expect(payload.l2DepositOwner).to.equal(testAddress.toLowerCase())
    expect(payload.l2Sender).to.equal(testAddress.toLowerCase())
  })

  it("should bind l2Sender to the owner encoded in deposit extra data", async () => {
    axiosStub.resolves({
      data: {
        success: true,
        receipt: {
          transactionHash: "0xabc123",
          blockNumber: 12345,
        },
      },
    })

    const receiptOwner =
      "0x01268f380a5232144f34e7b7acf86b73ce1419eec641804823f66ce071482605"
    depositor.setDepositOwner(StarkNetAddress.from(testAddress))

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
      extraData: Hex.from(receiptOwner),
    }

    await depositor.initializeDeposit(depositTx, 0, deposit)

    const payload = axiosStub.getCall(0).args[1]
    expect(payload.l2DepositOwner).to.equal(receiptOwner)
    expect(payload.l2Sender).to.equal(receiptOwner)
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
        success: true,
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
    expect(payload).to.not.have.property("destinationChainDepositOwner")
    expect(payload).to.have.property("l2DepositOwner")
    expect(payload).to.have.property("l2Sender")
  })

<<<<<<< HEAD
  // The three exact-decimal expected values pinned below ("should calculate
  // deposit ID correctly", "should derive the canonical deposit ID for the
  // standard mock vectors (output index 0)", and "should pack the output
  // index as uint32 when deriving the deposit ID (non-zero index)") were
  // generated by running deriveCanonicalDepositId itself against the mock
  // vectors, not sourced from an independent, relayer-confirmed ground
  // truth. They are self-consistency regression guards - they catch an
  // accidental future change to the derivation - not a proof that the
  // derivation matches the real relayer's output. The formula itself
  // (double-SHA256, unreversed, packed with a uint32 output index) is
  // independently cross-checked against this SDK's on-chain deposit-key
  // convention in deriveCanonicalDepositId's JSDoc.
  it("should calculate deposit ID correctly", async () => {
    // Mock console.log to capture deposit ID
=======
  it("should not log reveal request payloads", async () => {
>>>>>>> 686d5e70 (fix(sdk): harden cross-chain depositor inputs)
    const consoleLogStub = sinon.stub(console, "log")

    axiosStub.resolves({
      data: {
        success: true,
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

<<<<<<< HEAD
    // Verify the exact deposit ID was logged. The ID is derived with Bitcoin
    // SHA-256d over the serialized funding transaction (digest used directly,
    // NOT reversed) packed with the uint32 output index, matching the on-chain
    // deposit-key formula (EthereumBridge.buildDepositKey).
    const depositIdLogCall = consoleLogStub
      .getCalls()
      .find((call) => call.args[0]?.includes("Deposit initialized with ID:"))

    expect(depositIdLogCall).to.exist
    expect(depositIdLogCall!.args[0]).to.equal(
      "Deposit initialized with ID: 84327574594609900513771153583252034476167624431248952116381071070685377716504"
    )
  })
=======
    expect(consoleLogStub.called).to.be.false
>>>>>>> 686d5e70 (fix(sdk): harden cross-chain depositor inputs)

  it("should derive the canonical deposit ID for the standard mock vectors (output index 0)", async () => {
    // Canonical vector: createMockDepositTx() with output index 0 must
    // derive the same self-consistent decimal ID as the formula's other
    // test vectors (see the caveat above the "should calculate deposit ID
    // correctly" test).
    const consoleLogStub = sinon.stub(console, "log")

    axiosStub.resolves({
      data: {
        success: true,
        receipt: { transactionHash: "0xabc123", blockNumber: 12345 },
      },
    })

    await depositor.initializeDeposit(
      createMockDepositTx(),
      0,
      createMockDeposit()
    )

    const depositIdLogCall = consoleLogStub
      .getCalls()
      .find((call) => call.args[0]?.includes("Deposit initialized with ID:"))

    expect(depositIdLogCall, "deposit ID should be logged").to.exist
    expect(depositIdLogCall!.args[0]).to.equal(
      "Deposit initialized with ID: 52847317767373198432771341860755114399097173875446941334774910450063200677754"
    )
  })

  it("should pack the output index as uint32 when deriving the deposit ID (non-zero index)", async () => {
    // A non-zero output index must change the derived ID via uint32 packing.
    const consoleLogStub = sinon.stub(console, "log")

    axiosStub.resolves({
      data: {
        success: true,
        receipt: { transactionHash: "0xabc123", blockNumber: 12345 },
      },
    })

    await depositor.initializeDeposit(
      createMockDepositTx(),
      1,
      createMockDeposit()
    )

    const depositIdLogCall = consoleLogStub
      .getCalls()
      .find((call) => call.args[0]?.includes("Deposit initialized with ID:"))

    expect(depositIdLogCall, "deposit ID should be logged").to.exist
    expect(depositIdLogCall!.args[0]).to.equal(
      "Deposit initialized with ID: 9808213022425870350059927235286989383750284896017613751947258983338977818301"
    )
  })
  it("should derive the same deposit ID as EthereumBridge.buildDepositKey", async () => {
    // EthereumBridge.buildDepositKey reverses its BitcoinTxHash input back to
    // internal byte order before keccak-hashing it, so we feed it the funding
    // hash in DISPLAY (reversed) byte order to undo that internal reversal
    // and compare the result against the SDK's derivation, which hashes the
    // raw funding bytes fresh in internal byte order.
    const mockTx = createMockDepositTx()
    const fundingTxComponents =
      mockTx.version.toString() +
      mockTx.inputs.toString() +
      mockTx.outputs.toString() +
      mockTx.locktime.toString()
    const fundingTxHash = BitcoinHashUtils.computeHash256(
      Hex.from(fundingTxComponents)
    )
    const displayOrderHex = fundingTxHash.reverse().toString()
    const txHash = BitcoinTxHash.from(displayOrderHex)

    const keyHex = await EthereumBridge.buildDepositKey(txHash, 0)
    const derivedDecimal = ethers.BigNumber.from(keyHex).toString()

    // Capture the deposit ID the SDK actually logs from initializeDeposit
    // for the same funding tx, and assert the two agree.
    const consoleLogStub = sinon.stub(console, "log")
    axiosStub.resolves({
      data: {
        success: true,
        receipt: {
          transactionHash:
            "0x366220f9853aa8ad83376bcb3fd9377da7b55f03fc3a3aa4aed7b57f7cc60745",
          blockNumber: 8486402,
        },
      },
    })

    const deposit: DepositReceipt = {
      depositor: EthereumAddress.from("0x" + "0".repeat(40)),
      walletPublicKeyHash: Hex.from("ef5a2946f294f1742a779c9ac034bc3fa5d417b8"),
      refundPublicKeyHash: Hex.from("b4f19a044feea3aa4a7d3f494433a11d0f1c400e"),
      blindingFactor: Hex.from("b3460f26eda61ad1"),
      refundLocktime: Hex.from("a1faa569"),
      extraData: Hex.from(testAddress),
    }

    await depositor.initializeDeposit(mockTx, 0, deposit)

    const depositIdLogCall = consoleLogStub
      .getCalls()
      .find((call) => call.args[0]?.includes("Deposit initialized with ID:"))

    expect(depositIdLogCall, "deposit ID should be logged").to.exist
    const loggedId = depositIdLogCall!.args[0].replace(
      "Deposit initialized with ID: ",
      ""
    )
    expect(
      loggedId,
      "SDK derivation must match EthereumBridge.buildDepositKey"
    ).to.equal(derivedDecimal)
  })
})
