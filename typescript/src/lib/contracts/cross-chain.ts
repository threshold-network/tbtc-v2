import { ChainIdentifier } from "./chain-identifier"
import { BigNumber, BytesLike } from "ethers"
import { TransactionReceipt } from "@ethersproject/providers"
import { ChainMapping, DestinationChainName } from "./chain"
import { BitcoinRawTxVectors, BitcoinUtxo } from "../bitcoin"
import { DepositReceipt } from "./bridge"
import { Hex } from "../utils"

/**
 * Convenience type aggregating TBTC cross-chain contracts forming a connector
 * between TBTC L1 ledger chain and a specific supported destination chain.
 */
export type CrossChainInterfaces = DestinationChainInterfaces &
  L1CrossChainContracts

/**
 * Aggregates destination chain-specific TBTC cross-chain contracts.
 */
export type DestinationChainInterfaces = {
  destinationChainTbtcToken: DestinationChainTBTCToken
  destinationChainBitcoinDepositor: BitcoinDepositor
  l2BitcoinRedeemer?: L2BitcoinRedeemer
}

/**
 * Aggregates L1-specific TBTC cross-chain contracts.
 */
export type L1CrossChainContracts = {
  l1BitcoinDepositor: L1BitcoinDepositor
  l1BitcoinRedeemer: L1BitcoinRedeemer
}

/**
 * Interface for loading TBTC cross-chain contracts for a specific L2 chain.
 * It should be implemented for each supported L1 chain tBTC ledger is deployed
 * on.
 */
export interface CrossChainContractsLoader {
  /**
   * Loads the chain mapping based on underlying L1 chain.
   */
  loadChainMapping: () => ChainMapping | undefined
  /**
   * Loads L1-specific TBTC cross-chain contracts for the given destination chain.
   * @param destinationChainName Name of the destination chain for which to load L1 contracts.
   */
  loadL1Contracts: (
    destinationChainName: DestinationChainName
  ) => Promise<L1CrossChainContracts>
}

/**
 * Interface for communication with the on-chain contract of the given
 * canonical destination chain tBTC token.
 */
export interface DestinationChainTBTCToken {
  /**
   * Gets the chain-specific identifier of this contract.
   */
  getChainIdentifier(): ChainIdentifier

  /**
   * Returns the balance of the given identifier.
   * @param identifier Identifier of the account to get the balance for.
   * @returns The balance of the given identifier in 1e18 precision.
   */
  balanceOf(identifier: ChainIdentifier): Promise<BigNumber>
}

/**
 * Interface for communication with the BitcoinDepositor on-chain contract
 * deployed on the given destination chain.
 */
export interface BitcoinDepositor {
  /**
   * Gets the chain-specific identifier of this contract.
   * Optional method - may not be available for off-chain implementations.
   */
  getChainIdentifier?(): ChainIdentifier

  /**
   * Gets the identifier that should be used as the owner of the deposits
   * issued by this contract.
   * @returns The identifier of the deposit owner or undefined if not set.
   */
  getDepositOwner(): ChainIdentifier | undefined

  /**
   * Sets the identifier that should be used as the owner of the deposits
   * issued by this contract.
   * @param depositOwner Identifier of the deposit owner or undefined to clear.
   */
  setDepositOwner(depositOwner: ChainIdentifier): void

  /**
   * @returns Extra data encoder for this contract. The encoder is used to
   * encode and decode the extra data included in the cross-chain deposit script.
   */
  extraDataEncoder(): ExtraDataEncoder

  /**
   * Initializes the cross-chain deposit indirectly through the given destination chain.
   * @param depositTx Deposit transaction data
   * @param depositOutputIndex Index of the deposit transaction output that
   *        funds the revealed deposit
   * @param deposit Data of the revealed deposit
   * @param vault Optional parameter denoting the vault the given deposit
   *        should be routed to
   * @returns Transaction hash of the reveal deposit transaction or full transaction receipt.
   */
  initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex | TransactionReceipt>
}

/**
 * Interface for communication with the L2BitcoinRedeemer on-chain contract
 * deployed on the given L2 chain.
 */
export interface L2BitcoinRedeemer {
  /**
   * Gets the chain-specific identifier of this contract.
   */
  getChainIdentifier(): ChainIdentifier

  /**
   * Requests redemption in one transaction using the `approveAndCall` function
   * from the tBTC on-chain token contract. Then the tBTC token contract calls
   * the `receiveApproval` function from the `TBTCVault` contract which burns
   * tBTC tokens and requests redemption.
   * @param redeemerOutputScript - The output script that the redeemed funds
   *        will be locked to. Must not be prepended with length.
   * @param amount - The amount to be redeemed with the precision of the tBTC
   *        on-chain token contract.
   * @returns Transaction hash of the approve and call transaction.
   */
  requestRedemption(
    amount: BigNumber,
    redeemerOutputScript: Hex,
    nonce: number
  ): Promise<Hex>
}

/**
 * Represents the state of the deposit.
 */
export enum DepositState {
  // eslint-disable-next-line no-unused-vars
  UNKNOWN,
  // eslint-disable-next-line no-unused-vars
  INITIALIZED,
  // eslint-disable-next-line no-unused-vars
  FINALIZED,
}

/**
 * Interface for communication with the L1BitcoinDepositor on-chain contract
 * specific to the given L2 chain, deployed on the L1 chain.
 */
export interface L1BitcoinDepositor {
  /**
   * Gets the deposit state for the given deposit identifier.
   * @param depositId Identifier of the deposit to get the state for.
   * @returns The state of the deposit.
   */
  getDepositState(depositId: string): Promise<DepositState>

  /**
   * Gets the chain-specific identifier of this contract.
   */
  getChainIdentifier(): ChainIdentifier

  /**
   * @returns Extra data encoder for this contract. The encoder is used to
   * encode and decode the extra data included in the cross-chain deposit script.
   */
  extraDataEncoder(): ExtraDataEncoder

  /**
   * Initializes the cross-chain deposit directly on the given L1 chain.
   * @param depositTx Deposit transaction data
   * @param depositOutputIndex Index of the deposit transaction output that
   *        funds the revealed deposit
   * @param deposit Data of the revealed deposit
   * @param vault Optional parameter denoting the vault the given deposit
   *        should be routed to
   * @returns Transaction hash of the reveal deposit transaction.
   */
  initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex>
}

/**
 * Interface for communication with the L2BitcoinRedeemer on-chain contract
 * deployed on the given L2 chain.
 */
export interface L1BitcoinRedeemer {
  /**
   * Gets the chain-specific identifier of this contract.
   */
  getChainIdentifier(): ChainIdentifier

  /**
   * Requests redemption in one transaction using the `approveAndCall` function
   * from the tBTC on-chain token contract. Then the tBTC token contract calls
   * the `receiveApproval` function from the `TBTCVault` contract which burns
   * tBTC tokens and requests redemption.
   * @param walletPublicKey - The public key of the wallet that is redeeming the
   *        tBTC tokens.
   * @param mainUtxo - The main UTXO of the wallet that is redeeming the tBTC
   *        tokens.
   * @param encodedVm - The encoded VM of the redemption.
   * @returns Transaction hash of the approve and call transaction.
   */
  requestRedemption(
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    encodedVm: BytesLike
  ): Promise<Hex>
}

/**
 * Interface for encoding and decoding the extra data included in the
 * cross-chain deposit script.
 */
export interface ExtraDataEncoder {
  /**
   * Encodes the given deposit owner identifier into the extra data.
   * @param depositOwner Identifier of the deposit owner to encode.
   *        For cross-chain deposits, the deposit owner is typically an
   *        identifier on the destination chain.
   * @returns Encoded extra data.
   */
  encodeDepositOwner(depositOwner: ChainIdentifier): Hex

  /**
   * Decodes the extra data into the deposit owner identifier.
   * @param extraData Extra data to decode.
   * @returns Identifier of the deposit owner.
   */
  decodeDepositOwner(extraData: Hex): ChainIdentifier
}

// Backward compatibility aliases (deprecated)
/**
 * @deprecated Use CrossChainInterfaces instead
 */
export type CrossChainContracts = CrossChainInterfaces

/**
 * @deprecated Use DestinationChainInterfaces instead
 */
export type L2CrossChainContracts = DestinationChainInterfaces

/**
 * @deprecated Use DestinationChainTBTCToken instead
 */
export type L2TBTCToken = DestinationChainTBTCToken

/**
 * @deprecated Use BitcoinDepositor instead
 */
export type L2BitcoinDepositor = BitcoinDepositor

/**
 * @deprecated Use ExtraDataEncoder instead
 */
export type CrossChainExtraDataEncoder = ExtraDataEncoder
