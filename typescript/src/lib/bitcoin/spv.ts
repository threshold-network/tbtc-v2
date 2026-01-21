import { BitcoinTx, BitcoinTxHash, extractBitcoinRawTxVectors } from "./tx"
import { BitcoinClient } from "./client"
import { BigNumber } from "@ethersproject/bignumber"
import {
  BitcoinHeader,
  BitcoinHeaderSerializer,
  validateBitcoinHeadersChain,
} from "./header"
import { Hex } from "../utils"
import { BitcoinHashUtils } from "./hash"

/**
 * Data required to perform a proof that a given transaction was included in
 * the Bitcoin blockchain.
 */
export interface BitcoinSpvProof {
  /**
   * The merkle proof of transaction inclusion in a block.
   */
  merkleProof: Hex

  /**
   * Transaction index in the block (0-indexed).
   */
  txIndexInBlock: number

  /**
   * Concatenated block headers in hexadecimal format. Each block header is
   * 80-byte-long. The block header with the lowest height is first.
   */
  bitcoinHeaders: Hex

  /**
   * The sha256 preimage of the coinbase transaction hash i.e.,
   * the sha256 hash of the coinbase transaction.
   */
  coinbasePreimage: Hex

  /**
   * Merkle proof of coinbase transaction inclusion in a block.
   */
  coinbaseProof: Hex
}

/**
 * Information about the merkle branch to a confirmed transaction.
 */
export interface BitcoinTxMerkleBranch {
  /**
   * The height of the block the transaction was confirmed in.
   */
  blockHeight: number

  /**
   * A list of transaction hashes the current hash is paired with, recursively,
   * in order to trace up to obtain the merkle root of the including block,
   * the deepest pairing first. Each hash is an unprefixed hex string.
   */
  merkle: Hex[]

  /**
   * The 0-based index of the transaction's position in the block.
   */
  position: number
}

/**
 * Assembles a proof that a given transaction was included in the blockchain and
 * has accumulated the required number of confirmations.
 * @param transactionHash - Hash of the transaction being proven.
 * @param requiredConfirmations - Required number of confirmations.
 * @param bitcoinClient - Bitcoin client used to interact with the network.
 * @returns Bitcoin transaction along with the inclusion proof.
 */
export async function assembleBitcoinSpvProof(
  transactionHash: BitcoinTxHash,
  requiredConfirmations: number,
  bitcoinClient: BitcoinClient
): Promise<BitcoinTx & BitcoinSpvProof> {
  const transaction = await bitcoinClient.getTransaction(transactionHash)
  const confirmations = await bitcoinClient.getTransactionConfirmations(
    transactionHash
  )

  if (confirmations < requiredConfirmations) {
    throw new Error(
      "Transaction confirmations number[" +
        confirmations +
        "] is not enough, required [" +
        requiredConfirmations +
        "]"
    )
  }

  const latestBlockHeight = await bitcoinClient.latestBlockHeight()
  const txBlockHeight = latestBlockHeight - confirmations + 1

  // We subtract `1` from `requiredConfirmations` because the header at
  // `txBlockHeight` is already included in the headers chain and is considered
  // the first confirmation. So we only need to retrieve `requiredConfirmations - 1`
  // subsequent block headers to reach the desired number of confirmations for
  // the transaction.
  const headersChain = await bitcoinClient.getHeadersChain(
    txBlockHeight,
    requiredConfirmations - 1
  )

  const merkleBranch = await bitcoinClient.getTransactionMerkle(
    transactionHash,
    txBlockHeight
  )

  const merkleProof = createMerkleProof(merkleBranch)

  const coinbaseTxHash = await bitcoinClient.getCoinbaseTxHash(txBlockHeight)

  const coinbaseTx = extractBitcoinRawTxVectors(
    await bitcoinClient.getRawTransaction(coinbaseTxHash)
  )

  const coinbasePreimage = BitcoinHashUtils.computeSha256(
    Hex.from(
      `${coinbaseTx.version.toString()}` +
        `${coinbaseTx.inputs.toString()}` +
        `${coinbaseTx.outputs.toString()}` +
        `${coinbaseTx.locktime.toString()}`
    )
  )

  const coinbaseMerkleBranch = await bitcoinClient.getTransactionMerkle(
    coinbaseTxHash,
    txBlockHeight
  )

  const coinbaseMerkleProof = createMerkleProof(coinbaseMerkleBranch)

  const proof = {
    merkleProof: merkleProof,
    txIndexInBlock: merkleBranch.position,
    bitcoinHeaders: headersChain,
    coinbasePreimage: coinbasePreimage,
    coinbaseProof: coinbaseMerkleProof,
  }

  return { ...transaction, ...proof }
}

/**
 * Create a proof of transaction inclusion in the block by concatenating
 * 32-byte-long hash values. The values are converted to little endian form.
 * @param txMerkleBranch - Branch of a Merkle tree leading to a transaction.
 * @returns Transaction inclusion proof in hexadecimal form.
 */
function createMerkleProof(txMerkleBranch: BitcoinTxMerkleBranch): Hex {
  let proof = Buffer.from("")
  txMerkleBranch.merkle.forEach(function (item) {
    proof = Buffer.concat([proof, item.toBuffer().reverse()])
  })
  return Hex.from(proof)
}

/**
 * Proves that a transaction with the given hash is included in the Bitcoin
 * blockchain by validating the transaction's inclusion in the Merkle tree and
 * verifying that the block containing the transaction has enough confirmations.
 * @param transactionHash The hash of the transaction to be validated.
 * @param requiredConfirmations The number of confirmations required for the
 *        transaction to be considered valid. The transaction has 1 confirmation
 *        when it is in the block at the current blockchain tip. Every subsequent
 *        block added to the blockchain is one additional confirmation.
 * @param previousDifficulty The difficulty of the previous Bitcoin epoch.
 * @param currentDifficulty The difficulty of the current Bitcoin epoch.
 * @param bitcoinClient The client for interacting with the Bitcoin blockchain.
 * @throws {Error} If the transaction is not included in the Bitcoin blockchain
 *        or if the block containing the transaction does not have enough
 *        confirmations.
 * @dev The function should be used within a try-catch block.
 * @returns An empty return value.
 */
export async function validateBitcoinSpvProof(
  transactionHash: BitcoinTxHash,
  requiredConfirmations: number,
  previousDifficulty: BigNumber,
  currentDifficulty: BigNumber,
  bitcoinClient: BitcoinClient
) {
  if (requiredConfirmations < 1) {
    throw new Error("The number of required confirmations but at least 1")
  }

  const proof = await assembleBitcoinSpvProof(
    transactionHash,
    requiredConfirmations,
    bitcoinClient
  )

  if (
    proof.merkleProof.toBuffer().length !==
    proof.coinbaseProof.toBuffer().length
  ) {
    throw new Error("Tx not on same level of merkle tree as coinbase")
  }

  const bitcoinHeaders: BitcoinHeader[] =
    BitcoinHeaderSerializer.deserializeHeadersChain(proof.bitcoinHeaders)
  if (bitcoinHeaders.length != requiredConfirmations) {
    throw new Error("Wrong number of confirmations")
  }

  const merkleRootHash: Hex = bitcoinHeaders[0].merkleRootHash

  validateMerkleTree(
    transactionHash,
    merkleRootHash,
    splitMerkleProof(proof.merkleProof),
    proof.txIndexInBlock
  )

  validateBitcoinHeadersChain(
    bitcoinHeaders,
    previousDifficulty,
    currentDifficulty
  )

  validateMerkleTree(
    BitcoinHashUtils.computeSha256(proof.coinbasePreimage).reverse(),
    merkleRootHash,
    splitMerkleProof(proof.coinbaseProof),
    0
  )
}

/**
 * Validates the Merkle tree by checking if the provided transaction hash,
 * Merkle root hash, intermediate node hashes, and transaction index parameters
 * produce a valid Merkle proof.
 * @param transactionHash The hash of the transaction being validated.
 * @param merkleRootHash The Merkle root hash that the intermediate node hashes
 *        should compute to.
 * @param intermediateNodeHashes The Merkle tree intermediate node hashes.
 *        This is a list of hashes the transaction being validated is paired
 *        with in the Merkle tree.
 * @param transactionIndex The index of the transaction being validated within
 *        the block, used to determine the path to traverse in the Merkle tree.
 * @throws {Error} If the Merkle tree is not valid.
 * @returns An empty return value.
 */
function validateMerkleTree(
  transactionHash: BitcoinTxHash,
  merkleRootHash: Hex,
  intermediateNodeHashes: Hex[],
  transactionIndex: number
) {
  // Shortcut for a block that contains only a single transaction (coinbase).
  if (
    transactionHash.reverse().equals(merkleRootHash) &&
    transactionIndex == 0 &&
    intermediateNodeHashes.length == 0
  ) {
    return
  }

  validateMerkleTreeHashes(
    transactionHash,
    merkleRootHash,
    intermediateNodeHashes,
    transactionIndex
  )
}

/**
 * Validates the transaction's Merkle proof by traversing the Merkle tree
 * starting from the provided transaction hash and using the intermediate node
 * hashes to compute the root hash. If the computed root hash does not match the
 * merkle root hash, an error is thrown.
 * @param transactionHash The hash of the transaction being validated.
 * @param merkleRootHash The Merkle root hash that the intermediate nodes should
 *        compute to.
 * @param intermediateNodeHashes The Merkle tree intermediate node hashes.
 *        This is a list of hashes the transaction being validated is paired
 *        with in the Merkle tree.
 * @param transactionIndex The index of the transaction in the block, used
 *        to determine the path to traverse in the Merkle tree.
 * @throws {Error} If the intermediate nodes are of an invalid length or if the
 *         computed root hash does not match the merkle root hash parameter.
 * @returns An empty return value.
 */
function validateMerkleTreeHashes(
  transactionHash: BitcoinTxHash,
  merkleRootHash: Hex,
  intermediateNodeHashes: Hex[],
  transactionIndex: number
) {
  // To prove the transaction inclusion in a block we only need the hashes that
  // form a path from the transaction being validated to the Merkle root hash.
  // If the Merkle tree looks like this:
  //
  //           h_01234567
  //          /           \
  //      h_0123          h_4567
  //     /      \       /        \
  //   h_01    h_23    h_45     h_67
  //   /  \    /  \    /  \    /   \
  //  h_0 h_1 h_2 h_3 h_4 h_5 h_6 h_7
  //
  // and the transaction hash to be validated is h_5 the following data
  // will be used:
  // - `transactionHash`: h_5
  // - `merkleRootHash`: h_01234567
  // - `intermediateNodeHashes`: [h_4, h_67, h_0123]
  // - `transactionIndex`: 5
  //
  // The following calculations will be performed:
  // - h_4 and h_5 will be hashed to obtain h_45
  // - h_45 and h_67 will be hashed to obtain h_4567
  // - h_0123 will be hashed with h_4567 to obtain h_1234567 (Merkle root hash).

  // Note that when we move up the Merkle tree calculating parent hashes we need
  // to join children hashes. The information which child hash should go first
  // is obtained from `transactionIndex`. When `transactionIndex` is odd the
  // hash taken from `intermediateNodeHashes` must go first. If it is even the
  // hash from previous calculation must go first. The `transactionIndex` is
  // divided by `2` after every hash calculation.

  if (intermediateNodeHashes.length === 0) {
    throw new Error("Invalid merkle tree")
  }

  let idx = transactionIndex
  let currentHash = transactionHash.reverse()

  // Move up the Merkle tree hashing current hash value with hashes taken
  // from `intermediateNodeHashes`. Use `idx` to determine the order of joining
  // children hashes.
  for (let i = 0; i < intermediateNodeHashes.length; i++) {
    if (idx % 2 === 1) {
      // If the current value of idx is odd the hash taken from
      // `intermediateNodeHashes` goes before the current hash.
      currentHash = BitcoinHashUtils.computeHash256(
        Hex.from(intermediateNodeHashes[i].toString() + currentHash.toString())
      )
    } else {
      // If the current value of idx is even the hash taken from the current
      // hash goes before the hash taken from `intermediateNodeHashes`.
      currentHash = BitcoinHashUtils.computeHash256(
        Hex.from(currentHash.toString() + intermediateNodeHashes[i].toString())
      )
    }

    // Divide the value of `idx` by `2` when we move one level up the Merkle
    // tree.
    idx = idx >> 1
  }

  // Verify we arrived at the same value of Merkle root hash as the one stored
  // in the block header.
  if (!currentHash.equals(merkleRootHash)) {
    throw new Error(
      "Transaction Merkle proof is not valid for provided header and transaction hash"
    )
  }
}

/**
 * Splits a given concatenated Merkle proof into an array of intermediate node
 * hashes.
 * @param merkleProof A concatenated representation of the Merkle proof.
 * @returns An array of intermediate node hashes.
 * @throws {Error} If the length of the Merkle proof is not a multiple of 64.
 */
function splitMerkleProof(merkleProof: Hex): Hex[] {
  const merkleProofStr = merkleProof.toString()
  if (merkleProofStr.length % 64 != 0) {
    throw new Error("Incorrect length of Merkle proof")
  }

  const intermediateNodeHashes: Hex[] = []
  for (let i = 0; i < merkleProofStr.length; i += 64) {
    intermediateNodeHashes.push(Hex.from(merkleProofStr.slice(i, i + 64)))
  }

  return intermediateNodeHashes
}
