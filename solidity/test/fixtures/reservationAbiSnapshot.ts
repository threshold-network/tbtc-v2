import { ethers } from "ethers"
import type { JsonFragment } from "@ethersproject/abi"
import * as fs from "fs"
import * as path from "path"
import { artifacts } from "hardhat"

/**
 * Reservation ABI surface snapshot fixture.
 *
 * Mirrors the pattern in bridgeStorageLayoutSnapshot.ts: extracts a live
 * structural fact from compiled artifacts and compares against a checked-in
 * JSON snapshot. This fixture computes function selectors, event topic0 hashes,
 * and struct field order for the reservation ABI surface that keep-core's
 * client is documented as consuming.
 *
 * NOTE: A matching artifact SHOULD exist on the keep-core side for full
 * protection against cross-repo ABI drift. The cross-repo CI wiring to compare
 * both snapshots is tracked separately and out of scope here.
 */

export type FunctionSelectorInfo = {
  name: string
  selector: string
  inputs: string[]
  outputs: string[]
}

export type EventTopicInfo = {
  name: string
  topic0: string
  inputs: string[]
}

export type StructFieldInfo = {
  name: string
  type: string
}

export type ReservationAbiSnapshot = {
  functions: FunctionSelectorInfo[]
  events: EventTopicInfo[]
  structs: Record<string, StructFieldInfo[]>
}

type AbiParameter = { type: string; name?: string }
type AbiFragment = {
  type: string
  name?: string
  inputs?: AbiParameter[]
  outputs?: AbiParameter[]
}

// `isReservedDeposit` and `setReservationRouter` are declared directly on
// Bridge.sol (not reached through the router delegatecall); the other three
// are implemented by ReservationRouter and reached through the Bridge
// fallback. Both surfaces are equally part of the ABI observable at the
// Bridge address (see IReservationBridge.sol).
const FUNCTIONS_OF_INTEREST: { name: string; contract: string }[] = [
  { name: "updateReservationCaps", contract: "ReservationRouter" },
  { name: "reservationCaps", contract: "ReservationRouter" },
  { name: "notifyReservationStranded", contract: "ReservationRouter" },
  { name: "isReservedDeposit", contract: "Bridge" },
  { name: "setReservationRouter", contract: "Bridge" },
]

// `ReservationCapsUpdated` and `ReservationOccupancyChanged` are emitted by
// the `Reservation` library (inlined into ReservationRouter's ABI);
// `ReservationReanchored` is emitted by the `ReservationProofs` library
// (inlined into ReservationProofs' ABI).
const EVENTS_OF_INTEREST: { name: string; contract: string }[] = [
  { name: "ReservationCapsUpdated", contract: "ReservationRouter" },
  { name: "ReservationReanchored", contract: "ReservationProofs" },
  { name: "ReservationOccupancyChanged", contract: "ReservationRouter" },
]

const STRUCTS_OF_INTEREST = ["ReservationRequest", "ReservationAction"]

async function getContractAbi(contractName: string): Promise<AbiFragment[]> {
  const artifact = await artifacts.readArtifact(contractName)
  return artifact.abi as AbiFragment[]
}

export async function getReservationAbiSnapshot(): Promise<ReservationAbiSnapshot> {
  const abiByContract: Record<string, AbiFragment[]> = {
    ReservationRouter: await getContractAbi("ReservationRouter"),
    Bridge: await getContractAbi("Bridge"),
    ReservationProofs: await getContractAbi("ReservationProofs"),
  }

  const findFragment = (
    abi: AbiFragment[],
    name: string,
    type: "function" | "event"
  ): AbiFragment => {
    const fragment = abi.find((f) => f.type === type && f.name === name)
    if (!fragment) {
      throw new Error(`${type} ${name} not found in ABI`)
    }
    return fragment
  }

  // Compute function selectors.
  const functions: FunctionSelectorInfo[] = FUNCTIONS_OF_INTEREST.map(
    ({ name, contract }) => {
      const abi = abiByContract[contract]
      const fragment = findFragment(abi, name, "function")
      const iface = new ethers.utils.Interface(abi as JsonFragment[])
      return {
        name,
        selector: iface.getSighash(name),
        inputs: (fragment.inputs ?? []).map((i) => i.type),
        outputs: (fragment.outputs ?? []).map((o) => o.type),
      }
    }
  )

  // Compute event topic0 hashes.
  const events: EventTopicInfo[] = EVENTS_OF_INTEREST.map(
    ({ name, contract }) => {
      const abi = abiByContract[contract]
      const fragment = findFragment(abi, name, "event")
      const iface = new ethers.utils.Interface(abi as JsonFragment[])
      return {
        name,
        topic0: iface.getEventTopic(name),
        inputs: (fragment.inputs ?? []).map((i) => i.type),
      }
    }
  )

  // Extract struct field order directly from Reservation.sol source, since
  // internal-library structs don't appear in the compiled JSON ABI.
  const structs: Record<string, StructFieldInfo[]> = {}
  const reservationSource = fs.readFileSync(
    path.join(__dirname, "../../contracts/bridge/Reservation.sol"),
    "utf8"
  )
  STRUCTS_OF_INTEREST.forEach((structName) => {
    const structRegex = new RegExp(
      `struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
      "m"
    )
    const match = reservationSource.match(structRegex)
    if (!match) {
      throw new Error(`Struct ${structName} not found in Reservation.sol`)
    }
    const body = match[1]
    const fields: StructFieldInfo[] = body
      .split("\n")
      .map((line) => line.replace(/\/\/\/.*$/, "").trim())
      .filter((line) => line.length > 0 && !line.startsWith("//"))
      .map((line) => {
        // Parse a field declaration line: "type name;" (trailing comment
        // and trailing-comma-in-declaration-list stripped above).
        const cleanLine = line.replace(/,$/, "").replace(/;.*$/, "").trim()
        const parts = cleanLine.split(/\s+/)
        if (parts.length < 2) {
          return { name: "", type: cleanLine }
        }
        const name = parts[parts.length - 1]
        const type = parts.slice(0, -1).join(" ")
        return { name, type }
      })
      .filter((f) => f.name.length > 0)
    structs[structName] = fields
  })

  return { functions, events, structs }
}

export async function writeReservationAbiSnapshot(
  snapshot: ReservationAbiSnapshot,
  outputPath: string
): Promise<void> {
  const json = {
    _comment:
      "Snapshot of reservation ABI surface (function selectors, event topics, struct field order) that keep-core's client depends on. This snapshot must be regenerated by whichever future PR intentionally changes the reservation ABI surface. A CI failure here means that PR unexpectedly touched the reservation ABI surface consumed by keep-core's client. A matching artifact SHOULD exist on the keep-core side for full cross-repo protection; wiring CI to compare both snapshots is tracked separately and out of scope here.",
    ...snapshot,
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(json, null, 2)}\n`)
}
