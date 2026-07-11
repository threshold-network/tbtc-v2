import { expect } from "chai"
import { DepositReceipt } from "../../src/lib/contracts"
import { BitcoinRawTxVectors } from "../../src/lib/bitcoin"
import { EthereumAddress } from "../../src/lib/ethereum"
import { SolanaDepositorInterface } from "../../src/lib/solana/solana-depositor-interface"
import { Hex } from "../../src/lib/utils"

describe("SolanaDepositorInterface", () => {
  it("should reject Taproot receipts before calling the relayer", async () => {
    const depositor = new SolanaDepositorInterface()
    const depositTx: BitcoinRawTxVectors = {
      version: Hex.from("00000000"),
      inputs: Hex.from("11111111"),
      outputs: Hex.from("22222222"),
      locktime: Hex.from("33333333"),
    }
    const deposit: DepositReceipt = {
      depositor: EthereumAddress.from(
        "0x1234567890123456789012345678901234567890"
      ),
      walletPublicKeyHash: Hex.from("11".repeat(20)),
      refundPublicKeyHash: Hex.from("22".repeat(20)),
      walletXOnlyPublicKey: Hex.from("33".repeat(32)),
      refundXOnlyPublicKey: Hex.from("44".repeat(32)),
      blindingFactor: Hex.from("55".repeat(8)),
      refundLocktime: Hex.from("66".repeat(4)),
    }

    expect(depositor.supportsTaprootDeposits()).to.be.false
    await expect(
      depositor.initializeDeposit(depositTx, 0, deposit)
    ).to.be.rejectedWith("Taproot deposits are not supported by this depositor")
  })
})
