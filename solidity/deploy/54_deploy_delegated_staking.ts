import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

// Deploys every production staking proxy through an atomic initializer, then
// closes the three address cycles with owner-only set-once wiring. No proxy is
// ever left publicly initializable between transactions.
const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers, getNamedAccounts, helpers } = hre
  const { deployer, governance, treasury } = await getNamedAccounts()
  const signer = await ethers.getSigner(deployer)

  const T = await deployments.get("T")
  const TBTC = await deployments.get("TBTC")
  const Bank = await deployments.get("Bank")
  const TBTCVault = await deployments.get("TBTCVault")
  const FrostWalletRegistry = await deployments.get("FrostWalletRegistry")

  const governanceDelay = hre.network.name === "sepolia" ? 3600 : 172800

  const [signerRegistry] = await helpers.upgrades.deployProxy(
    "SignerRegistry",
    {
      contractName: "SignerRegistry",
      initializerArgs: [governanceDelay, 30 * 24 * 60 * 60, 2500, 500],
      factoryOpts: { signer },
      proxyOpts: { kind: "transparent" },
    }
  )

  const [stakeVault] = await helpers.upgrades.deployProxy("StakeVault", {
    contractName: "StakeVault",
    initializerArgs: [T.address, TBTC.address, governanceDelay],
    factoryOpts: { signer },
    proxyOpts: { kind: "transparent" },
  })

  const [slashingModule] = await helpers.upgrades.deployProxy(
    "SlashingModule",
    {
      contractName: "SlashingModule",
      initializerArgs: [stakeVault.address, governanceDelay],
      factoryOpts: { signer },
      proxyOpts: { kind: "transparent" },
    }
  )

  const [walletExposureLedger] = await helpers.upgrades.deployProxy(
    "WalletExposureLedger",
    {
      contractName: "WalletExposureLedger",
      initializerArgs: [FrostWalletRegistry.address],
      factoryOpts: { signer },
      proxyOpts: { kind: "transparent" },
    }
  )

  const [seatAllocator] = await helpers.upgrades.deployProxy("SeatAllocator", {
    contractName: "SeatAllocator",
    initializerArgs: [
      FrostWalletRegistry.address,
      signerRegistry.address,
      stakeVault.address,
      slashingModule.address,
      walletExposureLedger.address,
      ethers.constants.AddressZero,
      governanceDelay,
    ],
    factoryOpts: { signer },
    proxyOpts: { kind: "transparent" },
  })

  const [rewardsDistributor] = await helpers.upgrades.deployProxy(
    "RewardsDistributor",
    {
      contractName: "RewardsDistributor",
      initializerArgs: [
        TBTC.address,
        stakeVault.address,
        signerRegistry.address,
        seatAllocator.address,
        ethers.constants.AddressZero,
      ],
      factoryOpts: { signer },
      proxyOpts: { kind: "transparent" },
    }
  )

  const [feeRouter] = await helpers.upgrades.deployProxy("FeeRouter", {
    contractName: "FeeRouter",
    initializerArgs: [
      Bank.address,
      TBTCVault.address,
      TBTC.address,
      ethers.constants.AddressZero,
      treasury,
      0, // Phase 3 reward distribution remains default-off.
      governanceDelay,
    ],
    factoryOpts: { signer },
    proxyOpts: { kind: "transparent" },
  })

  await (await signerRegistry.setSeatAllocator(seatAllocator.address)).wait(1)
  await (await stakeVault.setSignerRegistry(signerRegistry.address)).wait(1)
  await (await stakeVault.setSeatAllocator(seatAllocator.address)).wait(1)
  await (await stakeVault.setSlashingModule(slashingModule.address)).wait(1)
  await (
    await stakeVault.setRewardsDistributor(rewardsDistributor.address)
  ).wait(1)
  await (
    await stakeVault.setWalletExposureLedger(walletExposureLedger.address)
  ).wait(1)
  await (await slashingModule.setSeatAllocator(seatAllocator.address)).wait(1)
  await (await slashingModule.setGuardian(governance)).wait(1)
  await (await slashingModule.setRestitutionReserve(treasury)).wait(1)
  await (
    await seatAllocator.setRewardsDistributor(rewardsDistributor.address)
  ).wait(1)
  await (await rewardsDistributor.setFeeRouter(feeRouter.address)).wait(1)
  await (
    await feeRouter.setRewardsDistributor(rewardsDistributor.address)
  ).wait(1)

  // eslint-disable-next-line no-restricted-syntax
  for (const deploymentName of [
    "SignerRegistry",
    "StakeVault",
    "SlashingModule",
    "WalletExposureLedger",
    "SeatAllocator",
    "RewardsDistributor",
    "FeeRouter",
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await helpers.ownable.transferOwnership(
      deploymentName,
      governance,
      deployer
    )
  }
}

export default func

func.tags = ["DelegatedStaking"]
func.dependencies = ["FrostWalletRegistry", "TBTCVault"]
