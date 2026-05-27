/* eslint-disable no-underscore-dangle */
import hre, { deployments, ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { smock } from "@defi-wonderland/smock"
import { expect } from "chai"
import bridgeFixture from "../fixtures/bridge"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  IRandomBeacon,
  IStaking,
} from "../../typechain"
import {
  FROST_GROUP_SIZE,
  deriveFundedOperatorWallets,
  registerOperators,
  wireStakingFake,
} from "../integration/utils/frost-wallet-registry"

// B-1.5 slice 2: 100-operator sortition pool fixture.
//
// Builds a deterministic 100-operator population in the FROST
// sortition pool so the next B-1.5 slice (full-DKG happy path)
// can call `requestNewWallet → submitDkgResult → approveDkgResult`
// with a valid group + signatures.
//
// This test is **fixture-only**: it pins that the fixture works
// (operators register, join the pool, get selectable identifiers,
// and `selectGroup` returns 100 of them). No DKG flow yet — the
// beacon callback + result submission are the slice 3 deliverable.
//
// Why fixture-only as its own test: the operator-registration
// loop is the slowest part of the eventual happy-path test
// (100 sequential txs). Pinning it as a standalone test makes
// failure diagnosis cleaner (fixture broken vs. DKG broken).

describe("FrostWalletRegistry 100-operator fixture (B-1.5 slice 2)", () => {
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let frostWalletRegistry: any
  let frostSortitionPool: any
  let operators: Awaited<ReturnType<typeof registerOperators>>

  before(async function setupFixture() {
    // 100 sequential operator-registration txs makes this slow;
    // bump mocha's default per-hook timeout.
    this.timeout(240_000)

    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, governance, bridge, bridgeGovernance } =
      await waffle.loadFixture(bridgeFixture))

    // Mirror the deploy chain from
    // FrostWalletRegistry.Permissions.test.ts: T token →
    // SortitionPool → IStaking fake → IRandomBeacon fake →
    // FrostDkgValidator → FrostInactivity → FrostWalletRegistry.
    const t = await deployments.get("T")
    const reimbursementPool = await deployments.get("ReimbursementPool")

    const randomBeacon = await smock.fake<IRandomBeacon>("IRandomBeacon")
    const tokenStaking = await smock.fake<IStaking>("IStaking")
    // Configure staking fake to return positive eligible-stake
    // for every (stakingProvider, application) pair so
    // `joinSortitionPool` passes the authorization check.
    wireStakingFake(hre, tokenStaking)

    const SortitionPoolFactory = await ethers.getContractFactory(
      "@keep-network/sortition-pools/contracts/SortitionPool.sol:SortitionPool"
    )
    frostSortitionPool = await SortitionPoolFactory.connect(deployer).deploy(
      t.address,
      ethers.utils.parseEther("1") // POOL_WEIGHT_DIVISOR
    )
    await frostSortitionPool.deployed()

    // Pool ships with chaosnet active; only the chaosnetOwner
    // (= deployer at construction time) can opt operators in
    // OR call deactivateChaosnet to open the pool to everyone.
    // Tests want every wallet to join freely, so deactivate.
    await frostSortitionPool.connect(deployer).deactivateChaosnet()

    const ValidatorFactory = await ethers.getContractFactory(
      "FrostDkgValidator"
    )
    const validator = await ValidatorFactory.connect(deployer).deploy(
      frostSortitionPool.address
    )
    await validator.deployed()

    const InactFactory = await ethers.getContractFactory("FrostInactivity")
    const inact = await InactFactory.connect(deployer).deploy()
    await inact.deployed()

    // Use a test-suite-unique deployment label so this fixture
    // doesn't collide with `Permissions.test.ts` or
    // `HappyPath.test.ts` when multiple frost-registry tests
    // run in the same Hardhat process (hardhat-deploy keeps
    // a per-name registry across tests in the same process).
    // `contractName` still resolves to the production
    // `FrostWalletRegistry` contract; only the deployment
    // label differs. (Codex P1 on PR #446.)
    const [registry] = await helpers.upgrades.deployProxy(
      "FrostWalletRegistryOperatorFixtureTest",
      {
        contractName: "FrostWalletRegistry",
        initializerArgs: [
          validator.address,
          randomBeacon.address,
          reimbursementPool.address,
          bridge.address,
        ],
        factoryOpts: {
          signer: deployer,
          libraries: { FrostInactivity: inact.address },
        },
        proxyOpts: {
          constructorArgs: [frostSortitionPool.address, tokenStaking.address],
          unsafeAllow: ["external-library-linking"],
          kind: "transparent",
        },
      }
    )
    frostWalletRegistry = registry
    await frostSortitionPool.transferOwnership(frostWalletRegistry.address)

    // Wire the registry to Bridge so any future slice that
    // triggers `requestNewWallet` via Bridge routes correctly.
    // The production deploy chain already wired Bridge.frostWalletRegistry

    // via the no-tags bridgeFixture. Re-wiring would revert with

    // FrostWalletRegistryAlreadySet. Tests below impersonate Bridge to

    // drive the test registry directly (not Bridge -> registry routing),

    // so Bridge.frostWalletRegistry pointing at the production registry

    // is harmless.

    await bridge.resetFrostWalletRegistryForTest(frostWalletRegistry.address)

    // Generate 100 deterministic funded wallets and register
    // each as an operator. Wallet i is both the staking
    // provider AND the operator for operator-slot i (tests
    // don't need the prod separation between roles).
    const wallets = await deriveFundedOperatorWallets(hre, FROST_GROUP_SIZE)
    operators = await registerOperators(
      hre,
      frostWalletRegistry,
      frostSortitionPool,
      wallets
    )
  })

  it("registers exactly FROST_GROUP_SIZE operators", () => {
    expect(operators).to.have.lengthOf(FROST_GROUP_SIZE)
  })

  it("assigns each operator a non-zero sortition-pool identifier", () => {
    const ids = operators.getIds()
    expect(new Set(ids).size).to.equal(
      FROST_GROUP_SIZE,
      "operator identifiers must be unique"
    )
    expect(ids.every((id) => id > 0)).to.equal(
      true,
      "operator identifiers must be non-zero"
    )
  })

  it("reports the right operator count from the sortition pool", async () => {
    const count = await frostSortitionPool.operatorsInPool()
    expect(count.toNumber()).to.equal(FROST_GROUP_SIZE)
  })

  // Note: actually exercising `selectGroup` requires the
  // sortition pool to be locked AND a non-zero DKG seed to be
  // present (so the pool has a deterministic source of
  // randomness). Both are side-effects of
  // `FrostWalletRegistry.requestNewWallet → __beaconCallback`,
  // which itself depends on a working IRandomBeacon. That full
  // happy-path test is the next B-1.5 slice; this fixture-only
  // slice deliberately stops at "operators registered + pool
  // populated" so failure diagnosis is clean. The
  // `selectFrostGroup` helper (in
  // `frost-wallet-registry.ts`) wraps the call for the slice
  // that does drive DKG.
})
