import { artifacts, ethers, helpers, upgrades, waffle } from "hardhat"
import { expect } from "chai"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

import bridgeFixture from "../fixtures/bridge"
import reservationRouterStorageLayoutSnapshot from "../fixtures/reservation-router-storage-layout.snapshot.json"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  ReservationRouter,
} from "../../typechain"
import {
  getStorageLayout,
  getBridgeStorageLayout,
  canonicalLayout,
} from "../helpers/storage-layout"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

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
      const bridgeLayout = await getBridgeStorageLayout()
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
      const bridgeLayout = await getBridgeStorageLayout()
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

    context(
      "when called with a contract that is not a reservation router",
      () => {
        it("should revert without consuming the one-time slot", async () => {
          // The BridgeStub has deployed code but declares no
          // `reservationRouter()` view, so the shape probe's call fails and
          // the guard rejects it (this is the P1 hardening: a wrong
          // but code-bearing address can no longer be committed, because a
          // bad wire used to be unrecoverable short of shipping an entire
          // new Bridge implementation).
          const [freshBridge] = await deployBridge(1, false)

          await expect(
            freshBridge
              .connect(deployer)
              .setReservationRouter(freshBridge.address)
          ).to.be.revertedWith(
            "Reservation router does not implement router ABI"
          )

          await freshBridge
            .connect(deployer)
            .setReservationRouter(routerAddress)
          expect(
            await bridge.attach(freshBridge.address).reservationRouter()
          ).to.equal(routerAddress)
        })
      }
    )

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

  describe("BridgeGovernance has no reservation-router passthrough", () => {
    it("should not expose setReservationRouter on BridgeGovernance", async () => {
      // The one-shot-via-governance-then-permanently-unreachable design
      // (RFC-13 invariant 4) rests on BridgeGovernance NEVER adding a
      // `setReservationRouter` passthrough, unlike its
      // `setRedemptionWatchtower`/`setRebateStaking` siblings which do
      // have one. A future contributor mirroring the existing passthrough
      // pattern would otherwise silently reopen a second wiring path with
      // no test failing -- this test guards that absence by construction.
      const governanceArtifact = await artifacts.readArtifact(
        "BridgeGovernance"
      )
      const governanceInterface = new ethers.utils.Interface(
        governanceArtifact.abi
      )
      expect(
        Object.values(governanceInterface.functions)
          .map((fragment) => fragment.name)
          .filter((name) => name.startsWith("setReservationRouter"))
      ).to.deep.equal([])
    })
  })

  describe("initializeV6_SetReservationRouter", () => {
    let esdm: SignerWithAddress

    before(async () => {
      // eslint-disable-next-line @typescript-eslint/no-extra-semi
      ;({ esdm } = await helpers.signers.getNamedSigners())
    })

    context(
      "when called directly, not through ProxyAdmin.upgradeAndCall",
      () => {
        it("should revert", async () => {
          const [freshBridge] = await deployBridge(1, false)
          await expect(
            freshBridge
              .connect(thirdParty)
              .initializeV6_SetReservationRouter(routerAddress)
          ).to.be.revertedWith("Caller is not the proxy admin")
        })
      }
    )

    context(
      "when called by the proxy admin via ProxyAdmin.upgradeAndCall",
      () => {
        it("should set the router and emit ReservationRouterSet", async () => {
          const [freshBridge, freshDeployment] = await deployBridge(1, false)

          const proxyAdmin = await upgrades.admin.getInstance()
          const proxyAdminWithUpgrade = await ethers.getContractAt(
            [
              "function upgradeAndCall(address proxy, address implementation, bytes data)",
            ],
            proxyAdmin.address,
            esdm
          )

          const upgradeData = freshBridge.interface.encodeFunctionData(
            "initializeV6_SetReservationRouter",
            [routerAddress]
          )

          const tx = await proxyAdminWithUpgrade.upgradeAndCall(
            freshBridge.address,
            freshDeployment.implementation,
            upgradeData
          )

          await expect(tx)
            .to.emit(freshBridge, "ReservationRouterSet")
            .withArgs(routerAddress)

          expect(await freshBridge.getReservationRouter()).to.equal(
            routerAddress
          )
        })
      }
    )

    context("when the router is already set", () => {
      it("should revert even when called by the proxy admin", async () => {
        const [freshBridge, freshDeployment] = await deployBridge(1)

        const proxyAdmin = await upgrades.admin.getInstance()
        const proxyAdminWithUpgrade = await ethers.getContractAt(
          [
            "function upgradeAndCall(address proxy, address implementation, bytes data)",
          ],
          proxyAdmin.address,
          esdm
        )

        const upgradeData = freshBridge.interface.encodeFunctionData(
          "initializeV6_SetReservationRouter",
          [thirdParty.address]
        )

        await expect(
          proxyAdminWithUpgrade.upgradeAndCall(
            freshBridge.address,
            freshDeployment.implementation,
            upgradeData
          )
        ).to.be.revertedWith("Reservation router already set")
      })
    })
  })

  describe("initializeV7_RepairReservationRouter", () => {
    let esdm: SignerWithAddress

    before(async () => {
      // eslint-disable-next-line @typescript-eslint/no-extra-semi
      ;({ esdm } = await helpers.signers.getNamedSigners())
    })

    context(
      "when called directly, not through ProxyAdmin.upgradeAndCall",
      () => {
        it("should revert", async () => {
          const [freshBridge] = await deployBridge(1, false)
          await expect(
            freshBridge
              .connect(thirdParty)
              .initializeV7_RepairReservationRouter(routerAddress)
          ).to.be.revertedWith("Caller is not the proxy admin")
        })
      }
    )

    context("when the router is not wired yet", () => {
      it("should wire it and emit ReservationRouterRepaired", async () => {
        // Distinct from `initializeV6`: repairs may run whether or not the
        // router is already set, so this also works on an unwired bridge
        // (emit `ReservationRouterRepaired(old=0x0, new=routerAddress)`).
        const [freshBridge, freshDeployment] = await deployBridge(1, false)

        const proxyAdmin = await upgrades.admin.getInstance()
        const proxyAdminWithUpgrade = await ethers.getContractAt(
          [
            "function upgradeAndCall(address proxy, address implementation, bytes data)",
          ],
          proxyAdmin.address,
          esdm
        )

        const upgradeData = freshBridge.interface.encodeFunctionData(
          "initializeV7_RepairReservationRouter",
          [routerAddress]
        )

        const tx = await proxyAdminWithUpgrade.upgradeAndCall(
          freshBridge.address,
          freshDeployment.implementation,
          upgradeData
        )

        await expect(tx)
          .to.emit(freshBridge, "ReservationRouterRepaired")
          .withArgs(ethers.constants.AddressZero, routerAddress)

        expect(await freshBridge.getReservationRouter()).to.equal(routerAddress)
      })
    })

    context("when the router is already wired", () => {
      it("should allow rebinding to a different router", async () => {
        // The repair path exists precisely because a one-shot
        // `setReservationRouter`/`initializeV6` cannot be re-run after a
        // bad wire. Wire one router via governance, then repair to a
        // freshly deployed second one via the proxy admin.
        const [freshBridge, freshDeployment] = await deployBridge(1, false)
        await freshBridge.connect(deployer).setReservationRouter(routerAddress)
        expect(await freshBridge.getReservationRouter()).to.equal(routerAddress)

        // A second, independent router deployment (also unwired, i.e.
        // `reservationRouter()` returns 0x0 on its own empty storage, so
        // the shape probe accepts it).
        const Reservation = await helpers.contracts.getContract("Reservation")
        const RouterFactory = await ethers.getContractFactory(
          "ReservationRouter",
          { libraries: { Reservation: Reservation.address } }
        )
        const secondRouter = await RouterFactory.deploy()
        await secondRouter.deployed()
        expect(await secondRouter.reservationRouter()).to.equal(
          ethers.constants.AddressZero
        )

        const proxyAdmin = await upgrades.admin.getInstance()
        const proxyAdminWithUpgrade = await ethers.getContractAt(
          [
            "function upgradeAndCall(address proxy, address implementation, bytes data)",
          ],
          proxyAdmin.address,
          esdm
        )

        const upgradeData = freshBridge.interface.encodeFunctionData(
          "initializeV7_RepairReservationRouter",
          [secondRouter.address]
        )
        const tx = await proxyAdminWithUpgrade.upgradeAndCall(
          freshBridge.address,
          freshDeployment.implementation,
          upgradeData
        )

        await expect(tx)
          .to.emit(freshBridge, "ReservationRouterRepaired")
          .withArgs(routerAddress, secondRouter.address)
        expect(await freshBridge.getReservationRouter()).to.equal(
          secondRouter.address
        )
      })

      it("should revert when the router is unchanged", async () => {
        const [freshBridge, freshDeployment] = await deployBridge(1)
        // `wireReservationRouter=true` already wired `routerAddress` via
        // governance during deployBridge.

        const proxyAdmin = await upgrades.admin.getInstance()
        const proxyAdminWithUpgrade = await ethers.getContractAt(
          [
            "function upgradeAndCall(address proxy, address implementation, bytes data)",
          ],
          proxyAdmin.address,
          esdm
        )

        const upgradeData = freshBridge.interface.encodeFunctionData(
          "initializeV7_RepairReservationRouter",
          [routerAddress]
        )

        await expect(
          proxyAdminWithUpgrade.upgradeAndCall(
            freshBridge.address,
            freshDeployment.implementation,
            upgradeData
          )
        ).to.be.revertedWith("Reservation router unchanged")
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
          // Pre-wiring the fallback reverts with "Unknown function"
          // directly; post-wiring the router has no fallback of its own, so
          // the delegatecall bubbles up empty returndata -- the fallback
          // re-encodes the same reason in that case (see Bridge.sol). Both
          // paths must surface the identical, message-bearing revert.
          await expect(
            thirdParty.sendTransaction({
              to: bridge.address,
              data: "0xdeadbeef",
            })
          ).to.be.revertedWith("Unknown function")
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
        // reservation call was one delegatecall hop (proxy -> Bridge
        // implementation); after, it's two (proxy -> Bridge implementation
        // -> ReservationRouter). Both `treasury()` and
        // `reservationParameters()` below are called through the same
        // proxy, so the pre-existing outer proxy hop's cost is present
        // in, and cancels out of, both measurements; the delta isolates
        // only the new fallback-dispatch cost (cold SLOAD of the router
        // slot, cold-address delegatecall surcharge under EIP-2929, and
        // the extra `calldatacopy`/`returndatacopy` framing) -- not the
        // proxy's own delegatecall hop, which every Bridge call already
        // pays today regardless of this PR.
        const baselineGas = await bridge.estimateGas.treasury()
        const routedGas = await bridge.estimateGas.reservationParameters()
        const overhead = routedGas.sub(baselineGas)

        // eslint-disable-next-line no-console
        console.log(
          `      fallback dispatch overhead: ${overhead.toString()} gas ` +
            `(baseline: ${baselineGas.toString()}, routed: ${routedGas.toString()})`
        )

        // Bounded around the measured overhead of routing through the
        // ReservationRouter fallback relative to a same-proxy call that
        // never reaches it (matches `hardhat.config.ts`'s own citation of
        // this test). Tightened from a loose `within(0, 15000)` so a real
        // regression (e.g. an accidental extra cold SLOAD added to the
        // dispatch path) or an unexpected drop (e.g. the router silently
        // not being invoked) both fail, while still tolerating
        // compiler/EVM-version gas-cost drift.
        expect(overhead.toNumber()).to.be.within(10000, 15000)
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
            20000,
            31536000,
            2592000,
            100000000000,
            10,
            100000
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
