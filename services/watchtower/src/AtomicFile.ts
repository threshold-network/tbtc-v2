import { promises as fs } from "fs"
import { dirname } from "path"

export async function writeFileAtomically(
  filePath: string,
  contents: string
): Promise<void> {
  const directory = dirname(filePath)
  await fs.mkdir(directory, { recursive: true })

  const temporaryPath = `${filePath}.${
    process.pid
  }.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  let shouldRemoveTemporaryFile = true

  try {
    const temporaryFile = await fs.open(temporaryPath, "wx")
    try {
      await temporaryFile.writeFile(contents, "utf8")
      await temporaryFile.sync()
    } finally {
      await temporaryFile.close()
    }

    await fs.rename(temporaryPath, filePath)
    shouldRemoveTemporaryFile = false
    await syncDirectory(directory)
  } finally {
    if (shouldRemoveTemporaryFile) {
      await fs.rm(temporaryPath, { force: true })
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const directoryHandle = await fs.open(directory, "r")
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    if (isIgnorableDirectorySyncError(error)) {
      return
    }

    throw error
  }
}

function isIgnorableDirectorySyncError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EINVAL" || error.code === "EPERM")
  )
}
