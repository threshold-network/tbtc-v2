/* eslint-disable no-await-in-loop */
import { randomBytes } from "crypto"
import { ethers, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import type { BigNumber } from "ethers"

const { increaseTime } = helpers.time

// hardhat-deploy persists proxy deployments by name across test processes;
// a per-deployment random suffix keeps labels collision-free (same idiom as
// the other staking suites).
const uniqueSuffix = (): string => randomBytes(8).toString("hex")

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
      errMsg.toLowerCase().includes(expectedSelector)
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

// OperatorStatus enum values (contracts/staking/api/ISignerRegistry.sol).
const STATUS_NONE = 0
const STATUS_ACTIVE = 1
const STATUS_DEACTIVATING = 2
const STATUS_EJECTED = 3

const GOVERNANCE_DELAY = 604_800 // 7 days

describe("SeatAllocator", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let notifier: SignerWithAddress
  let ledgerRegistrySigner: SignerWithAddress
  let provider: string
  let provider2: string

  let mockRegistry: any
  let signerRegistry: any
  let stakeVault: any
  let slashingModule: any
  let rewardsDistributor: any
  let exposureLedger: any
  let allocator: any

  const to18 = (n: number | string): BigNumber =>
    ethers.utils.parseEther(String(n))

  const MIN_SELF_BOND = to18(40_000)
  // Option B: seat/signing weight is UNIFORM. Every eligible (active,
  // allowlisted, self-bond >= minSelfBond) operator gets this exact value from
  // `currentWeight`, regardless of how much stake is delegated to it. The
  // default equals the FROST registry's genesis minimumAuthorization so every
  // eligible operator clears the registry's pool-eligibility floor.
  const EQUAL_SEAT_WEIGHT = to18(40_000)

  async function activate(p: string): Promise<void> {
    await signerRegistry.setOperatorStatus(p, STATUS_ACTIVE)
  }

  // Drives a governed equal-seat-weight change through the two-step process.
  async function setEqualSeatWeight(newValue: BigNumber): Promise<void> {
    await allocator.connect(governance).beginEqualSeatWeightUpdate(newValue)
    await increaseTime(GOVERNANCE_DELAY)
    await allocator.connect(governance).finalizeEqualSeatWeightUpdate()
  }

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[governance, thirdParty, notifier, ledgerRegistrySigner] =
      await ethers.getSigners()
    const signers = await ethers.getSigners()
    provider = signers[10].address
    provider2 = signers[11].address

    const MockRegistryFactory = await ethers.getContractFactory(
      "StakingMockWalletRegistry"
    )
    mockRegistry = await MockRegistryFactory.connect(governance).deploy()

    const SignerRegistryFactory = await ethers.getContractFactory(
      "StakingMockSignerRegistry"
    )
    signerRegistry = await SignerRegistryFactory.connect(governance).deploy()

    const StakeVaultFactory = await ethers.getContractFactory(
      "StakingMockStakeVault"
    )
    stakeVault = await StakeVaultFactory.connect(governance).deploy()
    await stakeVault.setMinSelfBond(MIN_SELF_BOND)

    const SlashingModuleFactory = await ethers.getContractFactory(
      "StakingMockSlashingModule"
    )
    slashingModule = await SlashingModuleFactory.connect(governance).deploy()

    const RewardsDistributorFactory = await ethers.getContractFactory(
      "StakingMockRewardsDistributor"
    )
    rewardsDistributor = await RewardsDistributorFactory.connect(
      governance
    ).deploy()

    // The exposure ledger is the REAL contract, driven by an EOA acting
    // as the FROST wallet registry — canFinalizeUndelegate is tested
    // against real epoch accounting.
    const deploymentId = uniqueSuffix()
    const [ledgerInstance] = await helpers.upgrades.deployProxy(
      `WalletExposureLedgerSeatAllocatorTest_${deploymentId}`,
      {
        contractName: "WalletExposureLedger",
        initializerArgs: [ledgerRegistrySigner.address],
        proxyOpts: { kind: "transparent" },
      }
    )
    exposureLedger = ledgerInstance

    const [allocatorInstance] = await helpers.upgrades.deployProxy(
      `SeatAllocatorUnitTest_${deploymentId}`,
      {
        contractName: "SeatAllocator",
        initializerArgs: [
          mockRegistry.address,
          signerRegistry.address,
          stakeVault.address,
          slashingModule.address,
          exposureLedger.address,
          rewardsDistributor.address,
          GOVERNANCE_DELAY,
        ],
        proxyOpts: { kind: "transparent" },
      }
    )
    allocator = allocatorInstance
  })

  describe("initialization", () => {
    it("stores the wired addresses", async () => {
      expect(await allocator.frostWalletRegistry()).to.equal(
        mockRegistry.address
      )
      expect(await allocator.signerRegistry()).to.equal(signerRegistry.address)
      expect(await allocator.stakeVault()).to.equal(stakeVault.address)
      expect(await allocator.slashingModule()).to.equal(slashingModule.address)
      expect(await allocator.walletExposureLedger()).to.equal(
        exposureLedger.address
      )
      expect(await allocator.rewardsDistributor()).to.equal(
        rewardsDistributor.address
      )
    })

    it("sets the default parameters", async () => {
      // Only the uniform seat weight and the governance delay remain — the
      // delegation factor and maximum operator weight were removed with the
      // flat-weight model.
      expect(await allocator.equalSeatWeight()).to.equal(EQUAL_SEAT_WEIGHT)
      expect(await allocator.governanceDelay()).to.equal(GOVERNANCE_DELAY)
    })

    it("rejects zero addresses", async () => {
      await expectCustomError(
        helpers.upgrades.deployProxy(
          `SeatAllocatorZeroAddrTest_${uniqueSuffix()}`,
          {
            contractName: "SeatAllocator",
            initializerArgs: [
              mockRegistry.address,
              signerRegistry.address,
              stakeVault.address,
              ethers.constants.AddressZero,
              exposureLedger.address,
              rewardsDistributor.address,
              GOVERNANCE_DELAY,
            ],
            proxyOpts: { kind: "transparent" },
          }
        ),
        "ZeroAddress"
      )
    })
  })

  // Option B — flat seat weight. Signing power is uniform by DAO curation:
  // every eligible active operator gets exactly `equalSeatWeight`, and
  // delegation (or its withdrawal) never moves it.
  describe("currentWeight", () => {
    it("returns 0 for a provider that is not Active, regardless of stake", async () => {
      await stakeVault.setSelfBond(provider, to18(100_000))
      await stakeVault.setDelegatedAssets(provider, to18(100_000))

      for (const status of [STATUS_NONE, STATUS_DEACTIVATING, STATUS_EJECTED]) {
        await signerRegistry.setOperatorStatus(provider, status)
        expect(await allocator.currentWeight(provider)).to.equal(0)
      }
    })

    it("returns the equal seat weight for an eligible active operator", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, MIN_SELF_BOND)
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
    })

    it("returns the SAME equal seat weight regardless of the delegation amount", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, MIN_SELF_BOND)

      // No delegation.
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
      // A large delegation does not raise the seat weight.
      await stakeVault.setDelegatedAssets(provider, to18(5_000_000))
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
      // An enormous delegation does not raise it either — signing power is
      // uniform by curation, not bought with delegated capital.
      await stakeVault.setDelegatedAssets(provider, to18(50_000_000))
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
    })

    it("gives two operators with very different delegation EQUAL seat weight", async () => {
      await activate(provider)
      await activate(provider2)
      // provider: modest self-bond, modest delegation.
      await stakeVault.setSelfBond(provider, to18(100_000))
      await stakeVault.setDelegatedAssets(provider, to18(100_000))
      // provider2: huge self-bond, huge delegation.
      await stakeVault.setSelfBond(provider2, to18(5_000_000))
      await stakeVault.setDelegatedAssets(provider2, to18(20_000_000))

      const w1 = await allocator.currentWeight(provider)
      const w2 = await allocator.currentWeight(provider2)
      expect(w1).to.equal(EQUAL_SEAT_WEIGHT)
      expect(w2).to.equal(EQUAL_SEAT_WEIGHT)
      // The 100:1 capital difference produces ZERO difference in seat weight.
      expect(w1).to.equal(w2)
    })

    it("does not change the seat weight when delegation changes", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, MIN_SELF_BOND)
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )

      await stakeVault.setDelegatedAssets(provider, to18(1_000_000))
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )

      await stakeVault.setDelegatedAssets(provider, 0)
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
    })

    it("is unaffected by pending undelegations", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, MIN_SELF_BOND)
      await stakeVault.setDelegatedAssets(provider, to18(1_000_000))
      // A queued undelegation — even of the entire delegation, and even one
      // exceeding the delegated assets — leaves the flat seat weight untouched.
      await stakeVault.setPendingUndelegationAssets(provider, to18(5_000_000))
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
    })

    it("returns 0 when the self-bond is below the minimum self-bond", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(39_999))
      // Even a massive delegation cannot rescue eligibility: the self-bond
      // floor (skin-in-the-game) is the sole stake gate.
      await stakeVault.setDelegatedAssets(provider, to18(500_000))
      expect(await allocator.currentWeight(provider)).to.equal(0)
    })

    it("excludes queued self-bond withdrawals from the effective self-bond", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, MIN_SELF_BOND)
      // 1 wei queued for withdrawal drops the effective self-bond below the
      // minimum — the operator becomes ineligible and the weight collapses.
      await stakeVault.setPendingSelfBondWithdrawal(provider, 1)
      expect(await allocator.currentWeight(provider)).to.equal(0)

      // A larger self-bond with a queued withdrawal that still leaves the
      // effective self-bond at or above the floor stays at the equal weight.
      await stakeVault.setSelfBond(provider, to18(100_000))
      await stakeVault.setPendingSelfBondWithdrawal(provider, to18(50_000))
      // effective selfBond = 50k >= minSelfBond 40k → eligible, flat weight.
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )

      // Push the queued withdrawal past the floor: back to 0.
      await stakeVault.setPendingSelfBondWithdrawal(provider, to18(70_000))
      expect(await allocator.currentWeight(provider)).to.equal(0)
    })
  })

  // Model B: reward weight tracks the operator's UNCAPPED delegated capital,
  // while seat/signing weight (currentWeight) is the flat equalSeatWeight.
  describe("rewardWeight (Model B)", () => {
    const MAX_UINT96 = ethers.BigNumber.from(2).pow(96).sub(1)

    it("returns the uncapped capital while the seat weight stays flat", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(40_000))
      await stakeVault.setDelegatedAssets(provider, to18(200_000))
      // Seat weight is the uniform equal seat weight...
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
      // ...but the reward weight is the full uncapped capital 40k + 200k.
      expect(await allocator.rewardWeight(provider)).to.equal(to18(240_000))
    })

    it("returns the uncapped capital for a large operator while the seat weight stays flat", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(1_000_000))
      await stakeVault.setDelegatedAssets(provider, to18(5_000_000))
      // Seat weight is flat regardless of the 6M of capital...
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
      // ...reward weight is the full 6M of capital.
      expect(await allocator.rewardWeight(provider)).to.equal(to18(6_000_000))
    })

    it("pays reward proportional to uncapped capital for equal-seat operators", async () => {
      // Two operators with the SAME flat seat weight but different capital —
      // the core Model-B property.
      await activate(provider)
      await activate(provider2)
      await stakeVault.setSelfBond(provider, to18(1_000_000))
      await stakeVault.setDelegatedAssets(provider, to18(2_000_000)) // raw 3M
      await stakeVault.setSelfBond(provider2, to18(1_000_000))
      await stakeVault.setDelegatedAssets(provider2, to18(5_000_000)) // raw 6M

      // Identical flat seat weight, so signing power / decentralization is
      // unchanged between them.
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
      expect(await allocator.currentWeight(provider2)).to.equal(
        EQUAL_SEAT_WEIGHT
      )

      // Reward weight tracks the uncapped capital: 3M vs 6M.
      const rw1 = await allocator.rewardWeight(provider)
      const rw2 = await allocator.rewardWeight(provider2)
      expect(rw1).to.equal(to18(3_000_000))
      expect(rw2).to.equal(to18(6_000_000))
      // The higher-capital operator earns strictly more, exactly 2:1.
      expect(rw2.gt(rw1)).to.be.true
      expect(rw2).to.equal(rw1.mul(2))
    })

    it("grows one-for-one with delegation (no dilution), seat weight unchanged", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(500_000))
      await stakeVault.setDelegatedAssets(provider, to18(1_500_000))
      const seatBefore = await allocator.currentWeight(provider)
      const rewardBefore = await allocator.rewardWeight(provider)
      expect(seatBefore).to.equal(EQUAL_SEAT_WEIGHT)
      expect(rewardBefore).to.equal(to18(2_000_000)) // 500k + 1.5M

      // Add 1M of delegation.
      await stakeVault.setDelegatedAssets(provider, to18(2_500_000))
      const seatAfter = await allocator.currentWeight(provider)
      const rewardAfter = await allocator.rewardWeight(provider)

      // Seat weight (signing power) is unchanged — it is flat by construction.
      expect(seatAfter).to.equal(seatBefore)
      // The reward weight grew by exactly the added capital, so the pool's
      // reward slice scales with the new delegation and existing delegators
      // are not diluted.
      expect(rewardAfter.sub(rewardBefore)).to.equal(to18(1_000_000))
    })

    it("keeps a pending exit earning: neither seat nor reward weight moves", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(100_000))
      await stakeVault.setDelegatedAssets(provider, to18(100_000))
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
      expect(await allocator.rewardWeight(provider)).to.equal(to18(200_000))

      // A delegator queues an undelegation. Under flat weight the seat weight
      // does NOT move (it never depended on delegation), and the capital is
      // still in the pool — slashable AND reward-earning until finalize.
      await stakeVault.setPendingUndelegationAssets(provider, to18(100_000))
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
      // Reward weight is unchanged: delegatedAssetsOf still includes the
      // pending-exit capital and rewardWeight does not subtract it.
      expect(await allocator.rewardWeight(provider)).to.equal(to18(200_000))
    })

    it("is zero for ineligible operators and restores on reactivation", async () => {
      await stakeVault.setSelfBond(provider, to18(1_000_000))
      await stakeVault.setDelegatedAssets(provider, to18(1_000_000))

      // No reward weight in any non-Active status, regardless of capital —
      // rewards are never paid to a non-signer.
      for (const status of [STATUS_NONE, STATUS_DEACTIVATING, STATUS_EJECTED]) {
        await signerRegistry.setOperatorStatus(provider, status)
        expect(await allocator.rewardWeight(provider)).to.equal(0)
      }

      // Reactivation restores the uncapped reward weight and accrual resumes.
      await activate(provider)
      expect(await allocator.rewardWeight(provider)).to.equal(to18(2_000_000))
    })

    it("is zero when the self-bond is below the minimum (shares currentWeight's gate)", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(39_999))
      await stakeVault.setDelegatedAssets(provider, to18(1_000_000))
      // currentWeight is 0 (self-bond below minSelfBond) → rewardWeight 0.
      expect(await allocator.currentWeight(provider)).to.equal(0)
      expect(await allocator.rewardWeight(provider)).to.equal(0)
    })

    // Boundary case: the self-bond floor overrides the
    // pending-exit-keeps-earning rule, but ONLY via the self-bond path.
    it("zeroes the whole pool via a below-floor self-bond withdrawal, but not via a delegator undelegation", async () => {
      await activate(provider)
      // Self-bond exactly at the floor, with delegated capital on top.
      await stakeVault.setSelfBond(provider, MIN_SELF_BOND)
      await stakeVault.setDelegatedAssets(provider, to18(200_000))
      // Active and at/above the floor: earns on the full uncapped capital.
      expect(await allocator.rewardWeight(provider)).to.equal(to18(240_000))

      // A delegator undelegation alone does NOT cross the eligibility floor —
      // the operator stays a qualified signer, so the pending-exit capital
      // keeps earning (design §6): the seat weight is flat and the reward
      // weight holds, even with the entire delegation queued to exit.
      await stakeVault.setPendingUndelegationAssets(provider, to18(200_000))
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
      expect(await allocator.rewardWeight(provider)).to.equal(to18(240_000))
      await stakeVault.setPendingUndelegationAssets(provider, 0)

      // Now queue a self-bond withdrawal that drops the effective self-bond
      // below minSelfBond: currentWeight subtracts the queued withdrawal
      // BEFORE the floor check, so currentWeight collapses to 0 and the WHOLE
      // pool's reward weight zeroes — including the still-present delegated
      // capital (which is unchanged). The operator has ceased to be a
      // qualified signer; this is the same wind-down state as deactivation.
      await stakeVault.setPendingSelfBondWithdrawal(provider, 1)
      expect(await stakeVault.delegatedAssetsOf(provider)).to.equal(
        to18(200_000)
      )
      expect(await allocator.currentWeight(provider)).to.equal(0)
      expect(await allocator.rewardWeight(provider)).to.equal(0)
    })

    it("clamps the reward weight to type(uint96).max defensively", async () => {
      await activate(provider)
      // Each field is a uint96; their sum overflows uint96. currentWeight is
      // the flat equal seat weight (well within range) so the eligibility
      // gate passes, and rewardWeight clamps the overflowing raw sum.
      await stakeVault.setSelfBond(provider, MAX_UINT96)
      await stakeVault.setDelegatedAssets(provider, MAX_UINT96)
      expect(await allocator.currentWeight(provider)).to.equal(
        EQUAL_SEAT_WEIGHT
      )
      expect(await allocator.rewardWeight(provider)).to.equal(MAX_UINT96)
    })
  })

  // The rewards distributor is driven with the UNCAPPED reward weight, while
  // the registry sync uses the flat seat weight.
  describe("refreshAuthorization reward leg (Model B)", () => {
    it("forwards the uncapped reward weight to the distributor while the seat weight stays flat", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(40_000))
      await stakeVault.setDelegatedAssets(provider, to18(200_000))

      await allocator.connect(thirdParty).refreshAuthorization(provider)

      // Registry sync (seat weight) is the flat equal seat weight...
      expect(
        await allocator.authorizedWeight(provider, ethers.constants.AddressZero)
      ).to.equal(EQUAL_SEAT_WEIGHT)
      const increaseCall = await mockRegistry.increaseCalls(0)
      expect(increaseCall.toAmount).to.equal(EQUAL_SEAT_WEIGHT)
      // ...but the reward leg received the uncapped 240k.
      expect(await rewardsDistributor.lastWeight()).to.equal(to18(240_000))
    })

    it("moves neither seat nor reward weight on a pending undelegation, and tracks capital on a real delegation change", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(100_000))
      await stakeVault.setDelegatedAssets(provider, to18(100_000))
      await allocator.refreshAuthorization(provider) // seat flat, reward 200k
      expect(await rewardsDistributor.lastWeight()).to.equal(to18(200_000))

      // Queue an undelegation: under flat weight the seat weight does NOT move,
      // so no authorization decrease is filed, and the reward weight holds
      // (pending-exit capital keeps earning).
      await stakeVault.setPendingUndelegationAssets(provider, to18(100_000))
      await allocator.refreshAuthorization(provider)
      expect(await allocator.decreasePending(provider)).to.be.false
      expect(
        await allocator.authorizedWeight(provider, ethers.constants.AddressZero)
      ).to.equal(EQUAL_SEAT_WEIGHT)
      expect(await rewardsDistributor.lastWeight()).to.equal(to18(200_000))

      // A genuine increase in delegated capital raises only the reward weight;
      // the seat weight stays flat.
      await stakeVault.setPendingUndelegationAssets(provider, 0)
      await stakeVault.setDelegatedAssets(provider, to18(500_000))
      await allocator.refreshAuthorization(provider)
      expect(
        await allocator.authorizedWeight(provider, ethers.constants.AddressZero)
      ).to.equal(EQUAL_SEAT_WEIGHT)
      expect(await rewardsDistributor.lastWeight()).to.equal(to18(600_000))
    })
  })

  describe("refreshAuthorization", () => {
    beforeEach(async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, MIN_SELF_BOND)
    })

    it("files an authorization increase and records it as synced", async () => {
      await expect(allocator.connect(thirdParty).refreshAuthorization(provider))
        .to.emit(allocator, "WeightIncreased")
        .withArgs(provider, 0, EQUAL_SEAT_WEIGHT)

      expect(await mockRegistry.increaseCallsCount()).to.equal(1)
      const call = await mockRegistry.increaseCalls(0)
      expect(call.stakingProvider).to.equal(provider)
      expect(call.fromAmount).to.equal(0)
      expect(call.toAmount).to.equal(EQUAL_SEAT_WEIGHT)

      expect(
        await allocator.authorizedWeight(provider, ethers.constants.AddressZero)
      ).to.equal(EQUAL_SEAT_WEIGHT)

      expect(await rewardsDistributor.onWeightChangedCallCount()).to.equal(1)
      expect(await rewardsDistributor.lastStakingProvider()).to.equal(provider)
      // rewardWeight == selfBond (no delegation) == 40k here.
      expect(await rewardsDistributor.lastWeight()).to.equal(MIN_SELF_BOND)
    })

    it("does not call the registry when the weight is unchanged", async () => {
      await allocator.refreshAuthorization(provider)
      await allocator.refreshAuthorization(provider)

      expect(await mockRegistry.increaseCallsCount()).to.equal(1)
      expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(0)
      // The rewards distributor is still kept in sync on every refresh.
      expect(await rewardsDistributor.onWeightChangedCallCount()).to.equal(2)
    })

    it("files a subsequent increase when the equal seat weight is raised by governance", async () => {
      await allocator.refreshAuthorization(provider) // synced 40k
      // Raising the uniform seat weight lifts every eligible operator's
      // authorization; the next refresh files the increase.
      await setEqualSeatWeight(to18(80_000))

      await expect(allocator.refreshAuthorization(provider))
        .to.emit(allocator, "WeightIncreased")
        .withArgs(provider, EQUAL_SEAT_WEIGHT, to18(80_000))

      expect(
        await allocator.authorizedWeight(provider, ethers.constants.AddressZero)
      ).to.equal(to18(80_000))
    })

    describe("decrease sequencing", () => {
      beforeEach(async () => {
        // Sync the flat weight, so a subsequent drop files a decrease.
        await allocator.refreshAuthorization(provider)
      })

      it("requests a decrease without changing the synced weight", async () => {
        // Deactivation drops the live weight to zero and files a decrease.
        await signerRegistry.setOperatorStatus(provider, STATUS_DEACTIVATING)

        await expect(allocator.refreshAuthorization(provider))
          .to.emit(allocator, "WeightDecreaseRequested")
          .withArgs(provider, EQUAL_SEAT_WEIGHT, 0)

        expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(1)
        const call = await mockRegistry.decreaseRequestCalls(0)
        expect(call.fromAmount).to.equal(EQUAL_SEAT_WEIGHT)
        expect(call.toAmount).to.equal(0)

        // The registry-known weight MUST stay at the pre-decrease value
        // until the registry approves.
        expect(
          await allocator.authorizedWeight(
            provider,
            ethers.constants.AddressZero
          )
        ).to.equal(EQUAL_SEAT_WEIGHT)
        expect(await allocator.decreasePending(provider)).to.be.true
        expect(await allocator.pendingDecreaseTarget(provider)).to.equal(0)

        // The operator is no longer an eligible signer, so the uncapped
        // reward weight legitimately falls to 0.
        expect(await rewardsDistributor.lastWeight()).to.equal(0)
      })

      it("does not re-request the same decrease target", async () => {
        await signerRegistry.setOperatorStatus(provider, STATUS_DEACTIVATING)
        await allocator.refreshAuthorization(provider)
        await allocator.refreshAuthorization(provider)
        expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(1)
      })

      it("re-points a pending decrease to a new lower target", async () => {
        // Model a deployment whose FROST registry floor is 10k, so re-pointing
        // the uniform seat weight down to an intermediate 20k stays above the
        // registry minimum (a config that could exist in production).
        await mockRegistry.setMinimumAuthorization(to18(10_000))
        // Lower the uniform seat weight to an intermediate value so the first
        // decrease targets 20k (not 0).
        await setEqualSeatWeight(to18(20_000))
        await allocator.refreshAuthorization(provider) // decrease 40k -> 20k
        expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(1)
        expect(await allocator.pendingDecreaseTarget(provider)).to.equal(
          to18(20_000)
        )

        // Deactivation drops the live weight to zero — the pending decrease is
        // re-pointed to the new lower target.
        await signerRegistry.setOperatorStatus(provider, STATUS_DEACTIVATING)
        await allocator.refreshAuthorization(provider)
        expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(2)
        const call = await mockRegistry.decreaseRequestCalls(1)
        expect(call.fromAmount).to.equal(EQUAL_SEAT_WEIGHT)
        expect(call.toAmount).to.equal(0)
        expect(await allocator.pendingDecreaseTarget(provider)).to.equal(0)
      })

      it("holds increases while a decrease is pending", async () => {
        await signerRegistry.setOperatorStatus(provider, STATUS_DEACTIVATING)
        await allocator.refreshAuthorization(provider) // decrease to 0 pending
        expect(await allocator.decreasePending(provider)).to.be.true

        // The operator recovers ABOVE the synced weight while the decrease is
        // pending (reactivated AND the uniform weight raised) — the allocator
        // must wait for registry approval, not file an increase.
        await activate(provider)
        await setEqualSeatWeight(to18(80_000))

        await allocator.refreshAuthorization(provider)
        // unchanged (only the initial 40k sync)
        expect(await mockRegistry.increaseCallsCount()).to.equal(1)
        expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(1)
        expect(
          await allocator.authorizedWeight(
            provider,
            ethers.constants.AddressZero
          )
        ).to.equal(EQUAL_SEAT_WEIGHT)
        expect(await allocator.decreasePending(provider)).to.be.true
      })

      it("finalizes the decrease on registry approval and resumes increases", async () => {
        await signerRegistry.setOperatorStatus(provider, STATUS_DEACTIVATING)
        await allocator.refreshAuthorization(provider) // decrease to 0 pending

        await expect(
          mockRegistry.callApproveAuthorizationDecrease(
            allocator.address,
            provider
          )
        )
          .to.emit(allocator, "WeightDecreaseFinalized")
          .withArgs(provider, EQUAL_SEAT_WEIGHT, 0)

        expect(await mockRegistry.lastApprovedWeight()).to.equal(0)
        expect(
          await allocator.authorizedWeight(
            provider,
            ethers.constants.AddressZero
          )
        ).to.equal(0)
        expect(await allocator.decreasePending(provider)).to.be.false
        expect(await allocator.pendingDecreaseTarget(provider)).to.equal(0)

        // After approval a reactivation is filed as a fresh increase.
        await activate(provider)
        await expect(allocator.refreshAuthorization(provider))
          .to.emit(allocator, "WeightIncreased")
          .withArgs(provider, 0, EQUAL_SEAT_WEIGHT)
      })
    })

    it("rejects approveAuthorizationDecrease without a pending decrease", async () => {
      await expectCustomError(
        mockRegistry.callApproveAuthorizationDecrease(
          allocator.address,
          provider
        ),
        "NoDecreasePending"
      )
    })

    it("rejects approveAuthorizationDecrease from non-registry callers", async () => {
      await expectCustomError(
        allocator.connect(thirdParty).approveAuthorizationDecrease(provider),
        "NotWalletRegistry"
      )
    })
  })

  describe("registry sync resilience", () => {
    beforeEach(async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, MIN_SELF_BOND)
    })

    it("survives a reverting registry on the increase path and completes on a later refresh", async () => {
      await mockRegistry.setRevertOnAuthorizationCalls(true)

      await expect(allocator.connect(thirdParty).refreshAuthorization(provider))
        .to.emit(allocator, "AuthorizationSyncFailed")
        .withArgs(provider)

      // Local bookkeeping untouched; the provider is marked dirty so the
      // sync can be retried permissionlessly.
      expect(await mockRegistry.increaseCallsCount()).to.equal(0)
      expect(
        await allocator.authorizedWeight(provider, ethers.constants.AddressZero)
      ).to.equal(0)
      expect(await allocator.weightDirty(provider)).to.be.true
      // The distributor leg was skipped too (early return on failure).
      expect(await rewardsDistributor.onWeightChangedCallCount()).to.equal(0)

      // A later permissionless refresh completes the sync.
      await mockRegistry.setRevertOnAuthorizationCalls(false)
      await expect(allocator.connect(thirdParty).refreshAuthorization(provider))
        .to.emit(allocator, "WeightIncreased")
        .withArgs(provider, 0, EQUAL_SEAT_WEIGHT)
      expect(await mockRegistry.increaseCallsCount()).to.equal(1)
      expect(await allocator.weightDirty(provider)).to.be.false
      expect(await rewardsDistributor.lastWeight()).to.equal(MIN_SELF_BOND)
    })

    it("survives a reverting registry on the decrease path", async () => {
      // Sync 40k, then drop the weight to zero via deactivation.
      await allocator.refreshAuthorization(provider)
      await signerRegistry.setOperatorStatus(provider, STATUS_DEACTIVATING)

      await mockRegistry.setRevertOnAuthorizationCalls(true)
      await expect(allocator.refreshAuthorization(provider))
        .to.emit(allocator, "AuthorizationSyncFailed")
        .withArgs(provider)

      // No pending decrease was recorded — the registry never saw one.
      expect(await allocator.decreasePending(provider)).to.be.false
      expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(0)
      expect(await allocator.weightDirty(provider)).to.be.true

      await mockRegistry.setRevertOnAuthorizationCalls(false)
      await expect(allocator.refreshAuthorization(provider))
        .to.emit(allocator, "WeightDecreaseRequested")
        .withArgs(provider, EQUAL_SEAT_WEIGHT, 0)
      expect(await allocator.decreasePending(provider)).to.be.true
      expect(await allocator.weightDirty(provider)).to.be.false
    })

    it("survives a reverting registry when re-pointing a pending decrease", async () => {
      // Model a deployment whose FROST registry floor is 10k, so the
      // intermediate 20k target stays above the registry minimum.
      await mockRegistry.setMinimumAuthorization(to18(10_000))
      // 40k synced, then a decrease to an intermediate 20k goes pending.
      await allocator.refreshAuthorization(provider)
      await setEqualSeatWeight(to18(20_000))
      await allocator.refreshAuthorization(provider) // target 20k pending

      // The weight drops to zero, but the registry is down — the re-point
      // is deferred and the pending target stays at 20k.
      await signerRegistry.setOperatorStatus(provider, STATUS_DEACTIVATING)
      await mockRegistry.setRevertOnAuthorizationCalls(true)
      await expect(allocator.refreshAuthorization(provider))
        .to.emit(allocator, "AuthorizationSyncFailed")
        .withArgs(provider)
      expect(await allocator.pendingDecreaseTarget(provider)).to.equal(
        to18(20_000)
      )
      expect(await allocator.weightDirty(provider)).to.be.true

      await mockRegistry.setRevertOnAuthorizationCalls(false)
      await allocator.refreshAuthorization(provider)
      expect(await allocator.pendingDecreaseTarget(provider)).to.equal(0)
      expect(await allocator.weightDirty(provider)).to.be.false
    })

    it("survives a reverting rewards distributor and retries it on a later refresh", async () => {
      await rewardsDistributor.setRevertOnWeightChanged(true)

      await expect(allocator.refreshAuthorization(provider))
        .to.emit(allocator, "AuthorizationSyncFailed")
        .withArgs(provider)

      // The registry sync itself landed; only the distributor leg failed.
      expect(await mockRegistry.increaseCallsCount()).to.equal(1)
      expect(
        await allocator.authorizedWeight(provider, ethers.constants.AddressZero)
      ).to.equal(EQUAL_SEAT_WEIGHT)
      expect(await allocator.weightDirty(provider)).to.be.true

      await rewardsDistributor.setRevertOnWeightChanged(false)
      await allocator.refreshAuthorization(provider)
      expect(await rewardsDistributor.onWeightChangedCallCount()).to.equal(1)
      expect(await rewardsDistributor.lastWeight()).to.equal(MIN_SELF_BOND)
      expect(await allocator.weightDirty(provider)).to.be.false
      // No duplicate registry call on the retry — the weight was already
      // recorded as synced.
      expect(await mockRegistry.increaseCallsCount()).to.equal(1)
    })

    it("keeps SignerRegistry.ejectOperator alive when the registry sync reverts", async () => {
      // Real SignerRegistry wired to the allocator: ejection pokes
      // refreshAuthorization; with the FROST registry down the ejection
      // must still land, and a later refresh completes the sync.
      const REAL_REGISTRY_DELAY = 3600
      const [realRegistry] = await helpers.upgrades.deployProxy(
        `SignerRegistryEjectionSyncTest_${uniqueSuffix()}`,
        {
          contractName: "SignerRegistry",
          initializerArgs: [REAL_REGISTRY_DELAY, 0, 2500, 500],
          factoryOpts: { signer: governance },
          proxyOpts: { kind: "transparent" },
        }
      )
      await realRegistry.connect(governance).setSeatAllocator(allocator.address)

      await realRegistry
        .connect(governance)
        .beginOperatorAddition(provider, provider, provider, 0)
      await increaseTime(REAL_REGISTRY_DELAY)
      // Finalization pokes refreshAuthorization against a healthy
      // registry — the flat seat weight gets synced.
      await realRegistry.connect(governance).finalizeOperatorAddition(provider)
      expect(
        await allocator.authorizedWeight(provider, ethers.constants.AddressZero)
      ).to.equal(EQUAL_SEAT_WEIGHT)

      // The FROST registry goes down and the provider's weight collapses
      // in the allocator's own signer registry view.
      await signerRegistry.setOperatorStatus(provider, STATUS_EJECTED)
      await mockRegistry.setRevertOnAuthorizationCalls(true)

      const tx = await realRegistry.connect(governance).ejectOperator(provider)
      await expect(tx)
        .to.emit(realRegistry, "OperatorEjected")
        .withArgs(provider)
      await expect(tx)
        .to.emit(allocator, "AuthorizationSyncFailed")
        .withArgs(provider)
      expect(await allocator.weightDirty(provider)).to.be.true
      expect(await allocator.decreasePending(provider)).to.be.false

      // A later permissionless refresh completes the deferred decrease.
      await mockRegistry.setRevertOnAuthorizationCalls(false)
      await expect(allocator.connect(thirdParty).refreshAuthorization(provider))
        .to.emit(allocator, "WeightDecreaseRequested")
        .withArgs(provider, EQUAL_SEAT_WEIGHT, 0)
      expect(await allocator.decreasePending(provider)).to.be.true
      expect(await allocator.weightDirty(provider)).to.be.false
    })
  })

  describe("reportMaliciousBehavior", () => {
    const perSeatAmount = ethers.utils.parseEther("500")

    it("rejects calls from non-registry callers", async () => {
      await expectCustomError(
        allocator
          .connect(thirdParty)
          .reportMaliciousBehavior(perSeatAmount, 100, notifier.address, [
            provider,
          ]),
        "NotWalletRegistry"
      )
    })

    it("forwards the report to the slashing module and marks weights dirty", async () => {
      await expect(
        mockRegistry.callReportMaliciousBehavior(
          allocator.address,
          perSeatAmount,
          100,
          notifier.address,
          [provider, provider2, provider]
        )
      ).to.emit(allocator, "MaliciousBehaviorReported")

      expect(await slashingModule.reportCallCount()).to.equal(1)
      expect(await slashingModule.lastPerSeatAmount()).to.equal(perSeatAmount)
      expect(await slashingModule.lastRewardMultiplier()).to.equal(100)
      expect(await slashingModule.lastNotifier()).to.equal(notifier.address)
      // Per-seat semantics: duplicates are forwarded as-is, one entry
      // per offending seat.
      expect(await slashingModule.lastStakingProvidersCount()).to.equal(3)
      expect(await slashingModule.lastStakingProviders(0)).to.equal(provider)
      expect(await slashingModule.lastStakingProviders(1)).to.equal(provider2)

      expect(await allocator.weightDirty(provider)).to.be.true
      expect(await allocator.weightDirty(provider2)).to.be.true

      // No registry callbacks may be made on the report path.
      expect(await mockRegistry.increaseCallsCount()).to.equal(0)
      expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(0)
    })

    it("lands the haircut in the vault with duplicate aggregation", async () => {
      await slashingModule.setVault(stakeVault.address)
      await stakeVault.setSelfBond(provider, to18(40_000))

      await mockRegistry.callReportMaliciousBehavior(
        allocator.address,
        perSeatAmount,
        100,
        notifier.address,
        [provider, provider] // two seats
      )

      // 2 seats * 500 T slashed from the self-bond, in one applySlash.
      expect(await stakeVault.selfBondOf(provider)).to.equal(to18(39_000))
      expect(await stakeVault.totalSeized()).to.equal(to18(1_000))
      expect(await stakeVault.applySlashCallCount()).to.equal(1)
    })

    it("never reverts on an empty providers array", async () => {
      await mockRegistry.callReportMaliciousBehavior(
        allocator.address,
        perSeatAmount,
        100,
        notifier.address,
        []
      )
      expect(await slashingModule.reportCallCount()).to.equal(1)
    })

    it("never reverts on an oversized providers array", async () => {
      // 112 entries — beyond the wallet group size the registry can
      // ever produce.
      const providers = new Array(112).fill(provider)
      await mockRegistry.callReportMaliciousBehavior(
        allocator.address,
        perSeatAmount,
        0,
        notifier.address,
        providers
      )
      expect(await slashingModule.reportCallCount()).to.equal(1)
      expect(await slashingModule.lastStakingProvidersCount()).to.equal(112)
      expect(await allocator.weightDirty(provider)).to.be.true
    })

    it("never reverts when the slashing module reverts", async () => {
      await slashingModule.setRevertOnReport(true)

      await expect(
        mockRegistry.callReportMaliciousBehavior(
          allocator.address,
          perSeatAmount,
          100,
          notifier.address,
          [provider]
        )
      ).to.emit(allocator, "SlashReportFailed")

      expect(await slashingModule.reportCallCount()).to.equal(0)
      // The dirty marker still lands so the weight can be refreshed.
      expect(await allocator.weightDirty(provider)).to.be.true
    })

    it("clears the dirty marker on refresh", async () => {
      await mockRegistry.callReportMaliciousBehavior(
        allocator.address,
        perSeatAmount,
        100,
        notifier.address,
        [provider]
      )
      expect(await allocator.weightDirty(provider)).to.be.true

      await allocator.connect(thirdParty).refreshAuthorization(provider)
      expect(await allocator.weightDirty(provider)).to.be.false
    })
  })

  describe("rolesOf", () => {
    it("returns governance, the signer registry beneficiary, and no authorizer", async () => {
      const beneficiary = thirdParty.address
      await signerRegistry.setBeneficiary(provider, beneficiary)

      const roles = await allocator.rolesOf(provider)
      expect(roles.stakeOwner).to.equal(governance.address)
      expect(roles.beneficiary).to.equal(beneficiary)
      expect(roles.authorizer).to.equal(ethers.constants.AddressZero)
    })
  })

  describe("canFinalizeUndelegate", () => {
    it("allows finalization when the provider has no exposure", async () => {
      expect(await allocator.canFinalizeUndelegate(provider, 0)).to.be.true
      expect(await allocator.canFinalizeUndelegate(provider, 5)).to.be.true
    })

    it("gates finalization on live wallet exposure at or before the epoch", async () => {
      const walletID = ethers.utils.id("allocator-wallet-1")
      await exposureLedger
        .connect(ledgerRegistrySigner)
        .onWalletRegistered(walletID, [provider], [3]) // epoch 1

      // Exit requested at epoch 1 (or later) is blocked by the live
      // wallet; an exit requested before the wallet existed is not.
      expect(await allocator.canFinalizeUndelegate(provider, 1)).to.be.false
      expect(await allocator.canFinalizeUndelegate(provider, 9)).to.be.false
      expect(await allocator.canFinalizeUndelegate(provider, 0)).to.be.true

      await exposureLedger
        .connect(ledgerRegistrySigner)
        .onWalletClosed(walletID)
      expect(await allocator.canFinalizeUndelegate(provider, 1)).to.be.true
    })
  })

  // The sortition pool selects at the STORED (stale) leaf weight until someone
  // re-syncs it, and the registry lifts an authorization decrease's clock off
  // type(uint64).max only inside that pool sync — so a wallet whose DKG starts
  // between the exit request and the first pool sync can be selected at the
  // pre-exit weight. Such a phantom wallet is registered at an epoch strictly
  // greater than epochAtRequest, so gating solely on epochAtRequest would let
  // the exiting stake finalize while a wallet it still slashably backs is live.
  // Under flat weight the decrease that opens this window is driven by a
  // SELF-BOND withdrawal crossing minSelfBond (a delegation change never moves
  // the flat seat weight). The allocator closes the window by (a) holding the
  // exit while an authorization decrease is unapproved and (b) lifting the
  // exposure gate to the epoch captured when the registry approves the decrease
  // (proof the pool re-synced first).
  describe("phantom-weight exit gate", () => {
    async function syncEligible(): Promise<void> {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(100_000)) // > minSelfBond
      await allocator.refreshAuthorization(provider) // synced flat weight
    }

    // Queues a self-bond withdrawal that drops the effective self-bond below
    // minSelfBond, collapsing the flat seat weight to 0.
    async function dropBelowSelfBondFloor(): Promise<void> {
      await stakeVault.setPendingSelfBondWithdrawal(provider, to18(70_000))
    }

    it("blocks finalize for a wallet created during the pre-sync window", async () => {
      await syncEligible()

      // The operator backs walletA (epoch 1); the exit is requested against
      // epoch 1.
      const walletA = ethers.utils.id("phantom-A")
      await exposureLedger
        .connect(ledgerRegistrySigner)
        .onWalletRegistered(walletA, [provider], [1])
      const epochAtRequest = await exposureLedger.currentEpoch(provider)
      expect(epochAtRequest).to.equal(1)

      // The operator queues a self-bond withdrawal crossing minSelfBond: the
      // flat weight collapses to 0 and the permissionless refresh files an
      // authorization decrease request.
      await dropBelowSelfBondFloor()
      await allocator.refreshAuthorization(provider)
      expect(await allocator.decreasePending(provider)).to.be.true

      // PHANTOM WINDOW: the pool leaf has not re-synced to the reduced
      // weight, so a DKG selects the operator at the stale weight into
      // walletB (epoch 2).
      const walletB = ethers.utils.id("phantom-B")
      await exposureLedger
        .connect(ledgerRegistrySigner)
        .onWalletRegistered(walletB, [provider], [1])

      // walletA retires; only the phantom walletB remains live.
      await exposureLedger.connect(ledgerRegistrySigner).onWalletClosed(walletA)

      // The bug, made explicit: a gate reading exposure at or before the
      // request epoch alone would already unlock here — walletB sits at
      // epoch 2 > epochAtRequest 1.
      expect(
        await exposureLedger.hasLiveExposureAtOrBefore(provider, epochAtRequest)
      ).to.be.false

      // The fixed gate holds the exit while the decrease is unapproved.
      expect(await allocator.canFinalizeUndelegate(provider, epochAtRequest)).to
        .be.false

      // Registry approves the decrease: the exposure floor is captured at the
      // current epoch (2), which is at or above the phantom walletB's epoch.
      await mockRegistry.callApproveAuthorizationDecrease(
        allocator.address,
        provider
      )
      expect(await allocator.exposureFloorEpoch(provider)).to.equal(2)

      // Still blocked: the floor lifts the gate to epoch 2 and walletB
      // (epoch 2 <= floor 2) is live.
      expect(await allocator.canFinalizeUndelegate(provider, epochAtRequest)).to
        .be.false

      // Once the phantom wallet retires the exit finally unlocks.
      await exposureLedger.connect(ledgerRegistrySigner).onWalletClosed(walletB)
      expect(await allocator.canFinalizeUndelegate(provider, epochAtRequest)).to
        .be.true
    })

    it("allows finalize once the decrease is settled and every backed wallet is closed", async () => {
      await syncEligible()

      const walletA = ethers.utils.id("settled-A")
      await exposureLedger
        .connect(ledgerRegistrySigner)
        .onWalletRegistered(walletA, [provider], [1])
      const epochAtRequest = await exposureLedger.currentEpoch(provider)

      await dropBelowSelfBondFloor()
      await allocator.refreshAuthorization(provider)
      expect(await allocator.decreasePending(provider)).to.be.true

      // No phantom wallet was created: the only backed wallet retires, then
      // the registry approves the decrease (floor captured at epoch 1).
      await exposureLedger.connect(ledgerRegistrySigner).onWalletClosed(walletA)
      await mockRegistry.callApproveAuthorizationDecrease(
        allocator.address,
        provider
      )
      expect(await allocator.exposureFloorEpoch(provider)).to.equal(1)
      expect(await allocator.decreasePending(provider)).to.be.false

      expect(await allocator.canFinalizeUndelegate(provider, epochAtRequest)).to
        .be.true
    })

    it("never permanently locks an exit: a pending decrease clears via permissionless approval", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(100_000))
      await allocator.refreshAuthorization(provider) // synced flat weight

      // The self-bond drops below minSelfBond; a refresh files a decrease that
      // never syncs on its own — modelling an operator whose pool leaf nobody
      // re-syncs.
      await stakeVault.setSelfBond(provider, to18(39_000))
      await allocator.refreshAuthorization(provider)
      expect(await allocator.decreasePending(provider)).to.be.true

      // While the decrease is unapproved the exit is held even with zero
      // live exposure — the safe direction, but NOT permanent.
      expect(await allocator.canFinalizeUndelegate(provider, 0)).to.be.false

      // Approval is permissionless (anyone can sync the pool and drive the
      // registry): once it lands the exit unlocks.
      await mockRegistry.callApproveAuthorizationDecrease(
        allocator.address,
        provider
      )
      expect(await allocator.decreasePending(provider)).to.be.false
      expect(await allocator.canFinalizeUndelegate(provider, 0)).to.be.true
    })
  })

  describe("governed parameters", () => {
    it("updates the equal seat weight via the two-step process", async () => {
      await expect(
        allocator.connect(thirdParty).beginEqualSeatWeightUpdate(to18(80_000))
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await allocator
        .connect(governance)
        .beginEqualSeatWeightUpdate(to18(80_000))

      await expect(
        allocator.connect(governance).finalizeEqualSeatWeightUpdate()
      ).to.be.revertedWith("Governance delay has not elapsed")

      await increaseTime(GOVERNANCE_DELAY)
      await expect(
        allocator.connect(governance).finalizeEqualSeatWeightUpdate()
      )
        .to.emit(allocator, "EqualSeatWeightUpdated")
        .withArgs(to18(80_000))
      expect(await allocator.equalSeatWeight()).to.equal(to18(80_000))

      // The new uniform weight takes effect for every eligible operator,
      // independent of self-bond size or delegation.
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(500_000))
      await stakeVault.setDelegatedAssets(provider, to18(1_000_000))
      expect(await allocator.currentWeight(provider)).to.equal(to18(80_000))
    })

    it("rejects a zero equal seat weight", async () => {
      await expectCustomError(
        allocator.connect(governance).beginEqualSeatWeightUpdate(0),
        "ZeroEqualSeatWeight"
      )
    })

    it("rejects an equal seat weight below the registry minimum", async () => {
      // The mock FROST registry reports a 40k pool-eligibility floor; a
      // target below it would push every eligible operator under the floor
      // and brick wallet formation, so both steps of the setter must reject
      // it (EqualSeatWeightBelowRegistryMinimum).
      await mockRegistry.setMinimumAuthorization(to18(40_000))

      // begin rejects an obviously-invalid target immediately.
      await expectCustomError(
        allocator.connect(governance).beginEqualSeatWeightUpdate(to18(20_000)),
        "EqualSeatWeightBelowRegistryMinimum"
      )

      // finalize re-checks: a target valid at begin time is rejected if the
      // registry minimum rises above it during the governance delay.
      await mockRegistry.setMinimumAuthorization(to18(30_000))
      await allocator
        .connect(governance)
        .beginEqualSeatWeightUpdate(to18(35_000))
      await mockRegistry.setMinimumAuthorization(to18(40_000))
      await increaseTime(GOVERNANCE_DELAY)
      await expectCustomError(
        allocator.connect(governance).finalizeEqualSeatWeightUpdate(),
        "EqualSeatWeightBelowRegistryMinimum"
      )
    })

    it("rejects finalization without a pending update", async () => {
      await expect(
        allocator.connect(governance).finalizeEqualSeatWeightUpdate()
      ).to.be.revertedWith("Change not initiated")
    })
  })
})
