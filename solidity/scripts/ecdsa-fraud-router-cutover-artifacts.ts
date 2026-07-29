import {
  DurableWriteOptions,
  durableWriteHashedJson,
  readHashedJsonWithHash,
} from "./durable-artifact"
import {
  HandoffManifest,
  InventoryBundle,
} from "./ecdsa-fraud-router-cutover-lib"

export const ECDSA_CUTOVER_MANIFEST_ARTIFACT_KIND =
  "tbtc/ecdsa-fraud-cutover/manifest/v5"
export const ECDSA_CUTOVER_INVENTORY_ARTIFACT_KIND =
  "tbtc/ecdsa-fraud-cutover/inventory/v1"

export type LoadedCutoverArtifact<T> = {
  value: T
  fileContentHash: string
}

function loadArtifact<T>(file: string, kind: string): LoadedCutoverArtifact<T> {
  const loaded = readHashedJsonWithHash<T>(file, kind)
  return { value: loaded.payload, fileContentHash: loaded.fileContentHash }
}

export function loadCutoverManifest(
  file: string
): LoadedCutoverArtifact<HandoffManifest> {
  return loadArtifact(file, ECDSA_CUTOVER_MANIFEST_ARTIFACT_KIND)
}

export function writeCutoverManifest(
  file: string,
  manifest: HandoffManifest,
  options: DurableWriteOptions = {}
): string {
  return durableWriteHashedJson(
    file,
    ECDSA_CUTOVER_MANIFEST_ARTIFACT_KIND,
    manifest,
    options
  )
}

export function loadCutoverInventory(
  file: string
): LoadedCutoverArtifact<InventoryBundle> {
  return loadArtifact(file, ECDSA_CUTOVER_INVENTORY_ARTIFACT_KIND)
}

export function writeCutoverInventory(
  file: string,
  inventory: InventoryBundle,
  options: DurableWriteOptions = {}
): string {
  return durableWriteHashedJson(
    file,
    ECDSA_CUTOVER_INVENTORY_ARTIFACT_KIND,
    inventory,
    options
  )
}
