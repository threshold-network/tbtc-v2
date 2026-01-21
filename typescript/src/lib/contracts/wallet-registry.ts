import { Hex } from "../utils"
import { ChainEvent, GetChainEvents } from "./chain-event"
import { BigNumber } from "@ethersproject/bignumber"
import { ChainIdentifier } from "./chain-identifier"

/**
 * Interface for communication with the WalletRegistry on-chain contract.
 */
export interface WalletRegistry {
  /**
   * Gets the chain-specific identifier of this contract.
   */
  getChainIdentifier(): ChainIdentifier

  /**
   * Gets the public key for the given wallet.
   * @param walletID ID of the wallet.
   * @returns Uncompressed public key without the 04 prefix.
   */
  getWalletPublicKey(walletID: Hex): Promise<Hex>

  /**
   * Get emitted DkgResultSubmittedEvent events.
   * @see GetEventsFunction
   */
  getDkgResultSubmittedEvents: GetChainEvents.Function<DkgResultSubmittedEvent>

  /**
   * Get emitted DkgResultApprovedEvent events.
   * @see GetEventsFunction
   */
  getDkgResultApprovedEvents: GetChainEvents.Function<DkgResultApprovedEvent>

  /**
   * Get emitted DkgResultChallengedEvent events.
   * @see GetEventsFunction
   */
  getDkgResultChallengedEvents: GetChainEvents.Function<DkgResultChallengedEvent>
}

/**
 * Represents an event emitted when a DKG result is submitted to the on-chain
 * wallet registry.
 */
export type DkgResultSubmittedEvent = {
  /**
   * 32-byte hash of the submitted DKG result.
   */
  resultHash: Hex
  /**
   * 32-byte seed of the current DKG execution.
   */
  seed: Hex
  /**
   * DKG result object.
   */
  result: DkgResult
} & ChainEvent

/**
 * Represents an event emitted when a DKG result is approved on the on-chain
 * wallet registry.
 */
export type DkgResultApprovedEvent = {
  /**
   * 32-byte hash of the submitted DKG result.
   */
  resultHash: Hex
  /**
   * Approver's chain identifier.
   */
  approver: ChainIdentifier
} & ChainEvent

/**
 * Represents an event emitted when a DKG result is challenged on the on-chain
 * wallet registry.
 */
export type DkgResultChallengedEvent = {
  /**
   * 32-byte hash of the submitted DKG result.
   */
  resultHash: Hex
  /**
   * Challenger's chain identifier.
   */
  challenger: ChainIdentifier
  /**
   * Reason of the challenge.
   */
  reason: string
} & ChainEvent

/**
 * Represents a DKG on-chain result.
 */
type DkgResult = {
  /**
   * Claimed submitter candidate group member index. Is in range [1, groupSize].
   */
  submitterMemberIndex: BigNumber
  /**
   * Generated group public key.
   */
  groupPubKey: Hex
  /**
   * Array of misbehaved members indices (disqualified or inactive). Indices
   * are in range [1, groupSize], unique, and sorted in ascending order.
   */
  misbehavedMembersIndices: number[]
  /**
   * Concatenation of signatures from members supporting the result.
   * The message to be signed by each member is keccak256 hash of the
   * calculated group public key, misbehaved members indices and DKG
   * start block. The calculated hash is also prefixed with
   * `\x19Ethereum signed message:\n` before signing.
   */
  signatures: Hex
  /**
   * Indices of members corresponding to each signature. Indices are
   * in range [1, groupSize], unique, and sorted in ascending order.
   */
  signingMembersIndices: BigNumber[]
  /**
   * Identifiers of candidate group members as outputted by the group
   * selection protocol.
   */
  members: number[]
  /**
   * Keccak256 hash of group members identifiers that actively took part
   * in DKG (excluding IA/DQ members).
   */
  membersHash: Hex
}
