import {
  Bridge,
  WalletRegistry,
  GetChainEvents,
  ChainIdentifier,
  NewWalletRegisteredEvent,
  Wallet,
  RedemptionRequest,
  RedemptionRequestedEvent,
  DepositReceipt,
  DepositRevealedEvent,
  DepositRequest,
} from "../../src/lib/contracts"
import {
  BitcoinRawTxVectors,
  BitcoinSpvProof,
  BitcoinUtxo,
  BitcoinHashUtils,
  BitcoinTxHash,
} from "../../src/lib/bitcoin"
import { BigNumber, BigNumberish } from "@ethersproject/bignumber"
import { AddressZero } from "@ethersproject/constants"
import { keccak256 as solidityKeccak256 } from "@ethersproject/solidity"
import { depositSweepWithNoMainUtxoAndWitnessOutput } from "../data/deposit-sweep"
import { EthereumAddress } from "../../src/lib/ethereum"
import { Hex } from "../../src/lib/utils"

interface DepositSweepProofLogEntry {
  sweepTx: BitcoinRawTxVectors
  sweepProof: BitcoinSpvProof
  mainUtxo: BitcoinUtxo
}

interface RevealDepositLogEntry {
  depositTx: BitcoinRawTxVectors
  depositOutputIndex: number
  deposit: DepositReceipt
}

interface RequestRedemptionLogEntry {
  walletPublicKey: Hex
  mainUtxo: BitcoinUtxo
  redeemerOutputScript: Hex
  amount: BigNumber
}

interface RedemptionProofLogEntry {
  redemptionTx: BitcoinRawTxVectors
  redemptionProof: BitcoinSpvProof
  mainUtxo: BitcoinUtxo
  walletPublicKey: Hex
}

interface NewWalletRegisteredEventsLog {
  options?: GetChainEvents.Options
  filterArgs: unknown[]
}

interface WalletLog {
  walletPublicKeyHash: Hex
}

/**
 * Mock Bridge used for test purposes.
 */
export class MockBridge implements Bridge {
  private _difficultyFactor = 6
  private _pendingRedemptions = new Map<BigNumberish, RedemptionRequest>()
  private _timedOutRedemptions = new Map<BigNumberish, RedemptionRequest>()
  private _depositSweepProofLog: DepositSweepProofLogEntry[] = []
  private _revealDepositLog: RevealDepositLogEntry[] = []
  private _requestRedemptionLog: RequestRedemptionLogEntry[] = []
  private _redemptionProofLog: RedemptionProofLogEntry[] = []
  private _deposits = new Map<BigNumberish, DepositRequest>()
  private _activeWalletPublicKey: Hex | undefined
  private _newWalletRegisteredEvents: NewWalletRegisteredEvent[] = []
  private _newWalletRegisteredEventsLog: NewWalletRegisteredEventsLog[] = []
  private _wallets = new Map<string, Wallet>()
  private _walletsLog: WalletLog[] = []

  setPendingRedemptions(value: Map<BigNumberish, RedemptionRequest>) {
    this._pendingRedemptions = value
  }

  setTimedOutRedemptions(value: Map<BigNumberish, RedemptionRequest>) {
    this._timedOutRedemptions = value
  }

  setWallet(key: string, value: Wallet) {
    this._wallets.set(key, value)
  }

  set newWalletRegisteredEvents(value: NewWalletRegisteredEvent[]) {
    this._newWalletRegisteredEvents = value
  }

  get depositSweepProofLog(): DepositSweepProofLogEntry[] {
    return this._depositSweepProofLog
  }

  get revealDepositLog(): RevealDepositLogEntry[] {
    return this._revealDepositLog
  }

  get requestRedemptionLog(): RequestRedemptionLogEntry[] {
    return this._requestRedemptionLog
  }

  get redemptionProofLog(): RedemptionProofLogEntry[] {
    return this._redemptionProofLog
  }

  get newWalletRegisteredEventsLog(): NewWalletRegisteredEventsLog[] {
    return this._newWalletRegisteredEventsLog
  }

  get walletsLog(): WalletLog[] {
    return this._walletsLog
  }

  setDeposits(value: Map<BigNumberish, DepositRequest>) {
    this._deposits = value
  }

  setActiveWalletPublicKey(activeWalletPublicKey: Hex) {
    this._activeWalletPublicKey = activeWalletPublicKey
  }

  getDepositRevealedEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<any>
  ): Promise<DepositRevealedEvent[]> {
    const deposit = depositSweepWithNoMainUtxoAndWitnessOutput.deposits[0]

    return new Promise<DepositRevealedEvent[]>((resolve, _) => {
      resolve([
        {
          blockNumber: 32142,
          blockHash: Hex.from(
            "0xe43552af34efab0828278b91e0f984e4b9769abf85beaed41eee4c25c822a619"
          ),
          transactionHash: Hex.from(
            "0xdc6c041baaf1cc5bebca5aab02d0488e885a3687541ef012d9beb53141f73419"
          ),
          fundingTxHash: deposit.utxo.transactionHash,
          fundingOutputIndex: deposit.utxo.outputIndex,
          depositor: deposit.data.depositor,
          amount: deposit.utxo.value,
          blindingFactor: deposit.data.blindingFactor,
          walletPublicKeyHash: deposit.data.walletPublicKeyHash,
          refundPublicKeyHash: deposit.data.refundPublicKeyHash,
          refundLocktime: deposit.data.refundLocktime,
          vault: EthereumAddress.from(AddressZero),
        },
      ])
    })
  }

  submitDepositSweepProof(
    sweepTx: BitcoinRawTxVectors,
    sweepProof: BitcoinSpvProof,
    mainUtxo: BitcoinUtxo,
    vault?: ChainIdentifier
  ): Promise<Hex> {
    this._depositSweepProofLog.push({ sweepTx, sweepProof, mainUtxo })
    return new Promise<Hex>((resolve, _) => {
      resolve(
        Hex.from(
          "01ee2a0061b6bd68b6f478c48b9625fac89a4401e73b49d3ee258f9a60c5e65f"
        )
      )
    })
  }

  revealDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt
  ): Promise<Hex> {
    this._revealDepositLog.push({ depositTx, depositOutputIndex, deposit })
    return new Promise<Hex>((resolve, _) => {
      // random transaction hash
      resolve(
        Hex.from(
          "2f952bdc206bf51bb745b967cb7166149becada878d3191ffe341155ebcd4883"
        )
      )
    })
  }

  deposits(
    depositTxHash: BitcoinTxHash,
    depositOutputIndex: number
  ): Promise<DepositRequest> {
    return new Promise<DepositRequest>((resolve, _) => {
      const depositKey = MockBridge.buildDepositKey(
        depositTxHash,
        depositOutputIndex
      )

      resolve(
        this._deposits.has(depositKey)
          ? (this._deposits.get(depositKey) as DepositRequest)
          : {
              depositor: EthereumAddress.from(AddressZero),
              amount: BigNumber.from(0),
              vault: EthereumAddress.from(AddressZero),
              revealedAt: 0,
              sweptAt: 0,
              treasuryFee: BigNumber.from(0),
            }
      )
    })
  }

  static buildDepositKey(
    depositTxHash: BitcoinTxHash,
    depositOutputIndex: number
  ): string {
    const prefixedReversedDepositTxHash = depositTxHash
      .reverse()
      .toPrefixedString()

    return solidityKeccak256(
      ["bytes32", "uint32"],
      [prefixedReversedDepositTxHash, depositOutputIndex]
    )
  }

  submitRedemptionProof(
    redemptionTx: BitcoinRawTxVectors,
    redemptionProof: BitcoinSpvProof,
    mainUtxo: BitcoinUtxo,
    walletPublicKey: Hex
  ): Promise<Hex> {
    this._redemptionProofLog.push({
      redemptionTx,
      redemptionProof,
      mainUtxo,
      walletPublicKey,
    })
    return new Promise<Hex>((resolve, _) => {
      // random transaction hash
      resolve(
        Hex.from(
          "4f6ce6af47d547bb9821d28c21261026f21b72e52d506d17ab81502b8021537d"
        )
      )
    })
  }

  requestRedemption(
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    redeemerOutputScript: Hex,
    amount: BigNumber
  ): Promise<Hex> {
    this._requestRedemptionLog.push({
      walletPublicKey,
      mainUtxo,
      redeemerOutputScript,
      amount,
    })
    return new Promise<Hex>((resolve, _) => {
      // random transaction hash
      resolve(
        Hex.from(
          "bcbef136592feabdebcc68eb4222a49369a9cfeb7fc5f5ec84583313249025fd"
        )
      )
    })
  }

  txProofDifficultyFactor(): Promise<number> {
    return new Promise<number>((resolve, _) => {
      resolve(this._difficultyFactor)
    })
  }

  pendingRedemptions(
    walletPublicKey: Hex,
    redeemerOutputScript: Hex
  ): Promise<RedemptionRequest> {
    return this.pendingRedemptionsByWalletPKH(
      BitcoinHashUtils.computeHash160(walletPublicKey),
      redeemerOutputScript
    )
  }

  pendingRedemptionsByWalletPKH(
    walletPublicKeyHash: Hex,
    redeemerOutputScript: Hex
  ): Promise<RedemptionRequest> {
    return new Promise<RedemptionRequest>((resolve, _) => {
      resolve(
        this.redemptions(
          walletPublicKeyHash,
          redeemerOutputScript,
          this._pendingRedemptions
        )
      )
    })
  }

  timedOutRedemptions(
    walletPublicKey: Hex,
    redeemerOutputScript: Hex
  ): Promise<RedemptionRequest> {
    return new Promise<RedemptionRequest>((resolve, _) => {
      resolve(
        this.redemptions(
          BitcoinHashUtils.computeHash160(walletPublicKey),
          redeemerOutputScript,
          this._timedOutRedemptions
        )
      )
    })
  }

  private redemptions(
    walletPublicKeyHash: Hex,
    redeemerOutputScript: Hex,
    redemptionsMap: Map<BigNumberish, RedemptionRequest>
  ): RedemptionRequest {
    const redemptionKey = MockBridge.buildRedemptionKey(
      walletPublicKeyHash,
      redeemerOutputScript
    )

    // Return the redemption if it is found in the map.
    // Otherwise, return zeroed values simulating the behavior of a smart contract.
    return redemptionsMap.has(redemptionKey)
      ? (redemptionsMap.get(redemptionKey) as RedemptionRequest)
      : {
          redeemer: EthereumAddress.from(AddressZero),
          redeemerOutputScript: Hex.from(""),
          requestedAmount: BigNumber.from(0),
          treasuryFee: BigNumber.from(0),
          txMaxFee: BigNumber.from(0),
          requestedAt: 0,
        }
  }

  static buildRedemptionKey(
    walletPublicKeyHash: Hex,
    redeemerOutputScript: Hex
  ): string {
    const prefixedWalletPublicKeyHash = walletPublicKeyHash.toPrefixedString()

    const rawOutputScript = redeemerOutputScript.toBuffer()

    const prefixedOutputScript = `0x${Buffer.concat([
      Buffer.from([rawOutputScript.length]),
      rawOutputScript,
    ]).toString("hex")}`

    return solidityKeccak256(
      ["bytes32", "bytes20"],
      [
        solidityKeccak256(["bytes"], [prefixedOutputScript]),
        prefixedWalletPublicKeyHash,
      ]
    )
  }

  async activeWalletPublicKey(): Promise<Hex | undefined> {
    return this._activeWalletPublicKey
  }

  async getNewWalletRegisteredEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<NewWalletRegisteredEvent[]> {
    this._newWalletRegisteredEventsLog.push({ options, filterArgs })
    return this._newWalletRegisteredEvents
  }

  walletRegistry(): Promise<WalletRegistry> {
    throw new Error("not implemented")
  }

  async wallets(walletPublicKeyHash: Hex): Promise<Wallet> {
    this._walletsLog.push({
      walletPublicKeyHash,
    })
    const wallet = this._wallets.get(walletPublicKeyHash.toPrefixedString())
    return wallet!
  }

  buildUtxoHash(utxo: BitcoinUtxo): Hex {
    return Hex.from(
      solidityKeccak256(
        ["bytes32", "uint32", "uint64"],
        [
          utxo.transactionHash.reverse().toPrefixedString(),
          utxo.outputIndex,
          utxo.value,
        ]
      )
    )
  }

  getRedemptionRequestedEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<any>
  ): Promise<RedemptionRequestedEvent[]> {
    throw new Error("not implemented")
  }

  getChainIdentifier(): ChainIdentifier {
    return EthereumAddress.from("0x894cfd89700040163727828AE20B52099C58F02C")
  }
}
