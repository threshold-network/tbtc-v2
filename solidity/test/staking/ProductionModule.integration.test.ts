import { randomBytes } from "crypto"
import hre, { ethers, helpers } from "hardhat"
import { expect } from "chai"

const to18 = (value: number | string) => ethers.utils.parseEther(String(value))

describe("Delegated staking production-contract integration", () => {
  it("wires the real module, migrates the real registry, checkpoints a slash, and exits", async function wiresProductionModule() {
    this.timeout(240_000)

    const [deployer, provider, delegator, treasury, notifier] =
      await ethers.getSigners()
    const suffix = randomBytes(8).toString("hex")
    const governanceDelay = 1

    const TokenFactory = await ethers.getContractFactory(
      "contracts/test/staking/StakingFeeMocks.sol:StakingTestToken"
    )
    const tToken = await TokenFactory.connect(deployer).deploy()
    const tbtcToken = await TokenFactory.connect(deployer).deploy()

    const SortitionPoolFactory = await ethers.getContractFactory(
      "@keep-network/sortition-pools/contracts/SortitionPool.sol:SortitionPool"
    )
    const sortitionPool = await SortitionPoolFactory.connect(deployer).deploy(
      tToken.address,
      to18(1)
    )
    await sortitionPool.deactivateChaosnet()

    const ValidatorFactory = await ethers.getContractFactory(
      "FrostDkgValidator"
    )
    const validator = await ValidatorFactory.connect(deployer).deploy(
      sortitionPool.address,
      0
    )
    const InactivityFactory = await ethers.getContractFactory("FrostInactivity")
    const inactivity = await InactivityFactory.connect(deployer).deploy()
    const ExposureFactory = await ethers.getContractFactory(
      "FrostWalletExposure"
    )
    const exposureLibrary = await ExposureFactory.connect(deployer).deploy()

    const [frostWalletRegistry] = await helpers.upgrades.deployProxy(
      `ProductionModuleFrostRegistry_${suffix}`,
      {
        contractName: "FrostWalletRegistry",
        initializerArgs: [
          validator.address,
          deployer.address,
          deployer.address,
          deployer.address,
        ],
        factoryOpts: {
          signer: deployer,
          libraries: {
            FrostInactivity: inactivity.address,
            FrostWalletExposure: exposureLibrary.address,
          },
        },
        proxyOpts: {
          constructorArgs: [sortitionPool.address],
          unsafeAllow: ["external-library-linking"],
          kind: "transparent",
        },
      }
    )
    await sortitionPool.transferOwnership(frostWalletRegistry.address)

    const [frostAllowlist] = await helpers.upgrades.deployProxy(
      `ProductionModuleFrostAllowlist_${suffix}`,
      {
        contractName: "FrostAllowlist",
        initializerArgs: [frostWalletRegistry.address],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    await frostWalletRegistry.initializeV2(frostAllowlist.address)

    const [signerRegistry] = await helpers.upgrades.deployProxy(
      `ProductionModuleSignerRegistry_${suffix}`,
      {
        contractName: "SignerRegistry",
        initializerArgs: [governanceDelay, 30 * 86400, 2500, 500],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    const [stakeVault] = await helpers.upgrades.deployProxy(
      `ProductionModuleStakeVault_${suffix}`,
      {
        contractName: "StakeVault",
        initializerArgs: [tToken.address, tbtcToken.address, governanceDelay],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    const [slashingModule] = await helpers.upgrades.deployProxy(
      `ProductionModuleSlashing_${suffix}`,
      {
        contractName: "SlashingModule",
        initializerArgs: [stakeVault.address, governanceDelay],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    const [walletExposureLedger] = await helpers.upgrades.deployProxy(
      `ProductionModuleLedger_${suffix}`,
      {
        contractName: "WalletExposureLedger",
        initializerArgs: [frostWalletRegistry.address],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    const [seatAllocator] = await helpers.upgrades.deployProxy(
      `ProductionModuleAllocator_${suffix}`,
      {
        contractName: "SeatAllocator",
        initializerArgs: [
          frostWalletRegistry.address,
          signerRegistry.address,
          stakeVault.address,
          slashingModule.address,
          walletExposureLedger.address,
          ethers.constants.AddressZero,
          governanceDelay,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    const [rewardsDistributor] = await helpers.upgrades.deployProxy(
      `ProductionModuleRewards_${suffix}`,
      {
        contractName: "RewardsDistributor",
        initializerArgs: [
          tbtcToken.address,
          stakeVault.address,
          signerRegistry.address,
          seatAllocator.address,
          ethers.constants.AddressZero,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )

    const BankFactory = await ethers.getContractFactory(
      "contracts/test/staking/StakingFeeMocks.sol:StakingMockBank"
    )
    const bank = await BankFactory.connect(deployer).deploy()
    const TbtcVaultFactory = await ethers.getContractFactory(
      "contracts/test/staking/StakingFeeMocks.sol:StakingMockTBTCVault"
    )
    const tbtcVault = await TbtcVaultFactory.connect(deployer).deploy(
      bank.address,
      tbtcToken.address
    )
    const [feeRouter] = await helpers.upgrades.deployProxy(
      `ProductionModuleFeeRouter_${suffix}`,
      {
        contractName: "FeeRouter",
        initializerArgs: [
          bank.address,
          tbtcVault.address,
          tbtcToken.address,
          ethers.constants.AddressZero,
          treasury.address,
          10000,
          governanceDelay,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )

    await signerRegistry.setSeatAllocator(seatAllocator.address)
    await stakeVault.setSignerRegistry(signerRegistry.address)
    await stakeVault.setSeatAllocator(seatAllocator.address)
    await stakeVault.setSlashingModule(slashingModule.address)
    await stakeVault.setRewardsDistributor(rewardsDistributor.address)
    await stakeVault.setWalletExposureLedger(walletExposureLedger.address)
    await slashingModule.setSeatAllocator(seatAllocator.address)
    await seatAllocator.setRewardsDistributor(rewardsDistributor.address)
    await rewardsDistributor.setFeeRouter(feeRouter.address)
    await feeRouter.setRewardsDistributor(rewardsDistributor.address)
    await frostWalletRegistry.setWalletExposureLedger(
      walletExposureLedger.address
    )

    // Activate one real signer and self-bond it while Phase 0 still uses the
    // event-only FrostAllowlist.
    await signerRegistry.beginOperatorAddition(
      provider.address,
      provider.address,
      provider.address,
      0
    )
    await helpers.time.increaseTime(2)
    await signerRegistry.finalizeOperatorAddition(provider.address)

    await tToken.mint(provider.address, to18(40_000))
    await tToken.mint(delegator.address, to18(40_000))
    await tToken.connect(provider).approve(stakeVault.address, to18(40_000))
    await tToken.connect(delegator).approve(stakeVault.address, to18(40_000))
    await stakeVault.connect(provider).depositSelfBond(to18(40_000))

    await frostAllowlist.addStakingProvider(provider.address, to18(40_000))
    await frostWalletRegistry
      .connect(provider)
      .registerOperator(provider.address)
    await frostWalletRegistry.connect(provider).joinSortitionPool()

    // The real registry atomically swaps from its initialized V2 allowlist to
    // the real allocator and rewrites the existing pool leaf.
    await frostWalletRegistry.migrateAuthorizationSource(
      seatAllocator.address,
      [provider.address],
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32[]", "uint256", "uint256"],
        [[], 0, 0]
      )
    )
    expect(await frostWalletRegistry.authorizationSource()).to.equal(
      seatAllocator.address
    )
    expect(await frostWalletRegistry.eligibleStake(provider.address)).to.equal(
      to18(40_000)
    )

    await stakeVault.beginDelegationUpdate(true)
    await slashingModule.beginEconomicSlashingUpdate(true)
    await helpers.time.increaseTime(2)
    await stakeVault.finalizeDelegationUpdate()
    await slashingModule.finalizeEconomicSlashingUpdate()

    await stakeVault.connect(delegator).delegate(provider.address, to18(40_000))
    expect(await rewardsDistributor.weightOf(provider.address)).to.equal(
      to18(80_000)
    )

    // First tranche proves the normal real FeeRouter -> distributor -> vault
    // settlement seam.
    await tbtcToken.mint(feeRouter.address, to18(20))
    await feeRouter.distribute()
    await rewardsDistributor.settleOperator(provider.address)
    expect(
      await stakeVault.claimableRewardsOf(provider.address, provider.address)
    ).to.equal(to18(10))
    expect(
      await stakeVault.claimableRewardsOf(provider.address, delegator.address)
    ).to.equal(to18(10))

    // Leave a second tranche lazy. The slash must checkpoint it against the
    // pre-slash 40k/40k composition, then zero reward weight in the same tx.
    await tbtcToken.mint(feeRouter.address, to18(100))
    await feeRouter.distribute()
    await hre.network.provider.send("hardhat_impersonateAccount", [
      frostWalletRegistry.address,
    ])
    await hre.network.provider.send("hardhat_setBalance", [
      frostWalletRegistry.address,
      "0x56BC75E2D63100000",
    ])
    const registrySigner = await ethers.getSigner(frostWalletRegistry.address)
    await seatAllocator
      .connect(registrySigner)
      .reportMaliciousBehavior(to18(40_000), 0, notifier.address, [
        provider.address,
      ])
    await hre.network.provider.send("hardhat_stopImpersonatingAccount", [
      frostWalletRegistry.address,
    ])

    expect(await stakeVault.selfBondOf(provider.address)).to.equal(0)
    expect(await stakeVault.delegatedAssetsOf(provider.address)).to.equal(
      to18(40_000)
    )
    expect(await rewardsDistributor.weightOf(provider.address)).to.equal(0)
    expect(
      await stakeVault.claimableRewardsOf(provider.address, provider.address)
    ).to.equal(to18(60))
    expect(
      await stakeVault.claimableRewardsOf(provider.address, delegator.address)
    ).to.equal(to18(60))

    const shares = await stakeVault.sharesOf(
      provider.address,
      delegator.address
    )
    await stakeVault
      .connect(delegator)
      .requestUndelegate(provider.address, shares)
    await helpers.time.increaseTime(45 * 86400 + 1)
    await slashingModule.matureSlash(0)
    await stakeVault.connect(delegator).finalizeUndelegate(0)
    expect(await tToken.balanceOf(delegator.address)).to.equal(to18(40_000))

    await stakeVault.connect(delegator).claimRewards(provider.address)
    expect(await tbtcToken.balanceOf(delegator.address)).to.equal(to18(60))
  })
})
