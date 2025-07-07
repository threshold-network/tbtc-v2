import {
  ChainIdentifier,
  DestinationChainTBTCToken,
  L1BitcoinDepositor,
  BitcoinDepositor,
  CrossChainExtraDataEncoder,
  BitcoinRawTxVectors,
  DepositReceipt,
  Hex,
  DepositState,
  L1BitcoinRedeemer,
  BitcoinUtxo,
  L2BitcoinRedeemer,
} from "../../src"
import { BigNumber, BytesLike } from "ethers"

export class MockDestinationChainTBTCToken
  implements DestinationChainTBTCToken
{
  balanceOf(identifier: ChainIdentifier): Promise<BigNumber> {
    throw new Error("Not supported")
  }

  getChainIdentifier(): ChainIdentifier {
    throw new Error("Not supported")
  }
}

export class MockBitcoinDepositor implements BitcoinDepositor {
  readonly #chainIdentifier: ChainIdentifier
  readonly #encoder: CrossChainExtraDataEncoder
  #depositOwner: ChainIdentifier | undefined
  public readonly initializeDepositCalls: InitializeDepositCall[] = []

  constructor(
    chainIdentifier: ChainIdentifier,
    encoder: CrossChainExtraDataEncoder
  ) {
    this.#chainIdentifier = chainIdentifier
    this.#encoder = encoder
  }

  extraDataEncoder(): CrossChainExtraDataEncoder {
    return this.#encoder
  }

  getChainIdentifier(): ChainIdentifier {
    return this.#chainIdentifier
  }

  getDepositOwner(): ChainIdentifier | undefined {
    return this.#depositOwner
  }

  setDepositOwner(depositOwner: ChainIdentifier): void {
    this.#depositOwner = depositOwner
  }

  initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex> {
    this.initializeDepositCalls.push({
      depositTx,
      depositOutputIndex,
      deposit,
      vault,
    })

    return Promise.resolve(Hex.from("0x02"))
  }
}

export class MockL1BitcoinDepositor implements L1BitcoinDepositor {
  readonly #chainIdentifier: ChainIdentifier
  readonly #encoder: CrossChainExtraDataEncoder
  public readonly initializeDepositCalls: InitializeDepositCall[] = []

  constructor(
    chainIdentifier: ChainIdentifier,
    encoder: CrossChainExtraDataEncoder
  ) {
    this.#chainIdentifier = chainIdentifier
    this.#encoder = encoder
  }

  getDepositState(depositId: string): Promise<DepositState> {
    throw new Error("Not supported")
  }

  extraDataEncoder(): CrossChainExtraDataEncoder {
    return this.#encoder
  }

  getChainIdentifier(): ChainIdentifier {
    return this.#chainIdentifier
  }

  initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex> {
    this.initializeDepositCalls.push({
      depositTx,
      depositOutputIndex,
      deposit,
      vault,
    })

    return Promise.resolve(Hex.from("0x01"))
  }
}

export class MockL1BitcoinRedeemer implements L1BitcoinRedeemer {
  readonly #chainIdentifier: ChainIdentifier

  constructor(chainIdentifier: ChainIdentifier) {
    this.#chainIdentifier = chainIdentifier
  }

  getChainIdentifier(): ChainIdentifier {
    return this.#chainIdentifier
  }

  requestRedemption(
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    encodedVm: BytesLike
  ): Promise<Hex> {
    return Promise.resolve(Hex.from("0x03"))
  }
}

export class MockL2BitcoinRedeemer implements L2BitcoinRedeemer {
  readonly #chainIdentifier: ChainIdentifier

  constructor(chainIdentifier: ChainIdentifier) {
    this.#chainIdentifier = chainIdentifier
  }

  getChainIdentifier(): ChainIdentifier {
    return this.#chainIdentifier
  }

  requestRedemption(
    amount: BigNumber,
    redeemerOutputScript: Hex,
    nonce: number
  ): Promise<Hex> {
    return Promise.resolve(Hex.from("0x04"))
  }
}
export class MockCrossChainExtraDataEncoder
  implements CrossChainExtraDataEncoder
{
  #encodings: Map<string, Hex> = new Map()

  setEncoding(depositOwner: ChainIdentifier, extraData: Hex): void {
    this.#encodings.set(depositOwner.identifierHex, extraData)
  }

  encodeDepositOwner(depositOwner: ChainIdentifier): Hex {
    const extraData = this.#encodings.get(depositOwner.identifierHex)
    if (!extraData) {
      throw new Error("Encoding not found")
    }

    return extraData
  }

  decodeDepositOwner(data: Hex): ChainIdentifier {
    throw new Error("Not supported")
  }
}

type InitializeDepositCall = {
  depositTx: BitcoinRawTxVectors
  depositOutputIndex: number
  deposit: DepositReceipt
  vault?: ChainIdentifier
}

// Backward compatibility aliases
export const MockL2TBTCToken = MockDestinationChainTBTCToken
export const MockL2BitcoinDepositor = MockBitcoinDepositor
