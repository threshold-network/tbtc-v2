/* eslint-disable no-await-in-loop */
import { randomBytes } from "crypto"
import hre, { deployments, ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { smock } from "@defi-wonderland/smock"
import { expect } from "chai"
import type { BigNumber } from "ethers"
import bridgeFixture from "../fixtures/bridge"
import type {
  Bridge,
  BridgeStub,
  IRandomBeacon,
  ReimbursementPool,
} from "../../typechain"
import {
  FROST_GROUP_SIZE,
  deriveFundedOperatorWallets,
  performFrostDkg,
  registerOperators,
  selectFrostGroup,
} from "../integration/utils/frost-wallet-registry"

// Delegated staking module integration: the REAL FrostWalletRegistry
// fixture (same shape as the FROST DKG happy-path test) with the
// SeatAllocator swapped in as the registry's authorization source and the
// WalletExposureLedger wired through the registry's set-once hook.
//
// Drives the spec's C-section integration scenario end to end:
//
//   operator activated + self-bonded  → refreshAuthorization
//                                     → registry sees stake-derived weight
//   full DKG (request → seed → submit → approve)
//                                     → approveDkgResult populates the
//                                       ledger via agent E's registry hook
//   seize (lifecycle owner)           → reportMaliciousBehavior forwards
//                                       to the slashing module; the
//                                       haircut lands in the vault
//   refresh after slash               → authorization decrease through the
//                                       registry's two-step machinery
//   closeWallet                       → ledger cleared; exit gate unlocks
//
// The signer registry, stake vault, slashing module, and rewards
// distributor are the module's test stubs (settable views + stateful
// first-loss slashing) — their production counterparts are built by other
// stages against the same `contracts/staking/api` interfaces and get their
// own unit suites; this test pins the allocator/ledger/registry seams.

const STATUS_ACTIVE = 1

// hardhat-deploy persists proxy deployments by name across test processes;
// a per-run random suffix keeps labels collision-free (same idiom as the
// other staking suites).
const deploymentId = randomBytes(8).toString("hex")

describe("Delegated staking integration (SeatAllocator + WalletExposureLedger + FrostWalletRegistry)", () => {
  let deployer: SignerWithAddress
  let notifier: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let frostWalletRegistry: any
  let frostSortitionPool: any
  let randomBeacon: any
  let operators: Awaited<ReturnType<typeof registerOperators>>

  let signerRegistryStub: any
  let stakeVaultStub: any
  let slashingModuleStub: any
  let rewardsDistributorStub: any
  let exposureLedger: any
  let seatAllocator: any

  const to18 = (n: number | string): BigNumber =>
    ethers.utils.parseEther(String(n))
  const SELF_BOND = to18(40_000)
  const PER_SEAT_SLASH = to18(500)

  // The FROST wallet's x-only output key doubles as the wallet ID. Must
  // not be all-zero nor legacy-shaped (high 12 bytes zero).
  const xOnlyOutputKey =
    "0x5747a1ede77a1eded0c62c414d363dfe5747a1ede77a1eded0c62c414d363dfe"

  // Filled during the DKG test and consumed by the follow-up steps.
  let dkgMembers: number[] = []
  let uniqueProviders: string[] = []
  let seatCountByProvider: Map<string, number>

  before(async function setupFixture() {
    // 100 sequential operator registrations + staking-side wiring.
    this.timeout(600_000)

    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, bridge } = await waffle.loadFixture(bridgeFixture))
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[, , , notifier] = await ethers.getSigners()

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
    // Seat cap disabled (0) — capped-selection behavior has its own
    // suite; this test focuses on the staking module seams.
    const validator = await ValidatorFactory.connect(deployer).deploy(
      frostSortitionPool.address,
      0
    )
    await validator.deployed()

    const InactivityFactory = await ethers.getContractFactory("FrostInactivity")
    const inactivity = await InactivityFactory.connect(deployer).deploy()
    await inactivity.deployed()

    const ExposureFactory = await ethers.getContractFactory(
      "FrostWalletExposure"
    )
    const exposure = await ExposureFactory.connect(deployer).deploy()
    await exposure.deployed()

    const [registry] = await helpers.upgrades.deployProxy(
      `FrostWalletRegistryStakingIntegrationTest_${deploymentId}`,
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
            FrostInactivity: inactivity.address,
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

    // Compress the challenge period so the DKG flow runs fast, and the
    // authorization decrease delay so the slash-driven decrease can be
    // approved within the test.
    const dkgParams = await frostWalletRegistry.dkgParameters()
    await frostWalletRegistry.connect(deployer).updateDkgParameters(
      dkgParams.seedTimeout,
      10, // resultChallengePeriodLength
      dkgParams.resultChallengeExtraGas,
      dkgParams.resultSubmissionTimeout,
      dkgParams.submitterPrecedencePeriodLength
    )
    await frostWalletRegistry
      .connect(deployer)
      .updateAuthorizationParameters(to18(40_000), 1, 1)

    // --- Delegated staking module ---

    const SignerRegistryFactory = await ethers.getContractFactory(
      "StakingMockSignerRegistry"
    )
    signerRegistryStub = await SignerRegistryFactory.connect(deployer).deploy()

    const StakeVaultFactory = await ethers.getContractFactory(
      "StakingMockStakeVault"
    )
    stakeVaultStub = await StakeVaultFactory.connect(deployer).deploy()
    await stakeVaultStub.setMinSelfBond(SELF_BOND)

    const SlashingModuleFactory = await ethers.getContractFactory(
      "StakingMockSlashingModule"
    )
    slashingModuleStub = await SlashingModuleFactory.connect(deployer).deploy()
    await slashingModuleStub.setVault(stakeVaultStub.address)

    const RewardsDistributorFactory = await ethers.getContractFactory(
      "StakingMockRewardsDistributor"
    )
    rewardsDistributorStub = await RewardsDistributorFactory.connect(
      deployer
    ).deploy()

    const [ledgerInstance] = await helpers.upgrades.deployProxy(
      `WalletExposureLedgerStakingIntegrationTest_${deploymentId}`,
      {
        contractName: "WalletExposureLedger",
        initializerArgs: [frostWalletRegistry.address],
        proxyOpts: { kind: "transparent" },
      }
    )
    exposureLedger = ledgerInstance

    const [allocatorInstance] = await helpers.upgrades.deployProxy(
      `SeatAllocatorStakingIntegrationTest_${deploymentId}`,
      {
        contractName: "SeatAllocator",
        initializerArgs: [
          frostWalletRegistry.address,
          signerRegistryStub.address,
          stakeVaultStub.address,
          slashingModuleStub.address,
          exposureLedger.address,
          rewardsDistributorStub.address,
          1, // governance delay (unused in this test)
        ],
        proxyOpts: { kind: "transparent" },
      }
    )
    seatAllocator = allocatorInstance

    // The allocator becomes the registry's authorization source and the
    // ledger is wired through the registry's set-once hook.
    await frostWalletRegistry
      .connect(deployer)
      .initializeV2(seatAllocator.address)
    await frostWalletRegistry
      .connect(deployer)
      .setWalletExposureLedger(exposureLedger.address)

    // 100 operators: Active in the signer registry, self-bonded in the
    // vault, weight synced to the FROST registry via the permissionless
    // refresh — no allowlist weight table anywhere.
    const wallets = await deriveFundedOperatorWallets(hre, FROST_GROUP_SIZE)
    for (const wallet of wallets) {
      // Top up beyond the helper's 1 ETH default — the DKG result
      // approval this fixture drives also pays for the ledger
      // population hook at the test gas price.
      await hre.network.provider.send("hardhat_setBalance", [
        wallet.address,
        "0x56BC75E2D63100000", // 100 ETH
      ])
      await signerRegistryStub.setOperatorStatus(wallet.address, STATUS_ACTIVE)
      await stakeVaultStub.setSelfBond(wallet.address, SELF_BOND)
      await seatAllocator.refreshAuthorization(wallet.address)
    }

    operators = await registerOperators(
      hre,
      frostWalletRegistry,
      frostSortitionPool,
      wallets
    )
  })

  it("derives registry authorization from stake", async () => {
    const sample = operators[0]
    expect(
      await seatAllocator.authorizedWeight(
        sample.stakingProvider,
        sample.signer.address
      )
    ).to.equal(SELF_BOND)
    expect(
      await frostWalletRegistry.eligibleStake(sample.stakingProvider)
    ).to.equal(SELF_BOND)
    expect(await frostSortitionPool.operatorsInPool()).to.equal(
      FROST_GROUP_SIZE
    )
  })

  it("registers a FROST wallet and populates the exposure ledger", async function walletCreation() {
    this.timeout(300_000)

    // Step 1 — walletOwner (Bridge) requests a new wallet.
    await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])
    const bridgeImpersonated = await ethers.getSigner(bridge.address)
    await hre.network.provider.send("hardhat_setBalance", [
      bridge.address,
      "0x56BC75E2D63100000", // 100 ETH
    ])
    await frostWalletRegistry.connect(bridgeImpersonated).requestNewWallet()

    // Step 2 — beacon delivers the seed.
    await ethers.provider.send("hardhat_impersonateAccount", [
      randomBeacon.address,
    ])
    const beaconImpersonated = await ethers.getSigner(randomBeacon.address)
    await hre.network.provider.send("hardhat_setBalance", [
      randomBeacon.address,
      "0x56BC75E2D63100000", // 100 ETH
    ])
    const seed = ethers.BigNumber.from(
      ethers.utils.id("staking-integration-dkg-seed")
    )
    await frostWalletRegistry
      .connect(beaconImpersonated)
      .__beaconCallback(seed, 0)

    // Step 3 — select the group, sign, submit, approve.
    const groupMembers = await selectFrostGroup(
      hre,
      frostWalletRegistry,
      frostSortitionPool,
      operators
    )
    expect(groupMembers).to.have.lengthOf(FROST_GROUP_SIZE)

    const { approveDkgResultTx, dkgResult } = await performFrostDkg(
      hre,
      frostWalletRegistry,
      bridge.address,
      seed,
      xOnlyOutputKey,
      groupMembers
    )
    dkgMembers = dkgResult.members

    // The ledger hook must have succeeded — approval may never be
    // bricked by the ledger, but in the healthy case it must not have
    // fallen into the failure branch either.
    const approveReceipt = await approveDkgResultTx.wait()
    const failedEvents = approveReceipt.events?.filter(
      (e: any) => e.event === "WalletExposureLedgerCallFailed"
    )
    expect(failedEvents ?? []).to.have.lengthOf(0)

    expect(await frostWalletRegistry.isWalletRegistered(xOnlyOutputKey)).to.be
      .true

    // Aggregate the expected unique providers + seat counts from the
    // approved result (with-replacement sampling can assign an operator
    // several seats).
    seatCountByProvider = new Map<string, number>()
    for (const member of groupMembers) {
      const p = member.stakingProvider
      seatCountByProvider.set(p, (seatCountByProvider.get(p) ?? 0) + 1)
    }
    uniqueProviders = Array.from(seatCountByProvider.keys())

    // The ledger recorded exactly this exposure, one fresh epoch per
    // unique provider.
    const record = await exposureLedger.getWalletExposure(xOnlyOutputKey)
    expect(record.live).to.be.true
    expect(record.stakingProviders.length).to.equal(uniqueProviders.length)
    for (let i = 0; i < record.stakingProviders.length; i++) {
      const p = record.stakingProviders[i]
      expect(record.seatCounts[i]).to.equal(seatCountByProvider.get(p))
      expect(record.epochs[i]).to.equal(1)
    }

    for (const p of uniqueProviders) {
      expect(await exposureLedger.currentEpoch(p)).to.equal(1)
      expect(await exposureLedger.liveWalletCount(p)).to.equal(1)
    }

    // Exit gate: an exit requested at epoch 1 is blocked while the
    // wallet lives; one requested before the wallet existed is not.
    const sample = uniqueProviders[0]
    expect(await seatAllocator.canFinalizeUndelegate(sample, 1)).to.be.false
    expect(await seatAllocator.canFinalizeUndelegate(sample, 0)).to.be.true
  })

  it("routes seize through the allocator into the vault", async function seizeFlow() {
    this.timeout(120_000)

    const sample = uniqueProviders[0]
    const sampleSeats = seatCountByProvider.get(sample)!
    const sampleOperator = operators.find(
      (operator) => operator.stakingProvider === sample
    )!

    // The lifecycle owner (Bridge router stand-in) seizes stake from the
    // wallet members — the registry resolves members to staking
    // providers and calls the allocator's reportMaliciousBehavior.
    await frostWalletRegistry
      .connect(deployer)
      .seize(PER_SEAT_SLASH, 100, notifier.address, xOnlyOutputKey, dkgMembers)

    // Forwarded per-seat to the slashing module (one entry per seat).
    expect(await slashingModuleStub.reportCallCount()).to.equal(1)
    expect(await slashingModuleStub.lastPerSeatAmount()).to.equal(
      PER_SEAT_SLASH
    )
    expect(await slashingModuleStub.lastRewardMultiplier()).to.equal(100)
    expect(await slashingModuleStub.lastNotifier()).to.equal(notifier.address)
    expect(await slashingModuleStub.lastStakingProvidersCount()).to.equal(
      FROST_GROUP_SIZE
    )

    // The haircut landed in the vault: per-seat amount times the
    // provider's seat count, taken from the self-bond first.
    expect(await stakeVaultStub.selfBondOf(sample)).to.equal(
      SELF_BOND.sub(PER_SEAT_SLASH.mul(sampleSeats))
    )

    // The allocator marked the provider dirty but made no registry
    // callbacks on the report path.
    expect(await seatAllocator.weightDirty(sample)).to.be.true
    expect(
      await seatAllocator.authorizedWeight(
        sample,
        sampleOperator.signer.address
      )
    ).to.equal(SELF_BOND)
  })

  it("syncs the slashed weight through the registry's two-step decrease", async function slashedWeightSync() {
    this.timeout(120_000)

    const sample = uniqueProviders[0]
    const sampleOperator = operators.find(
      (operator) => operator.stakingProvider === sample
    )!

    // The slash dropped the self-bond below the minimum — the live
    // weight collapses to zero and the permissionless refresh files an
    // authorization decrease request.
    expect(await seatAllocator.currentWeight(sample)).to.equal(0)
    await seatAllocator.refreshAuthorization(sample)
    expect(await seatAllocator.weightDirty(sample)).to.be.false
    expect(await seatAllocator.decreasePending(sample)).to.be.true

    expect(
      await frostWalletRegistry.pendingAuthorizationDecrease(sample)
    ).to.equal(SELF_BOND)
    expect(await frostWalletRegistry.eligibleStake(sample)).to.equal(0)

    // Registry two-step: pool sync activates the decrease delay, then
    // the (permissionless) approval finalizes it back into the
    // allocator.
    await frostWalletRegistry.connect(deployer).updateOperatorStatus(sample)
    await helpers.time.increaseTime(2)
    await frostWalletRegistry
      .connect(deployer)
      .approveAuthorizationDecrease(sample)

    expect(await seatAllocator.decreasePending(sample)).to.be.false
    expect(
      await seatAllocator.authorizedWeight(
        sample,
        sampleOperator.signer.address
      )
    ).to.equal(0)
  })

  it("unlocks the exit gate when the wallet closes", async function closeFlow() {
    this.timeout(120_000)

    const sample = uniqueProviders[0]
    expect(await seatAllocator.canFinalizeUndelegate(sample, 1)).to.be.false

    await frostWalletRegistry.connect(deployer).closeWallet(xOnlyOutputKey)

    const record = await exposureLedger.getWalletExposure(xOnlyOutputKey)
    expect(record.live).to.be.false

    for (const p of uniqueProviders) {
      expect(await exposureLedger.liveWalletCount(p)).to.equal(0)
    }
    expect(await seatAllocator.canFinalizeUndelegate(sample, 1)).to.be.true
  })
})
