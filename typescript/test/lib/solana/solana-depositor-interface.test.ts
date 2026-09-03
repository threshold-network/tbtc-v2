import { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import chai from "chai"
import sinon from "sinon"
import axios from "axios"
import { SolanaDepositorInterface } from "../../../src/lib/solana/solana-depositor-interface"
import { SolanaAddress, SolanaExtraDataEncoder } from "../../../src/lib/solana"
import { BitcoinRawTxVectors } from "../../../src/lib/bitcoin"
import { DepositReceipt } from "../../../src/lib/contracts"
import { Hex } from "../../../src/lib/utils"
import { EthereumAddress } from "../../../src/lib/ethereum"

chai.use(chaiAsPromised)

describe("SolanaDepositorInterface", () => {
  let depositor: SolanaDepositorInterface
  let axiosStub: sinon.SinonStub
  const ownerAddress = "11111111111111111111111111111111"
  const senderAddress = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

  const depositTx: BitcoinRawTxVectors = {
    version: Hex.from("0x02000000"),
    inputs: Hex.from("0x01234567"),
    outputs: Hex.from("0x89abcdef"),
    locktime: Hex.from("0x00000000"),
  }

  function buildDeposit(extraData?: Hex): DepositReceipt {
    const encoder = new SolanaExtraDataEncoder()
    const owner = SolanaAddress.from(ownerAddress)
    return {
      depositor: EthereumAddress.from("0x" + "1".repeat(40)),
      walletPublicKeyHash: Hex.from("0x" + "2".repeat(40)),
      refundPublicKeyHash: Hex.from("0x" + "3".repeat(40)),
      blindingFactor: Hex.from("0x" + "4".repeat(16)),
      refundLocktime: Hex.from("0x" + "5".repeat(8)),
      extraData: extraData ?? encoder.encodeDepositOwner(owner),
    }
  }

  const validReceipt = {
    transactionHash: "0x" + "a".repeat(64),
    blockNumber: 1,
    blockHash: "0x" + "b".repeat(64),
    confirmations: 1,
    from: "0x" + "c".repeat(40),
    to: "0x" + "d".repeat(40),
    gasUsed: { toString: () => "21000" },
    logs: [],
  }

  beforeEach(() => {
    depositor = new SolanaDepositorInterface()
    axiosStub = sinon.stub(axios, "post")
  })

  afterEach(() => {
    sinon.restore()
  })

  it("should reject when deposit owner is missing", async () => {
    const deposit = buildDeposit()
    deposit.extraData = undefined

    await expect(
      depositor.initializeDeposit(depositTx, 0, deposit)
    ).to.be.rejectedWith("Extra data is required.")
    expect(axiosStub.called).to.be.false
  })

  it("should post to HTTPS relayer URL", async () => {
    depositor.setDepositOwner(SolanaAddress.from(senderAddress))
    axiosStub.resolves({ data: { receipt: validReceipt } })

    await depositor.initializeDeposit(depositTx, 0, buildDeposit())

    expect(axiosStub.calledOnce).to.be.true
    expect(axiosStub.getCall(0).args[0]).to.equal(
      "https://relayer.tbtcscan.com/api/reveal"
    )
  })

  it("should reject malformed receipt responses", async () => {
    depositor.setDepositOwner(SolanaAddress.from(senderAddress))
    axiosStub.resolves({ data: { receipt: { transactionHash: "not-hex" } } })

    await expect(
      depositor.initializeDeposit(depositTx, 0, buildDeposit())
    ).to.be.rejectedWith("Unexpected response from /api/reveal")
  })

  it("should send aligned owner encodings on valid receipt path", async () => {
    depositor.setDepositOwner(SolanaAddress.from(senderAddress))
    axiosStub.resolves({ data: { receipt: validReceipt } })

    await depositor.initializeDeposit(depositTx, 0, buildDeposit())

    const payload = axiosStub.getCall(0).args[1]
    const owner = SolanaAddress.from(ownerAddress)
    expect(payload.l2DepositOwner).to.equal(`0x${owner.identifierHex}`)
    expect(payload.l2Sender).to.equal(
      `0x${SolanaAddress.from(senderAddress).identifierHex}`
    )
    expect(axiosStub.getCall(0).args[2]).to.deep.include({ timeout: 90000 })
  })
})
