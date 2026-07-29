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

  async function activate(p: string): Promise<void> {
    await signerRegistry.setOperatorStatus(p, STATUS_ACTIVE)
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
      expect(await allocator.delegationFactor()).to.equal(4)
      expect(await allocator.maxOperatorWeight()).to.equal(to18(2_000_000))
      expect(await allocator.minimumAuthorization()).to.equal(to18(40_000))
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

  describe("currentWeight", () => {
    it("returns 0 for a provider that is not Active, regardless of stake", async () => {
      await stakeVault.setSelfBond(provider, to18(100_000))
      await stakeVault.setDelegatedAssets(provider, to18(100_000))

      for (const status of [STATUS_NONE, STATUS_DEACTIVATING, STATUS_EJECTED]) {
        await signerRegistry.setOperatorStatus(provider, status)
        expect(await allocator.currentWeight(provider)).to.equal(0)
      }
    })

    it("returns the self-bond for a self-bond-only operator at the minimum", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, MIN_SELF_BOND)
      expect(await allocator.currentWeight(provider)).to.equal(MIN_SELF_BOND)
    })

    it("caps delegated capacity at selfBond * delegationFactor", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(40_000))
      await stakeVault.setDelegatedAssets(provider, to18(200_000))
      // raw = 240k, λ cap = 4 * 40k = 160k
      expect(await allocator.currentWeight(provider)).to.equal(to18(160_000))
    })

    it("uses the raw sum when below both caps, net of pending undelegations", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(100_000))
      await stakeVault.setDelegatedAssets(provider, to18(50_000))
      await stakeVault.setPendingUndelegationAssets(provider, to18(20_000))
      // raw = 100k + (50k - 20k) = 130k < λ cap 400k < max 2M
      expect(await allocator.currentWeight(provider)).to.equal(to18(130_000))
    })

    it("caps at maxOperatorWeight", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(1_000_000))
      await stakeVault.setDelegatedAssets(provider, to18(5_000_000))
      // raw = 6M, λ cap = 4M, absolute cap = 2M
      expect(await allocator.currentWeight(provider)).to.equal(to18(2_000_000))
    })

    it("returns 0 when the self-bond is below the minimum self-bond", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(39_999))
      await stakeVault.setDelegatedAssets(provider, to18(500_000))
      expect(await allocator.currentWeight(provider)).to.equal(0)
    })

    it("excludes queued self-bond withdrawals from the effective self-bond", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, MIN_SELF_BOND)
      // 1 wei queued for withdrawal drops the effective self-bond below
      // the minimum — the whole weight collapses to zero.
      await stakeVault.setPendingSelfBondWithdrawal(provider, 1)
      expect(await allocator.currentWeight(provider)).to.equal(0)

      // A larger self-bond with a queued withdrawal keeps only the
      // remainder counting towards the λ cap.
      await stakeVault.setSelfBond(provider, to18(100_000))
      await stakeVault.setPendingSelfBondWithdrawal(provider, to18(60_000))
      await stakeVault.setDelegatedAssets(provider, to18(200_000))
      // effective selfBond = 40k; raw = 240k; λ cap = 160k
      expect(await allocator.currentWeight(provider)).to.equal(to18(160_000))
    })

    it("returns 0 when the weight falls below the minimum authorization", async () => {
      await activate(provider)
      // Lower the vault-side minimum self-bond so only the allocator's
      // minimumAuthorization gate is in play.
      await stakeVault.setMinSelfBond(to18(10_000))
      await stakeVault.setSelfBond(provider, to18(20_000))
      // w = 20k < minimumAuthorization 40k
      expect(await allocator.currentWeight(provider)).to.equal(0)
    })

    it("clamps pending undelegations exceeding delegated assets instead of reverting", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, MIN_SELF_BOND)
      await stakeVault.setDelegatedAssets(provider, to18(10_000))
      await stakeVault.setPendingUndelegationAssets(provider, to18(50_000))
      expect(await allocator.currentWeight(provider)).to.equal(MIN_SELF_BOND)
    })
  })

  // Model B: reward weight tracks the operator's UNCAPPED delegated capital,
  // while seat/signing weight (currentWeight) stays capped exactly as before.
  describe("rewardWeight (Model B)", () => {
    const MAX_UINT96 = ethers.BigNumber.from(2).pow(96).sub(1)

    it("returns the uncapped capital while currentWeight stays λ-capped", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(40_000))
      await stakeVault.setDelegatedAssets(provider, to18(200_000))
      // Seat weight is λ-clamped to 4 * 40k = 160k...
      expect(await allocator.currentWeight(provider)).to.equal(to18(160_000))
      // ...but the reward weight is the full uncapped capital 40k + 200k.
      expect(await allocator.rewardWeight(provider)).to.equal(to18(240_000))
    })

    it("returns the uncapped capital while currentWeight stays at maxOperatorWeight", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(1_000_000))
      await stakeVault.setDelegatedAssets(provider, to18(5_000_000))
      // Seat weight clamps at maxOperatorWeight 2M...
      expect(await allocator.currentWeight(provider)).to.equal(to18(2_000_000))
      // ...reward weight is the full 6M of capital.
      expect(await allocator.rewardWeight(provider)).to.equal(to18(6_000_000))
    })

    it("pays reward proportional to uncapped capital for equal-seat operators", async () => {
      // Two operators with the SAME capped seat weight but different over-cap
      // capital — the core Model-B property.
      await activate(provider)
      await activate(provider2)
      await stakeVault.setSelfBond(provider, to18(1_000_000))
      await stakeVault.setDelegatedAssets(provider, to18(2_000_000)) // raw 3M
      await stakeVault.setSelfBond(provider2, to18(1_000_000))
      await stakeVault.setDelegatedAssets(provider2, to18(5_000_000)) // raw 6M

      // Identical capped seat weight (both clamp to maxOperatorWeight 2M),
      // so signing power / decentralization is unchanged between them.
      expect(await allocator.currentWeight(provider)).to.equal(to18(2_000_000))
      expect(await allocator.currentWeight(provider2)).to.equal(to18(2_000_000))

      // Reward weight tracks the uncapped capital: 3M vs 6M.
      const rw1 = await allocator.rewardWeight(provider)
      const rw2 = await allocator.rewardWeight(provider2)
      expect(rw1).to.equal(to18(3_000_000))
      expect(rw2).to.equal(to18(6_000_000))
      // The higher-capital operator earns strictly more, exactly 2:1.
      expect(rw2.gt(rw1)).to.be.true
      expect(rw2).to.equal(rw1.mul(2))
    })

    it("grows one-for-one with over-cap delegation (no dilution), seat weight unchanged", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(500_000))
      await stakeVault.setDelegatedAssets(provider, to18(1_500_000))
      // Seat weight already at the λ cap (4 * 500k = 2M).
      const seatBefore = await allocator.currentWeight(provider)
      const rewardBefore = await allocator.rewardWeight(provider)
      expect(seatBefore).to.equal(to18(2_000_000))
      expect(rewardBefore).to.equal(to18(2_000_000)) // 500k + 1.5M

      // Add 1M of over-cap delegation.
      await stakeVault.setDelegatedAssets(provider, to18(2_500_000))
      const seatAfter = await allocator.currentWeight(provider)
      const rewardAfter = await allocator.rewardWeight(provider)

      // Seat weight (signing power) is unchanged — the cap holds.
      expect(seatAfter).to.equal(seatBefore)
      // The reward weight grew by exactly the added capital, so the pool's
      // reward slice scales with the new delegation and existing delegators
      // are not diluted (Model A would have kept the capped weight flat, so
      // the added capital earned zero extra pool reward — the dilution cliff).
      expect(rewardAfter.sub(rewardBefore)).to.equal(to18(1_000_000))
    })

    it("keeps a pending exit earning: currentWeight drops, rewardWeight does not", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(100_000))
      await stakeVault.setDelegatedAssets(provider, to18(100_000))
      expect(await allocator.currentWeight(provider)).to.equal(to18(200_000))
      expect(await allocator.rewardWeight(provider)).to.equal(to18(200_000))

      // A delegator queues an undelegation: the seat weight drops immediately
      // (pending undelegation leaves rawWeight), but the capital is still in
      // the pool — slashable AND reward-earning until finalize (design §6).
      await stakeVault.setPendingUndelegationAssets(provider, to18(100_000))
      expect(await allocator.currentWeight(provider)).to.equal(to18(100_000))
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
      // keeps earning (design §6): the seat weight drops but reward weight
      // holds, even with the entire delegation queued to exit.
      await stakeVault.setPendingUndelegationAssets(provider, to18(200_000))
      expect(await allocator.currentWeight(provider)).to.equal(MIN_SELF_BOND)
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
      // capped at maxOperatorWeight (well within range) so the eligibility
      // gate passes, and rewardWeight clamps the overflowing raw sum.
      await stakeVault.setSelfBond(provider, MAX_UINT96)
      await stakeVault.setDelegatedAssets(provider, MAX_UINT96)
      expect(await allocator.currentWeight(provider)).to.equal(to18(2_000_000))
      expect(await allocator.rewardWeight(provider)).to.equal(MAX_UINT96)
    })
  })

  // The rewards distributor is driven with the UNCAPPED reward weight, while
  // the registry sync stays capped.
  describe("refreshAuthorization reward leg (Model B)", () => {
    it("forwards the uncapped reward weight to the distributor on a capped operator", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(40_000))
      await stakeVault.setDelegatedAssets(provider, to18(200_000))

      await allocator.connect(thirdParty).refreshAuthorization(provider)

      // Registry sync (seat weight) is λ-capped at 160k...
      expect(
        await allocator.authorizedWeight(provider, ethers.constants.AddressZero)
      ).to.equal(to18(160_000))
      const increaseCall = await mockRegistry.increaseCalls(0)
      expect(increaseCall.toAmount).to.equal(to18(160_000))
      // ...but the reward leg received the uncapped 240k.
      expect(await rewardsDistributor.lastWeight()).to.equal(to18(240_000))
    })

    it("keeps forwarding the full reward weight when a pending exit drops the seat weight", async () => {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(100_000))
      await stakeVault.setDelegatedAssets(provider, to18(100_000))
      await allocator.refreshAuthorization(provider) // seat + reward = 200k
      expect(await rewardsDistributor.lastWeight()).to.equal(to18(200_000))

      // Queue an undelegation: seat weight halves, reward weight holds.
      await stakeVault.setPendingUndelegationAssets(provider, to18(100_000))
      await allocator.refreshAuthorization(provider)
      // Registry saw a decrease to the capped 100k...
      expect(await allocator.decreasePending(provider)).to.be.true
      expect(await allocator.pendingDecreaseTarget(provider)).to.equal(
        to18(100_000)
      )
      // ...while the distributor still sees the full 200k of earning capital.
      expect(await rewardsDistributor.lastWeight()).to.equal(to18(200_000))
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
        .withArgs(provider, 0, MIN_SELF_BOND)

      expect(await mockRegistry.increaseCallsCount()).to.equal(1)
      const call = await mockRegistry.increaseCalls(0)
      expect(call.stakingProvider).to.equal(provider)
      expect(call.fromAmount).to.equal(0)
      expect(call.toAmount).to.equal(MIN_SELF_BOND)

      expect(
        await allocator.authorizedWeight(provider, ethers.constants.AddressZero)
      ).to.equal(MIN_SELF_BOND)

      expect(await rewardsDistributor.onWeightChangedCallCount()).to.equal(1)
      expect(await rewardsDistributor.lastStakingProvider()).to.equal(provider)
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

    it("files subsequent increases from the synced weight", async () => {
      await allocator.refreshAuthorization(provider)
      await stakeVault.setDelegatedAssets(provider, to18(200_000))

      await expect(allocator.refreshAuthorization(provider))
        .to.emit(allocator, "WeightIncreased")
        .withArgs(provider, MIN_SELF_BOND, to18(160_000))

      expect(
        await allocator.authorizedWeight(provider, ethers.constants.AddressZero)
      ).to.equal(to18(160_000))
    })

    describe("decrease sequencing", () => {
      beforeEach(async () => {
        // Sync 160k, then drop the delegation so the next refresh files
        // a decrease to 40k.
        await stakeVault.setDelegatedAssets(provider, to18(200_000))
        await allocator.refreshAuthorization(provider)
        await stakeVault.setDelegatedAssets(provider, 0)
      })

      it("requests a decrease without changing the synced weight", async () => {
        await expect(allocator.refreshAuthorization(provider))
          .to.emit(allocator, "WeightDecreaseRequested")
          .withArgs(provider, to18(160_000), MIN_SELF_BOND)

        expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(1)
        const call = await mockRegistry.decreaseRequestCalls(0)
        expect(call.fromAmount).to.equal(to18(160_000))
        expect(call.toAmount).to.equal(MIN_SELF_BOND)

        // The registry-known weight MUST stay at the pre-decrease value
        // until the registry approves.
        expect(
          await allocator.authorizedWeight(
            provider,
            ethers.constants.AddressZero
          )
        ).to.equal(to18(160_000))
        expect(await allocator.decreasePending(provider)).to.be.true
        expect(await allocator.pendingDecreaseTarget(provider)).to.equal(
          MIN_SELF_BOND
        )

        // The delegated capital was actually removed (dropped to 0), so the
        // uncapped reward weight legitimately falls to the self-bond. (This is
        // a real capital reduction, not a pending exit — a pending exit would
        // keep earning under Model B; see the rewardWeight suite.)
        expect(await rewardsDistributor.lastWeight()).to.equal(MIN_SELF_BOND)
      })

      it("does not re-request the same decrease target", async () => {
        await allocator.refreshAuthorization(provider)
        await allocator.refreshAuthorization(provider)
        expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(1)
      })

      it("re-points a pending decrease to a new lower target", async () => {
        await allocator.refreshAuthorization(provider) // target 40k
        await stakeVault.setSelfBond(provider, to18(50_000)) // w = 50k

        await allocator.refreshAuthorization(provider)
        expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(2)
        const call = await mockRegistry.decreaseRequestCalls(1)
        expect(call.fromAmount).to.equal(to18(160_000))
        expect(call.toAmount).to.equal(to18(50_000))
        expect(await allocator.pendingDecreaseTarget(provider)).to.equal(
          to18(50_000)
        )

        // Deactivation drops the weight to zero — the pending decrease
        // is re-pointed once more.
        await signerRegistry.setOperatorStatus(provider, STATUS_DEACTIVATING)
        await allocator.refreshAuthorization(provider)
        expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(3)
        expect(await allocator.pendingDecreaseTarget(provider)).to.equal(0)
      })

      it("holds increases while a decrease is pending", async () => {
        await allocator.refreshAuthorization(provider) // decrease to 40k pending

        // Stake recovers above the synced weight while the decrease is
        // pending — the allocator must wait for registry approval, not
        // file an increase.
        await stakeVault.setSelfBond(provider, to18(100_000))
        await stakeVault.setDelegatedAssets(provider, to18(400_000))

        await allocator.refreshAuthorization(provider)
        expect(await mockRegistry.increaseCallsCount()).to.equal(1) // unchanged (only the initial 160k sync)
        expect(await mockRegistry.decreaseRequestCallsCount()).to.equal(1)
        expect(
          await allocator.authorizedWeight(
            provider,
            ethers.constants.AddressZero
          )
        ).to.equal(to18(160_000))
        // Rewards track the UNCAPPED reward weight (Model B): selfBond 100k +
        // delegated 400k = 500k, even though the capped seat weight is
        // λ-clamped to 400k. The registry sync stays capped; only the reward
        // leg goes uncapped.
        expect(await rewardsDistributor.lastWeight()).to.equal(to18(500_000))
      })

      it("finalizes the decrease on registry approval and resumes increases", async () => {
        await allocator.refreshAuthorization(provider) // target 40k

        await expect(
          mockRegistry.callApproveAuthorizationDecrease(
            allocator.address,
            provider
          )
        )
          .to.emit(allocator, "WeightDecreaseFinalized")
          .withArgs(provider, to18(160_000), MIN_SELF_BOND)

        expect(await mockRegistry.lastApprovedWeight()).to.equal(MIN_SELF_BOND)
        expect(
          await allocator.authorizedWeight(
            provider,
            ethers.constants.AddressZero
          )
        ).to.equal(MIN_SELF_BOND)
        expect(await allocator.decreasePending(provider)).to.be.false
        expect(await allocator.pendingDecreaseTarget(provider)).to.equal(0)

        // After approval a stake recovery is filed as a fresh increase.
        await stakeVault.setDelegatedAssets(provider, to18(200_000))
        await expect(allocator.refreshAuthorization(provider))
          .to.emit(allocator, "WeightIncreased")
          .withArgs(provider, MIN_SELF_BOND, to18(160_000))
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
        .withArgs(provider, 0, MIN_SELF_BOND)
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
        .withArgs(provider, MIN_SELF_BOND, 0)
      expect(await allocator.decreasePending(provider)).to.be.true
      expect(await allocator.weightDirty(provider)).to.be.false
    })

    it("survives a reverting registry when re-pointing a pending decrease", async () => {
      // 160k synced, then a decrease to 40k goes pending.
      await stakeVault.setDelegatedAssets(provider, to18(200_000))
      await allocator.refreshAuthorization(provider)
      await stakeVault.setDelegatedAssets(provider, 0)
      await allocator.refreshAuthorization(provider) // target 40k pending

      // The weight drops to zero, but the registry is down — the re-point
      // is deferred and the pending target stays at 40k.
      await signerRegistry.setOperatorStatus(provider, STATUS_DEACTIVATING)
      await mockRegistry.setRevertOnAuthorizationCalls(true)
      await expect(allocator.refreshAuthorization(provider))
        .to.emit(allocator, "AuthorizationSyncFailed")
        .withArgs(provider)
      expect(await allocator.pendingDecreaseTarget(provider)).to.equal(
        MIN_SELF_BOND
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
      ).to.equal(MIN_SELF_BOND)
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
      // registry — the 40k weight gets synced.
      await realRegistry.connect(governance).finalizeOperatorAddition(provider)
      expect(
        await allocator.authorizedWeight(provider, ethers.constants.AddressZero)
      ).to.equal(MIN_SELF_BOND)

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
        .withArgs(provider, MIN_SELF_BOND, 0)
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

  // The sortition pool selects at the STORED (stale) leaf weight until
  // someone re-syncs it, and the registry lifts an authorization decrease's
  // clock off type(uint64).max only inside that pool sync — so a wallet
  // whose DKG starts between requestUndelegate and the first pool sync can
  // be selected at the pre-exit weight. Such a phantom wallet is registered
  // at an epoch strictly greater than epochAtRequest, so gating solely on
  // epochAtRequest would let the exiting stake finalize while a wallet it
  // still slashably backs is live. The allocator closes this by (a) holding
  // the exit while an authorization decrease is unapproved and (b) lifting
  // the exposure gate to the epoch captured when the registry approves the
  // decrease (proof the pool re-synced first).
  describe("phantom-weight exit gate", () => {
    async function syncTwoHundredK(): Promise<void> {
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(100_000))
      await stakeVault.setDelegatedAssets(provider, to18(100_000))
      await allocator.refreshAuthorization(provider) // synced weight 200k
    }

    it("blocks finalize for a wallet created during the pre-sync window", async () => {
      await syncTwoHundredK()

      // The operator backs walletA (epoch 1); the delegator's exit is
      // requested against epoch 1.
      const walletA = ethers.utils.id("phantom-A")
      await exposureLedger
        .connect(ledgerRegistrySigner)
        .onWalletRegistered(walletA, [provider], [1])
      const epochAtRequest = await exposureLedger.currentEpoch(provider)
      expect(epochAtRequest).to.equal(1)

      // The delegator queues an undelegation: the live weight drops and the
      // permissionless refresh files an authorization decrease request.
      await stakeVault.setPendingUndelegationAssets(provider, to18(100_000))
      await allocator.refreshAuthorization(provider)
      expect(await allocator.decreasePending(provider)).to.be.true

      // PHANTOM WINDOW: the pool leaf has not re-synced to the reduced
      // weight, so a DKG selects the operator at the stale (higher) weight
      // into walletB (epoch 2).
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
      await syncTwoHundredK()

      const walletA = ethers.utils.id("settled-A")
      await exposureLedger
        .connect(ledgerRegistrySigner)
        .onWalletRegistered(walletA, [provider], [1])
      const epochAtRequest = await exposureLedger.currentEpoch(provider)

      await stakeVault.setPendingUndelegationAssets(provider, to18(100_000))
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
      await allocator.refreshAuthorization(provider) // synced weight 100k

      // The weight drops; a refresh files a decrease that never syncs on its
      // own — modelling an operator whose pool leaf nobody re-syncs.
      await stakeVault.setSelfBond(provider, to18(40_000))
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
    it("updates the delegation factor via the two-step process", async () => {
      await expect(
        allocator.connect(thirdParty).beginDelegationFactorUpdate(2)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await allocator.connect(governance).beginDelegationFactorUpdate(2)

      await expect(
        allocator.connect(governance).finalizeDelegationFactorUpdate()
      ).to.be.revertedWith("Governance delay has not elapsed")

      await increaseTime(GOVERNANCE_DELAY)
      await expect(
        allocator.connect(governance).finalizeDelegationFactorUpdate()
      )
        .to.emit(allocator, "DelegationFactorUpdated")
        .withArgs(2)
      expect(await allocator.delegationFactor()).to.equal(2)

      // The new factor takes effect in the weight function.
      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(40_000))
      await stakeVault.setDelegatedAssets(provider, to18(200_000))
      expect(await allocator.currentWeight(provider)).to.equal(to18(80_000))
    })

    it("rejects a zero delegation factor", async () => {
      await expectCustomError(
        allocator.connect(governance).beginDelegationFactorUpdate(0),
        "ZeroDelegationFactor"
      )
    })

    it("updates the maximum operator weight via the two-step process", async () => {
      await allocator
        .connect(governance)
        .beginMaxOperatorWeightUpdate(to18(100_000))
      await expect(
        allocator.connect(governance).finalizeMaxOperatorWeightUpdate()
      ).to.be.revertedWith("Governance delay has not elapsed")

      await increaseTime(GOVERNANCE_DELAY)
      await allocator.connect(governance).finalizeMaxOperatorWeightUpdate()
      expect(await allocator.maxOperatorWeight()).to.equal(to18(100_000))

      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(1_000_000))
      await stakeVault.setDelegatedAssets(provider, to18(5_000_000))
      expect(await allocator.currentWeight(provider)).to.equal(to18(100_000))
    })

    it("updates the minimum authorization via the two-step process", async () => {
      await allocator
        .connect(governance)
        .beginMinimumAuthorizationUpdate(to18(200_000))
      await increaseTime(GOVERNANCE_DELAY)
      await allocator.connect(governance).finalizeMinimumAuthorizationUpdate()
      expect(await allocator.minimumAuthorization()).to.equal(to18(200_000))

      await activate(provider)
      await stakeVault.setSelfBond(provider, to18(40_000))
      await stakeVault.setDelegatedAssets(provider, to18(200_000))
      // w = 160k < new minimum 200k → 0
      expect(await allocator.currentWeight(provider)).to.equal(0)
    })

    it("rejects finalization without a pending update", async () => {
      await expect(
        allocator.connect(governance).finalizeDelegationFactorUpdate()
      ).to.be.revertedWith("Change not initiated")
    })
  })
})
