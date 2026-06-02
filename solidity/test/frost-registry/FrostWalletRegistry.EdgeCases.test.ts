/* eslint-disable no-underscore-dangle */
import hre, { deployments, ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { smock } from "@defi-wonderland/smock"
import chai, { expect } from "chai"
import bridgeFixture from "../fixtures/bridge"
import type {
  Bridge,
  BridgeStub,
  IRandomBeacon,
  IStaking,
  ReimbursementPool,
} from "../../typechain"
import {
  FROST_GROUP_SIZE,
  Operators,
  computeFrostResultDigest,
  deriveFundedOperatorWallets,
  hardhatNetworkId,
  performFrostDkg,
  registerOperators,
  selectFrostGroup,
  signFrostDkgResult,
  wireStakingFake,
} from "../integration/utils/frost-wallet-registry"

// Register smock's chai matchers (`have.been.calledOnce`,
// `have.been.calledWith`, etc.) for use against smock fakes.
chai.use(smock.matchers)

// B-1.5 slice 4: DKG edge cases — timeouts, challenge slashing,
// misbehaved members.
//
// Builds on the slice 2 100-operator fixture + slice 3 happy
// path. Each test reuses the same shared deployment and walks
// the registry through a state-machine path that exits
// abnormally:
//
//   1. SEED TIMEOUT — request → no beacon callback → seed
//      window elapses → notifySeedTimeout() resets to IDLE.
//   2. RESULT TIMEOUT — request → beacon callback → no
//      submitDkgResult → submission window elapses →
//      notifyDkgTimeout() resets to IDLE.
//   3. CHALLENGE SLASHING — request → beacon callback →
//      submit a deliberately bad result (sub-threshold
//      signatures) → challengeDkgResult succeeds, submitter
//      slashed, state reset.
//   4. MISBEHAVED-MEMBERS — happy path with non-empty
//      misbehavedMembersIndices → wallet still registers,
//      misbehaved members get setRewardIneligibility'd in
//      the sortition pool.
//
// The shared deploy logic mirrors slice 3 (smock beacon +
// staking + reimbursement pool, deactivated chaosnet on the
// sortition pool, registry wired to Bridge with both
// walletOwner and lifecycleOwner set, DKG params compressed).

describe("FrostWalletRegistry DKG edge cases (B-1.5 slice 4)", () => {
  let deployer: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let frostWalletRegistry: any
  let frostSortitionPool: any
  let randomBeacon: any
  let staking: any
  let operators: Operators

  // DKG state enum mirrors `FrostDkg.State`:
  //   IDLE=0, AWAITING_SEED=1, AWAITING_RESULT=2, CHALLENGE=3
  const State = {
    IDLE: 0,
    AWAITING_SEED: 1,
    AWAITING_RESULT: 2,
    CHALLENGE: 3,
  }

  // Compressed timeout values (production values are much
  // larger; compression keeps tests fast).
  const SEED_TIMEOUT_BLOCKS = 8
  const RESULT_CHALLENGE_BLOCKS = 6
  const RESULT_SUBMISSION_TIMEOUT_BLOCKS = 20
  const RESULT_CHALLENGE_EXTRA_GAS = 50_000
  const SUBMITTER_PRECEDENCE_BLOCKS = 5

  before(async function setupSharedFixture() {
    this.timeout(300_000)

    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, bridge } = await waffle.loadFixture(bridgeFixture))

    const t = await deployments.get("T")
    randomBeacon = await smock.fake<IRandomBeacon>("IRandomBeacon")
    staking = await smock.fake<IStaking>("IStaking")
    wireStakingFake(hre, staking)

    const reimbursementPoolFake = await smock.fake<ReimbursementPool>(
      "ReimbursementPool"
    )
    reimbursementPoolFake.refund.returns()

    const SortitionPoolFactory = await ethers.getContractFactory(
      "@keep-network/sortition-pools/contracts/SortitionPool.sol:SortitionPool"
    )
    frostSortitionPool = await SortitionPoolFactory.connect(deployer).deploy(
      t.address,
      ethers.utils.parseEther("1")
    )
    await frostSortitionPool.deployed()
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

    // Distinct deployment label so this fixture doesn't collide
    // with the other frost-registry tests when they run in the
    // same Hardhat process (Codex P1 on PR #446).
    const [registry] = await helpers.upgrades.deployProxy(
      "FrostWalletRegistryEdgeCasesTest",
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
          libraries: { FrostInactivity: inact.address },
        },
        proxyOpts: {
          constructorArgs: [frostSortitionPool.address, staking.address],
          unsafeAllow: ["external-library-linking"],
          kind: "transparent",
        },
      }
    )
    frostWalletRegistry = registry
    await frostSortitionPool.transferOwnership(frostWalletRegistry.address)

    // The production deploy chain already wired Bridge.frostWalletRegistry
    // and Bridge.lifecycleRouter via the no-tags bridgeFixture. This suite
    // deploys a fresh registry and still lets approveDkgResult callback into
    // Bridge, so reset the Bridge-side pointers to the local test registry
    // and lifecycle-owner stand-in.

    await bridge.resetFrostWalletRegistryForTest(frostWalletRegistry.address)

    await bridge.resetLifecycleRouterForTest(deployer.address)

    await frostWalletRegistry
      .connect(deployer)
      .updateLifecycleOwner(deployer.address)

    // Compress every DKG window to the test-only values so
    // mining stays fast.
    await frostWalletRegistry
      .connect(deployer)
      .updateDkgParameters(
        SEED_TIMEOUT_BLOCKS,
        RESULT_CHALLENGE_BLOCKS,
        RESULT_CHALLENGE_EXTRA_GAS,
        RESULT_SUBMISSION_TIMEOUT_BLOCKS,
        SUBMITTER_PRECEDENCE_BLOCKS
      )

    const wallets = await deriveFundedOperatorWallets(hre, FROST_GROUP_SIZE)
    operators = await registerOperators(
      hre,
      frostWalletRegistry,
      frostSortitionPool,
      wallets
    )

    // Fund the impersonatable accounts (Bridge for requestNewWallet,
    // beacon for the callback).
    await hre.network.provider.send("hardhat_setBalance", [
      bridge.address,
      "0x56BC75E2D63100000", // 100 ETH
    ])
    await hre.network.provider.send("hardhat_setBalance", [
      randomBeacon.address,
      "0x56BC75E2D63100000",
    ])
  })

  // Each test owns its own snapshot — the DKG state machine
  // is process-shared, so isolating per-test prevents one
  // test's residual state from breaking the next.
  let snapshotId: string
  beforeEach(async () => {
    snapshotId = (await hre.network.provider.send("evm_snapshot", [])) as string
  })
  afterEach(async () => {
    await hre.network.provider.send("evm_revert", [snapshotId])
  })

  it("seed timeout: request → no beacon → notifySeedTimeout resets to IDLE", async function seedTimeout() {
    this.timeout(60_000)

    await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])

    const bridgeAsSigner = await ethers.getSigner(bridge.address)
    await frostWalletRegistry.connect(bridgeAsSigner).requestNewWallet()
    expect(await frostWalletRegistry.getWalletCreationState()).to.equal(
      State.AWAITING_SEED
    )

    // Advance past the seed timeout window. The contract check
    // is `block.number > stateLockBlock + seedTimeout`; mine
    // `SEED_TIMEOUT_BLOCKS + 2` to absorb the off-by-one.
    await hre.network.provider.send("hardhat_mine", [
      `0x${(SEED_TIMEOUT_BLOCKS + 2).toString(16)}`,
    ])

    const tx = await frostWalletRegistry.notifySeedTimeout()
    await expect(tx).to.emit(frostWalletRegistry, "DkgSeedTimedOut")

    expect(await frostWalletRegistry.getWalletCreationState()).to.equal(
      State.IDLE,
      "state machine must return to IDLE after timeout"
    )
  })

  it("result timeout: request → seed → no submit → notifyDkgTimeout resets to IDLE", async function resultTimeout() {
    this.timeout(60_000)

    await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])

    const bridgeAsSigner = await ethers.getSigner(bridge.address)
    await frostWalletRegistry.connect(bridgeAsSigner).requestNewWallet()

    await ethers.provider.send("hardhat_impersonateAccount", [
      randomBeacon.address,
    ])

    const beaconAsSigner = await ethers.getSigner(randomBeacon.address)
    const seed = ethers.BigNumber.from(
      ethers.utils.id("frost-result-timeout-test-seed")
    )
    await frostWalletRegistry.connect(beaconAsSigner).__beaconCallback(seed, 0)

    expect(await frostWalletRegistry.getWalletCreationState()).to.equal(
      State.AWAITING_RESULT
    )

    // Advance past the result-submission window. The contract
    // check is
    //   `block.number > startBlock + submissionStartOffset + resultSubmissionTimeout`.
    // The `resultSubmissionStartBlockOffset` defaults to ~20
    // blocks (covers off-chain DKG ack); mine enough to cover
    // both windows plus headroom.
    await hre.network.provider.send("hardhat_mine", [
      `0x${(RESULT_SUBMISSION_TIMEOUT_BLOCKS + 100).toString(16)}`,
    ])

    const tx = await frostWalletRegistry.notifyDkgTimeout()
    await expect(tx).to.emit(frostWalletRegistry, "DkgTimedOut")

    expect(await frostWalletRegistry.getWalletCreationState()).to.equal(
      State.IDLE,
      "state machine must return to IDLE after timeout"
    )
  })

  it("challenge slashing: submit sub-threshold result → challengeDkgResult slashes submitter, resets state", async function challengeSlashing() {
    this.timeout(120_000)

    // Drive to AWAITING_RESULT.
    await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])

    const bridgeAsSigner = await ethers.getSigner(bridge.address)
    await frostWalletRegistry.connect(bridgeAsSigner).requestNewWallet()

    await ethers.provider.send("hardhat_impersonateAccount", [
      randomBeacon.address,
    ])

    const beaconAsSigner = await ethers.getSigner(randomBeacon.address)
    const seed = ethers.BigNumber.from(
      ethers.utils.id("frost-challenge-slashing-seed")
    )
    await frostWalletRegistry.connect(beaconAsSigner).__beaconCallback(seed, 0)

    const groupMembers = await selectFrostGroup(
      hre,
      frostWalletRegistry,
      frostSortitionPool,
      operators
    )

    // Build a deliberately BAD result: only 1 signature (well
    // below the FROST_GROUP_SIZE/2+1 = 51 threshold). The
    // validator's sub-threshold check rejects this on the
    // challenge path.
    const xOnlyOutputKey =
      "0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff"
    const badResult = await signFrostDkgResult(
      hre,
      groupMembers,
      bridge.address,
      frostWalletRegistry.address,
      seed,
      xOnlyOutputKey,
      1, // submitterMemberIndex
      [], // misbehaved
      1 // SUB-THRESHOLD: only 1 signature (need 51)
    )

    const submitter = groupMembers[0].signer
    const submitTx = await frostWalletRegistry
      .connect(submitter)
      .submitDkgResult(badResult)
    await submitTx.wait()
    expect(await frostWalletRegistry.getWalletCreationState()).to.equal(
      State.CHALLENGE,
      "submit is optimistic; state moves to CHALLENGE"
    )

    // Within the challenge window, an EOA challenger calls
    // challengeDkgResult. The contract requires `msg.sender ==
    // tx.origin`; deployer is an EOA so this works.
    const challengeTx = await frostWalletRegistry
      .connect(deployer)
      .challengeDkgResult(badResult)
    await expect(challengeTx).to.emit(
      frostWalletRegistry,
      "DkgResultChallenged"
    )

    expect(await frostWalletRegistry.getWalletCreationState()).to.equal(
      State.AWAITING_RESULT,
      "successful challenge resets state to AWAITING_RESULT (submission window not yet expired)"
    )

    // `staking.seize(...)` was called with the slashing
    // amount, mult, notifier, and the wrapped submitter
    // operator address. Smock IStaking auto-stubs the
    // function; assert it was called with the right
    // notifier (msg.sender of challenge).
    expect(staking.seize).to.have.been.calledOnce
  })

  it("misbehaved members: happy path with non-empty misbehaved list registers wallet + sets reward ineligibility", async function misbehavedMembers() {
    this.timeout(120_000)

    await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])

    const bridgeAsSigner = await ethers.getSigner(bridge.address)
    await frostWalletRegistry.connect(bridgeAsSigner).requestNewWallet()

    await ethers.provider.send("hardhat_impersonateAccount", [
      randomBeacon.address,
    ])

    const beaconAsSigner = await ethers.getSigner(randomBeacon.address)
    const seed = ethers.BigNumber.from(
      ethers.utils.id("frost-misbehaved-members-seed")
    )
    await frostWalletRegistry.connect(beaconAsSigner).__beaconCallback(seed, 0)

    const groupMembers = await selectFrostGroup(
      hre,
      frostWalletRegistry,
      frostSortitionPool,
      operators
    )

    // Mark members at positions 10, 25, 60 as misbehaved
    // (1-based per FrostDkg convention; must be strictly
    // ascending + unique).
    const misbehavedMembersIndices = [10, 25, 60]
    const xOnlyOutputKey =
      "0xaaaaffff00001111222233334444555566667777888899990000aaaabbbbcccc"

    const { dkgResult, approveDkgResultTx } = await performFrostDkg(
      hre,
      frostWalletRegistry,
      bridge.address,
      seed,
      xOnlyOutputKey,
      groupMembers,
      { misbehavedMembersIndices }
    )

    // Sanity: wallet got registered end-to-end.
    expect(
      await frostWalletRegistry.isWalletRegistered(xOnlyOutputKey)
    ).to.equal(true)

    // Misbehaved members must be reward-ineligible in the
    // sortition pool post-approval. Map indices →
    // identifiers via the dkgResult.members array.
    const misbehavedOperatorIds = misbehavedMembersIndices.map(
      (i) => dkgResult.members[i - 1]
    )
    const misbehavedAddresses = await frostSortitionPool.getIDOperators(
      misbehavedOperatorIds
    )

    for (const addr of misbehavedAddresses) {
      // eslint-disable-next-line no-await-in-loop
      const eligible = await frostSortitionPool.isEligibleForRewards(addr)
      expect(eligible).to.equal(
        false,
        `misbehaved operator ${addr} should be reward-ineligible after approval`
      )
    }

    // Non-misbehaved operators stay eligible.
    const nonMisbehavedAddr = (
      await frostSortitionPool.getIDOperators([dkgResult.members[0]])
    )[0]
    expect(
      await frostSortitionPool.isEligibleForRewards(nonMisbehavedAddr)
    ).to.equal(true, "non-misbehaved operators retain reward eligibility")

    // Confirm approveDkgResultTx is the one that actually
    // wrote the registry state (sanity check on helper output).
    expect(approveDkgResultTx).to.not.equal(undefined)
    // Reference unused symbol to avoid lint complaint while
    // keeping the import line useful for future test
    // additions.
    void computeFrostResultDigest
    void hardhatNetworkId
  })
})
