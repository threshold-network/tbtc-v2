/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"
import fs from "fs"
import os from "os"
import path from "path"
import { Wallet, utils } from "ethers"
import hre, { ethers } from "hardhat"
import { scanCanonicalHistory } from "../../scripts/frost-wallet-registry-canonical-history"
import {
  ARCHIVE_PHASE_SCHEMA,
  ArchiveManifestContext,
  ArchiveManifestEntry,
  ArchiveCheckpointV2,
  ArchivePhaseArtifact,
  FrostWalletHistory,
  SignedArchiveManifest,
  assertRuntimeLinks,
  activeDkgMembers,
  assertIndependentWalletHistory,
  assertCheckpointHeadCanonical,
  deriveArchiveEntries,
  hashActiveDkgMembers,
  hashArchiveCheckpoint,
  hashArchivePhaseArtifact,
  hashArchiveManifestPayload,
  normalizeLibraryRuntime,
  readCanonicalBlockLogs,
  readArchiveCheckpoint,
  readArchivePhase,
  validateArchiveCheckpoint,
  validateSignedArchiveManifest,
  zeroRuntimeLinks,
  writeArchiveCheckpoint,
  writeArchivePhase,
} from "../../deploy/54_upgrade_frost_wallet_registry_archive"

describe("Deploy Script 54: FROST wallet archive upgrade", () => {
  const walletID = `0x${"11".repeat(32)}`
  const resultHash = `0x${"22".repeat(32)}`
  const members = [7, 7, 9, 11, 13]
  const misbehavedMembersIndices = [2, 4]
  const membersIdsHash = hashActiveDkgMembers(members, misbehavedMembersIndices)
  const snapshotHash = `0x${"44".repeat(32)}`
  const registry = `0x${"55".repeat(20)}`

  const validHistory = (): FrostWalletHistory => ({
    coverage: {
      chainId: 31337,
      registry,
      scanStartBlock: 1,
      finalizedBlock: 30,
      startParentHash: snapshotHash,
      startBlockHash: snapshotHash,
      finalizedBlockHash: snapshotHash,
      historyCommitment: resultHash,
      blockCount: 30,
      transactionCount: 3,
      receiptCount: 3,
      logCount: 4,
      registryLogCount: 4,
      registryLogDigest: resultHash,
      selectedLogCount: 4,
      selectedLogDigest: resultHash,
      selectionUpperExclusive: null,
    },
    submitted: [
      {
        resultHash,
        walletID,
        membersIdsHash,
        members,
        misbehavedMembersIndices,
        position: { blockNumber: 10, transactionIndex: 0, logIndex: 0 },
      },
    ],
    approved: [
      {
        resultHash,
        position: { blockNumber: 20, transactionIndex: 0, logIndex: 0 },
      },
    ],
    created: [
      {
        walletID,
        dkgResultHash: resultHash,
        position: { blockNumber: 20, transactionIndex: 0, logIndex: 1 },
      },
    ],
    closed: [
      {
        walletID,
        position: { blockNumber: 30, transactionIndex: 0, logIndex: 0 },
      },
    ],
  })

  it("derives every closed wallet from ordered DKG provenance", () => {
    expect(deriveArchiveEntries(validHistory())).to.deep.equal([
      { walletID, dkgResultHash: resultHash, membersIdsHash },
    ])
  })

  it("filters misbehaved members by exact one-based position", () => {
    expect(activeDkgMembers([10, 20, 30, 40], [])).to.deep.equal([
      10, 20, 30, 40,
    ])
    expect(activeDkgMembers([10, 20, 30, 40, 50], [2, 4])).to.deep.equal([
      10, 30, 50,
    ])
    // Duplicate operator IDs are valid group positions. Removing position two
    // must retain the identical operator occurring at position one.
    expect(activeDkgMembers([7, 7, 9], [2])).to.deep.equal([7, 9])

    for (const invalid of [[0], [5], [2, 2], [3, 2]]) {
      expect(() => activeDkgMembers([1, 2, 3, 4], invalid)).to.throw(
        "corrupted misbehaved members indices"
      )
    }
  })

  it("binds history roots to the complete coverage certificate", () => {
    const primary = validHistory()
    const changed = validHistory()
    changed.coverage.receiptCount += 1
    expect(() => assertIndependentWalletHistory(primary, changed)).to.throw(
      "independent canonical wallet history rebuild mismatch"
    )
  })

  describe("durable pre-upgrade checkpoint", () => {
    const checkpoint = (): ArchiveCheckpointV2 => {
      const history = validHistory()
      const unsigned = {
        schemaVersion: "tbtc/frost-wallet-archive/checkpoint-v3" as const,
        chainId: "31337",
        registry,
        scanFromBlock: 1,
        checkpointBlockNumber: 30,
        checkpointBlockHash: snapshotHash,
        maxTailBlocks: 64,
        upgradeDeadlineBlock: 94,
        history,
        entries: deriveArchiveEntries(history),
      }
      return {
        ...unsigned,
        checkpointHash: hashArchiveCheckpoint(unsigned),
      }
    }

    it("round-trips atomically for crash resume", () => {
      const value = checkpoint()
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "frost-archive-checkpoint-")
      )
      const checkpointPath = path.join(directory, "checkpoint.json")
      try {
        expect(() =>
          writeArchiveCheckpoint(checkpointPath, value, "after-file-sync")
        ).to.throw("failpoint after file sync")
        expect(fs.existsSync(checkpointPath)).to.equal(false)
        expect(fs.existsSync(`${checkpointPath}.tmp`)).to.equal(true)

        writeArchiveCheckpoint(checkpointPath, value)
        expect(fs.existsSync(`${checkpointPath}.tmp`)).to.equal(false)
        expect(fs.statSync(checkpointPath).mode & 0o777).to.equal(0o600)
        const resumed = readArchiveCheckpoint(checkpointPath)
        expect(resumed).to.deep.equal(value)
        expect(() =>
          validateArchiveCheckpoint(resumed!, {
            chainId: "31337",
            registry,
            scanFromBlock: 1,
            maxTailBlocks: 64,
          })
        ).to.not.throw()

        const replacement = checkpoint()
        replacement.checkpointBlockHash = `0x${"99".repeat(32)}`
        const replacementPayload = { ...replacement }
        Reflect.deleteProperty(replacementPayload, "checkpointHash")
        replacement.checkpointHash = hashArchiveCheckpoint(replacementPayload)
        expect(() =>
          writeArchiveCheckpoint(checkpointPath, replacement)
        ).to.throw("immutable archive artifact already exists")
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    })

    it("rejects any altered checkpoint history or inventory", () => {
      const changedHistory = checkpoint()
      changedHistory.history.coverage.receiptCount += 1
      expect(() =>
        validateArchiveCheckpoint(changedHistory, {
          chainId: "31337",
          registry,
          scanFromBlock: 1,
          maxTailBlocks: 64,
        })
      ).to.throw("checkpoint hash mismatch")

      const changedInventory = checkpoint()
      changedInventory.entries = []
      expect(() =>
        validateArchiveCheckpoint(changedInventory, {
          chainId: "31337",
          registry,
          scanFromBlock: 1,
          maxTailBlocks: 64,
        })
      ).to.throw("checkpoint inventory mismatch")
    })

    it("self-hashes phase revisions and preserves bound fields", () => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "frost-archive-phase-")
      )
      const phasePath = path.join(directory, "phase.json")
      const address = (byte: string) => `0x${byte.repeat(40)}`
      const hash = (byte: string) => `0x${byte.repeat(64)}`
      const initial: ArchivePhaseArtifact = {
        schemaVersion: ARCHIVE_PHASE_SCHEMA,
        networkName: "hardhat",
        chainId: "31337",
        proxy: address("1"),
        proxyAdmin: address("2"),
        proxyAdminOwner: address("3"),
        governance: address("4"),
        authority: address("5"),
        oldImplementation: address("6"),
        oldImplementationCodeHash: hash("a"),
        implementation: address("7"),
        implementationCodeHash: hash("b"),
        frostInactivity: address("8"),
        frostInactivityCodeHash: hash("c"),
        searchFromBlock: 31,
        phase: "pending-start-authorization",
        checkpoint: checkpoint(),
      }

      try {
        writeArchivePhase(phasePath, initial)
        const first = readArchivePhase(phasePath)!
        expect(first.artifactHash).to.equal(hashArchivePhaseArtifact(first))
        expect(fs.statSync(phasePath).mode & 0o777).to.equal(0o600)
        expect(
          fs.existsSync(
            path.join(
              `${phasePath}.revisions`,
              `${first.artifactHash!.slice(2)}.json`
            )
          )
        ).to.equal(true)

        expect(() =>
          writeArchivePhase(phasePath, {
            ...first,
            authority: address("9"),
          })
        ).to.throw("archive phase binding changed: authority")

        writeArchivePhase(phasePath, {
          ...first,
          phase: "prepared",
          upgrade: {
            target: initial.proxyAdmin,
            value: "0",
            data: "0x1234",
            description: "bound upgrade",
          },
        })
        const second = readArchivePhase(phasePath)!
        expect(second.previousArtifactHash).to.equal(first.artifactHash)
        expect(second.artifactHash).to.equal(hashArchivePhaseArtifact(second))

        fs.writeFileSync(
          phasePath,
          fs
            .readFileSync(phasePath, "utf8")
            .replace("bound upgrade", "tampered upgrade"),
          { mode: 0o600 }
        )
        expect(() => readArchivePhase(phasePath)).to.throw(
          "archive phase artifact hash mismatch"
        )
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    })
  })

  it("rejects missing, reordered, duplicate, and inconsistent provenance", () => {
    const missingDkg = validHistory()
    missingDkg.submitted = []
    expect(() => deriveArchiveEntries(missingDkg)).to.throw(
      "no prior DkgResultSubmitted provenance"
    )

    const missingApproval = validHistory()
    missingApproval.approved = []
    expect(() => deriveArchiveEntries(missingApproval)).to.throw(
      "DkgResultApproved provenance"
    )

    const reordered = validHistory()
    reordered.closed[0].position.blockNumber = 19
    expect(() => deriveArchiveEntries(reordered)).to.throw(
      "WalletClosed precedes WalletCreated"
    )

    const duplicate = validHistory()
    duplicate.closed.push({ ...duplicate.closed[0] })
    expect(() => deriveArchiveEntries(duplicate)).to.throw(
      "duplicate WalletClosed"
    )

    const inconsistent = validHistory()
    inconsistent.submitted[0].membersIdsHash = `0x${"99".repeat(32)}`
    expect(() => deriveArchiveEntries(inconsistent)).to.throw(
      "DKG members hash mismatch"
    )
  })

  describe("signed manifest", () => {
    let signer: Wallet
    let context: ArchiveManifestContext
    const expectedEntries: ArchiveManifestEntry[] = [
      { walletID, dkgResultHash: resultHash, membersIdsHash },
    ]

    beforeEach(() => {
      signer = Wallet.createRandom()
      context = {
        networkName: "hardhat",
        chainId: "31337",
        registry,
        scanFromBlock: 0,
        scanToBlock: 100,
        scanToBlockHash: snapshotHash,
        requiredSigner: signer.address,
      }
    })

    const signManifest = async (
      entries: ArchiveManifestEntry[],
      signingWallet = signer
    ): Promise<SignedArchiveManifest> => {
      const payload = {
        schemaVersion: "tbtc/frost-wallet-archive/v1" as const,
        networkName: context.networkName,
        chainId: context.chainId,
        registry: context.registry,
        scanFromBlock: 0 as const,
        scanToBlock: context.scanToBlock,
        scanToBlockHash: context.scanToBlockHash,
        entries,
      }
      const payloadHash = hashArchiveManifestPayload(payload, utils)
      return {
        ...payload,
        payloadHash,
        signer: signingWallet.address,
        signature: await signingWallet.signMessage(utils.arrayify(payloadHash)),
      }
    }

    it("accepts only the exact pinned, signed archive set", async () => {
      const manifest = await signManifest(expectedEntries)
      expect(() =>
        validateSignedArchiveManifest(manifest, expectedEntries, context, utils)
      ).to.not.throw()
    })

    it("rejects missing, extra, duplicate, and mismatched entries", async () => {
      const missing = await signManifest([])
      expect(() =>
        validateSignedArchiveManifest(missing, expectedEntries, context, utils)
      ).to.throw("count mismatch")

      const extra = await signManifest([
        ...expectedEntries,
        {
          walletID: `0x${"66".repeat(32)}`,
          dkgResultHash: `0x${"77".repeat(32)}`,
          membersIdsHash: `0x${"88".repeat(32)}`,
        },
      ])
      expect(() =>
        validateSignedArchiveManifest(extra, expectedEntries, context, utils)
      ).to.throw("count mismatch")

      const duplicate = await signManifest([
        expectedEntries[0],
        expectedEntries[0],
      ])
      expect(() =>
        validateSignedArchiveManifest(
          duplicate,
          expectedEntries,
          context,
          utils
        )
      ).to.throw("duplicate archive manifest wallet")

      const mismatch = await signManifest([
        { ...expectedEntries[0], membersIdsHash: `0x${"99".repeat(32)}` },
      ])
      expect(() =>
        validateSignedArchiveManifest(mismatch, expectedEntries, context, utils)
      ).to.throw("entry mismatch")
    })

    it("rejects an unapproved signer and payload mutation", async () => {
      const unapproved = await signManifest(
        expectedEntries,
        Wallet.createRandom()
      )
      expect(() =>
        validateSignedArchiveManifest(
          unapproved,
          expectedEntries,
          context,
          utils
        )
      ).to.throw("signature mismatch")

      const mutated = await signManifest(expectedEntries)
      mutated.scanToBlockHash = `0x${"aa".repeat(32)}`
      expect(() =>
        validateSignedArchiveManifest(mutated, expectedEntries, context, utils)
      ).to.throw("snapshot hash mismatch")
    })
  })

  describe("authenticated canonical receipt journal", () => {
    const eventBlock = async () => {
      const factory = await ethers.getContractFactory(
        "FrostArchiveMigrationHarnessV1"
      )
      const emitter = await factory.deploy()
      await emitter.deployed()
      const receipt = await (await emitter.emitJournalEntry(resultHash)).wait()
      return {
        blockNumber: receipt.blockNumber,
        transactionHash: receipt.transactionHash,
      }
    }

    const providerWithReceiptMutation = (
      transactionHash: string,
      mutate: (receipt: any) => any
    ): any => {
      const { provider } = ethers
      return {
        getNetwork: () => provider.getNetwork(),
        send: async (method: string, params: unknown[]) => {
          const value = await provider.send(method, params)
          if (
            method === "eth_getTransactionReceipt" &&
            String(params[0]).toLowerCase() === transactionHash.toLowerCase()
          ) {
            return mutate(JSON.parse(JSON.stringify(value)))
          }
          return value
        },
      }
    }

    const customHre = (provider: any): any => ({
      ethers: { constants: ethers.constants, provider },
    })

    const cacheCanonicalBlockProvider = async (
      blockNumber: number
    ): Promise<any> => {
      const { provider } = ethers
      const block = await provider.send("eth_getBlockByNumber", [
        utils.hexValue(blockNumber),
        true,
      ])
      const receipts = new Map<string, unknown>()
      for (const transaction of block.transactions) {
        receipts.set(
          transaction.hash.toLowerCase(),
          await provider.send("eth_getTransactionReceipt", [transaction.hash])
        )
      }
      return {
        getNetwork: () => provider.getNetwork(),
        send: async (method: string, params: unknown[]) => {
          if (method === "eth_getBlockByNumber") {
            expect(params[0]).to.equal(utils.hexValue(blockNumber))
            return block
          }
          if (method === "eth_getTransactionReceipt") {
            return receipts.get(String(params[0]).toLowerCase()) ?? null
          }
          throw new Error(`unexpected cached-provider RPC method ${method}`)
        },
      }
    }

    const expectJournalFailure = async (
      promise: Promise<unknown>,
      message: string
    ) => {
      let error: Error | undefined
      try {
        await promise
      } catch (caught) {
        error = caught as Error
      }
      expect(error?.message).to.include(message)
    }

    it("reconstructs the canonical header, transaction trie, and receipt trie", async () => {
      const { blockNumber } = await eventBlock()
      const logs = await readCanonicalBlockLogs(hre, blockNumber)
      expect(logs).to.have.lengthOf(1)
      expect(logs[0].topics[1]).to.equal(resultHash)
    })

    it("rejects an omitted receipt", async () => {
      const { blockNumber, transactionHash } = await eventBlock()
      const provider = providerWithReceiptMutation(transactionHash, () => null)
      await expectJournalFailure(
        readCanonicalBlockLogs(customHre(provider), blockNumber),
        "is missing or malformed"
      )
    })

    it("rejects a reordered receipt", async () => {
      const { blockNumber, transactionHash } = await eventBlock()
      const provider = providerWithReceiptMutation(
        transactionHash,
        (receipt) => ({ ...receipt, transactionIndex: "0x1" })
      )
      await expectJournalFailure(
        readCanonicalBlockLogs(customHre(provider), blockNumber),
        "receipt transaction/block/order mismatch"
      )
    })

    it("rejects an omitted or fabricated log by the receipt root", async () => {
      const first = await eventBlock()
      const omittedProvider = providerWithReceiptMutation(
        first.transactionHash,
        (receipt) => ({ ...receipt, logs: [] })
      )
      await expectJournalFailure(
        readCanonicalBlockLogs(customHre(omittedProvider), first.blockNumber),
        "receipt trie root mismatch"
      )

      const second = await eventBlock()
      const fabricatedProvider = providerWithReceiptMutation(
        second.transactionHash,
        (receipt) => ({
          ...receipt,
          logs: [
            {
              ...receipt.logs[0],
              data: "0x01",
            },
          ],
        })
      )
      await expectJournalFailure(
        readCanonicalBlockLogs(
          customHre(fabricatedProvider),
          second.blockNumber
        ),
        "receipt trie root mismatch"
      )
    })

    it("fails closed on checkpoint-head and bounded-tail reorgs", async () => {
      const factory = await ethers.getContractFactory(
        "FrostArchiveMigrationHarnessV1"
      )
      const emitter = await factory.deploy()
      await emitter.deployed()
      const snapshot = await ethers.provider.send("evm_snapshot", [])

      const oldReceipt = await (
        await emitter.emitJournalEntry(resultHash)
      ).wait()
      const oldBlock = await ethers.provider.getBlock(oldReceipt.blockNumber)
      const oldProvider = await cacheCanonicalBlockProvider(
        oldReceipt.blockNumber
      )

      expect(await ethers.provider.send("evm_revert", [snapshot])).to.equal(
        true
      )
      const replacementReceipt = await (
        await emitter.emitJournalEntry(walletID)
      ).wait()
      const replacementBlock = await ethers.provider.getBlock(
        replacementReceipt.blockNumber
      )
      expect(replacementReceipt.blockNumber).to.equal(oldReceipt.blockNumber)
      expect(replacementBlock.hash).to.not.equal(oldBlock.hash)

      const reorgedCheckpoint = {
        registry: emitter.address,
        checkpointBlockNumber: oldReceipt.blockNumber,
        checkpointBlockHash: oldBlock.hash,
      } as ArchiveCheckpointV2
      await expectJournalFailure(
        assertCheckpointHeadCanonical(
          ethers.provider,
          oldProvider,
          reorgedCheckpoint
        ),
        "archive checkpoint head is no longer canonical"
      )

      const topic = utils.id("JournalEntry(bytes32)")
      const [replacementScan, oldScan] = await Promise.all([
        scanCanonicalHistory(
          ethers.provider,
          emitter.address,
          replacementReceipt.blockNumber,
          replacementReceipt.blockNumber,
          [topic]
        ),
        scanCanonicalHistory(
          oldProvider,
          emitter.address,
          oldReceipt.blockNumber,
          oldReceipt.blockNumber,
          [topic]
        ),
      ])
      const history = (coverage: typeof replacementScan.evidence) => ({
        coverage,
        submitted: [],
        approved: [],
        created: [],
        closed: [],
      })
      expect(() =>
        assertIndependentWalletHistory(
          history(replacementScan.evidence),
          history(oldScan.evidence)
        )
      ).to.throw("independent canonical wallet history rebuild mismatch")
    })
  })

  it("verifies every linked runtime address and rejects mismatches", () => {
    const expectedLibrary = `0x${"ab".repeat(20)}`
    const references = [
      { start: 5, length: 20 },
      { start: 35, length: 20 },
    ]
    let runtime = `0x${"00".repeat(80)}`
    for (const reference of references) {
      const start = 2 + reference.start * 2
      runtime =
        runtime.slice(0, start) +
        expectedLibrary.slice(2) +
        runtime.slice(start + 40)
    }

    expect(() =>
      assertRuntimeLinks(runtime, references, expectedLibrary)
    ).to.not.throw()
    expect(() =>
      assertRuntimeLinks(runtime, references, `0x${"cd".repeat(20)}`)
    ).to.throw("link mismatch")
    expect(zeroRuntimeLinks(runtime, references)).to.equal(
      `0x${"00".repeat(80)}`
    )
  })

  it("normalizes only the Solidity library self-address guard", () => {
    const runtime = `0x73${"ab".repeat(20)}${"ff".repeat(10)}`
    expect(normalizeLibraryRuntime(runtime)).to.equal(
      `0x73${"00".repeat(20)}${"ff".repeat(10)}`
    )
  })
})
