/* eslint-disable @typescript-eslint/no-non-null-assertion */
import fs from "fs"
import os from "os"
import path from "path"
import { expect } from "chai"
import {
  ParsedPrepareArtifact,
  AddressKey,
  SEPOLIA_CHAIN_ID,
  REHEARSAL_CHAIN_ID,
  PREPARE_ARTIFACT_SCHEMA_VERSION,
  parsePrepareArtifact,
  isAddressOrAbsent,
  hasAllDeployedAddresses,
  prepareArtifactFiles,
  selectPrepareArtifact,
  bindingMismatch,
  bindingPreflight,
  chainPreflight,
  buildFreshArtifact,
  writePrepareArtifact,
  prepareArtifactFilename,
} from "../scripts/prepare-artifact-guard"

const ZERO = "0x0000000000000000000000000000000000000000"
const A_BRIDGE = "0x2220acE07d86B508742D511478e517716B675940"
const A_IMPL = "0x2DB8355295C5f09da68Cf35A318F7209d90c0640"
const A_ROUTER = "0xd8F192488c6B2AF29c6E0a02040E68F87B9d5EAA"
const A_VAULT = "0x222C73bc1440b97876B64C3F34077904deF93714"
const A_GOV = "0xfb5C050a969921b882b9EB151a8862Bf56D5cBE0"
const A_PROXY_ADMIN = "0x0E9bD483CC8Fb649636e0cd7a60BC48b6C040103"
const A_DEPLOYER = "0xb9B8a92677fcad86dc8d36fe947184283B03b3C8"

function liveArtifact(
  overrides: {
    addresses?: Partial<Record<AddressKey, string | null>>
    chainId?: number
    bridge?: string | null
    network?: string
  } = {}
): ParsedPrepareArtifact {
  return {
    schemaVersion: PREPARE_ARTIFACT_SCHEMA_VERSION,
    mode: "live",
    network: overrides.network ?? "sepolia",
    phase: "prepare",
    startBlock: 11884979,
    forkBlock: null,
    activationBlock: 0,
    runAt: "2026-10-10T00:00:00.000Z",
    binding: {
      chainId: overrides.chainId ?? SEPOLIA_CHAIN_ID,
      bridge: overrides.bridge ?? A_BRIDGE,
      forkBlock: null,
    },
    addresses: {
      bridge: A_BRIDGE,
      oldGov: null,
      oldImpl: null,
      newImpl: A_IMPL,
      newGov: A_GOV,
      router: A_ROUTER,
      vault: A_VAULT,
      proxyAdmin: A_PROXY_ADMIN,
      deployer: A_DEPLOYER,
      ...overrides.addresses,
    },
    steps: [],
  }
}

function forkArtifact(): ParsedPrepareArtifact {
  return {
    ...liveArtifact(),
    schemaVersion: PREPARE_ARTIFACT_SCHEMA_VERSION,
    mode: "fork",
    network: "hardhat",
    forkBlock: 11883858,
    binding: { chainId: null, bridge: null, forkBlock: 11883858 },
  }
}

function writeSet(
  dir: string,
  files: Record<string, string | ParsedPrepareArtifact>,
  mtimesMs?: Record<string, number>
): void {
  Object.entries(files).forEach(([name, content]) => {
    const p = path.join(dir, name)
    const body = typeof content === "string" ? content : JSON.stringify(content)
    fs.writeFileSync(p, `${body}\n`)
    const m = mtimesMs?.[name]
    if (m) fs.utimesSync(p, new Date(m), new Date(m + 1000))
  })
}

describe("prepare-artifact-guard", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-artifacts-"))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  describe("isAddressOrAbsent", () => {
    it("accepts a null or a checksum-compatible 0x address", () => {
      expect(isAddressOrAbsent(null)).to.be.true
      expect(isAddressOrAbsent(A_BRIDGE)).to.be.true
      expect(isAddressOrAbsent(`0x${"ab".repeat(20)}`)).to.be.true
    })

    it("rejects truncated, non-hex and missing addresses", () => {
      expect(isAddressOrAbsent("0xabc")).to.be.false
      expect(isAddressOrAbsent("abc")).to.be.false
      expect(isAddressOrAbsent("0xzz".padEnd(42, "0"))).to.be.false
      expect(isAddressOrAbsent("")).to.be.false
      expect(isAddressOrAbsent(42)).to.be.false
    })

    it("rejects the all-zero address when rejectZeros is set", () => {
      expect(isAddressOrAbsent(ZERO)).to.be.true
      expect(isAddressOrAbsent(ZERO, true)).to.be.false
      expect(isAddressOrAbsent(null, true)).to.be.true
    })
  })

  describe("parsePrepareArtifact", () => {
    it("parses a well-formed live artifact", () => {
      const json = JSON.stringify(liveArtifact())
      const parsed = parsePrepareArtifact(json)
      expect(parsed.ok).to.be.true
      if (parsed.ok) expect(parsed.value.addresses.newImpl).to.equal(A_IMPL)
    })

    it("rejects malformed JSON and truncated address payloads", () => {
      expect(parsePrepareArtifact("{nope").ok).to.be.false
      const badAddr = JSON.stringify(
        liveArtifact({ addresses: { newImpl: "0x123" } })
      )
      const truncated = parsePrepareArtifact(badAddr)
      expect(truncated.ok).to.be.false
      if (!truncated.ok)
        expect(truncated.reason).to.match(/addresses|malformed/i)
      const zeroArtifact = JSON.stringify(
        liveArtifact({ addresses: { vault: ZERO } })
      )
      const zeroOk = parsePrepareArtifact(zeroArtifact, true)
      expect(zeroOk.ok).to.be.false
    })

    it("rejects old JSON that carries no binding metadata", () => {
      const legacy = JSON.stringify(
        {
          mode: "live",
          network: "sepolia",
          phase: "prepare",
          startBlock: 11884979,
          activationBlock: 0,
          addresses: liveArtifact().addresses,
          steps: [],
        },
        null,
        2
      )
      const parsed = parsePrepareArtifact(legacy)
      expect(parsed.ok).to.be.false
      if (!parsed.ok) expect(parsed.reason).to.match(/binding/i)
    })

    it("rejects a missing or shape-wrong binding", () => {
      const raw: unknown = JSON.parse(JSON.stringify(liveArtifact()))
      const stripped = Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(
          ([k]) => k !== "binding"
        )
      )
      expect(parsePrepareArtifact(JSON.stringify(stripped)).ok).to.be.false
      const wrongChainType = JSON.stringify(liveArtifact({ chainId: 0 }))
      const parsed = parsePrepareArtifact(wrongChainType)
      expect(parsed.ok).to.be.false
      if (!parsed.ok) expect(parsed.reason).to.match(/binding/i)
    })
  })

  describe("selectPrepareArtifact", () => {
    const liveCtx = {
      live: true,
      networkName: "sepolia",
      chainId: SEPOLIA_CHAIN_ID,
      forkBlock: 11883858,
      bridge: A_BRIDGE,
    }

    it("prefers a valid complete artifact over a newer empty one", () => {
      // "complete" = all four deployed addresses present (hasAllDeployedAddresses=true)
      // "empty" = all four deployed addresses null (hasAllDeployedAddresses=false)
      const empty = liveArtifact({
        addresses: {
          newImpl: null,
          router: null,
          vault: null,
          newGov: null,
        },
      })
      writeSet(
        dir,
        {
          "reservations-sepolia-rehearsal-sepolia-100.json": liveArtifact(),
          "reservations-sepolia-rehearsal-sepolia-200.json": empty,
        },
        {
          "reservations-sepolia-rehearsal-sepolia-100.json": 1000,
          "reservations-sepolia-rehearsal-sepolia-200.json": 2000,
        }
      )
      const selected = selectPrepareArtifact(dir, liveCtx, {
        requireComplete: false,
      })
      expect(selected.kind).to.equal("selected")
      if (selected.kind === "selected")
        expect(selected.candidate.file).to.equal(
          "reservations-sepolia-rehearsal-sepolia-100.json"
        )
    })

    it("resumes a valid complete artifact from an interrupted run", () => {
      // Complete artifact: all deployed addresses set, interrupted mid-steps
      const complete = liveArtifact()
      writeSet(dir, {
        "reservations-sepolia-rehearsal-sepolia-100.json": complete,
      })
      const selected = selectPrepareArtifact(dir, liveCtx, {
        requireComplete: false,
      })
      expect(selected.kind).to.equal("selected")
      if (selected.kind === "selected") {
        expect(selected.candidate.state).to.equal("partial")
        expect(selected.candidate.artifact?.addresses.router).to.equal(A_ROUTER)
      }
    })

    it("rejects when a malformed live file is present instead of redeploying", () => {
      writeSet(dir, {
        "reservations-sepolia-rehearsal-sepolia-100.json":
          '{"schemaVersion":2,"binding":{bad',
        "reservations-sepolia-rehearsal-sepolia-200.json": liveArtifact(),
      })
      const result = selectPrepareArtifact(dir, liveCtx, {
        requireComplete: false,
      })
      expect(result.kind).to.equal("rejected")
      if (result.kind === "rejected")
        expect(result.reason).to.include(
          "reservations-sepolia-rehearsal-sepolia-100.json"
        )
    })

    it("rejects an old (unbound) live artifact mixed with a valid one", () => {
      const legacy = JSON.stringify({
        addresses: liveArtifact().addresses,
      })
      writeSet(dir, {
        "reservations-sepolia-rehearsal-sepolia-100.json": legacy,
        "reservations-sepolia-rehearsal-sepolia-200.json": liveArtifact(),
      })
      const result = selectPrepareArtifact(dir, liveCtx, {
        requireComplete: false,
      })
      expect(result.kind).to.equal("rejected")
      if (result.kind === "rejected")
        expect(result.reason).to.include("no longer accepted")
    })

    it("returns none when no artifact exists, and only deployed ones for activate", () => {
      expect(
        selectPrepareArtifact(dir, liveCtx, {
          requireComplete: true,
        }).kind
      ).to.equal("none")
      const empty = liveArtifact({
        addresses: {
          newImpl: null,
          router: null,
          vault: null,
          newGov: null,
          oldImpl: null,
        },
      })
      writeSet(dir, {
        "reservations-sepolia-rehearsal-sepolia-100.json": empty,
      })
      expect(
        selectPrepareArtifact(dir, liveCtx, {
          requireComplete: true,
        }).kind
      ).to.equal("none")
    })

    it("cannot use a fork artifact for activate on the live set", () => {
      writeSet(dir, {
        "reservations-sepolia-rehearsal-sepolia-100.json": liveArtifact(),
      })
      const forkCtx = {
        live: false,
        networkName: "hardhat",
        chainId: null,
        forkBlock: 11883858,
        bridge: "",
      }
      writeSet(dir, {
        "reservations-sepolia-rehearsal-11883858.json": forkArtifact(),
      })
      const forkResult = selectPrepareArtifact(dir, forkCtx, {
        requireComplete: true,
      })
      expect(forkResult.kind).to.equal("selected")
      if (forkResult.kind === "selected") {
        const mismatch = bindingMismatch(
          forkResult.candidate.artifact!,
          liveCtx
        )
        expect(mismatch).to.match(/mode|hardhat/)
      }
    })
  })

  describe("bindingMismatch", () => {
    const liveCtx = {
      live: true,
      networkName: "sepolia",
      chainId: SEPOLIA_CHAIN_ID,
      forkBlock: 11883858,
      bridge: A_BRIDGE,
    }
    const forkCtx = {
      live: false,
      networkName: "hardhat",
      chainId: null,
      forkBlock: 11883858,
      bridge: "",
    }

    it("accepts a matching live artifact", () => {
      expect(bindingMismatch(liveArtifact(), liveCtx)).to.be.null
    })

    it("rejects the wrong chain id", () => {
      expect(bindingMismatch(liveArtifact({ chainId: 1 }), liveCtx)).to.match(
        /chainId 1 does not match/
      )
    })

    it("rejects a different Bridge proxy", () => {
      const other = "0x3210acE07d86B508742D511478e517716B675940"
      expect(
        bindingMismatch(liveArtifact({ bridge: other }), liveCtx)
      ).to.match(/binding bridge/)
    })

    it("rejects the rehearsal-node artifact on the Sepolia key network", () => {
      const rehearsalNode = liveArtifact({
        chainId: REHEARSAL_CHAIN_ID,
        network: "rehearsal",
      })
      expect(bindingMismatch(rehearsalNode, liveCtx)).to.match(
        /chainId|network/
      )
    })

    it("rejects a fork artifact in a live context and vice versa", () => {
      expect(bindingMismatch(forkArtifact(), liveCtx)).to.match(
        /artifact mode is fork/
      )
      expect(bindingMismatch(liveArtifact(), forkCtx)).to.match(
        /artifact mode is live/
      )
    })

    it("rejects a fork artifact pinned to a different block", () => {
      const shifted = forkArtifact()
      shifted.binding = { chainId: null, bridge: null, forkBlock: 999 }
      expect(bindingMismatch(shifted, forkCtx)).to.match(
        /forkBlock 999 != pinned 11883858/
      )
    })
  })

  describe("chainPreflight", () => {
    it("passes the supported combinations", () => {
      expect(chainPreflight("sepolia", SEPOLIA_CHAIN_ID, true)).to.be.null
      expect(chainPreflight("rehearsal", REHEARSAL_CHAIN_ID, true)).to.be.null
      expect(chainPreflight("hardhat", REHEARSAL_CHAIN_ID, false)).to.be.null
    })

    it("fails a wrong chain before any signer is involved", () => {
      expect(chainPreflight("sepolia", 1, true)).to.match(/not Sepolia/)
      expect(chainPreflight("sepolia", REHEARSAL_CHAIN_ID, true)).to.match(
        /not Sepolia/
      )
      expect(chainPreflight("rehearsal", SEPOLIA_CHAIN_ID, true)).to.match(
        /not 31337/
      )
      expect(chainPreflight("mainnet", SEPOLIA_CHAIN_ID, true)).to.match(
        /not a supported live network/
      )
      expect(chainPreflight("hardhat", 1, false)).to.match(/not 31337/)
      expect(chainPreflight("hardhat", SEPOLIA_CHAIN_ID, false)).to.match(
        /not 31337/
      )
    })
  })

  describe("bindingPreflight", () => {
    it("passes a matching live artifact", () => {
      expect(
        bindingPreflight(liveArtifact(), {
          live: true,
          networkName: "sepolia",
          chainId: SEPOLIA_CHAIN_ID,
          forkBlock: 11883858,
        })
      ).to.be.null
    })

    it("rejects a sepolia artifact on a rehearsal context", () => {
      expect(
        bindingPreflight(liveArtifact(), {
          live: true,
          networkName: "rehearsal",
          chainId: REHEARSAL_CHAIN_ID,
          forkBlock: 11883858,
        })
      ).to.match(/chainId|network/)
    })

    it("rejects a rehearsal-node artifact on a sepolia context", () => {
      expect(
        bindingPreflight(
          liveArtifact({ network: "rehearsal", chainId: REHEARSAL_CHAIN_ID }),
          {
            live: true,
            networkName: "sepolia",
            chainId: SEPOLIA_CHAIN_ID,
            forkBlock: 11883858,
          }
        )
      ).to.match(/chainId|network/)
    })

    it("rejects a fork artifact in a live context", () => {
      expect(
        bindingPreflight(forkArtifact(), {
          live: true,
          networkName: "sepolia",
          chainId: SEPOLIA_CHAIN_ID,
          forkBlock: 11883858,
        })
      ).to.match(/artifact mode is fork/)
    })
  })

  describe("writePrepareArtifact", () => {
    it("round-trips through parse", () => {
      const artifact = liveArtifact()
      const file = path.join(dir, "roundtrip.json")
      writePrepareArtifact(file, artifact)
      const raw = fs.readFileSync(file, "utf8")
      const parsed = parsePrepareArtifact(raw)
      expect(parsed.ok).to.be.true
      if (parsed.ok) {
        expect(parsed.value.addresses.router).to.equal(A_ROUTER)
        expect(hasAllDeployedAddresses(parsed.value)).to.be.true
      }
    })

    it("overwrites an existing file atomically", () => {
      const artifact = liveArtifact()
      const file = path.join(dir, "atomic.json")
      fs.writeFileSync(file, "placeholder")
      writePrepareArtifact(file, artifact)
      const raw = fs.readFileSync(file, "utf8")
      const parsed = parsePrepareArtifact(raw)
      expect(parsed.ok).to.be.true
      expect(raw).not.to.include("placeholder")
    })
  })

  describe("prepareArtifactFilename", () => {
    it("builds a live filename from network and startBlock", () => {
      const name = prepareArtifactFilename(
        { live: true, networkName: "sepolia", forkBlock: 0 },
        "rehearsal",
        11884979
      )
      expect(name).to.equal(
        "reservations-sepolia-rehearsal-sepolia-11884979.json"
      )
    })

    it("builds a fork filename from the pinned block", () => {
      const name = prepareArtifactFilename(
        { live: false, networkName: "hardhat", forkBlock: 11883858 },
        "rehearsal",
        0
      )
      expect(name).to.equal("reservations-sepolia-rehearsal-11883858.json")
    })
  })

  describe("buildFreshArtifact", () => {
    it("produces a round-trip parseable artifact", () => {
      const fresh = buildFreshArtifact({
        live: true,
        networkName: "sepolia",
        phase: "prepare",
        startBlock: 11884979,
        activationBlock: 0,
        chainId: SEPOLIA_CHAIN_ID,
        bridge: A_BRIDGE,
        forkBlock: null,
        addresses: {
          bridge: A_BRIDGE,
          oldGov: null,
          oldImpl: null,
          newImpl: null,
          newGov: null,
          router: null,
          vault: null,
          proxyAdmin: A_PROXY_ADMIN,
          deployer: A_DEPLOYER,
        },
      })
      const parsed = parsePrepareArtifact(JSON.stringify(fresh))
      expect(parsed.ok).to.be.true
      if (parsed.ok) {
        // All four deployed addresses are null in a fresh artifact.
        expect(hasAllDeployedAddresses(parsed.value)).to.be.false
        // Addresses object is preserved through the round-trip.
        expect(parsed.value.addresses.newImpl).to.be.null
        expect(parsed.value.addresses.router).to.be.null
        expect(
          prepareArtifactFiles("/nonexistent", {
            live: true,
            networkName: "sepolia",
            chainId: SEPOLIA_CHAIN_ID,
            forkBlock: 11883858,
            bridge: A_BRIDGE,
          })
        ).to.deep.equal([])
      }
    })
  })
})
