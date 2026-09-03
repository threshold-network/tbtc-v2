import { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import chai from "chai"
import sinon from "sinon"

chai.use(chaiAsPromised)
import { SuiBitcoinDepositor, SuiAddress, SuiError } from "../../../src/lib/sui"
import { Chains } from "../../../src/lib/contracts"
import { BitcoinRawTxVectors } from "../../../src/lib/bitcoin"
import { DepositReceipt } from "../../../src/lib/contracts"
import { Hex } from "../../../src/lib/utils"
import { EthereumAddress } from "../../../src/lib/ethereum"

// Create mock Transaction class
class MockTransaction {
  moveCall = sinon.stub()
  pure = {
    vector: sinon.stub().returns("mockPureVector"),
  }
}

describe("SUI Bitcoin Depositor", () => {
  let depositor: SuiBitcoinDepositor
  let mockClient: any
  let mockSigner: any
  let mockTransaction: any
  let importStub: sinon.SinonStub

  const packageId = "0x" + "a".repeat(64)
  const chainId = Chains.Sui.Testnet

  beforeEach(() => {
    // Set up import stub for all tests
    importStub = sinon.stub()
    importStub.withArgs("@mysten/sui/transactions").resolves({
      Transaction: MockTransaction,
    })
    ;(global as any).import = importStub

    // Create a new transaction instance for each test
    mockTransaction = new MockTransaction()

    // Mock SUI client
    mockClient = {
      getBalance: sinon.stub(),
      signAndExecuteTransaction: sinon.stub().resolves({
        digest: "0xmocktransactiondigest123",
        effects: {
          status: { status: "success" },
        },
        events: [
          {
            type: `${packageId}::BitcoinDepositor::DepositInitialized`,
            parsedJson: { deposit_id: "123" },
          },
        ],
      }),
      waitForTransaction: sinon.stub().resolves({
        digest: "0xmocktransactiondigest123",
        effects: {
          status: { status: "success" },
        },
        events: [
          {
            type: `${packageId}::BitcoinDepositor::DepositInitialized`,
            parsedJson: { deposit_id: "123" },
          },
        ],
      }),
    }

    // Mock signer (Ed25519Keypair or wallet adapter)
    mockSigner = {
      getPublicKey: () => ({
        toSuiAddress: () => "0x" + "c".repeat(64),
      }),
    }

    depositor = new SuiBitcoinDepositor(
      mockClient,
      mockSigner,
      packageId,
      chainId
    )
  })

  afterEach(() => {
    delete (global as any).import
    sinon.restore()
  })

  describe("getChainIdentifier", () => {
    it("should return the package ID as chain identifier", () => {
      const identifier = depositor.getChainIdentifier()
      expect(identifier).to.be.instanceOf(SuiAddress)
      expect(identifier.identifierHex).to.equal(packageId.substring(2))
    })
  })

  describe("getDepositOwner and setDepositOwner", () => {
    it("should set and get deposit owner", () => {
      const owner = SuiAddress.from("0x" + "b".repeat(64))

      expect(depositor.getDepositOwner()).to.be.undefined

      depositor.setDepositOwner(owner)

      const retrievedOwner = depositor.getDepositOwner()
      expect(retrievedOwner).to.equal(owner)
    })

    it("should clear deposit owner", () => {
      const owner = SuiAddress.from("0x" + "b".repeat(64))

      depositor.setDepositOwner(owner)
      depositor.setDepositOwner(undefined)

      expect(depositor.getDepositOwner()).to.be.undefined
    })

    it("should reject non-SUI deposit owners", () => {
      const ethereumAddress = EthereumAddress.from(
        "0x1234567890123456789012345678901234567890"
      )

      expect(() => depositor.setDepositOwner(ethereumAddress)).to.throw(
        "Deposit owner must be a SUI address"
      )
    })
  })

  describe("extraDataEncoder", () => {
    it("should return an extra data encoder instance", () => {
      const encoder = depositor.extraDataEncoder()
      expect(encoder).to.exist
      expect(encoder.encodeDepositOwner).to.be.a("function")
      expect(encoder.decodeDepositOwner).to.be.a("function")
    })
  })

  describe("initializeDeposit", () => {
    let depositTx: BitcoinRawTxVectors
    let deposit: DepositReceipt
    const depositOutputIndex = 0

    beforeEach(() => {
      depositTx = {
        version: Hex.from("0x02000000"),
        inputs: Hex.from("0x01234567"),
        outputs: Hex.from("0x89abcdef"),
        locktime: Hex.from("0x00000000"),
      }

      deposit = {
        depositor: SuiAddress.from("0x" + "1".repeat(64)),
        walletPublicKeyHash: Hex.from("0x" + "2".repeat(40)),
        refundPublicKeyHash: Hex.from("0x" + "3".repeat(40)),
        blindingFactor: Hex.from("0x" + "4".repeat(16)),
        refundLocktime: Hex.from("0x" + "5".repeat(8)),
        extraData: Hex.from("0x" + "6".repeat(64)),
      }
    })

    it("should initialize deposit successfully", async () => {
      const result = await depositor.initializeDeposit(
        depositTx,
        depositOutputIndex,
        deposit
      )

      expect(result.digest).to.equal("0xmocktransactiondigest123")
      expect(result.effects.status.status).to.equal("success")

      // Verify transaction execution on client
      expect(mockClient.signAndExecuteTransaction.calledOnce).to.be.true
      const execArg = mockClient.signAndExecuteTransaction.getCall(0).args[0]
      expect(execArg.signer).to.equal(mockSigner)
      expect(execArg.options.showEffects).to.be.true
      expect(execArg.options.showEvents).to.be.true
      expect(execArg.options.showObjectChanges).to.be.true

      // Verify transaction building
      const txData = execArg.transaction.getData()
      expect(txData.commands).to.have.length(1)
      const command = txData.commands[0]
      expect(command.$kind).to.equal("MoveCall")
      expect(command.MoveCall.module).to.equal("BitcoinDepositor")
      expect(command.MoveCall.function).to.equal("initialize_deposit")
      expect(command.MoveCall.arguments).to.have.length(3)

      // Verify waitForTransaction was called
      expect(mockClient.waitForTransaction.calledOnce).to.be.true
      const waitArg = mockClient.waitForTransaction.getCall(0).args[0]
      expect(waitArg.digest).to.equal("0xmocktransactiondigest123")
    })

    it("should use deposit owner from extra data", async () => {
      await depositor.initializeDeposit(depositTx, depositOutputIndex, deposit)

      const execArg = mockClient.signAndExecuteTransaction.getCall(0).args[0]
      const txData = execArg.transaction.getData()
      // The third argument should be the deposit owner from extra data
      expect(txData.commands[0].MoveCall.arguments[2]).to.exist
      const ownerInput =
        txData.inputs[txData.commands[0].MoveCall.arguments[2].Input]
      expect(ownerInput.$kind).to.equal("Pure")
      const rawBytes = Buffer.from(ownerInput.Pure.bytes, "base64")
      const decodedOwner = depositor
        .extraDataEncoder()
        .decodeDepositOwner(deposit.extraData!)
      expect(rawBytes.subarray(1).toString("hex")).to.equal(
        decodedOwner.identifierHex
      )
    })

    it("should use set deposit owner when extra data is missing", async () => {
      const owner = SuiAddress.from("0x" + "7".repeat(64))
      depositor.setDepositOwner(owner)

      deposit.extraData = undefined

      await depositor.initializeDeposit(depositTx, depositOutputIndex, deposit)

      const execArg = mockClient.signAndExecuteTransaction.getCall(0).args[0]
      const txData = execArg.transaction.getData()
      expect(txData.commands[0].MoveCall.arguments[2]).to.exist
      const ownerInput =
        txData.inputs[txData.commands[0].MoveCall.arguments[2].Input]
      expect(ownerInput.$kind).to.equal("Pure")
      const rawBytes = Buffer.from(ownerInput.Pure.bytes, "base64")
      expect(rawBytes.subarray(1).toString("hex")).to.equal(owner.identifierHex)
    })

    it("should handle transaction failure", async () => {
      mockClient.waitForTransaction.resolves({
        digest: "0xfailed123",
        effects: {
          status: {
            status: "failure",
            error: "Insufficient gas",
          },
        },
      })

      await expect(
        depositor.initializeDeposit(depositTx, depositOutputIndex, deposit)
      ).to.be.rejectedWith(SuiError, "Transaction failed: Insufficient gas")
    })

    it.skip("should handle SDK import failure", async () => {
      // Skipping: Dynamic import syntax (import()) cannot be stubbed in Node.js ESM without custom loader hooks
      importStub
        .withArgs("@mysten/sui/transactions")
        .rejects(new Error("Module not found"))

      await expect(
        depositor.initializeDeposit(depositTx, depositOutputIndex, deposit)
      ).to.be.rejectedWith(
        SuiError,
        "Failed to load SUI SDK. Please ensure @mysten/sui is installed."
      )
    })

    it("should ignore vault parameter", async () => {
      const vault = SuiAddress.from("0x" + "8".repeat(64))

      const result = await depositor.initializeDeposit(
        depositTx,
        depositOutputIndex,
        deposit,
        vault // This should be ignored
      )

      expect(result.digest).to.equal("0xmocktransactiondigest123")

      // Verify vault is not included in the transaction
      const execArg = mockClient.signAndExecuteTransaction.getCall(0).args[0]
      const txData = execArg.transaction.getData()
      expect(txData.commands[0].MoveCall.arguments).to.have.length(3) // Only 3 args, no vault
    })

    it("should reject missing deposit owner before building transaction", async () => {
      deposit.extraData = undefined

      await expect(
        depositor.initializeDeposit(depositTx, depositOutputIndex, deposit)
      ).to.be.rejectedWith(
        SuiError,
        "SUI deposit owner must be set before initializing deposit"
      )
    })

    it("should reject transactions missing DepositInitialized event", async () => {
      mockClient.waitForTransaction.resolves({
        digest: "0xmocktransactiondigest123",
        effects: {
          status: { status: "success" },
        },
        events: [],
      })

      let thrownError: SuiError | undefined
      try {
        await depositor.initializeDeposit(
          depositTx,
          depositOutputIndex,
          deposit
        )
      } catch (error) {
        thrownError = error as SuiError
      }

      expect(thrownError).to.be.instanceOf(SuiError)
      expect(thrownError?.message).to.include(
        "DepositInitialized event not found in transaction"
      )
      expect((thrownError?.cause as any)?.digest).to.equal(
        "0xmocktransactiondigest123"
      )

      // Verify third argument (deposit owner) on the reachable path
      const execArg = mockClient.signAndExecuteTransaction.getCall(0).args[0]
      const txData = execArg.transaction.getData()
      expect(txData.commands[0].MoveCall.arguments).to.have.length(3)
      const ownerInput =
        txData.inputs[txData.commands[0].MoveCall.arguments[2].Input]
      expect(ownerInput.$kind).to.equal("Pure")
      const rawBytes = Buffer.from(ownerInput.Pure.bytes, "base64")
      const decodedOwner = depositor
        .extraDataEncoder()
        .decodeDepositOwner(deposit.extraData!)
      expect(rawBytes.subarray(1).toString("hex")).to.equal(
        decodedOwner.identifierHex
      )
    })
  })
})
