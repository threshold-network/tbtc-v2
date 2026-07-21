/* eslint-disable no-bitwise */
import crypto from "crypto"
import fs from "fs"
import path from "path"

export type DurableWritePhase =
  | "after-directory-fsync"
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
  /** Require the artifact parent to be a current-user-owned 0700 directory. */
  requirePrivateDirectory?: boolean
  failpoint?: DurableWriteFailpoint
}

export type PrivateReadOptions = {
  /** Require the artifact parent to be a current-user-owned 0700 directory. */
  requirePrivateDirectory?: boolean
}

export type DurableArtifactSessionLockOptions = {
  /** Require the artifact parent to be a current-user-owned 0700 directory. */
  requirePrivateDirectory?: boolean
}

export type DurableArtifactSessionLock = {
  path: string
  release: () => void
}

export type PrivateFile = {
  contents: string
  contentHash: string
}

const PRIVATE_FILE_MODE = 0o600
const MODE_MASK = 0o777
const UNSAFE_DIRECTORY_MODE = 0o022

type FileIdentity = {
  device: string
  inode: string
}

type PrivateFileSnapshot = PrivateFile & {
  identity: FileIdentity
}

type TargetSnapshot =
  | { exists: false }
  | ({ exists: true } & PrivateFileSnapshot)

function pathEntryExists(file: string): boolean {
  try {
    fs.lstatSync(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function fileIdentity(metadata: fs.Stats): FileIdentity {
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

type OwnedPathUnlinkResult = "removed" | "missing" | "replaced"

function unlinkOwnedPath(
  file: string,
  expected: FileIdentity
): OwnedPathUnlinkResult {
  try {
    const observed = fileIdentity(fs.lstatSync(file))
    if (!sameFileIdentity(observed, expected)) return "replaced"
    fs.unlinkSync(file)
    return "removed"
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
    throw error
  }
}

function openDirectory(directory: string): number {
  return fs.openSync(
    directory,
    fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY ?? 0) |
      (fs.constants.O_NOFOLLOW ?? 0)
  )
}

function syncDirectory(directory: string): void {
  const descriptor = openDirectory(directory)
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

/**
 * Creates each missing path component separately so both the new directory's
 * metadata and its parent's new entry are durable before the next component is
 * created.
 */
function createDirectoriesDurably(
  directory: string,
  failpoint?: DurableWriteFailpoint
): void {
  const missing: string[] = []
  let cursor = path.resolve(directory)
  while (!pathEntryExists(cursor)) {
    missing.push(cursor)
    const parent = path.dirname(cursor)
    if (parent === cursor) {
      throw new Error(
        `could not find an existing artifact ancestor: ${directory}`
      )
    }
    cursor = parent
  }

  missing.reverse().forEach((current) => {
    const parent = path.dirname(current)
    let created = true
    try {
      fs.mkdirSync(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      created = false
      const metadata = fs.lstatSync(current)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`artifact parent must be a directory: ${current}`)
      }
    }

    const descriptor = openDirectory(current)
    try {
      if (created) fs.fchmodSync(descriptor, 0o700)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    syncDirectory(parent)
    failpoint?.("after-directory-fsync")
  })
}

function assertSecureDirectory(
  directory: string,
  create = false,
  requirePrivateDirectory = false,
  failpoint?: DurableWriteFailpoint
): string {
  if (create) createDirectoriesDurably(directory, failpoint)
  const requested = path.resolve(directory)
  const requestedMetadata = fs.lstatSync(requested)
  if (requestedMetadata.isSymbolicLink() || !requestedMetadata.isDirectory()) {
    throw new Error(`artifact parent must be a directory: ${directory}`)
  }
  const canonical = fs.realpathSync.native(requested)
  const metadata = fs.lstatSync(canonical)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`artifact parent must be a directory: ${directory}`)
  }
  if ((metadata.mode & UNSAFE_DIRECTORY_MODE) !== 0) {
    throw new Error(
      `artifact parent must not be group/world writable: ${canonical}`
    )
  }
  if (requirePrivateDirectory && (metadata.mode & MODE_MASK) !== 0o700) {
    throw new Error(
      `artifact parent permissions must be exactly 0700: ${canonical}`
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

function assertRegularPrivateMetadata(
  file: string,
  metadata: fs.Stats,
  allowMultipleLinks = false
): void {
  if (!metadata.isFile()) {
    throw new Error(`artifact must be a regular file: ${file}`)
  }
  if ((metadata.mode & MODE_MASK) !== PRIVATE_FILE_MODE) {
    throw new Error(`artifact permissions must be exactly 0600: ${file}`)
  }
  if (!allowMultipleLinks && metadata.nlink !== 1) {
    throw new Error(`artifact must have exactly one hard link: ${file}`)
  }
  const effectiveUser = process.geteuid?.()
  if (effectiveUser !== undefined && metadata.uid !== effectiveUser) {
    throw new Error(`artifact must be owned by the current user: ${file}`)
  }
}

function assertRegularPrivateDescriptor(
  file: string,
  descriptor: number,
  allowMultipleLinks = false
): fs.Stats {
  const metadata = fs.fstatSync(descriptor)
  assertRegularPrivateMetadata(file, metadata, allowMultipleLinks)
  return metadata
}

function openPrivateFile(file: string, allowMultipleLinks = false): number {
  const flags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0)
  const descriptor = fs.openSync(file, flags)
  try {
    assertRegularPrivateDescriptor(file, descriptor, allowMultipleLinks)
    return descriptor
  } catch (error) {
    fs.closeSync(descriptor)
    throw error
  }
}

export function artifactContentHash(contents: string): string {
  return `sha256:${crypto.createHash("sha256").update(contents).digest("hex")}`
}

function assertPathIdentity(
  file: string,
  expected: FileIdentity,
  description: string
): void {
  let observed: fs.Stats
  try {
    observed = fs.lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${description} is missing: ${file}`)
    }
    throw error
  }
  assertRegularPrivateMetadata(file, observed)
  if (!sameFileIdentity(fileIdentity(observed), expected)) {
    throw new Error(`${description} identity changed: ${file}`)
  }
}

function readPrivateFileSnapshot(
  file: string,
  options: PrivateReadOptions = {}
): PrivateFileSnapshot {
  const requested = path.resolve(file)
  const directory = assertSecureDirectory(
    path.dirname(requested),
    false,
    options.requirePrivateDirectory
  )
  const absolute = path.join(directory, path.basename(requested))
  const descriptor = openPrivateFile(absolute)
  try {
    const before = assertRegularPrivateDescriptor(absolute, descriptor)
    const identity = fileIdentity(before)
    const contents = fs.readFileSync(descriptor, "utf8")
    const after = assertRegularPrivateDescriptor(absolute, descriptor)
    if (!sameFileIdentity(fileIdentity(after), identity)) {
      throw new Error(`artifact descriptor identity changed: ${absolute}`)
    }
    assertPathIdentity(absolute, identity, "artifact")
    return {
      contents,
      contentHash: artifactContentHash(contents),
      identity,
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

export function readPrivateFileWithHash(
  file: string,
  options: PrivateReadOptions = {}
): PrivateFile {
  const { contents, contentHash } = readPrivateFileSnapshot(file, options)
  return { contents, contentHash }
}

export function readPrivateFile(
  file: string,
  options: PrivateReadOptions = {}
): string {
  return readPrivateFileWithHash(file, options).contents
}

export function readPrivateJson<T>(
  file: string,
  options: PrivateReadOptions = {}
): T {
  return JSON.parse(readPrivateFile(file, options)) as T
}

function siblingArtifactPath(file: string, suffix: string): string {
  const absolute = path.resolve(file)
  const requestedDirectory = path.dirname(absolute)
  let directory = requestedDirectory
  try {
    directory = fs.realpathSync.native(requestedDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return path.join(directory, `.${path.basename(absolute)}.${suffix}`)
}

export function durableArtifactWriteLockPath(file: string): string {
  return siblingArtifactPath(file, "lock")
}

export function durableArtifactSessionLockPath(file: string): string {
  return siblingArtifactPath(file, "session.lock")
}

function exclusivePrivateCreateFlags(): number {
  return (
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0)
  )
}

/**
 * Holds a durable sibling lock for an entire multi-write artifact session.
 * This lock is intentionally distinct from the short-lived per-write lock.
 */
export function acquireDurableArtifactSessionLock(
  file: string,
  options: DurableArtifactSessionLockOptions = {}
): DurableArtifactSessionLock {
  const requested = path.resolve(file)
  const directory = assertSecureDirectory(
    path.dirname(requested),
    true,
    options.requirePrivateDirectory
  )
  const absolute = path.join(directory, path.basename(requested))
  const lock = path.join(
    directory,
    path.basename(durableArtifactSessionLockPath(absolute))
  )
  let descriptor: number | undefined
  let identity: FileIdentity | undefined

  try {
    try {
      descriptor = fs.openSync(
        lock,
        exclusivePrivateCreateFlags(),
        PRIVATE_FILE_MODE
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`artifact session is already locked: ${absolute}`)
      }
      throw error
    }

    identity = fileIdentity(fs.fstatSync(descriptor))
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE)
    identity = fileIdentity(assertRegularPrivateDescriptor(lock, descriptor))
    fs.fsyncSync(descriptor)
    assertPathIdentity(lock, identity, "artifact session lock")
    syncDirectory(directory)

    let released = false
    return {
      path: lock,
      release: () => {
        if (released) return
        released = true
        try {
          assertPathIdentity(
            lock,
            identity as FileIdentity,
            "artifact session lock"
          )
          if (unlinkOwnedPath(lock, identity as FileIdentity) !== "removed") {
            throw new Error(`artifact session lock identity changed: ${lock}`)
          }
          syncDirectory(directory)
        } finally {
          fs.closeSync(descriptor as number)
          descriptor = undefined
        }
      },
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (
      identity !== undefined &&
      unlinkOwnedPath(lock, identity) === "removed"
    ) {
      syncDirectory(directory)
    }
    throw error
  }
}

function captureTargetSnapshot(
  file: string,
  options: PrivateReadOptions
): TargetSnapshot {
  if (!pathEntryExists(file)) return { exists: false }
  return { exists: true, ...readPrivateFileSnapshot(file, options) }
}

function assertTargetUnchanged(
  file: string,
  expected: TargetSnapshot,
  options: PrivateReadOptions
): void {
  if (!expected.exists) {
    if (pathEntryExists(file)) {
      throw new Error(`artifact target appeared during write: ${file}`)
    }
    return
  }

  if (!pathEntryExists(file)) {
    throw new Error(`artifact target disappeared during write: ${file}`)
  }
  const observed = readPrivateFileSnapshot(file, options)
  if (
    !sameFileIdentity(observed.identity, expected.identity) ||
    observed.contentHash !== expected.contentHash
  ) {
    throw new Error(`artifact target changed during write: ${file}`)
  }
}

/**
 * Atomically publishes a private artifact and fsyncs both the file and parent
 * directory. A sibling O_EXCL lock serializes cooperating writers. CAS is
 * therefore serialized for cooperating writers, while the captured target
 * inode and hash are rechecked immediately before publication to detect a
 * non-cooperating replacement. A lock left by a terminated process is
 * intentionally fail-closed and must be removed only after an operator has
 * verified that no writer is live and the target is valid.
 */
export function durableWriteFile(
  file: string,
  contents: string,
  options: DurableWriteOptions = {}
): string {
  const requested = path.resolve(file)
  const directory = assertSecureDirectory(
    path.dirname(requested),
    true,
    options.requirePrivateDirectory,
    options.failpoint
  )
  const absolute = path.join(directory, path.basename(requested))
  const lock = path.join(
    directory,
    path.basename(durableArtifactWriteLockPath(absolute))
  )
  const temporary = path.join(
    directory,
    `.${path.basename(absolute)}.tmp-${process.pid}-${crypto
      .randomBytes(8)
      .toString("hex")}`
  )
  let lockDescriptor: number | undefined
  let lockIdentity: FileIdentity | undefined
  let temporaryDescriptor: number | undefined
  let temporaryIdentity: FileIdentity | undefined
  let temporaryAtPath = false
  let completed = false
  let resultHash: string | undefined
  let cleanupChanged = false

  try {
    try {
      lockDescriptor = fs.openSync(
        lock,
        exclusivePrivateCreateFlags(),
        PRIVATE_FILE_MODE
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`artifact write is already locked: ${absolute}`)
      }
      throw error
    }
    lockIdentity = fileIdentity(fs.fstatSync(lockDescriptor))
    fs.fchmodSync(lockDescriptor, PRIVATE_FILE_MODE)
    lockIdentity = fileIdentity(
      assertRegularPrivateDescriptor(lock, lockDescriptor)
    )
    fs.fsyncSync(lockDescriptor)
    assertPathIdentity(lock, lockIdentity, "artifact write lock")
    syncDirectory(directory)

    const privateOptions = {
      requirePrivateDirectory: options.requirePrivateDirectory,
    }
    const target = captureTargetSnapshot(absolute, privateOptions)
    if (options.createOnly && target.exists) {
      throw new Error(`artifact already exists: ${absolute}`)
    }
    if (
      target.exists &&
      options.expectedCurrentContentHash !== undefined &&
      target.contentHash !== options.expectedCurrentContentHash
    ) {
      throw new Error(`artifact compare-and-swap mismatch: ${absolute}`)
    }
    if (!target.exists && options.expectedCurrentContentHash !== undefined) {
      throw new Error(
        `artifact compare-and-swap target is missing: ${absolute}`
      )
    }

    temporaryDescriptor = fs.openSync(
      temporary,
      exclusivePrivateCreateFlags(),
      PRIVATE_FILE_MODE
    )
    temporaryAtPath = true
    temporaryIdentity = fileIdentity(fs.fstatSync(temporaryDescriptor))
    fs.fchmodSync(temporaryDescriptor, PRIVATE_FILE_MODE)
    temporaryIdentity = fileIdentity(
      assertRegularPrivateDescriptor(temporary, temporaryDescriptor)
    )
    options.failpoint?.("before-temp-write")
    fs.writeFileSync(temporaryDescriptor, contents, { encoding: "utf8" })
    fs.fsyncSync(temporaryDescriptor)
    options.failpoint?.("after-temp-fsync")

    assertRegularPrivateDescriptor(temporary, temporaryDescriptor)
    assertPathIdentity(temporary, temporaryIdentity, "artifact temporary")
    assertPathIdentity(lock, lockIdentity, "artifact write lock")
    const staged = readPrivateFileSnapshot(temporary, privateOptions)
    const expectedHash = artifactContentHash(contents)
    if (
      !sameFileIdentity(staged.identity, temporaryIdentity) ||
      staged.contentHash !== expectedHash
    ) {
      throw new Error(`artifact temporary content changed: ${temporary}`)
    }

    // Revalidate last so a non-cooperating target replacement during the
    // failpoint window cannot be silently overwritten.
    assertTargetUnchanged(absolute, target, privateOptions)

    // A target that was absent is published with no-replace link semantics.
    // Existing-target replacement remains atomic through same-directory rename.
    if (!target.exists) {
      fs.linkSync(temporary, absolute)
      if (unlinkOwnedPath(temporary, temporaryIdentity) !== "removed") {
        throw new Error(`artifact temporary identity changed: ${temporary}`)
      }
    } else {
      fs.renameSync(temporary, absolute)
    }
    temporaryAtPath = false
    options.failpoint?.("after-rename")
    syncDirectory(directory)

    // Read back the exact staged inode through O_NOFOLLOW before success.
    const observed = readPrivateFileSnapshot(absolute, privateOptions)
    if (
      !sameFileIdentity(observed.identity, temporaryIdentity) ||
      observed.contentHash !== expectedHash
    ) {
      throw new Error(`artifact durable readback mismatch: ${absolute}`)
    }
    assertPathIdentity(lock, lockIdentity, "artifact write lock")
    assertPathIdentity(absolute, temporaryIdentity, "artifact")
    completed = true
    resultHash = expectedHash
  } finally {
    if (temporaryDescriptor !== undefined) {
      fs.closeSync(temporaryDescriptor)
    }
    if (lockDescriptor !== undefined) fs.closeSync(lockDescriptor)

    if (temporaryAtPath && temporaryIdentity !== undefined) {
      const result = unlinkOwnedPath(temporary, temporaryIdentity)
      if (result === "removed") syncDirectory(directory)
      cleanupChanged ||= result !== "removed"
    }
    if (lockIdentity !== undefined) {
      const result = unlinkOwnedPath(lock, lockIdentity)
      if (result === "removed") syncDirectory(directory)
      cleanupChanged ||= result !== "removed"
    }
  }
  if (completed && cleanupChanged) {
    throw new Error(`artifact owned path identity changed: ${absolute}`)
  }
  return resultHash as string
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
  kind: string,
  options: PrivateReadOptions = {}
): LoadedHashedJson<T> {
  const loaded = readPrivateFileWithHash(file, options)
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

export function readHashedJson<T>(
  file: string,
  kind: string,
  options: PrivateReadOptions = {}
): T {
  return readHashedJsonWithHash<T>(file, kind, options).payload
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
  // Alias detection intentionally allows multiple links here. All artifact
  // reads and writes reject them; this path must inspect the shared inode so it
  // can emit the distinct-store diagnostic instead.
  const descriptor = openPrivateFile(canonicalPath, true)
  try {
    const metadata = assertRegularPrivateDescriptor(
      canonicalPath,
      descriptor,
      true
    )
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
