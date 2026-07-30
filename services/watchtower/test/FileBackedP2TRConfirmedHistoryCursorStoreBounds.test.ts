import assert from "assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import test from "node:test"

import {
  FileBackedP2TRConfirmedHistoryCursorStore,
  MAXIMUM_P2TR_CONFIRMED_HISTORY_CURSOR_MAX_FILE_BYTES,
} from "../src/FileBackedP2TRConfirmedHistoryCursorStore.js"

const emptyState = `${JSON.stringify({ version: 1, wallets: {} }, null, 2)}\n`

test("validates the configured cursor file byte bound", () => {
  const filePath = "/tmp/p2tr-confirmed-history-cursor.json"

  for (const maxFileBytes of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAXIMUM_P2TR_CONFIRMED_HISTORY_CURSOR_MAX_FILE_BYTES + 1,
  ]) {
    assert.throws(
      () =>
        new FileBackedP2TRConfirmedHistoryCursorStore(filePath, {
          maxFileBytes,
        }),
      /maxFileBytes must be a positive safe integer/
    )
  }

  assert.throws(
    () =>
      new FileBackedP2TRConfirmedHistoryCursorStore(filePath, null as never),
    /cursor store options must be an object/
  )
})

test("accepts an exact-bound file and rejects one additional byte before parsing", async () => {
  await withCursorFile(async (filePath) => {
    const maxFileBytes = Buffer.byteLength(emptyState, "utf8")
    await writeFile(filePath, emptyState, "utf8")

    const exactBoundStore = new FileBackedP2TRConfirmedHistoryCursorStore(
      filePath,
      { maxFileBytes }
    )
    assert.equal(
      await exactBoundStore.loadConfirmedHistoryCursor("wallet"),
      undefined
    )

    // The extra byte is valid trailing JSON whitespace. The size guard, not
    // JSON parsing, must reject it.
    await writeFile(filePath, `${emptyState} `, "utf8")
    const oversizedStore = new FileBackedP2TRConfirmedHistoryCursorStore(
      filePath,
      { maxFileBytes }
    )
    await assert.rejects(
      oversizedStore.loadConfirmedHistoryCursor("wallet"),
      new RegExp(`exceeds configured ${maxFileBytes}-byte bound`)
    )
  })
})

test("applies the byte bound while checking that a loaded file is unchanged", async () => {
  await withCursorFile(async (filePath) => {
    const maxFileBytes = Buffer.byteLength(emptyState, "utf8") + 1
    await writeFile(filePath, emptyState, "utf8")
    const store = new FileBackedP2TRConfirmedHistoryCursorStore(filePath, {
      maxFileBytes,
    })
    assert.equal(await store.loadConfirmedHistoryCursor("wallet"), undefined)

    const oversizedContents = `${emptyState}  `
    await writeFile(filePath, oversizedContents, "utf8")

    await assert.rejects(
      store.saveConfirmedHistoryCursor("wallet", {}),
      new RegExp(`exceeds configured ${maxFileBytes}-byte bound`)
    )
    assert.equal(await readFile(filePath, "utf8"), oversizedContents)
  })
})

test("uses serialized UTF-8 bytes and refuses an oversized write", async () => {
  await withCursorFile(async (filePath) => {
    const walletAddress = "é".repeat(96)
    const serialized = `${JSON.stringify(
      {
        version: 1,
        wallets: { [walletAddress]: {} },
      },
      null,
      2
    )}\n`
    const maxFileBytes = serialized.length
    assert.ok(Buffer.byteLength(serialized, "utf8") > maxFileBytes)

    const store = new FileBackedP2TRConfirmedHistoryCursorStore(filePath, {
      maxFileBytes,
    })
    await assert.rejects(
      store.saveConfirmedHistoryCursor(walletAddress, {}),
      new RegExp(`exceeds configured ${maxFileBytes}-byte bound`)
    )
    await assert.rejects(
      readFile(filePath),
      (error: unknown) => isNodeError(error) && error.code === "ENOENT"
    )
  })
})

test("preserves ENOENT initialization and atomic snapshot writes", async () => {
  await withCursorFile(async (filePath, directory) => {
    const store = new FileBackedP2TRConfirmedHistoryCursorStore(filePath)
    assert.equal(await store.loadConfirmedHistoryCursor("wallet"), undefined)

    await store.saveConfirmedHistoryCursor("wallet", {})

    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
      version: 1,
      wallets: { wallet: {} },
    })
    assert.deepEqual(await readdir(directory), ["cursor.json"])

    const reloadedStore = new FileBackedP2TRConfirmedHistoryCursorStore(
      filePath,
      { maxFileBytes: 1024 }
    )
    assert.deepEqual(
      await reloadedStore.loadConfirmedHistoryCursor("wallet"),
      {}
    )
  })
})

test("compares loaded snapshots byte-for-byte", async () => {
  await withCursorFile(async (filePath) => {
    const prefix = Buffer.from('{"version":1,"wallets":{"', "utf8")
    const suffix = Buffer.from('":{}}}', "utf8")
    const initialContents = Buffer.concat([prefix, Buffer.from([0x80]), suffix])
    const changedContents = Buffer.concat([prefix, Buffer.from([0x81]), suffix])
    await writeFile(filePath, initialContents)

    const store = new FileBackedP2TRConfirmedHistoryCursorStore(filePath, {
      maxFileBytes: 1024,
    })
    assert.deepEqual(await store.loadConfirmedHistoryCursor("�"), {})

    // Both invalid source bytes decode to the same replacement character.
    // A decoded-string snapshot would miss this external change.
    await writeFile(filePath, changedContents)
    await assert.rejects(
      store.saveConfirmedHistoryCursor("wallet", {}),
      /cursor file changed since the last load/
    )
    assert.deepEqual(await readFile(filePath), changedContents)
  })
})

async function withCursorFile(
  run: (filePath: string, directory: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "p2tr-confirmed-history-bounds-")
  )
  try {
    await run(join(directory, "cursor.json"), directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
