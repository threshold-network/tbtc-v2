import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { expect } from "chai"
import {
  acquireDurableArtifactSessionLock,
  assertIndependentArtifactStores,
  durableArtifactSessionLockPath,
  durableArtifactWriteLockPath,
  durableWriteFile,
  durableWriteHashedJson,
  readHashedJsonWithHash,
  readPrivateFile,
} from "../scripts/durable-artifact"
import {
  loadCutoverManifest,
  writeCutoverManifest,
} from "../scripts/ecdsa-fraud-router-cutover-artifacts"
import type { CanonicalHistoryScan } from "../scripts/ecdsa-fraud-router-canonical-history"
import {
  loadCanonicalHistoryJournal,
  nextCanonicalHistoryJournal,
  saveCanonicalHistoryJournal,
} from "../scripts/ecdsa-fraud-router-journal-store"
import {
  cutoverPreflightTiming,
  HandoffManifest,
} from "../scripts/ecdsa-fraud-router-cutover-lib"

describe("ECDSA fraud cutover durable artifacts", () => {
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "tbtc-ecdsa-cutover-artifacts-")
    )
    fs.chmodSync(directory, 0o700)
  })

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true })
  })

  function artifact(name = "manifest.json"): string {
    return path.join(directory, name)
  }

  it("publishes exact-mode, hashed artifacts and resumes with CAS", () => {
    const file = artifact()
    const initial = {
      version: 5,
      phase: "new-governance-owned",
    } as unknown as HandoffManifest
    const initialFileHash = writeCutoverManifest(file, initial, {
      createOnly: true,
    })

    expect(fs.statSync(file).mode & 0o777).to.equal(0o600)
    const loaded = loadCutoverManifest(file)
    expect(loaded.value).to.deep.equal(initial)
    expect(loaded.fileContentHash).to.equal(initialFileHash)

    const resumed = { ...initial, phase: "drain-owner-authorized" }
    const resumedFileHash = writeCutoverManifest(file, resumed, {
      expectedCurrentContentHash: loaded.fileContentHash,
    })
    expect(loadCutoverManifest(file).value).to.deep.equal(resumed)
    expect(resumedFileHash).not.to.equal(initialFileHash)
    expect(() =>
      writeCutoverManifest(file, initial, {
        expectedCurrentContentHash: initialFileHash,
      })
    ).to.throw("compare-and-swap mismatch")
    expect(() =>
      writeCutoverManifest(file, initial, { createOnly: true })
    ).to.throw("already exists")
  })

  it("rejects envelope tampering and artifact-kind substitution", () => {
    const file = artifact()
    durableWriteHashedJson(file, "expected-kind", { phase: "prepared" })
    expect(() => readHashedJsonWithHash(file, "other-kind")).to.throw(
      "identity/content mismatch"
    )

    const envelope = JSON.parse(readPrivateFile(file))
    envelope.payload.phase = "tampered"
    fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    expect(() => readHashedJsonWithHash(file, "expected-kind")).to.throw(
      "identity/content mismatch"
    )
  })

  it("rejects loose modes, symlinks, and unsafe parent directories", () => {
    const file = artifact()
    durableWriteFile(file, "private")
    fs.chmodSync(file, 0o644)
    expect(() => readPrivateFile(file)).to.throw(
      "permissions must be exactly 0600"
    )
    fs.chmodSync(file, 0o400)
    expect(() => readPrivateFile(file)).to.throw(
      "permissions must be exactly 0600"
    )

    fs.chmodSync(file, 0o600)
    const alias = artifact("alias.json")
    fs.symlinkSync(file, alias)
    expect(() => readPrivateFile(alias)).to.throw()

    fs.unlinkSync(alias)
    fs.chmodSync(directory, 0o770)
    expect(() => readPrivateFile(file)).to.throw(
      "must not be group/world writable"
    )
  })

  it("durably resumes recursive directory creation after its fsync boundary", () => {
    const file = path.join(directory, "nested", "private", "manifest.json")
    expect(() =>
      durableWriteFile(file, "payload", {
        requirePrivateDirectory: true,
        failpoint: (phase) => {
          if (phase === "after-directory-fsync") {
            throw new Error("fail after directory fsync")
          }
        },
      })
    ).to.throw("fail after directory fsync")
    expect(fs.existsSync(file)).to.equal(false)

    durableWriteFile(file, "payload", { requirePrivateDirectory: true })
    expect(readPrivateFile(file, { requirePrivateDirectory: true })).to.equal(
      "payload"
    )
    expect(fs.statSync(path.dirname(file)).mode & 0o777).to.equal(0o700)
  })

  it("rejects hard-linked artifact reads", () => {
    const file = artifact("hard-linked.json")
    const alias = artifact("hard-linked-alias.json")
    durableWriteFile(file, "payload")
    fs.linkSync(file, alias)

    expect(() => readPrivateFile(file)).to.throw(
      "must have exactly one hard link"
    )
    expect(() => readPrivateFile(alias)).to.throw(
      "must have exactly one hard link"
    )
  })

  it("preserves the prior artifact until atomic publication", () => {
    const file = artifact()
    const originalHash = durableWriteFile(file, "original")
    for (const phase of ["before-temp-write", "after-temp-fsync"] as const) {
      expect(() =>
        durableWriteFile(file, "replacement", {
          expectedCurrentContentHash: originalHash,
          failpoint: (observed) => {
            if (observed === phase) throw new Error(`fail at ${phase}`)
          },
        })
      ).to.throw(`fail at ${phase}`)
      expect(readPrivateFile(file)).to.equal("original")
    }

    expect(() =>
      durableWriteFile(file, "replacement", {
        expectedCurrentContentHash: originalHash,
        failpoint: (phase) => {
          if (phase === "after-rename") throw new Error("fail after rename")
        },
      })
    ).to.throw("fail after rename")
    expect(readPrivateFile(file)).to.equal("replacement")
  })

  it("detects two paths backed by one artifact inode", () => {
    const source = artifact("source.json")
    const reconciler = artifact("reconciler.json")
    durableWriteFile(source, "journal")
    fs.linkSync(source, reconciler)
    expect(() => assertIndependentArtifactStores(source, reconciler)).to.throw(
      "distinct canonical journal stores"
    )
  })

  it("never removes another writer's exclusive lock", () => {
    const file = artifact()
    const lock = artifact(".manifest.json.lock")
    fs.writeFileSync(lock, "live writer", { mode: 0o600, flag: "wx" })

    expect(() => durableWriteFile(file, "payload")).to.throw(
      "write is already locked"
    )
    expect(fs.readFileSync(lock, "utf8")).to.equal("live writer")
  })

  it("does not clobber a non-cooperating create-only publisher", () => {
    const file = artifact()
    expect(() =>
      durableWriteFile(file, "ours", {
        createOnly: true,
        failpoint: (phase) => {
          if (phase === "after-temp-fsync") {
            fs.writeFileSync(file, "theirs", { mode: 0o600, flag: "wx" })
          }
        },
      })
    ).to.throw()
    expect(readPrivateFile(file)).to.equal("theirs")
  })

  it("rejects a non-cooperating target replacement during staging", () => {
    const file = artifact()
    const originalHash = durableWriteFile(file, "original")

    expect(() =>
      durableWriteFile(file, "ours", {
        expectedCurrentContentHash: originalHash,
        failpoint: (phase) => {
          if (phase === "after-temp-fsync") {
            fs.unlinkSync(file)
            fs.writeFileSync(file, "theirs", { mode: 0o600, flag: "wx" })
          }
        },
      })
    ).to.throw("target changed during write")
    expect(readPrivateFile(file)).to.equal("theirs")
  })

  it("never removes a replaced lock during cleanup", () => {
    const file = artifact()
    const lock = durableArtifactWriteLockPath(file)

    expect(() =>
      durableWriteFile(file, "payload", {
        failpoint: (phase) => {
          if (phase === "after-temp-fsync") {
            fs.unlinkSync(lock)
            fs.writeFileSync(lock, "replacement lock", {
              mode: 0o600,
              flag: "wx",
            })
          }
        },
      })
    ).to.throw("write lock identity changed")
    expect(fs.readFileSync(lock, "utf8")).to.equal("replacement lock")
    expect(fs.existsSync(file)).to.equal(false)
  })

  it("holds and inode-binds a durable session lock", () => {
    const file = artifact()
    const expectedLock = durableArtifactSessionLockPath(file)
    const first = acquireDurableArtifactSessionLock(file, {
      requirePrivateDirectory: true,
    })

    expect(first.path).to.equal(expectedLock)
    expect(fs.statSync(first.path).mode & 0o777).to.equal(0o600)
    expect(() =>
      acquireDurableArtifactSessionLock(file, {
        requirePrivateDirectory: true,
      })
    ).to.throw("session is already locked")

    first.release()
    first.release()
    expect(fs.existsSync(expectedLock)).to.equal(false)

    const resumed = acquireDurableArtifactSessionLock(file, {
      requirePrivateDirectory: true,
    })
    resumed.release()
  })

  it("uses raw-file SHA-256 values for compare-and-swap", () => {
    const file = artifact()
    const hash = durableWriteFile(file, "payload")
    expect(hash).to.equal(
      `sha256:${crypto.createHash("sha256").update("payload").digest("hex")}`
    )
  })

  it("binds journals to an explicit durable-store UUID", () => {
    const file = artifact("journal.json")
    const sourceId = `0x${"11".repeat(32)}`
    const storeIdentity = `0x${"22".repeat(32)}`
    const wrongStoreIdentity = `0x${"33".repeat(32)}`
    const scan = {
      evidence: {
        finalizedBlock: 100,
        finalizedBlockHash: `0x${"44".repeat(32)}`,
      },
    } as unknown as CanonicalHistoryScan
    const journal = nextCanonicalHistoryJournal(sourceId, storeIdentity, scan)
    saveCanonicalHistoryJournal(file, journal, { createOnly: true })

    expect(
      loadCanonicalHistoryJournal(file, sourceId, storeIdentity).storageIdentity
    ).to.equal(storeIdentity)
    expect(() =>
      loadCanonicalHistoryJournal(file, sourceId, wrongStoreIdentity)
    ).to.throw("identity/content mismatch")
  })
})

describe("ECDSA fraud cutover timing", () => {
  it("selects a confirmed checkpoint with usable permissionless-begin slack", () => {
    expect(cutoverPreflightTiming(1000, 64, 255, 16)).to.deep.equal({
      preflightBlock: 936,
      maxTailBlocks: 255,
      earliestBeginBlock: 1001,
      latestBeginBlock: 1191,
      beginSlackBlocks: 190,
    })
  })

  it("rejects a tail that is valid in isolation but already has no begin slot", () => {
    expect(() => cutoverPreflightTiming(1000, 64, 64, 1)).to.throw(
      "preflight leaves -1 begin blocks of slack"
    )
  })
})
