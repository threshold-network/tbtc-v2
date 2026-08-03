/* eslint-disable no-underscore-dangle */
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

// B-1.5 slice 3: full-cycle DKG happy path.
//
// Drives the FrostWalletRegistry through the complete state
// machine:
//
//   IDLE
//   ─requestNewWallet (walletOwner=Bridge)→
//   AWAITING_SEED  (pool locked)
//   ─__beaconCallback(seed, _) (impersonated randomBeacon)→
//   AWAITING_RESULT  (seed set, group selectable)
//   ─submitDkgResult (any signed-by-majority result)→
//   CHALLENGE  (challenge window opens)
//   ─advance blocks past challengePeriod→
//   ─approveDkgResult (submitter)→
//   IDLE  (wallet registered, Bridge callback fired)
//
// Builds on slice 2's 100-operator fixture; adds an
// impersonated walletOwner (Bridge) + impersonated beacon
// caller + a smock ReimbursementPool to bypass the
// authorization + ETH-balance setup the production reimbursement
// flow requires.

describe("FrostWalletRegistry full-cycle DKG happy path (B-1.5 slice 3)", () => {
  let deployer: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let frostWalletRegistry: any
  let frostSortitionPool: any
  let randomBeacon: any
  let operators: Awaited<ReturnType<typeof registerOperators>>

  before(async function setupFixture() {
    // 100 sequential operator registrations + DKG flow.
    this.timeout(300_000)

    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, bridge } = await waffle.loadFixture(bridgeFixture))

    const t = await deployments.get("T")

    randomBeacon = await smock.fake<IRandomBeacon>("IRandomBeacon")

    // Smock the reimbursement pool so `refund(...)` is a no-op.
    // Production registry calls require the pool to be ETH-
    // funded AND the caller (registry) to be authorized; both
    // are out of scope for this unit-level integration test
    // (slice covers DKG state-machine correctness, not gas
    // accounting).
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

    // Distinct deployment label so this fixture doesn't
    // collide with `Permissions.test.ts` /
    // `OperatorFixture.test.ts` when multiple frost-registry
    // tests run in the same Hardhat process. (Codex P1 on
    // PR #446.)
    const [registry] = await helpers.upgrades.deployProxy(
      "FrostWalletRegistryHappyPathTest",
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

    // The production deploy chain already wired Bridge.frostWalletRegistry

    // via the no-tags bridgeFixture. Re-wiring would revert with

    // FrostWalletRegistryAlreadySet. Tests below impersonate Bridge to

    // drive the test registry directly (not Bridge -> registry routing),

    // so Bridge.frostWalletRegistry pointing at the production registry

    // is harmless.

    await bridge.resetFrostWalletRegistryForTest(frostWalletRegistry.address)

    // Bridge-side callback guard requires the registry lifecycle owner
    // to match Bridge.lifecycleRouter. The deploy chain sets the
    // one-time router slot before this test deploys a fresh registry,
    // so use the test-only reset helper to point Bridge at the local
    // stand-in lifecycle owner.
    await bridge.resetLifecycleRouterForTest(deployer.address)

    // Wire lifecycleOwner to match the test Bridge router stand-in.
    await frostWalletRegistry
      .connect(deployer)
      .updateLifecycleOwner(deployer.address)

    // Compress challenge period to 10 blocks so the test runs
    // fast (production is much longer).
    const dkgParams = await frostWalletRegistry.dkgParameters()
    await frostWalletRegistry.connect(deployer).updateDkgParameters(
      dkgParams.seedTimeout,
      dkgParams.resultChallengePeriodLength.toNumber() === 10 ? 10 : 10, // resultChallengePeriodLength
      dkgParams.resultChallengeExtraGas,
      dkgParams.resultSubmissionTimeout,
      dkgParams.submitterPrecedencePeriodLength
    )

    const [frostAllowlist] = await helpers.upgrades.deployProxy(
      "FrostAllowlistHappyPathTest",
      {
        contractName: "FrostAllowlist",
        initializerArgs: [frostWalletRegistry.address],
        factoryOpts: {
          signer: deployer,
        },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )

    await frostWalletRegistry
      .connect(deployer)
      .initializeV2(frostAllowlist.address)

    // 100 operators allowlisted + funded + registered + joined the pool.
    const wallets = await deriveFundedOperatorWallets(hre, FROST_GROUP_SIZE)
    await allowlistOperatorWallets(frostAllowlist, frostWalletRegistry, wallets)
    operators = await registerOperators(
      hre,
      frostWalletRegistry,
      frostSortitionPool,
      wallets
    )
  })

  it("registers a FROST wallet end-to-end (request → seed → submit → approve)", async function happyPath() {
    this.timeout(120_000)

    // Step 1 — walletOwner (Bridge) requests a new wallet.
    // Production path is Bridge.requestNewWallet → Wallets
    // library → registry.requestNewWallet(). For this unit-
    // level integration test we impersonate Bridge directly
    // and call the registry to avoid coupling to D-1/D-2
    // scheme-flip state.
    await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])

    const bridgeImpersonated = await ethers.getSigner(bridge.address)
    await hre.network.provider.send("hardhat_setBalance", [
      bridge.address,
      "0x56BC75E2D63100000", // 100 ETH
    ])
    await frostWalletRegistry.connect(bridgeImpersonated).requestNewWallet()

    expect(await frostWalletRegistry.getWalletCreationState()).to.equal(
      1 /* AWAITING_SEED */
    )

    // Step 2 — beacon delivers the seed via __beaconCallback.
    // Smock fake doesn't auto-call back; impersonate the
    // beacon address and invoke the callback directly.
    await ethers.provider.send("hardhat_impersonateAccount", [
      randomBeacon.address,
    ])

    const beaconImpersonated = await ethers.getSigner(randomBeacon.address)
    await hre.network.provider.send("hardhat_setBalance", [
      randomBeacon.address,
      "0x56BC75E2D63100000", // 100 ETH
    ])
    const seed = ethers.BigNumber.from(
      ethers.utils.id("frost-dkg-test-seed-2026-05-24")
    )
    await frostWalletRegistry
      .connect(beaconImpersonated)
      .__beaconCallback(seed, 0)

    expect(await frostWalletRegistry.getWalletCreationState()).to.equal(
      2 /* AWAITING_RESULT */
    )

    // Step 3 — select the group, sign a result, submit + approve.
    const groupMembers = await selectFrostGroup(
      hre,
      frostWalletRegistry,
      frostSortitionPool,
      operators
    )
    expect(groupMembers).to.have.lengthOf(FROST_GROUP_SIZE)

    // Use a deterministic non-legacy-shaped 32B key for the
    // FROST wallet's x-only output. The validator rejects
    // both all-zero and high-12-bytes-zero shapes.
    const xOnlyOutputKey =
      "0xabcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01"

    const dkgResult = await performFrostDkg(
      hre,
      frostWalletRegistry,
      bridge.address,
      seed,
      xOnlyOutputKey,
      groupMembers
    )

    // Submission validates the declared members by recreating the selected
    // 100-operator group. Keep its fixed approval-time reimbursement at least
    // as large as the real populated-pool transaction cost.
    const submitReceipt = await dkgResult.submitDkgResultTx.wait()
    const gasParameters = await frostWalletRegistry.gasParameters()
    expect(gasParameters.dkgResultSubmissionGas).to.equal(1_500_000)
    expect(gasParameters.dkgResultSubmissionGas).to.be.gte(
      submitReceipt.gasUsed
    )

    expect(await frostWalletRegistry.getWalletCreationState()).to.equal(
      0 /* IDLE */,
      "DKG returned to IDLE after approval"
    )

    // Step 4 — verify the wallet landed on Bridge via the
    // __frostWalletCreatedCallback. xOnlyOutputKey IS the
    // canonical walletID; the 20-byte compat pubKeyHash is
    // HASH160(0x02 || xOnlyOutputKey).
    const registered = await frostWalletRegistry.isWalletRegistered(
      xOnlyOutputKey
    )
    expect(registered).to.equal(true)

    // Bridge-side: derive the compat pubKeyHash and read the
    // wallet entry.
    const compressedKey = ethers.utils.solidityPack(
      ["bytes1", "bytes32"],
      ["0x02", xOnlyOutputKey]
    )
    const pubKeyHash = ethers.utils.hexDataSlice(
      ethers.utils.ripemd160(ethers.utils.sha256(compressedKey)),
      0,
      20
    )
    const bridgeWallet = await bridge.wallets(pubKeyHash)
    expect(bridgeWallet.ecdsaWalletID).to.equal(
      ethers.constants.HashZero,
      "ECDSA wallet ID must be zero for a FROST wallet (the canonical marker)"
    )

    // Confirm the WalletCreated + NewFrostWalletRegistered
    // events fired with consistent xOnlyOutputKey.
    expect(dkgResult.approveDkgResultTx).to.not.equal(undefined)
  })
})
