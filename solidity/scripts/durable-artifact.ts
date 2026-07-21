/* eslint-disable no-bitwise */
import crypto from "crypto"
import fs from "fs"
import path from "path"

export type DurableWritePhase =
  | "before-temp-write"
  | "after-temp-fsync"
  | "after-rename"
export type DurableWriteFailpoint = (phase: DurableWritePhase) => void

export type DurableWriteOptions = {
  /** Refuse to replace any existing directory entry. */
  createOnly?: boolean
  /**
   * Compare-and-swap guard over the exact existing file bytes. The write is
   * rejected if the target changed since it was read.
   */
  expectedCurrentContentHash?: string
  failpoint?: DurableWriteFailpoint
}

export type PrivateFile = {
  contents: string
  contentHash: string
}

const PRIVATE_FILE_MODE = 0o600
const MODE_MASK = 0o777
const UNSAFE_DIRECTORY_MODE = 0o022

function pathEntryExists(file: string): boolean {
  try {
    fs.lstatSync(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function unlinkIfExists(file: string): boolean {
  try {
    fs.unlinkSync(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function assertSecureDirectory(directory: string, create = false): string {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const canonical = fs.realpathSync.native(directory)
  const metadata = fs.lstatSync(canonical)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`artifact parent must be a directory: ${directory}`)
  }
  if ((metadata.mode & UNSAFE_DIRECTORY_MODE) !== 0) {
    throw new Error(
      `artifact parent must not be group/world writable: ${canonical}`
    )
  }
  const effectiveUser = process.geteuid?.()
  if (effectiveUser !== undefined && metadata.uid !== effectiveUser) {
    throw new Error(
      `artifact parent must be owned by the current user: ${canonical}`
    )
  }
  return canonical
}

function assertRegularPrivateDescriptor(
  file: string,
  descriptor: number
): fs.Stats {
  const metadata = fs.fstatSync(descriptor)
  if (!metadata.isFile()) {
    throw new Error(`artifact must be a regular file: ${file}`)
  }
  if ((metadata.mode & MODE_MASK) !== PRIVATE_FILE_MODE) {
    throw new Error(`artifact permissions must be exactly 0600: ${file}`)
  }
  const effectiveUser = process.geteuid?.()
  if (effectiveUser !== undefined && metadata.uid !== effectiveUser) {
    throw new Error(`artifact must be owned by the current user: ${file}`)
  }
  return metadata
}

function openPrivateFile(file: string): number {
  const flags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0)
  const descriptor = fs.openSync(file, flags)
  try {
    assertRegularPrivateDescriptor(file, descriptor)
    return descriptor
  } catch (error) {
    fs.closeSync(descriptor)
    throw error
  }
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0)
  )
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

export function artifactContentHash(contents: string): string {
  return `sha256:${crypto.createHash("sha256").update(contents).digest("hex")}`
}

export function readPrivateFileWithHash(file: string): PrivateFile {
  const requested = path.resolve(file)
  const directory = assertSecureDirectory(path.dirname(requested))
  const absolute = path.join(directory, path.basename(requested))
  const descriptor = openPrivateFile(absolute)
  try {
    const contents = fs.readFileSync(descriptor, "utf8")
    return { contents, contentHash: artifactContentHash(contents) }
  } finally {
    fs.closeSync(descriptor)
  }
}

export function readPrivateFile(file: string): string {
  return readPrivateFileWithHash(file).contents
}

export function readPrivateJson<T>(file: string): T {
  return JSON.parse(readPrivateFile(file)) as T
}

/**
 * Atomically publishes a private artifact and fsyncs both the file and parent
 * directory. A sibling O_EXCL lock serializes cooperating writers. A lock left
 * by a terminated process is intentionally fail-closed and must be removed only
 * after an operator has verified that no writer is live and the target is valid.
 */
export function durableWriteFile(
  file: string,
  contents: string,
  options: DurableWriteOptions = {}
): string {
  const requested = path.resolve(file)
  const directory = assertSecureDirectory(path.dirname(requested), true)
  const absolute = path.join(directory, path.basename(requested))
  const lock = path.join(directory, `.${path.basename(absolute)}.lock`)
  const temporary = path.join(
    directory,
    `.${path.basename(absolute)}.tmp-${process.pid}-${crypto
      .randomBytes(8)
      .toString("hex")}`
  )
  const exclusiveFlags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0)
  let lockDescriptor: number | undefined
  let lockOwned = false
  let temporaryDescriptor: number | undefined
  let temporaryExists = false
  try {
    try {
      lockDescriptor = fs.openSync(lock, exclusiveFlags, PRIVATE_FILE_MODE)
      lockOwned = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`artifact write is already locked: ${absolute}`)
      }
      throw error
    }
    fs.fchmodSync(lockDescriptor, PRIVATE_FILE_MODE)
    fs.fsyncSync(lockDescriptor)
    fs.closeSync(lockDescriptor)
    lockDescriptor = undefined
    syncDirectory(directory)

    const exists = pathEntryExists(absolute)
    if (options.createOnly && exists) {
      throw new Error(`artifact already exists: ${absolute}`)
    }
    if (exists) {
      const current = readPrivateFileWithHash(absolute)
      if (
        options.expectedCurrentContentHash !== undefined &&
        current.contentHash !== options.expectedCurrentContentHash
      ) {
        throw new Error(`artifact compare-and-swap mismatch: ${absolute}`)
      }
    } else if (options.expectedCurrentContentHash !== undefined) {
      throw new Error(
        `artifact compare-and-swap target is missing: ${absolute}`
      )
    }

    temporaryDescriptor = fs.openSync(
      temporary,
      exclusiveFlags,
      PRIVATE_FILE_MODE
    )
    temporaryExists = true
    fs.fchmodSync(temporaryDescriptor, PRIVATE_FILE_MODE)
    assertRegularPrivateDescriptor(temporary, temporaryDescriptor)
    options.failpoint?.("before-temp-write")
    fs.writeFileSync(temporaryDescriptor, contents, { encoding: "utf8" })
    fs.fsyncSync(temporaryDescriptor)
    fs.closeSync(temporaryDescriptor)
    temporaryDescriptor = undefined
    options.failpoint?.("after-temp-fsync")

    // The private mode is fixed and synced before publication. Create-only
    // uses an atomic same-directory hard link so even a non-cooperating writer
    // cannot appear between the existence check and publication.
    if (options.createOnly) {
      fs.linkSync(temporary, absolute)
      fs.unlinkSync(temporary)
    } else {
      fs.renameSync(temporary, absolute)
    }
    temporaryExists = false
    options.failpoint?.("after-rename")
    syncDirectory(directory)

    // Read back through O_NOFOLLOW and the exact-mode check before success.
    const observed = readPrivateFileWithHash(absolute)
    const expectedHash = artifactContentHash(contents)
    if (observed.contentHash !== expectedHash) {
      throw new Error(`artifact durable readback mismatch: ${absolute}`)
    }
    return expectedHash
  } finally {
    if (temporaryDescriptor !== undefined) {
      fs.closeSync(temporaryDescriptor)
    }
    if (lockDescriptor !== undefined) fs.closeSync(lockDescriptor)
    if (temporaryExists) unlinkIfExists(temporary)
    if (lockOwned && unlinkIfExists(lock)) {
      syncDirectory(directory)
    }
  }
}

export function durableWriteJson(
  file: string,
  value: unknown,
  options: DurableWriteOptions = {}
): string {
  return durableWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, options)
}

export type DurableJsonArtifact<T> = {
  version: 1
  kind: string
  contentHash: string
  payload: T
}

export type LoadedHashedJson<T> = {
  payload: T
  fileContentHash: string
}

function durableJsonPayloadHash(value: unknown): string {
  return artifactContentHash(JSON.stringify(value))
}

export function durableWriteHashedJson<T>(
  file: string,
  kind: string,
  payload: T,
  options: DurableWriteOptions = {}
): string {
  const artifact: DurableJsonArtifact<T> = {
    version: 1,
    kind,
    contentHash: durableJsonPayloadHash(payload),
    payload,
  }
  return durableWriteJson(file, artifact, options)
}

export function readHashedJsonWithHash<T>(
  file: string,
  kind: string
): LoadedHashedJson<T> {
  const loaded = readPrivateFileWithHash(file)
  const artifact = JSON.parse(loaded.contents) as DurableJsonArtifact<T>
  if (
    artifact.version !== 1 ||
    artifact.kind !== kind ||
    typeof artifact.contentHash !== "string" ||
    artifact.contentHash !== durableJsonPayloadHash(artifact.payload)
  ) {
    throw new Error(`artifact identity/content mismatch: ${file}`)
  }
  return { payload: artifact.payload, fileContentHash: loaded.contentHash }
}

export function readHashedJson<T>(file: string, kind: string): T {
  return readHashedJsonWithHash<T>(file, kind).payload
}

export type CanonicalArtifactIdentity = {
  path: string
  device?: string
  inode?: string
}

export function canonicalArtifactIdentity(
  file: string
): CanonicalArtifactIdentity {
  const absolute = path.resolve(file)
  const directory = assertSecureDirectory(path.dirname(absolute))
  const canonicalPath = path.join(directory, path.basename(absolute))
  if (!pathEntryExists(canonicalPath)) return { path: canonicalPath }
  const descriptor = openPrivateFile(canonicalPath)
  try {
    const metadata = assertRegularPrivateDescriptor(canonicalPath, descriptor)
    return {
      path: canonicalPath,
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

export function assertIndependentArtifactStores(
  sourceFile: string,
  reconcilerFile: string
): void {
  const source = canonicalArtifactIdentity(sourceFile)
  const reconciler = canonicalArtifactIdentity(reconcilerFile)
  if (
    source.path === reconciler.path ||
    (source.device !== undefined &&
      source.device === reconciler.device &&
      source.inode === reconciler.inode)
  ) {
    throw new Error(
      "source and reconciler must use distinct canonical journal stores"
    )
  }
}
