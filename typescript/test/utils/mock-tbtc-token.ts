import { ChainIdentifier, TBTCToken } from "../../src/lib/contracts"
import { Hex } from "../../src/lib/utils"
import { BigNumber } from "@ethersproject/bignumber"
import { BitcoinUtxo } from "../../src/lib/bitcoin"
import { EthereumAddress } from "../../src"

interface RequestRedemptionLog {
  walletPublicKey: Hex
  mainUtxo: BitcoinUtxo
  redeemerOutputScript: Hex
  amount: BigNumber
}

interface BuildRequestRedemptionLog {
  redeemer: ChainIdentifier
  walletPublicKey: Hex
  mainUtxo: BitcoinUtxo
  redeemerOutputScript: Hex
}

export class MockTBTCToken implements TBTCToken {
  private _requestRedemptionLog: RequestRedemptionLog[] = []
  private _buildRequestRedemptionLog: BuildRequestRedemptionLog[] = []

  get requestRedemptionLog() {
    return this._requestRedemptionLog
  }

  get buildRequestRedemptionLog() {
    return this._buildRequestRedemptionLog
  }

  totalSupply(blockNumber?: number | undefined): Promise<BigNumber> {
    throw new Error("Method not implemented.")
  }

  async requestRedemption(
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    redeemerOutputScript: Hex,
    amount: BigNumber
  ): Promise<Hex> {
    this._requestRedemptionLog.push({
      walletPublicKey,
      mainUtxo,
      redeemerOutputScript,
      amount: amount.div(1e10), // Store amount in satoshi.
    })

    return Hex.from(
      "0xf7d0c92c8de4d117d915c2a8a54ee550047f926bc00b91b651c40628751cfe29"
    )
  }

  buildRequestRedemptionData(
    redeemer: ChainIdentifier,
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    redeemerOutputScript: Hex
  ): Hex {
    this._buildRequestRedemptionLog.push({
      redeemer,
      walletPublicKey,
      mainUtxo,
      redeemerOutputScript,
    })

    return Hex.from(
      "0x00000000000000000000000048cce57c4d2dbb31eaf79575abf482bbb8dc071d8ffb0f52fcc9a9295f93be404c650e518e965f1a000000000000000000000000d644201d17980ce2109d5dce0cf12fa04333f7c2f9b6d1cf1e6dcb818c4e01a100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000012d9151100000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000017160014165baee6aebf6c14f72c3fc1f46b2369e6eb7c40000000000000000000"
    )
  }

  getChainIdentifier(): ChainIdentifier {
    return EthereumAddress.from("0x694cfd89700040163727828AE20B52099C58F02C")
  }
}
