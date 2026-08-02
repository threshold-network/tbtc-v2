import { randomBytes } from "crypto"
import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import type { BigNumber } from "ethers"
import { to1e18 } from "../helpers/contract-test-helpers"

// Model B end-to-end: the capped-seat / uncapped-reward property proven
// through the REAL SeatAllocator and the REAL RewardsDistributor wired
// together over a real ERC-20. The SeatAllocator suite proves the allocator
// computes an uncapped rewardWeight while keeping currentWeight λ-capped, and
// the RewardsDistributor suite proves the distributor splits a tranche pro
// rata to the weight it is fed. This test closes the loop: it feeds the
// distributor the REAL allocator's rewardWeight and asserts revenue (and the
// delegators' claimable yield) splits by UNCAPPED capital while the registry
// authorization stays equal (decentralization preserved).
//
// Real vs mocked:
//   REAL   — SeatAllocator (currentWeight + rewardWeight), RewardsDistributor
//            (accrual, commission/delegator split, ERC-20 transfers), the TBTC
//            token, and the capital source the allocator reads.
//   MOCKED — the SeatAllocator <-> RewardsDistributor mutual constructor
//            reference cannot be closed in one deployment (neither contract has
//            a setter, so their init addresses are circular). We therefore
//            authorize the harness as the distributor's `seatAllocator` and
//            forward the allocator's REAL `rewardWeight(p)` into it, instead of
//            letting `refreshAuthorization` make that call. To show the value
//            is faithful to the production path, we ALSO run the real
//            `refreshAuthorization` and assert the weight it forwards to the
//            allocator's own (recording) distributor equals the value we feed
//            the real distributor. The stake vault, signer registry, and FROST
//            wallet registry are the module's settable test stubs.

const STATUS_ACTIVE = 1
const uniqueSuffix = (): string => randomBytes(8).toString("hex")

describe("Model B reward weighting (real SeatAllocator + real RewardsDistributor)", () => {
  let deployer: SignerWithAddress
  let feeRouter: SignerWithAddress
  let provider1: SignerWithAddress
  let provider2: SignerWithAddress

  let token: any
  let stakeVault: any
  let signerRegistry: any
  let walletRegistry: any
  let slashingModule: any
  let exposureLedger: any
  let allocatorRewardSink: any
  let seatAllocator: any
  let rewardsDistributor: any

  const to18 = (n: number | string): BigNumber =>
    ethers.utils.parseEther(String(n))

  const MIN_SELF_BOND = to18(40_000)
  // Option B: seat weight is FLAT — both operators get the same
  // equalSeatWeight regardless of delegation — while their capital differs
  // 2:1 (6M vs 3M reward weight). Signing power is uniform; rewards are not.
  const SELF_BOND = to18(1_000_000)
  const DELEGATED_1 = to18(5_000_000) // uncapped reward weight 6M
  const DELEGATED_2 = to18(2_000_000) // uncapped reward weight 3M
  const REWARD_WEIGHT_1 = to18(6_000_000)
  const REWARD_WEIGHT_2 = to18(3_000_000)
  const EQUAL_SEAT_WEIGHT = to18(40_000) // flat seat weight for both
  const COMMISSION_BPS = 1000 // 10%

  const fixture = async () => {
    const signers = await ethers.getSigners()
    ;[deployer, feeRouter, provider1, provider2] = signers

    const TokenFactory = await ethers.getContractFactory(
      "contracts/test/staking/StakingFeeMocks.sol:StakingTestToken"
    )
    token = await TokenFactory.connect(deployer).deploy()

    const StakeVaultFactory = await ethers.getContractFactory(
      "StakingMockStakeVault"
    )
    stakeVault = await StakeVaultFactory.connect(deployer).deploy()
    await stakeVault.setMinSelfBond(MIN_SELF_BOND)

    const SignerRegistryFactory = await ethers.getContractFactory(
      "StakingMockSignerRegistry"
    )
    signerRegistry = await SignerRegistryFactory.connect(deployer).deploy()

    const WalletRegistryFactory = await ethers.getContractFactory(
      "StakingMockWalletRegistry"
    )
    walletRegistry = await WalletRegistryFactory.connect(deployer).deploy()

    const SlashingModuleFactory = await ethers.getContractFactory(
      "StakingMockSlashingModule"
    )
    slashingModule = await SlashingModuleFactory.connect(deployer).deploy()

    // Recording distributor wired into the allocator's own reward leg. It
    // stands in for the real distributor ONLY on the allocator's constructor
    // reference (see the "real vs mocked" note); we read back the weight it
    // received to prove the value we feed the real distributor is exactly what
    // `refreshAuthorization` forwards.
    const RewardSinkFactory = await ethers.getContractFactory(
      "StakingMockRewardsDistributor"
    )
    allocatorRewardSink = await RewardSinkFactory.connect(deployer).deploy()

    const suffix = uniqueSuffix()
    const [ledgerInstance] = await helpers.upgrades.deployProxy(
      `RewardsModelBLedger_${suffix}`,
      {
        contractName: "WalletExposureLedger",
        initializerArgs: [walletRegistry.address],
        proxyOpts: { kind: "transparent" },
      }
    )
    exposureLedger = ledgerInstance

    const [allocatorInstance] = await helpers.upgrades.deployProxy(
      `RewardsModelBAllocator_${suffix}`,
      {
        contractName: "SeatAllocator",
        initializerArgs: [
          walletRegistry.address,
          signerRegistry.address,
          stakeVault.address,
          slashingModule.address,
          exposureLedger.address,
          allocatorRewardSink.address,
          604_800,
        ],
        proxyOpts: { kind: "transparent" },
      }
    )
    seatAllocator = allocatorInstance

    // The real distributor authorizes the harness (`deployer`) as its
    // seat allocator so we can forward the real allocator's rewardWeight.
    const [distributorInstance] = await helpers.upgrades.deployProxy(
      `RewardsModelBDistributor_${suffix}`,
      {
        contractName: "RewardsDistributor",
        initializerArgs: [
          token.address,
          stakeVault.address,
          signerRegistry.address,
          deployer.address,
          feeRouter.address,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    rewardsDistributor = distributorInstance

    return {
      token,
      stakeVault,
      signerRegistry,
      walletRegistry,
      seatAllocator,
      rewardsDistributor,
      allocatorRewardSink,
    }
  }

  // Notifies a reward the way the fee router does: transfer first, then
  // account for it.
  async function notify(amount: BigNumber): Promise<void> {
    await token.mint(rewardsDistributor.address, amount)
    await rewardsDistributor.connect(feeRouter).notifyReward(amount)
  }

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      token,
      stakeVault,
      signerRegistry,
      walletRegistry,
      seatAllocator,
      rewardsDistributor,
      allocatorRewardSink,
    } = await waffle.loadFixture(fixture))

    // Two active, allowlisted operators with the SAME capped seat weight but
    // 2:1 over-cap capital.
    await signerRegistry.setOperatorStatus(provider1.address, STATUS_ACTIVE)
    await signerRegistry.setOperatorStatus(provider2.address, STATUS_ACTIVE)
    await stakeVault.setSelfBond(provider1.address, SELF_BOND)
    await stakeVault.setSelfBond(provider2.address, SELF_BOND)
    await stakeVault.setDelegatedAssets(provider1.address, DELEGATED_1)
    await stakeVault.setDelegatedAssets(provider2.address, DELEGATED_2)
    await signerRegistry.setCommissionBps(provider1.address, COMMISSION_BPS)
    await signerRegistry.setCommissionBps(provider2.address, COMMISSION_BPS)
  })

  it("keeps the flat seat weight equal for both operators (decentralization preserved)", async () => {
    // The REAL allocator: both operators receive the same flat seat weight
    // even though their capital differs 2:1.
    expect(await seatAllocator.currentWeight(provider1.address)).to.equal(
      EQUAL_SEAT_WEIGHT
    )
    expect(await seatAllocator.currentWeight(provider2.address)).to.equal(
      EQUAL_SEAT_WEIGHT
    )

    // refreshAuthorization files the FLAT seat weight to the registry —
    // equal authorization, so signing power / decentralization is identical.
    await seatAllocator.refreshAuthorization(provider1.address)
    // The allocator's own reward leg forwarded the UNCAPPED reward weight;
    // capture it to prove the value we later feed the real distributor is
    // exactly what the production path forwards.
    expect(await allocatorRewardSink.lastWeight()).to.equal(REWARD_WEIGHT_1)

    await seatAllocator.refreshAuthorization(provider2.address)
    expect(await allocatorRewardSink.lastWeight()).to.equal(REWARD_WEIGHT_2)

    const auth1 = await seatAllocator.authorizedWeight(
      provider1.address,
      provider1.address
    )
    const auth2 = await seatAllocator.authorizedWeight(
      provider2.address,
      provider2.address
    )
    expect(auth1).to.equal(EQUAL_SEAT_WEIGHT)
    expect(auth2).to.equal(auth1)

    // The registry saw the same flat increase for both.
    expect(await walletRegistry.increaseCallsCount()).to.equal(2)
    expect((await walletRegistry.increaseCalls(0)).toAmount).to.equal(
      EQUAL_SEAT_WEIGHT
    )
    expect((await walletRegistry.increaseCalls(1)).toAmount).to.equal(
      EQUAL_SEAT_WEIGHT
    )
  })

  it("splits reward accrual and delegator yield by UNCAPPED capital, not by the equal seat weight", async () => {
    // Feed the REAL distributor the REAL allocator's rewardWeight (uncapped).
    // The value equals what refreshAuthorization forwarded above; only the
    // caller identity is the harness (see the "real vs mocked" note).
    const rw1 = await seatAllocator.rewardWeight(provider1.address)
    const rw2 = await seatAllocator.rewardWeight(provider2.address)
    expect(rw1).to.equal(REWARD_WEIGHT_1)
    expect(rw2).to.equal(REWARD_WEIGHT_2)
    expect(rw1).to.equal(rw2.mul(2))

    await rewardsDistributor
      .connect(deployer)
      .onWeightChanged(provider1.address, rw1)
    await rewardsDistributor
      .connect(deployer)
      .onWeightChanged(provider2.address, rw2)

    // Sanity: the distributor's total weight is the sum of the UNCAPPED
    // weights (9M), not the sum of the capped seat weights (4M).
    expect(await rewardsDistributor.totalWeight()).to.equal(to18(9_000_000))

    // One reward tranche of 900 TBTC.
    await notify(to18(900))

    const pending1 = await rewardsDistributor.pendingRewardOf(provider1.address)
    const pending2 = await rewardsDistributor.pendingRewardOf(provider2.address)

    // Accrual splits 2:1 by uncapped capital (600 / 300) — NOT 1:1 by the
    // equal capped seat weight, which would have paid 450 / 450.
    expect(pending1).to.equal(to18(600))
    expect(pending2).to.equal(to18(300))
    expect(pending1).to.equal(pending2.mul(2))
    expect(pending1).to.not.equal(to18(450))

    // Settle both: the delegator share (transferred to the vault) and the
    // operator commission both split 2:1 — the delegators' claimable yield
    // tracks uncapped capital.
    const vaultBefore = await token.balanceOf(stakeVault.address)

    await expect(rewardsDistributor.settleOperator(provider1.address))
      .to.emit(rewardsDistributor, "OperatorSettled")
      .withArgs(provider1.address, to18(60), to18(540))
    const vaultAfterP1 = await token.balanceOf(stakeVault.address)
    expect(vaultAfterP1.sub(vaultBefore)).to.equal(to18(540))

    await expect(rewardsDistributor.settleOperator(provider2.address))
      .to.emit(rewardsDistributor, "OperatorSettled")
      .withArgs(provider2.address, to18(30), to18(270))
    const vaultAfterP2 = await token.balanceOf(stakeVault.address)
    expect(vaultAfterP2.sub(vaultAfterP1)).to.equal(to18(270))

    // Delegator yield 540 : 270 == 2 : 1, and operator commission 60 : 30 too.
    expect(vaultAfterP1.sub(vaultBefore)).to.equal(
      vaultAfterP2.sub(vaultAfterP1).mul(2)
    )
    const commission1 = await rewardsDistributor.operatorCommission(
      provider1.address
    )
    const commission2 = await rewardsDistributor.operatorCommission(
      provider2.address
    )
    expect(commission1).to.equal(to18(60))
    expect(commission2).to.equal(to18(30))
    expect(commission1).to.equal(commission2.mul(2))

    // Decentralization is still intact: the registry authorization the two
    // operators hold is equal, despite the 2:1 revenue split.
    const auth1 = await seatAllocator.authorizedWeight(
      provider1.address,
      provider1.address
    )
    const auth2 = await seatAllocator.authorizedWeight(
      provider2.address,
      provider2.address
    )
    expect(auth1).to.equal(EQUAL_SEAT_WEIGHT)
    expect(auth2).to.equal(auth1)
  })
})
