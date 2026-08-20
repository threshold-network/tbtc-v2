import { artifacts, ethers, helpers, waffle } from "hardhat"
import { expect } from "chai"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

import bridgeFixture from "../fixtures/bridge"
import reservationRouterStorageLayoutSnapshot from "../fixtures/reservation-router-storage-layout.snapshot.json"
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

    it("should match the storage layout snapshot pinned when the router was introduced", async () => {
      // The other two tests in this block compare the router against
      // Bridge/BridgeStub freshly recompiled from the SAME commit, so they
      // can't detect drift between the deployed, immutable router (it can
      // never be redeployed post-deployment -- replacing router code
      // requires a Bridge implementation upgrade instead, see invariant 4)
      // and a `BridgeState.Storage` that keeps evolving in later PRs. A
      // later PR could violate the append-only storage policy and this
      // in-commit comparison would still trivially pass, since both sides
      // would recompile from the same (already-drifted) source.
      //
      // No mainnet deployment of the router exists yet to pin against (see
      // `Bridge.StorageLayout.test.ts`, which compares against a real
      // deployment artifact for exactly this reason). This checked-in
      // snapshot, captured at the commit that introduces the router, is
      // the closest available proxy: from this PR's merge onward the
      // router's storage expectations are permanently fixed, so pinning
      // against a frozen baseline now is equivalent in spirit and starts
      // enforcing the invariant immediately rather than only after the
      // first real deployment.
      const routerLayout = await getStorageLayout(
        "contracts/bridge/ReservationRouter.sol",
        "ReservationRouter"
      )

      expect(canonicalLayout(routerLayout)).to.deep.equal(
        reservationRouterStorageLayoutSnapshot
      )
    })
  })

  describe("selector disjointness", () => {
    // The `Governable` base is inherited by both contracts for storage
    // parity, so its two members are declared on both sides with
    // identical semantics. The Bridge's own copies win and the router's
    // are unreachable, which is exactly the intent. Anything else
    // overlapping means a router function is silently unreachable.
    const knownIdenticalInherited = new Set([
      "governance()",
      "transferGovernance(address)",
    ])

    async function assertNoShadowedRouterFunctions(
      bridgeSideContractName: string
    ) {
      const bridgeArtifact = await artifacts.readArtifact(
        bridgeSideContractName
      )
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

      expect(
        shadowed
          .map((fragment) => fragment.format())
          .filter((signature) => !knownIdenticalInherited.has(signature)),
        "router functions unreachable behind identical Bridge selectors"
      ).to.be.empty
    }

    it("should not shadow any router function with a Bridge function", async () => {
      await assertNoShadowedRouterFunctions("Bridge")
    })

    // The fixture wires the router onto `BridgeStub` (which adds test-only
    // externals on top of `Bridge`), not the plain `Bridge` contract -- a
    // stub-only selector collision would silently shadow the router path
    // there with none of the reservation tests failing, since they all run
    // against the stub. Guard the fixture's actual wiring target too.
    it("should not shadow any router function with a BridgeStub function", async () => {
      await assertNoShadowedRouterFunctions("BridgeStub")
    })
  })

  describe("event declaration parity with the Reservation library", () => {
    it("should keep every re-declared event identical to its Reservation library counterpart", async () => {
      // The router re-declares every event the `Reservation` library emits
      // (library events aren't part of any contract ABI under solc 0.8.17,
      // so the router -- the ABI home of the reservation surface --
      // declares its own copy for off-chain consumers). Drive the
      // comparison from the library side: the router ABI also carries
      // events with no library counterpart by design (`GovernanceTransferred`
      // and `Initialized` from its `Governable`/`Initializable` bases,
      // `ReservationRouterSet` declared in `BridgeState` instead).
      const routerArtifact = await artifacts.readArtifact("ReservationRouter")
      const reservationArtifact = await artifacts.readArtifact("Reservation")

      const routerInterface = new ethers.utils.Interface(routerArtifact.abi)
      const reservationInterface = new ethers.utils.Interface(
        reservationArtifact.abi
      )

      const routerEventsByName = new Map(
        Object.values(routerInterface.events).map((fragment) => [
          fragment.name,
          fragment,
        ])
      )

      const reservationEvents = Object.values(reservationInterface.events)
      expect(reservationEvents).to.not.be.empty

      reservationEvents.forEach((reservationEvent) => {
        const routerEvent = routerEventsByName.get(reservationEvent.name)
        expect(
          routerEvent,
          `ReservationRouter has no re-declared counterpart for ${reservationEvent.name}`
        ).to.not.be.undefined
        // Comparing the sighash-format string (name + parameter types, no
        // `indexed` info) catches added/removed/reordered/retyped fields;
        // comparing the full format additionally catches a mismatched
        // `indexed` flag, which changes the event's topic layout without
        // changing topic0.
        expect(
          routerInterface.getEventTopic(routerEvent!),
          `${reservationEvent.name} topic0 diverged from the Reservation library`
        ).to.equal(reservationInterface.getEventTopic(reservationEvent))
        expect(
          routerEvent!.format(),
          `${reservationEvent.name} indexed-field layout diverged from the Reservation library`
        ).to.equal(reservationEvent.format())
      })
    })
  })

  describe("IReservationBridge / IReservationBridgeGovernance conformance", () => {
    it("should implement every interface member with an identical signature", async () => {
      // The router does not (and cannot) declare `is IReservationBridge` --
      // it doesn't implement `treasury()`, which is the Bridge's own field,
      // included in the interface only so consumers can use one handle
      // against the Bridge address. A signature drift would otherwise
      // compile cleanly and only fail at runtime as a bare fallback revert.
      const routerArtifact = await artifacts.readArtifact("ReservationRouter")
      const governanceInterfaceArtifact = await artifacts.readArtifact(
        "IReservationBridgeGovernance"
      )

      const routerInterface = new ethers.utils.Interface(routerArtifact.abi)
      const governanceInterface = new ethers.utils.Interface(
        governanceInterfaceArtifact.abi
      )

      const routerSignaturesByName = new Map(
        Object.values(routerInterface.functions).map((fragment) => [
          fragment.name,
          fragment,
        ])
      )

      Object.values(governanceInterface.functions)
        .filter((fragment) => fragment.name !== "treasury")
        .forEach((interfaceFragment) => {
          const routerFragment = routerSignaturesByName.get(
            interfaceFragment.name
          )
          expect(
            routerFragment,
            `ReservationRouter has no member for ${interfaceFragment.name}`
          ).to.not.be.undefined
          expect(
            routerInterface.getSighash(routerFragment!),
            `${interfaceFragment.name} selector diverged from IReservationBridgeGovernance`
          ).to.equal(governanceInterface.getSighash(interfaceFragment))
        })
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

        await freshBridge.connect(deployer).setReservationRouter(routerAddress)
        expect(
          await bridge.attach(freshBridge.address).reservationRouter()
        ).to.equal(routerAddress)
      })
    })

    context("when called with an EOA", () => {
      it("should revert without consuming the one-time slot", async () => {
        const [freshBridge] = await deployBridge(1, false)

        await expect(
          freshBridge.connect(deployer).setReservationRouter(thirdParty.address)
        ).to.be.revertedWith("Reservation router must be a contract")

        await freshBridge.connect(deployer).setReservationRouter(routerAddress)
        expect(
          await bridge.attach(freshBridge.address).reservationRouter()
        ).to.equal(routerAddress)
      })
    })

    context("when called with a not-yet-deployed address", () => {
      it("should revert without consuming the one-time slot", async () => {
        const [freshBridge] = await deployBridge(1, false)
        const notYetDeployedAddress = ethers.utils.getContractAddress({
          from: thirdParty.address,
          nonce: await thirdParty.getTransactionCount(),
        })

        expect(await ethers.provider.getCode(notYetDeployedAddress)).to.equal(
          "0x"
        )
        await expect(
          freshBridge
            .connect(deployer)
            .setReservationRouter(notYetDeployedAddress)
        ).to.be.revertedWith("Reservation router must be a contract")
        expect(await ethers.provider.getCode(notYetDeployedAddress)).to.equal(
          "0x"
        )
        expect(
          ethers.utils.getContractAddress({
            from: thirdParty.address,
            nonce: await thirdParty.getTransactionCount(),
          })
        ).to.equal(notYetDeployedAddress)

        await freshBridge.connect(deployer).setReservationRouter(routerAddress)
        expect(
          await bridge.attach(freshBridge.address).reservationRouter()
        ).to.equal(routerAddress)
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

        await expect(
          freshBridge.connect(deployer).setReservationRouter(routerAddress)
        ).to.be.revertedWith("Reservation router already set")
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

    context("delegatecall dispatch overhead", () => {
      it("should log the fixed per-call overhead of the fallback hop over a direct router call", async () => {
        // Quantifies the PR's own "0-8 gas measured hot-path diff" claim,
        // which is scoped to the Bridge's optimizer-runs setting and does
        // NOT measure the new delegatecall hop itself. Before this PR a
        // reservation call was one delegatecall hop (Bridge -> Reservation
        // library); after, it's two (Bridge -> ReservationRouter ->
        // Reservation library). Compares the same view call made directly
        // on the standalone router (no fallback dispatch) against the
        // identical call routed through the Bridge fallback -- the delta
        // isolates the fallback's own dispatch cost (cold SLOAD of the
        // router slot, cold-address delegatecall surcharge under EIP-2929,
        // and the extra `calldatacopy`/`returndatacopy` framing), separate
        // from the deposit/redemption hot-path functions the PR's own
        // optimizer-runs comparison covers.
        const standaloneRouterHandle = (await ethers.getContractAt(
          "ReservationRouter",
          routerAddress
        )) as ReservationRouter
        const directGas =
          await standaloneRouterHandle.estimateGas.reservationParameters()
        const routedGas = await bridge.estimateGas.reservationParameters()
        const overhead = routedGas.sub(directGas)

        // eslint-disable-next-line no-console
        console.log(
          `      fallback dispatch overhead: ${overhead.toString()} gas ` +
            `(direct: ${directGas.toString()}, routed: ${routedGas.toString()})`
        )

        // Loose upper bound, not a tight snapshot: guards against the
        // overhead silently growing far past the analytically-estimated
        // ~5,000 gas (e.g. an accidental extra cold SLOAD or storage read
        // added to the dispatch path), without pinning an exact value that
        // would make this test brittle across compiler/EVM-version bumps.
        expect(overhead.toNumber()).to.be.within(0, 15000)
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
            10
          )
      ).to.be.revertedWith("Caller is not the governance")

      await expect(
        standaloneRouter.connect(thirdParty).extendReservation(1)
      ).to.be.revertedWith("Caller is not the reservation vault")

      await expect(
        standaloneRouter
          .connect(thirdParty)
          .requestReservedRedemption(1, thirdParty.address, "0x1600144b47c798")
      ).to.be.revertedWith("Caller is not the reservation vault")

      await expect(
        standaloneRouter.connect(thirdParty).notifyReservedRedemptionVeto(1)
      ).to.be.revertedWith("Caller is not the redemption watchtower")

      // The single entry point for all reservation lifecycle SPV proofs.
      // Gated by `onlySpvMaintainer` in the router itself (not the
      // library), so this is the one guard not already exercised by a
      // `Reservation` library-level "Caller is not ..." check above.
      const emptyBitcoinTxInfo = {
        version: "0x00000000",
        inputVector: "0x00",
        outputVector: "0x00",
        locktime: "0x00000000",
      }
      const emptyBitcoinTxProof = {
        merkleProof: "0x",
        txIndexInBlock: 0,
        bitcoinHeaders: "0x",
        coinbasePreimage: ethers.constants.HashZero,
        coinbaseProof: "0x",
      }
      const emptyMainUtxo = {
        txHash: ethers.constants.HashZero,
        txOutputIndex: 0,
        txOutputValue: 0,
      }
      await expect(
        standaloneRouter
          .connect(thirdParty)
          .submitReservationProof(
            0,
            emptyBitcoinTxInfo,
            emptyBitcoinTxProof,
            emptyMainUtxo,
            1
          )
      ).to.be.revertedWith("Caller is not SPV maintainer")

      // The only permissionless mutator; its safety rests entirely on the
      // reservation state check below rather than an access-control
      // require, since a standalone router's `reservations` mapping is
      // empty and every entry defaults to `ReservationState.Unknown` (the
      // enum's zero value), not `RedemptionRequested`.
      await expect(
        standaloneRouter
          .connect(thirdParty)
          .notifyReservedRedemptionTimeout(1, [])
      ).to.be.revertedWith("No pending reserved redemption")
    })
  })
})
