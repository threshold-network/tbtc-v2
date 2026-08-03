/* eslint-disable no-underscore-dangle */
import { randomBytes } from "crypto"
import hre, { deployments, ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { smock } from "@defi-wonderland/smock"
import { expect } from "chai"
import bridgeFixture from "../fixtures/bridge"
import type {
  Bridge,
  BridgeStub,
  IRandomBeacon,
  ReimbursementPool,
} from "../../typechain"
import {
  FROST_GROUP_SIZE,
  allowlistOperatorWallets,
  deriveFundedOperatorWallets,
  performFrostDkg,
  registerOperators,
  selectFrostGroup,
} from "../integration/utils/frost-wallet-registry"

// Delegated staking module, spec section E + ledger reconcile:
// the permissionless `reconcileWalletExposure` repair path on the
// FrostWalletRegistry.
//
// A ledger notification hook (`onWalletRegistered` /
// `onWalletClosed`) can be swallowed — the registry wraps both in
// try/catch and emits `WalletExposureLedgerCallFailed` on failure,
// and a ledger wired after wallets already exist simply never sees
// the earlier registrations. Either way the ledger desyncs from the
// registry's authoritative wallet state. `reconcileWalletExposure`
// repairs the divergence in both directions, driven only by state
// the registry itself corroborates:
//
//   - Under-counted (premature-unlock, UNSAFE): the registry still
//     knows the wallet but the ledger has no record. A caller
//     supplies the member IDs (verified against the stored
//     `membersIdsHash`); the registry resolves them to staking
//     providers and records the wallet live, restoring the exit gate.
//   - Over-locked (SAFE): the registry no longer knows the wallet
//     but the ledger still marks it live. The closure is replayed
//     from the ledger's own record.
//
// Reuses the HappyPath fixture shape (100 registered operators,
// impersonated Bridge + beacon, compressed challenge period) and a
// REAL `WalletExposureLedger` so both the resolution payload and the
// resulting exit-gate state are asserted end-to-end.

const uniqueSuffix = (): string => randomBytes(8).toString("hex")

const encodeLiveWalletProof = (
  liveWalletIDs: string[],
  historicalWalletsCreated: number,
  historicalWalletsClosed: number
): string =>
  ethers.utils.defaultAbiCoder.encode(
    ["bytes32[]", "uint256", "uint256"],
    [liveWalletIDs, historicalWalletsCreated, historicalWalletsClosed]
  )

// Assert a transaction reverts with a specific no-arg custom error by
// decoding the 4-byte selector (this toolchain does not register
// chai's `revertedWithCustomError` matcher). Mirrors the sibling
// exposure-ledger suite.
async function expectCustomError(
  promise: Promise<unknown>,
  errorName: string
): Promise<void> {
  const expectedSelector = ethers.utils.id(`${errorName}()`).slice(0, 10)
  try {
    await promise
  } catch (err) {
    const errAny = err as {
      data?: string
      message?: string
      error?: { data?: string }
    }
    const revertData = errAny.data || errAny.error?.data || ""
    const errMsg = errAny.message || String(err)
    if (
      (revertData && revertData.toLowerCase().startsWith(expectedSelector)) ||
      errMsg.toLowerCase().includes(expectedSelector) ||
      errMsg.includes(errorName)
    ) {
      return
    }
    throw new Error(
      `expected revert with custom error ${errorName} ` +
        `(selector ${expectedSelector}), got: ${errMsg}`
    )
  }
  throw new Error(
    `expected revert with custom error ${errorName} but tx succeeded`
  )
}

describe("FrostWalletRegistry wallet exposure reconcile", () => {
  let deployer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let frostWalletRegistry: any
  let frostSortitionPool: any
  let frostAllowlist: any
  let randomBeacon: any
  let operators: Awaited<ReturnType<typeof registerOperators>>

  let ledger: any
  // Provider / seat payload the registry must hand the ledger for the
  // wallet registered in the shared fixture (first-occurrence ordered
  // unique providers covering all 100 seats).
  let expectedProviders: string[]
  let expectedSeatCounts: number[]
  let members: number[]

  const walletKeyA =
    "0xabcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01"

  before(async function setupFixture() {
    // 100 sequential operator registrations + one DKG flow.
    this.timeout(600_000)

    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, thirdParty, bridge } = await waffle.loadFixture(
      bridgeFixture
    ))

    const t = await deployments.get("T")

    randomBeacon = await smock.fake<IRandomBeacon>("IRandomBeacon")

    const reimbursementPoolFake = await smock.fake<ReimbursementPool>(
      "ReimbursementPool"
    )
    reimbursementPoolFake.refund.returns()

    const SortitionPoolFactory = await ethers.getContractFactory(
      "@keep-network/sortition-pools/contracts/SortitionPool.sol:SortitionPool"
    )
    frostSortitionPool = await SortitionPoolFactory.connect(deployer).deploy(
      t.address,
      ethers.utils.parseEther("1") // POOL_WEIGHT_DIVISOR
    )
    await frostSortitionPool.deployed()
    await frostSortitionPool.connect(deployer).deactivateChaosnet()

    const ValidatorFactory = await ethers.getContractFactory(
      "FrostDkgValidator"
    )
    const validator = await ValidatorFactory.connect(deployer).deploy(
      frostSortitionPool.address,
      0 // maxSeatsPerWallet disabled
    )
    await validator.deployed()

    const InactFactory = await ethers.getContractFactory("FrostInactivity")
    const inact = await InactFactory.connect(deployer).deploy()
    await inact.deployed()

    const ExposureFactory = await ethers.getContractFactory(
      "FrostWalletExposure"
    )
    const exposure = await ExposureFactory.connect(deployer).deploy()
    await exposure.deployed()

    const [registry] = await helpers.upgrades.deployProxy(
      `FrostWalletRegistryExposureReconcileTest_${uniqueSuffix()}`,
      {
        contractName: "FrostWalletRegistry",
        initializerArgs: [
          validator.address,
          randomBeacon.address,
          reimbursementPoolFake.address,
          bridge.address,
        ],
        factoryOpts: {
          signer: deployer,
          libraries: {
            FrostInactivity: inact.address,
            FrostWalletExposure: exposure.address,
          },
        },
        proxyOpts: {
          constructorArgs: [frostSortitionPool.address],
          unsafeAllow: ["external-library-linking"],
          kind: "transparent",
        },
      }
    )
    frostWalletRegistry = registry
    await frostSortitionPool.transferOwnership(frostWalletRegistry.address)

    await bridge.resetFrostWalletRegistryForTest(frostWalletRegistry.address)
    await bridge.resetLifecycleRouterForTest(deployer.address)
    await frostWalletRegistry
      .connect(deployer)
      .updateLifecycleOwner(deployer.address)

    // Compress the challenge period so the DKG flow runs fast.
    const dkgParams = await frostWalletRegistry.dkgParameters()
    await frostWalletRegistry
      .connect(deployer)
      .updateDkgParameters(
        dkgParams.seedTimeout,
        10,
        dkgParams.resultChallengeExtraGas,
        dkgParams.resultSubmissionTimeout,
        dkgParams.submitterPrecedencePeriodLength
      )
    ;[frostAllowlist] = await helpers.upgrades.deployProxy(
      `FrostAllowlistExposureReconcileTest_${uniqueSuffix()}`,
      {
        contractName: "FrostAllowlist",
        initializerArgs: [frostWalletRegistry.address],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )

    await frostWalletRegistry
      .connect(deployer)
      .initializeV2(frostAllowlist.address)

    const wallets = await deriveFundedOperatorWallets(hre, FROST_GROUP_SIZE)
    await allowlistOperatorWallets(frostAllowlist, frostWalletRegistry, wallets)
    operators = await registerOperators(
      hre,
      frostWalletRegistry,
      frostSortitionPool,
      wallets
    )

    // Register wallet A while the ledger is DELIBERATELY unwired, so
    // the ledger never learns about it — a faithful stand-in for a
    // swallowed `onWalletRegistered` (the divergence reconcile repairs
    // in the under-counted direction).
    const { dkgResult, groupMembers } = await runDkgRound(
      walletKeyA,
      "frost-reconcile-seed-A"
    )
    members = dkgResult.members
    const exp = expectedExposure(groupMembers)
    expectedProviders = exp.providers
    expectedSeatCounts = exp.seatCounts

    // Now deploy + wire a REAL ledger (registry as its sole caller).
    // It starts with NO record of wallet A — the desync to reconcile.
    const [ledgerInstance] = await helpers.upgrades.deployProxy(
      `WalletExposureLedgerReconcileTest_${uniqueSuffix()}`,
      {
        contractName: "WalletExposureLedger",
        initializerArgs: [frostWalletRegistry.address],
        proxyOpts: { kind: "transparent" },
      }
    )
    ledger = ledgerInstance
  })

  /// Drives one full DKG round (request → seed → submit → approve) and
  /// returns the approve receipt plus the group used.
  async function runDkgRound(xOnlyOutputKey: string, seedLabel: string) {
    await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])
    const bridgeImpersonated = await ethers.getSigner(bridge.address)
    await hre.network.provider.send("hardhat_setBalance", [
      bridge.address,
      "0x56BC75E2D63100000", // 100 ETH
    ])
    await frostWalletRegistry.connect(bridgeImpersonated).requestNewWallet()

    await ethers.provider.send("hardhat_impersonateAccount", [
      randomBeacon.address,
    ])
    const beaconImpersonated = await ethers.getSigner(randomBeacon.address)
    await hre.network.provider.send("hardhat_setBalance", [
      randomBeacon.address,
      "0x56BC75E2D63100000", // 100 ETH
    ])
    const seed = ethers.BigNumber.from(ethers.utils.id(seedLabel))
    await frostWalletRegistry
      .connect(beaconImpersonated)
      .__beaconCallback(seed, 0)

    const groupMembers = await selectFrostGroup(
      hre,
      frostWalletRegistry,
      frostSortitionPool,
      operators
    )

    const { approveDkgResultTx, dkgResult } = await performFrostDkg(
      hre,
      frostWalletRegistry,
      bridge.address,
      seed,
      xOnlyOutputKey,
      groupMembers
    )

    const approveReceipt = await approveDkgResultTx.wait()
    return { approveReceipt, dkgResult, groupMembers }
  }

  /// First-occurrence-ordered unique providers + seat counts the
  /// registry must resolve the members into.
  function expectedExposure(
    groupMembers: Awaited<ReturnType<typeof selectFrostGroup>>
  ): { providers: string[]; seatCounts: number[] } {
    const providers: string[] = []
    const seatCounts: number[] = []
    for (const member of groupMembers) {
      const provider = member.stakingProvider.toLowerCase()
      const idx = providers.indexOf(provider)
      if (idx === -1) {
        providers.push(provider)
        seatCounts.push(1)
      } else {
        seatCounts[idx] += 1
      }
    }
    return { providers, seatCounts }
  }

  describe("before the ledger is wired", () => {
    it("reverts reconcile with WalletExposureLedgerNotSet", async () => {
      expect(await frostWalletRegistry.walletExposureLedger()).to.equal(
        ethers.constants.AddressZero
      )
      await expectCustomError(
        frostWalletRegistry
          .connect(thirdParty)
          .reconcileWalletExposure(walletKeyA, members),
        "WalletExposureLedgerNotSet"
      )
    })
  })

  describe("under-counted direction (swallowed onWalletRegistered)", () => {
    it("wires the ledger, which starts blind to the pre-existing wallet", async () => {
      await frostWalletRegistry
        .connect(deployer)
        .setWalletExposureLedger(ledger.address)
      expect(await frostWalletRegistry.walletExposureLedger()).to.equal(
        ledger.address
      )

      // The premature-unlock hole: the registry still holds wallet A,
      // but the ledger records no exposure for its providers, so the
      // exit gate would let a delegator finalize out early.
      const p0 = expectedProviders[0]
      expect(await ledger.liveWalletCount(p0)).to.equal(0)
      expect(await ledger.hasLiveExposureAtOrBefore(p0, 1_000_000)).to.be.false

      const record = await ledger.getWalletExposure(walletKeyA)
      expect(record.live).to.be.false
      expect(record.epochs.length).to.equal(0)
    })

    it("blocks stateful migration while a live registry wallet is absent from the ledger", async () => {
      const MigrationSourceFactory = await ethers.getContractFactory(
        "StakingMigrationAuthorizationSource"
      )
      const migrationSource = await MigrationSourceFactory.connect(
        deployer
      ).deploy()
      const providers = operators.map((operator) => operator.stakingProvider)

      await expectCustomError(
        frostWalletRegistry
          .connect(deployer)
          .migrateAuthorizationSource(
            migrationSource.address,
            providers,
            encodeLiveWalletProof([walletKeyA], 0, 0)
          ),
        "LiveWalletRosterLedgerMismatch"
      )
      expect(await frostWalletRegistry.authorizationSource()).to.equal(
        frostAllowlist.address
      )
    })

    it("rejects a forged members list (wrong hash)", async () => {
      // Flip one member ID so the encoded hash no longer matches the
      // registry's stored `membersIdsHash`.
      const forged = members.slice()
      forged[0] += 1
      await expect(
        frostWalletRegistry
          .connect(thirdParty)
          .reconcileWalletExposure(walletKeyA, forged)
      ).to.be.revertedWith("Invalid wallet members identifiers")

      // Nothing recorded from the failed attempt.
      expect(await ledger.getWalletExposure(walletKeyA)).to.have.property(
        "live",
        false
      )
    })

    it("reconciles: records the wallet live with the resolved providers", async () => {
      await frostWalletRegistry
        .connect(thirdParty)
        .reconcileWalletExposure(walletKeyA, members)

      const record = await ledger.getWalletExposure(walletKeyA)
      expect(record.live).to.be.true
      expect(
        record.stakingProviders.map((p: string) => p.toLowerCase())
      ).to.deep.equal(expectedProviders)
      expect(record.seatCounts.map((c: any) => Number(c))).to.deep.equal(
        expectedSeatCounts
      )
      // Seat counts cover every one of the 100 seats.
      expect(
        record.seatCounts.reduce((acc: number, c: any) => acc + Number(c), 0)
      ).to.equal(members.length)
    })

    it("restores the exit gate so a would-be premature exit is blocked", async () => {
      const p0 = expectedProviders[0]
      expect(await ledger.liveWalletCount(p0)).to.equal(1)

      // The provider's exposure epoch was assigned fresh at reconcile
      // time; the gate now reports live exposure at or after it,
      // blocking an exit requested at that epoch.
      const epoch = (await ledger.currentEpoch(p0)).toNumber()
      expect(epoch).to.be.greaterThan(0)
      expect(await ledger.hasLiveExposureAtOrBefore(p0, epoch)).to.be.true
      // An exit requested strictly before the exposure existed is not
      // blocked by it.
      expect(await ledger.hasLiveExposureAtOrBefore(p0, epoch - 1)).to.be.false
    })

    it("is idempotent: a second reconcile reverts WalletExposureInSync and cannot double-count", async () => {
      const p0 = expectedProviders[0]
      const countBefore = await ledger.liveWalletCount(p0)

      await expectCustomError(
        frostWalletRegistry
          .connect(thirdParty)
          .reconcileWalletExposure(walletKeyA, members),
        "WalletExposureInSync"
      )

      expect(await ledger.liveWalletCount(p0)).to.equal(countBefore)
    })
  })

  describe("over-locked direction (swallowed onWalletClosed)", () => {
    // A wallet the ledger still marks live but the registry no longer
    // knows. Seed the ledger directly (impersonating the registry, its
    // sole authorized caller) to reproduce the exact over-locked state
    // a swallowed `onWalletClosed` leaves behind: the registry never
    // registered this walletID, so `isWalletRegistered` is false.
    const orphanWallet = ethers.utils.id("reconcile-orphan-wallet")
    const orphanProvider = ethers.utils.getAddress(
      "0x000000000000000000000000000000000000BEEF"
    )

    before(async () => {
      await ethers.provider.send("hardhat_impersonateAccount", [
        frostWalletRegistry.address,
      ])
      await hre.network.provider.send("hardhat_setBalance", [
        frostWalletRegistry.address,
        "0x56BC75E2D63100000",
      ])
      const registryImpersonated = await ethers.getSigner(
        frostWalletRegistry.address
      )
      await ledger
        .connect(registryImpersonated)
        .onWalletRegistered(orphanWallet, [orphanProvider], [1])
    })

    it("starts over-locked: the ledger holds a wallet the registry does not", async () => {
      expect(await frostWalletRegistry.isWalletRegistered(orphanWallet)).to.be
        .false
      const record = await ledger.getWalletExposure(orphanWallet)
      expect(record.live).to.be.true
      expect(await ledger.liveWalletCount(orphanProvider)).to.equal(1)

      const epoch = (await ledger.currentEpoch(orphanProvider)).toNumber()
      expect(await ledger.hasLiveExposureAtOrBefore(orphanProvider, epoch)).to
        .be.true
    })

    it("reconciles: replays the closure from the ledger's own record", async () => {
      // walletMembersIDs is ignored in the close direction; pass empty.
      await frostWalletRegistry
        .connect(thirdParty)
        .reconcileWalletExposure(orphanWallet, [])

      const record = await ledger.getWalletExposure(orphanWallet)
      expect(record.live).to.be.false
      expect(await ledger.liveWalletCount(orphanProvider)).to.equal(0)

      const epoch = (await ledger.currentEpoch(orphanProvider)).toNumber()
      expect(await ledger.hasLiveExposureAtOrBefore(orphanProvider, epoch)).to
        .be.false
    })

    it("is idempotent: a second reconcile reverts WalletExposureInSync", async () => {
      await expectCustomError(
        frostWalletRegistry
          .connect(thirdParty)
          .reconcileWalletExposure(orphanWallet, []),
        "WalletExposureInSync"
      )
    })
  })

  describe("in-sync wallets", () => {
    it("reverts a redundant reconcile of a live, correctly-recorded wallet", async () => {
      // Wallet A is registered in the registry AND recorded live in the
      // ledger — no divergence to repair.
      expect(await frostWalletRegistry.isWalletRegistered(walletKeyA)).to.be
        .true
      expect(await ledger.getWalletExposure(walletKeyA)).to.have.property(
        "live",
        true
      )
      await expectCustomError(
        frostWalletRegistry
          .connect(thirdParty)
          .reconcileWalletExposure(walletKeyA, members),
        "WalletExposureInSync"
      )
    })
  })

  describe("authorization migration wallet roster", () => {
    let migrationSource: any
    let providers: string[]

    before(async function prepareMigrationSource() {
      this.timeout(300_000)
      providers = operators.map((operator) => operator.stakingProvider)
      const MigrationSourceFactory = await ethers.getContractFactory(
        "StakingMigrationAuthorizationSource"
      )
      migrationSource = await MigrationSourceFactory.connect(deployer).deploy()
      const weight = await frostWalletRegistry.minimumAuthorization()
      for (const provider of providers) {
        await migrationSource.setWeight(provider, weight)
      }
    })

    it("rejects an incomplete live-wallet roster", async () => {
      await expectCustomError(
        frostWalletRegistry
          .connect(deployer)
          .migrateAuthorizationSource(
            migrationSource.address,
            providers,
            encodeLiveWalletProof([], 0, 0)
          ),
        "LiveWalletRosterLengthMismatch"
      )
    })

    it("rejects a roster entry absent from the registry", async () => {
      await expectCustomError(
        frostWalletRegistry
          .connect(deployer)
          .migrateAuthorizationSource(
            migrationSource.address,
            providers,
            encodeLiveWalletProof([ethers.utils.id("unknown-wallet")], 0, 0)
          ),
        "LiveWalletRosterWalletNotRegistered"
      )
    })

    it("rejects duplicate wallet IDs even when the claimed count matches", async () => {
      await expectCustomError(
        frostWalletRegistry
          .connect(deployer)
          .migrateAuthorizationSource(
            migrationSource.address,
            providers,
            encodeLiveWalletProof([walletKeyA, walletKeyA], 1, 0)
          ),
        "LiveWalletRosterDuplicate"
      )
    })

    it("migrates only after every live wallet is registered in the ledger", async () => {
      await frostWalletRegistry
        .connect(deployer)
        .migrateAuthorizationSource(
          migrationSource.address,
          providers,
          encodeLiveWalletProof([walletKeyA], 0, 0)
        )
      expect(await frostWalletRegistry.authorizationSource()).to.equal(
        migrationSource.address
      )
    })

    it("keeps the audited historical counts immutable across rollback", async () => {
      await frostWalletRegistry
        .connect(deployer)
        .migrateAuthorizationSource(frostAllowlist.address, providers, "0x")

      await expectCustomError(
        frostWalletRegistry
          .connect(deployer)
          .migrateAuthorizationSource(
            migrationSource.address,
            providers,
            encodeLiveWalletProof([walletKeyA], 1, 1)
          ),
        "HistoricalWalletCountMismatch"
      )
      expect(await frostWalletRegistry.authorizationSource()).to.equal(
        frostAllowlist.address
      )
    })

    it("rejects migration while DKG is active", async () => {
      await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])
      const bridgeImpersonated = await ethers.getSigner(bridge.address)
      await hre.network.provider.send("hardhat_setBalance", [
        bridge.address,
        "0x56BC75E2D63100000",
      ])
      await frostWalletRegistry.connect(bridgeImpersonated).requestNewWallet()

      await expect(
        frostWalletRegistry
          .connect(deployer)
          .migrateAuthorizationSource(
            migrationSource.address,
            providers,
            encodeLiveWalletProof([walletKeyA], 0, 0)
          )
      ).to.be.revertedWith("Current state is not IDLE")
    })
  })
})
