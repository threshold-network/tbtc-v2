import {
  CrossChainContractsLoader,
  L1CrossChainContracts,
  L2Chain,
  ChainMapping,
  Chains,
  L1BitcoinDepositor,
  DepositState,
  DepositReceipt,
  ChainIdentifier,
  CrossChainExtraDataEncoder,
} from "../../src/lib/contracts"
import { EthereumAddress } from "../../src/lib/ethereum"
import { BitcoinRawTxVectors } from "../../src/lib/bitcoin"
import { Hex } from "../../src/lib/utils"
import { MockL1BitcoinRedeemer } from "./mock-cross-chain"

class MockL1BitcoinDepositor implements L1BitcoinDepositor {
  async getDepositState(depositId: string): Promise<DepositState> {
    return DepositState.UNKNOWN
  }

  getChainIdentifier(): ChainIdentifier {
    return EthereumAddress.from("0x0000000000000000000000000000000000000005")
  }

  extraDataEncoder(): CrossChainExtraDataEncoder {
    return {
      encodeDepositOwner: (depositOwner: ChainIdentifier) => Hex.from("0x"),
      decodeDepositOwner: (extraData: Hex) =>
        EthereumAddress.from("0x0000000000000000000000000000000000000000"),
    }
  }

  async initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex> {
    return Hex.from(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    )
  }
}

export class MockCrossChainContractsLoader
  implements CrossChainContractsLoader
{
  loadChainMapping(): ChainMapping | undefined {
    return {
      ethereum: Chains.Ethereum.Sepolia,
      base: Chains.Base.BaseSepolia,
      arbitrum: Chains.Arbitrum.ArbitrumSepolia,
      starknet: Chains.StarkNet.Sepolia,
    }
  }

  async loadL1Contracts(l2ChainName: L2Chain): Promise<L1CrossChainContracts> {
    const l1BitcoinDepositor = new MockL1BitcoinDepositor()
    const l1BitcoinRedeemer = new MockL1BitcoinRedeemer(
      EthereumAddress.from("D61d47F917Cd1188BfEAC6D79f682a3cCA1BBEc7")
    )

    return {
      l1BitcoinDepositor,
      l1BitcoinRedeemer,
    }
  }
}
