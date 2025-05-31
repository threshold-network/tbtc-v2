import { ChainIdentifier } from "./chain-identifier"
import { BigNumber } from "ethers"
import { ChainMapping, DestinationChainName } from "./chain"
import { BitcoinRawTxVectors } from "../bitcoin"
import { DepositReceipt } from "./bridge"
import { Hex } from "../utils"
import { TransactionReceipt } from "@ethersproject/providers"

/**
 * Convenience type aggregating TBTC cross-chain contracts forming a connector
 * between TBTC L1 ledger chain and a specific supported L2/side-chain.
 */
export type CrossChainInterfaces = DestinationChainInterfaces &
  L1CrossChainContracts

/**
 * Aggregates destination chain specific TBTC cross-chain interfaces.
 */
export type DestinationChainInterfaces = {
  destinationChainTbtcToken: DestinationChainTBTCToken
  destinationChainBitcoinDepositor: BitcoinDepositor
}

/**
 * Aggregates L1-specific TBTC cross-chain contracts.
 */
export type L1CrossChainContracts = {
  l1BitcoinDepositor: L1BitcoinDepositor
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
   * Initializes the cross-chain deposit indirectly through the given L2 chain.
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
  ): Promise<Hex | TransactionReceipt>
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
export type L1BitcoinDepositor = BitcoinDepositor & {
  /**
   * Gets the chain-specific identifier of this contract.
   */
  getChainIdentifier(): ChainIdentifier

  /**
   * Gets the deposit state for the given deposit identifier.
   * @param depositId Identifier of the deposit to get the state for.
   * @returns The state of the deposit.
   */
  getDepositState(depositId: string): Promise<DepositState>
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
   *        identifier on the L2 chain.
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
