/* eslint-disable no-await-in-loop */
/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-nested-ternary */
import fs from "fs"
import { createHash } from "crypto"
import { BigNumber, providers, utils } from "ethers"
import { decode as rlpDecode, encode as rlpEncode } from "rlp"

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Trie = require("merkle-patricia-tree")

export const RECEIPT_ARCHIVE_SCHEMA =
  "tbtc/complete-p2tr-authenticated-ethereum-history/v1"
export const BITCOIN_JOURNAL_SCHEMA =
  "tbtc/complete-p2tr-canonical-bitcoin-journal/v1"
export const REBUILD_CERTIFICATE_DOMAIN =
  "tbtc-complete-p2tr-coverage-rebuild-certificate-v1"

export interface AuthenticatedArchiveBlock {
  number: number
  hash: string
  headerRlp: string
  transactions: Array<{
    rawTransaction: string
    rawReceipt: string
  }>
}

export interface AuthenticatedEthereumArchive {
  schemaVersion: typeof RECEIPT_ARCHIVE_SCHEMA
  sourceID: string
  backendID: string
  chainId: string
  bridge: string
  historyStartBlockNumber: number
  snapshotBlockNumber: number
  snapshotBlockHash: string
  blocks: AuthenticatedArchiveBlock[]
}

export interface BitcoinDepositOccurrence {
  fundingTxHash: string
  fundingOutputIndex: number
  rawTransaction: string
  strippedTransaction: {
    version: string
    inputVector: string
    outputVector: string
    locktime: string
  }
  bitcoinBlockHeight: number
  bitcoinBlockHash: string
  outputKey: string
}

export interface CanonicalBitcoinJournal {
  schemaVersion: typeof BITCOIN_JOURNAL_SCHEMA
  sourceID: string
  bitcoinRawEvidenceCommitment: string
  semanticProjectionRoot: string
  watermark: {
    ethereumBlockNumber: number
    ethereumBlockHash: string
    bitcoinBlockHeight: number
    bitcoinBlockHash: string
  }
  depositOccurrences: BitcoinDepositOccurrence[]
}

export interface RebuildCertificate {
  sourceID: string
  backendID: string
  signer: string
  signature: string
  archivePath: string
  archiveSha256: string
  bitcoinJournalSha256: string
  bitcoinRawEvidenceCommitment: string
  semanticProjectionRoot: string
}

export interface DerivedHistoricalDeposit {
  depositKey: string
  walletID: string
  outputKey: string
  fundingTxHash: string
  fundingOutputIndex: number
  ethereumTransactionHash: string
  ethereumBlockNumber: number
  logIndex: number
}

const bufferHex = (value: Buffer): string => utils.hexlify(value)

const decodeRlpList = (value: string): any[] => {
  const bytes = Buffer.from(utils.arrayify(value))
  const body = bytes[0] < 0x80 ? bytes.slice(1) : bytes
  const decoded = rlpDecode(body)
  if (!Array.isArray(decoded)) throw new Error("RLP value is not a list")
  return decoded as any[]
}

const bufferNumber = (value: Buffer): number => {
  if (value.length === 0) return 0
  const number = BigNumber.from(value)
  if (number.gt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("RLP integer exceeds JavaScript safe range")
  }
  return number.toNumber()
}

const triePut = (trie: any, key: Buffer, value: Buffer): Promise<void> =>
  new Promise((resolve, reject) =>
    trie.put(key, value, (error: Error | null) =>
      error ? reject(error) : resolve()
    )
  )

export const rebuildTrieRoot = async (values: string[]): Promise<string> => {
  const trie = new Trie()
  for (let index = 0; index < values.length; index++) {
    // eslint-disable-next-line no-await-in-loop
    await triePut(
      trie,
      rlpEncode(index),
      Buffer.from(utils.arrayify(values[index]))
    )
  }
  return bufferHex(trie.root)
}

const rawFileSha256 = (filePath: string): string => {
  const hash = createHash("sha256")
  hash.update(fs.readFileSync(filePath))
  return `0x${hash.digest("hex")}`
}

const decodeReceiptLogs = (
  rawReceipt: string
): Array<{ address: string; topics: string[]; data: string }> => {
  const receipt = decodeRlpList(rawReceipt)
  if (receipt.length !== 4 || !Array.isArray(receipt[3])) {
    throw new Error("Malformed raw Ethereum receipt")
  }
  return (receipt[3] as any[]).map((encodedLog) => {
    if (!Array.isArray(encodedLog) || encodedLog.length !== 3) {
      throw new Error("Malformed raw Ethereum receipt log")
    }
    return {
      address: utils.getAddress(bufferHex(encodedLog[0] as Buffer)),
      topics: (encodedLog[1] as Buffer[]).map(bufferHex),
      data: bufferHex(encodedLog[2] as Buffer),
    }
  })
}

const receiptSucceeded = (rawReceipt: string): boolean => {
  const first = decodeRlpList(rawReceipt)[0] as Buffer
  // The Bridge postdates Byzantium; a 32-byte pre-Byzantium state root is not
  // accepted as an ambiguous success marker in a production cutover archive.
  if (first.length === 0) return false
  if (first.length !== 1 || (first[0] !== 0 && first[0] !== 1)) {
    throw new Error("Receipt archive contains a pre-Byzantium receipt")
  }
  return first[0] === 1
}

const readCompactSize = (
  bytes: Uint8Array,
  offset: number
): { value: number; next: number } => {
  const marker = bytes[offset]
  if (marker < 0xfd) return { value: marker, next: offset + 1 }
  const width = marker === 0xfd ? 2 : marker === 0xfe ? 4 : 8
  let value = BigNumber.from(0)
  for (let index = 0; index < width; index++) {
    value = value.add(BigNumber.from(bytes[offset + 1 + index]).shl(8 * index))
  }
  if (value.gt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Bitcoin CompactSize exceeds JavaScript safe range")
  }
  return { value: value.toNumber(), next: offset + 1 + width }
}

const bitcoinOutputKey = (
  outputVector: string,
  expectedIndex: number
): string => {
  const bytes = utils.arrayify(outputVector)
  const count = readCompactSize(bytes, 0)
  if (expectedIndex >= count.value) throw new Error("Bitcoin output is missing")
  let offset = count.next
  for (let index = 0; index < count.value; index++) {
    if (offset + 8 > bytes.length) throw new Error("Truncated Bitcoin output")
    offset += 8
    const scriptSize = readCompactSize(bytes, offset)
    offset = scriptSize.next
    if (offset + scriptSize.value > bytes.length) {
      throw new Error("Truncated Bitcoin output script")
    }
    const script = bytes.slice(offset, offset + scriptSize.value)
    offset += scriptSize.value
    if (index === expectedIndex) {
      if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) {
        throw new Error("Historical Taproot reveal output is not P2TR")
      }
      return utils.hexlify(script.slice(2))
    }
  }
  throw new Error("Bitcoin output is missing")
}

const bitcoinTransactionHash = (transaction: {
  version: string
  inputVector: string
  outputVector: string
  locktime: string
}): string =>
  utils.sha256(
    utils.sha256(
      utils.hexConcat([
        transaction.version,
        transaction.inputVector,
        transaction.outputVector,
        transaction.locktime,
      ])
    )
  )

const journalKey = (hash: string, index: number): string =>
  `${hash.toLowerCase()}:${index}`

export const rebuildCertificateDigest = (
  chainId: string,
  bridge: string,
  archive: AuthenticatedEthereumArchive,
  archiveSha256: string,
  bitcoinJournalSha256: string,
  bitcoinRawEvidenceCommitment: string,
  semanticProjectionRoot: string
): string =>
  utils.keccak256(
    utils.defaultAbiCoder.encode(
      [
        "string",
        "string",
        "string",
        "uint256",
        "address",
        "uint64",
        "uint64",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
      ],
      [
        REBUILD_CERTIFICATE_DOMAIN,
        archive.sourceID,
        archive.backendID,
        chainId,
        bridge,
        archive.historyStartBlockNumber,
        archive.snapshotBlockNumber,
        archive.snapshotBlockHash,
        archiveSha256,
        bitcoinJournalSha256,
        bitcoinRawEvidenceCommitment,
        semanticProjectionRoot,
      ]
    )
  )

export async function verifyIndependentSignature(
  provider: providers.Provider,
  signer: string,
  digest: string,
  signature: string
): Promise<void> {
  const code = await provider.getCode(signer)
  if (code === "0x") {
    if (
      utils.verifyMessage(utils.arrayify(digest), signature).toLowerCase() !==
      signer.toLowerCase()
    ) {
      throw new Error("Invalid EOA rebuild certificate")
    }
    return
  }
  const eip1271 = new utils.Interface([
    "function isValidSignature(bytes32 digest,bytes signature) view returns (bytes4)",
  ])
  const result = await provider.call({
    to: signer,
    data: eip1271.encodeFunctionData("isValidSignature", [digest, signature]),
  })
  if (
    eip1271.decodeFunctionResult("isValidSignature", result)[0] !== "0x1626ba7e"
  ) {
    throw new Error("Invalid EIP-1271 rebuild certificate")
  }
}

export async function verifyAndDeriveEthereumArchive(
  provider: providers.Provider,
  archivePath: string,
  expected: {
    chainId: string
    bridge: string
    historyStartBlockNumber: number
    snapshotBlockNumber: number
    snapshotBlockHash: string
  },
  bridgeInterface: utils.Interface
): Promise<{
  archive: AuthenticatedEthereumArchive
  sha256: string
  deposits: DerivedHistoricalDeposit[]
}> {
  const archive = JSON.parse(
    fs.readFileSync(archivePath, "utf8")
  ) as AuthenticatedEthereumArchive
  if (
    archive.schemaVersion !== RECEIPT_ARCHIVE_SCHEMA ||
    !archive.sourceID ||
    !archive.backendID ||
    archive.chainId !== expected.chainId ||
    archive.bridge.toLowerCase() !== expected.bridge.toLowerCase() ||
    archive.historyStartBlockNumber !== expected.historyStartBlockNumber ||
    archive.snapshotBlockNumber !== expected.snapshotBlockNumber ||
    archive.snapshotBlockHash.toLowerCase() !==
      expected.snapshotBlockHash.toLowerCase()
  ) {
    throw new Error("Authenticated Ethereum archive scope mismatch")
  }
  if (
    archive.blocks.length !==
    archive.snapshotBlockNumber - archive.historyStartBlockNumber + 1
  ) {
    throw new Error("Authenticated Ethereum archive has a block gap")
  }
  const anchor =
    archive.historyStartBlockNumber === 0
      ? undefined
      : await provider.getBlock(archive.historyStartBlockNumber - 1)
  let parentHash = anchor?.hash
  const deposits: DerivedHistoricalDeposit[] = []
  let taprootEventCount = 0

  for (let offset = 0; offset < archive.blocks.length; offset++) {
    const block = archive.blocks[offset]
    const header = rlpDecode(Buffer.from(utils.arrayify(block.headerRlp)))
    if (!Array.isArray(header) || header.length < 15) {
      throw new Error("Malformed Ethereum block header")
    }
    const fields = header as Buffer[]
    const number = bufferNumber(fields[8])
    const hash = utils.keccak256(block.headerRlp)
    if (
      number !== archive.historyStartBlockNumber + offset ||
      block.number !== number ||
      block.hash.toLowerCase() !== hash.toLowerCase() ||
      (parentHash &&
        bufferHex(fields[0]).toLowerCase() !== parentHash.toLowerCase())
    ) {
      throw new Error("Ethereum archive header chain mismatch")
    }
    parentHash = hash
    const transactionRoot = await rebuildTrieRoot(
      block.transactions.map(({ rawTransaction }) => rawTransaction)
    )
    const receiptRoot = await rebuildTrieRoot(
      block.transactions.map(({ rawReceipt }) => rawReceipt)
    )
    if (
      transactionRoot.toLowerCase() !== bufferHex(fields[4]).toLowerCase() ||
      receiptRoot.toLowerCase() !== bufferHex(fields[5]).toLowerCase()
    ) {
      throw new Error("Ethereum archive transaction/receipt trie mismatch")
    }

    for (const transaction of block.transactions) {
      const parsedTransaction = utils.parseTransaction(
        transaction.rawTransaction
      )
      const receiptLogs = decodeReceiptLogs(transaction.rawReceipt)
      const taprootLogs = receiptLogs
        .map((log, logIndex) => ({ log, logIndex }))
        .filter(({ log }) => {
          if (log.address.toLowerCase() !== expected.bridge.toLowerCase()) {
            return false
          }
          try {
            return (
              bridgeInterface.parseLog(log).name === "TaprootDepositRevealed"
            )
          } catch {
            return false
          }
        })
      taprootEventCount += taprootLogs.length
      if (!receiptSucceeded(transaction.rawReceipt)) {
        if (taprootLogs.length !== 0) throw new Error("Failed receipt has logs")
        continue
      }
      if (
        parsedTransaction.to?.toLowerCase() !== expected.bridge.toLowerCase()
      ) {
        if (taprootLogs.length !== 0) {
          throw new Error(
            "Internal Taproot reveal requires an authenticated execution proof"
          )
        }
        continue
      }
      let decodedCall: utils.TransactionDescription
      try {
        decodedCall = bridgeInterface.parseTransaction({
          data: parsedTransaction.data,
          value: parsedTransaction.value,
        })
      } catch {
        continue
      }
      if (
        decodedCall.name !== "revealTaprootDeposit" &&
        decodedCall.name !== "revealTaprootDepositWithExtraData"
      ) {
        if (taprootLogs.length !== 0) {
          throw new Error("Taproot reveal event/call mismatch")
        }
        continue
      }
      if (taprootLogs.length !== 1) {
        throw new Error("Taproot reveal call must emit exactly one event")
      }
      const fundingTx = decodedCall.args[0]
      const reveal = decodedCall.args[1]
      const fundingTxHash = bitcoinTransactionHash(fundingTx)
      const fundingOutputIndex = BigNumber.from(
        reveal.fundingOutputIndex
      ).toNumber()
      const outputKey = bitcoinOutputKey(
        fundingTx.outputVector,
        fundingOutputIndex
      )
      const decodedEvent = bridgeInterface.parseLog(taprootLogs[0].log)
      if (
        decodedEvent.args.fundingTxHash.toLowerCase() !==
          fundingTxHash.toLowerCase() ||
        BigNumber.from(decodedEvent.args.fundingOutputIndex).toNumber() !==
          fundingOutputIndex ||
        decodedEvent.args.walletXOnlyPublicKey.toLowerCase() !==
          reveal.walletXOnlyPublicKey.toLowerCase()
      ) {
        throw new Error("Taproot reveal calldata/event mismatch")
      }
      deposits.push({
        depositKey: BigNumber.from(
          utils.keccak256(
            utils.solidityPack(
              ["bytes32", "uint32"],
              [fundingTxHash, fundingOutputIndex]
            )
          )
        ).toString(),
        walletID: reveal.walletXOnlyPublicKey,
        outputKey,
        fundingTxHash,
        fundingOutputIndex,
        ethereumTransactionHash: parsedTransaction.hash,
        ethereumBlockNumber: number,
        logIndex: taprootLogs[0].logIndex,
      })
    }
  }
  if (
    parentHash?.toLowerCase() !== archive.snapshotBlockHash.toLowerCase() ||
    taprootEventCount !== deposits.length
  ) {
    throw new Error("Ethereum archive Taproot reveal coverage mismatch")
  }
  const snapshot = await provider.getBlock(archive.snapshotBlockNumber)
  if (snapshot.hash.toLowerCase() !== archive.snapshotBlockHash.toLowerCase()) {
    throw new Error("Authenticated Ethereum archive snapshot reorged")
  }
  return { archive, sha256: rawFileSha256(archivePath), deposits }
}

export function verifyBitcoinJournal(
  journalPath: string,
  expectedSha256: string,
  expected: {
    ethereumBlockNumber: number
    ethereumBlockHash: string
    bitcoinBlockHeight: number
    bitcoinBlockHash: string
    bitcoinRawEvidenceCommitment: string
    semanticProjectionRoot: string
  },
  deposits: DerivedHistoricalDeposit[]
): CanonicalBitcoinJournal {
  if (
    rawFileSha256(journalPath).toLowerCase() !== expectedSha256.toLowerCase()
  ) {
    throw new Error("Canonical Bitcoin journal hash mismatch")
  }
  const journal = JSON.parse(
    fs.readFileSync(journalPath, "utf8")
  ) as CanonicalBitcoinJournal
  if (
    journal.schemaVersion !== BITCOIN_JOURNAL_SCHEMA ||
    journal.watermark.ethereumBlockNumber !== expected.ethereumBlockNumber ||
    journal.watermark.ethereumBlockHash.toLowerCase() !==
      expected.ethereumBlockHash.toLowerCase() ||
    journal.watermark.bitcoinBlockHeight !== expected.bitcoinBlockHeight ||
    journal.watermark.bitcoinBlockHash.toLowerCase() !==
      expected.bitcoinBlockHash.toLowerCase() ||
    journal.bitcoinRawEvidenceCommitment.toLowerCase() !==
      expected.bitcoinRawEvidenceCommitment.toLowerCase() ||
    journal.semanticProjectionRoot.toLowerCase() !==
      expected.semanticProjectionRoot.toLowerCase()
  ) {
    throw new Error("Canonical Bitcoin journal watermark mismatch")
  }
  const occurrences = new Map<string, BitcoinDepositOccurrence>()
  for (const occurrence of journal.depositOccurrences) {
    const key = journalKey(
      occurrence.fundingTxHash,
      occurrence.fundingOutputIndex
    )
    if (occurrences.has(key)) {
      throw new Error("Canonical Bitcoin journal has duplicate occurrence")
    }
    if (
      !utils.isHexString(occurrence.rawTransaction) ||
      occurrence.rawTransaction === "0x"
    ) {
      throw new Error("Canonical Bitcoin journal raw transaction is missing")
    }
    occurrences.set(key, occurrence)
  }
  if (occurrences.size !== deposits.length) {
    throw new Error("Canonical Bitcoin journal occurrence count mismatch")
  }
  for (const deposit of deposits) {
    const occurrence = occurrences.get(
      journalKey(deposit.fundingTxHash, deposit.fundingOutputIndex)
    )
    if (!occurrence)
      throw new Error("Taproot reveal is absent from Bitcoin journal")
    if (
      bitcoinTransactionHash(occurrence.strippedTransaction).toLowerCase() !==
        deposit.fundingTxHash.toLowerCase() ||
      bitcoinOutputKey(
        occurrence.strippedTransaction.outputVector,
        occurrence.fundingOutputIndex
      ).toLowerCase() !== deposit.outputKey.toLowerCase() ||
      occurrence.outputKey.toLowerCase() !== deposit.outputKey.toLowerCase()
    ) {
      throw new Error("Bitcoin journal output key mismatch")
    }
  }
  return journal
}

export async function reconcileDerivedCoverageStorage(
  provider: providers.Provider,
  bridge: string,
  snapshotBlockNumber: number,
  deposits: DerivedHistoricalDeposit[]
): Promise<DerivedHistoricalDeposit[]> {
  const storageBase = 51
  const commitmentSlot = storageBase + 38
  const outputKeySlot = storageBase + 39
  const missing: DerivedHistoricalDeposit[] = []
  for (let offset = 0; offset < deposits.length; offset += 100) {
    const batch = deposits.slice(offset, offset + 100)
    // eslint-disable-next-line no-await-in-loop
    const states = await Promise.all(
      batch.map(async (deposit) => {
        const key = BigNumber.from(deposit.depositKey)
        const commitmentLocation = utils.keccak256(
          utils.defaultAbiCoder.encode(
            ["uint256", "uint256"],
            [key, commitmentSlot]
          )
        )
        const outputKeyLocation = utils.keccak256(
          utils.defaultAbiCoder.encode(
            ["uint256", "uint256"],
            [key, outputKeySlot]
          )
        )
        return Promise.all([
          provider.getStorageAt(
            bridge,
            commitmentLocation,
            snapshotBlockNumber
          ),
          provider.getStorageAt(bridge, outputKeyLocation, snapshotBlockNumber),
        ])
      })
    )
    states.forEach(([commitment, exactOutputKey], index) => {
      const deposit = batch[index]
      const expectedCommitment = utils.keccak256(
        utils.solidityPack(
          ["bytes32", "bytes32"],
          [deposit.walletID, deposit.outputKey]
        )
      )
      if (commitment.toLowerCase() !== expectedCommitment.toLowerCase()) {
        throw new Error("Bridge Taproot commitment/reveal mismatch")
      }
      if (exactOutputKey === utils.hexZeroPad("0x00", 32)) {
        missing.push(deposit)
      } else if (
        exactOutputKey.toLowerCase() !== deposit.outputKey.toLowerCase()
      ) {
        throw new Error("Bridge exact Taproot output key mismatch")
      }
    })
  }
  return missing.sort((left, right) => {
    const keyOrder = BigNumber.from(left.depositKey).sub(right.depositKey)
    return keyOrder.isZero() ? 0 : keyOrder.isNegative() ? -1 : 1
  })
}
