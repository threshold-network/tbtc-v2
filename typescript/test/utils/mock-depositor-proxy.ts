import {
  BitcoinRawTxVectors,
  ChainIdentifier,
  DepositorProxy,
  DepositReceipt,
  EthereumAddress,
  Hex,
} from "../../src"

interface RevealDepositLogEntry {
  depositTx: BitcoinRawTxVectors
  depositOutputIndex: number
  deposit: DepositReceipt
}

export class MockDepositorProxy implements DepositorProxy {
  private _revealDepositLog: RevealDepositLogEntry[] = []

  constructor(public taprootDepositsSupported = false) {}

  get revealDepositLog(): RevealDepositLogEntry[] {
    return this._revealDepositLog
  }

  getChainIdentifier(): ChainIdentifier {
    return EthereumAddress.from("0xEdA7bE2D82566ce2546b150447b5cb0E4320a1B2")
  }

  supportsTaprootDeposits(): boolean {
    return this.taprootDepositsSupported
  }

  revealDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex> {
    this._revealDepositLog.push({ depositTx, depositOutputIndex, deposit })
    return new Promise<Hex>((resolve, _) => {
      // random transaction hash
      resolve(
        Hex.from(
          "3f952bdc206bf51bb745b967cb7166149becada878d3191ffe341155ebcd4883"
        )
      )
    })
  }
}
