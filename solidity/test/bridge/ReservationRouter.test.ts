import { artifacts, ethers, helpers, waffle } from "hardhat"
import { expect } from "chai"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import * as fs from "fs"
import * as path from "path"
import { getStorageUpgradeErrors } from "@openzeppelin/upgrades-core"
import { normalizeValidationData } from "@openzeppelin/upgrades-core/dist/validate/data"
import type { ValidationData } from "@openzeppelin/upgrades-core/dist/validate/data"
import { unfoldStorageLayout } from "@openzeppelin/upgrades-core/dist/validate/query"
import type { StorageLayout as OZStorageLayout } from "@openzeppelin/upgrades-core/dist/storage/layout"

import bridgeFixture from "../fixtures/bridge"
import type { Bridge, BridgeStub, ReservationRouter } from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

/**
 * Storage layout entry as reported by solc's `storageLayout` output.
 */
type StorageEntry = {
  label: string
  offset: number
  slot: string
  type: string
}

type StorageLayout = {
  storage: StorageEntry[]
  types: Record<
    string,
    {
      label: string
      encoding: string
      numberOfBytes: string
      members?: StorageEntry[]
      key?: string
      value?: string
      base?: string
    }
  >
}

async function getStorageLayout(
  sourceName: string,
  contractName: string
): Promise<StorageLayout> {
  const buildInfo = await artifacts.getBuildInfo(
    `${sourceName}:${contractName}`
  )
  if (!buildInfo) {
    throw new Error(`No build info for ${sourceName}:${contractName}`)
  }
  const layout = (
    buildInfo.output.contracts[sourceName][contractName] as {
      storageLayout?: StorageLayout
    }
  ).storageLayout
  if (!layout) {
    throw new Error(
      `No storage layout for ${sourceName}:${contractName}; ` +
        "is the storageLayout output selection enabled?"
    )
  }
  return layout
}

/**
 * Produces a compilation-independent canonical description of a storage
 * type: solc type identifiers embed AST ids (e.g.
 * `t_struct(Storage)12345_storage`) that differ between compilation units,
 * so the identifiers are normalized and struct members are expanded
 * recursively.
 */
function canonicalType(
  typeId: string,
  types: StorageLayout["types"],
  seen: Set<string> = new Set()
): unknown {
  const normalized = typeId.replace(/\)\d+/g, ")")
  if (seen.has(typeId)) {
    return normalized
  }
  seen.add(typeId)

  const type = types[typeId]
  if (!type) {
    return normalized
  }

  const result: Record<string, unknown> = {
    id: normalized,
    encoding: type.encoding,
    numberOfBytes: type.numberOfBytes,
  }
  if (type.members) {
    result.members = type.members.map((member) => ({
      label: member.label,
      slot: member.slot,
      offset: member.offset,
      type: canonicalType(member.type, types, seen),
    }))
  }
  if (type.key) {
    result.key = canonicalType(type.key, types, seen)
  }
  if (type.value) {
    result.value = canonicalType(type.value, types, seen)
  }
  if (type.base) {
    result.base = canonicalType(type.base, types, seen)
  }
  return result
}

function canonicalLayout(layout: StorageLayout): unknown {
  return layout.storage.map((entry) => ({
    label: entry.label,
    slot: entry.slot,
    offset: entry.offset,
    type: canonicalType(entry.type, layout.types),
  }))
}

describe("ReservationRouter", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let deployer: SignerWithAddress
  let bridge: Bridge & BridgeStub & ReservationRouter
  let deployBridge: (
    txProofDifficultyFactor: number,
    wireReservationRouter?: boolean
  ) => Promise<any>
  let routerAddress: string

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, deployer, bridge, deployBridge } =
      await waffle.loadFixture(bridgeFixture))

    routerAddress = (await helpers.contracts.getContract("ReservationRouter"))
      .address
  })

  describe("storage layout parity", () => {
    it("should pass the OpenZeppelin upgrade check from the deployed Bridge gap", () => {
      const validations = normalizeValidationData(
        JSON.parse(
          fs.readFileSync(
            path.resolve(__dirname, "../../cache/validations.json"),
            "utf8"
          )
        ) as ValidationData
      )

      const currentLayout = validations.log.reduce<OZStorageLayout | undefined>(
        (matchingLayout, run) => {
          if (!run.Bridge) return matchingLayout

          const candidate = unfoldStorageLayout(run, "Bridge")
          const selfEntry = candidate.storage.find(
            (entry) => entry.label === "self"
          )
          if (!selfEntry) return matchingLayout

          const members = candidate.types[selfEntry.type].members as
            | StorageEntry[]
            | undefined
          return members?.some((member) => member.label === "reservedDeposits")
            ? candidate
            : matchingLayout
        },
        undefined
      )

      expect(currentLayout, "compiled Bridge validation layout").not.to.be
        .undefined

      const selfEntry = currentLayout!.storage.find(
        (entry) => entry.label === "self"
      )!
      const members = currentLayout!.types[selfEntry.type]
        .members as StorageEntry[]
      const rebateStakingIndex = members.findIndex(
        (member) => member.label === "rebateStaking"
      )
      expect(rebateStakingIndex).to.be.greaterThan(-1)

      const currentGap = members.find((member) => member.label === "__gap")!
      expect(currentGap.slot).to.equal("39")
      expect(currentLayout!.types[currentGap.type].label).to.equal(
        "uint256[39]"
      )

      const asStorageItem = (entry: StorageEntry) => ({
        ...entry,
        contract: "Bridge",
        src: "compiled-layout",
      })
      const legacyGap = {
        label: "__gap",
        slot: "30",
        offset: 0,
        type: "t_array(t_uint256)48_storage",
        contract: "Bridge",
        src: "deployed-layout",
      }
      const legacyTypes = {
        ...currentLayout!.types,
        [legacyGap.type]: {
          label: "uint256[48]",
          numberOfBytes: "1536",
        },
      }

      const errors = getStorageUpgradeErrors(
        {
          storage: [
            ...members.slice(0, rebateStakingIndex + 1).map(asStorageItem),
            legacyGap,
          ],
          types: legacyTypes,
        },
        {
          storage: members.map(asStorageItem),
          types: currentLayout!.types,
        }
      )

      expect(errors).to.deep.equal([])
    })

    it("should give the router the exact storage layout of the Bridge", async () => {
      const bridgeLayout = await getStorageLayout(
        "contracts/bridge/Bridge.sol",
        "Bridge"
      )
      const routerLayout = await getStorageLayout(
        "contracts/bridge/ReservationRouter.sol",
        "ReservationRouter"
      )

      // Every storage variable reachable by router code must live at the
      // same slot/offset and have the same canonical type as in the Bridge.
      // The Bridge and the router are compiled in different compilation
      // units, hence the comparison of canonicalized layouts rather than
      // raw solc output.
      expect(canonicalLayout(routerLayout)).to.deep.equal(
        canonicalLayout(bridgeLayout)
      )
    })

    it("should keep the BridgeStub used in tests layout-compatible", async () => {
      const bridgeLayout = await getStorageLayout(
        "contracts/bridge/Bridge.sol",
        "Bridge"
      )
      const stubLayout = await getStorageLayout(
        "contracts/test/BridgeStub.sol",
        "BridgeStub"
      )

      // The stub may append storage after the Bridge's own variables but
      // must never alter the shared prefix.
      const prefix = stubLayout.storage.slice(0, bridgeLayout.storage.length)
      expect(
        canonicalLayout({ storage: prefix, types: stubLayout.types })
      ).to.deep.equal(canonicalLayout(bridgeLayout))
    })
  })

  describe("selector disjointness", () => {
    it("should not shadow any router function with a Bridge function", async () => {
      const bridgeArtifact = await artifacts.readArtifact("Bridge")
      const routerArtifact = await artifacts.readArtifact("ReservationRouter")

      const bridgeInterface = new ethers.utils.Interface(bridgeArtifact.abi)
      const routerInterface = new ethers.utils.Interface(routerArtifact.abi)

      const bridgeSelectors = new Set(
        Object.values(bridgeInterface.functions).map((fragment) =>
          bridgeInterface.getSighash(fragment)
        )
      )

      const shadowed = Object.values(routerInterface.functions).filter(
        (fragment) => bridgeSelectors.has(routerInterface.getSighash(fragment))
      )

      // The `Governable` base is inherited by both contracts for storage
      // parity, so its two members are declared on both sides with
      // identical semantics. The Bridge's own copies win and the router's
      // are unreachable, which is exactly the intent. Anything else
      // overlapping means a router function is silently unreachable.
      const knownIdenticalInherited = new Set([
        "governance()",
        "transferGovernance(address)",
      ])

      expect(
        shadowed
          .map((fragment) => fragment.format())
          .filter((signature) => !knownIdenticalInherited.has(signature)),
        "router functions unreachable behind identical Bridge selectors"
      ).to.be.empty
    })
  })

  describe("setReservationRouter", () => {
    context("when called on a bridge with the router already set", () => {
      it("should revert", async () => {
        // A fresh bridge is governed by the deployer (the main bridge's
        // governance was transferred to the BridgeGovernance contract by
        // the deployment scripts).
        const [freshBridge] = await deployBridge(1)
        await expect(
          freshBridge.connect(deployer).setReservationRouter(routerAddress)
        ).to.be.revertedWith("Reservation router already set")
      })
    })

    context("when called by a third party on a fresh bridge", () => {
      it("should revert", async () => {
        const [freshBridge] = await deployBridge(1, false)
        await expect(
          freshBridge.connect(thirdParty).setReservationRouter(routerAddress)
        ).to.be.revertedWith("Caller is not the governance")
      })
    })

    context("when called with the zero address", () => {
      it("should revert", async () => {
        const [freshBridge] = await deployBridge(1, false)
        await expect(
          freshBridge
            .connect(deployer)
            .setReservationRouter(ethers.constants.AddressZero)
        ).to.be.revertedWith("Reservation router address must not be 0x0")
      })
    })

    context("when called by the governance on a fresh bridge", () => {
      it("should set the router and emit ReservationRouterSet", async () => {
        const [freshBridge] = await deployBridge(1, false)
        const tx = await freshBridge
          .connect(deployer)
          .setReservationRouter(routerAddress)

        // The event is declared in the BridgeState library; resolve it
        // through the router-merged interface of the main bridge handle.
        await expect(tx)
          .to.emit(bridge.attach(freshBridge.address), "ReservationRouterSet")
          .withArgs(routerAddress)

        expect(
          await bridge.attach(freshBridge.address).reservationRouter()
        ).to.equal(routerAddress)
      })
    })
  })

  describe("fallback routing", () => {
    context("before the router is set", () => {
      it("should revert reservation calls with a clear error", async () => {
        const [freshBridge] = await deployBridge(1, false)
        const routed = bridge.attach(freshBridge.address)
        await expect(routed.reservationParameters()).to.be.revertedWith(
          "Unknown function"
        )
      })
    })

    context("after the router is set", () => {
      it("should serve the reservation surface at the Bridge address", async () => {
        // The fixture wires the router, so the reservation views must
        // resolve through the fallback and read Bridge storage.
        expect(await bridge.reservationRouter()).to.equal(routerAddress)

        const params = await bridge.reservationParameters()
        expect(params.reservationVault).to.be.properAddress
      })

      it("should revert unknown selectors without executing anything", async () => {
        await createSnapshot()
        try {
          await expect(
            thirdParty.sendTransaction({
              to: bridge.address,
              data: "0xdeadbeef",
            })
          ).to.be.reverted
        } finally {
          await restoreSnapshot()
        }
      })

      it("should not accept plain value transfers", async () => {
        await expect(
          thirdParty.sendTransaction({
            to: bridge.address,
            value: 1,
          })
        ).to.be.reverted
      })
    })
  })

  describe("standalone router hardening", () => {
    let standaloneRouter: ReservationRouter

    before(async () => {
      standaloneRouter = (await ethers.getContractAt(
        "ReservationRouter",
        routerAddress
      )) as ReservationRouter
    })

    it("should have empty storage of its own", async () => {
      // Direct calls execute on the router's own storage where nothing has
      // ever been initialized.
      expect(await standaloneRouter.reservationRouter()).to.equal(
        ethers.constants.AddressZero
      )
      const params = await standaloneRouter.reservationParameters()
      expect(params.reservationVault).to.equal(ethers.constants.AddressZero)
    })

    it("should reject state-changing calls made directly", async () => {
      await expect(
        standaloneRouter
          .connect(thirdParty)
          .updateReservationParameters(
            ethers.constants.AddressZero,
            1000000,
            10000,
            31536000,
            2592000,
            100000000000,
            10,
            172800
          )
      ).to.be.revertedWith("Caller is not the governance")

      await expect(
        standaloneRouter.connect(thirdParty).extendReservation(1)
      ).to.be.revertedWith("Caller is not the reservation vault")

      await expect(
        standaloneRouter
          .connect(thirdParty)
          .requestReservedRedemption(
            1,
            thirdParty.address,
            "0x1600144b47c798",
            true,
            false
          )
      ).to.be.revertedWith("Caller is not the reservation vault")

      await expect(
        standaloneRouter.connect(thirdParty).notifyReservedRedemptionVeto(1, 1)
      ).to.be.revertedWith("Caller is not the redemption watchtower")

      await expect(
        standaloneRouter
          .connect(thirdParty)
          .requestReservationAcceptance(
            1,
            "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
          )
      ).to.be.revertedWith("Reservations are disabled")
    })
  })
})
