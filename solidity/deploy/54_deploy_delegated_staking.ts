import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import type { Contract } from "ethers"

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

  const attachOrDeployProxy = async (
    name: string,
    contractName: string,
    initializerArgs: unknown[]
  ): Promise<Contract> => {
    const existing = await deployments.getOrNull(name)
    if (existing) {
      return ethers.getContractAt(contractName, existing.address, signer)
    }

    const [instance] = await helpers.upgrades.deployProxy(name, {
      contractName,
      initializerArgs,
      factoryOpts: { signer },
      proxyOpts: { kind: "transparent" },
    })
    return instance
  }

  const setOnce = async (
    contract: Contract,
    getter: string,
    setter: string,
    expected: string
  ): Promise<void> => {
    const current: string = await contract[getter]()
    if (current.toLowerCase() === expected.toLowerCase()) return
    if (current !== ethers.constants.AddressZero) {
      throw new Error(
        `${getter} already points to ${current}; expected ${expected}`
      )
    }
    await (await contract[setter](expected)).wait(1)
  }

  const setIfDifferent = async (
    contract: Contract,
    getter: string,
    setter: string,
    expected: string
  ): Promise<void> => {
    const current: string = await contract[getter]()
    if (current.toLowerCase() !== expected.toLowerCase()) {
      await (await contract[setter](expected)).wait(1)
    }
  }

  const signerRegistry = await attachOrDeployProxy(
    "SignerRegistry",
    "SignerRegistry",
    [governanceDelay, 30 * 24 * 60 * 60, 2500, 500]
  )

  const stakeVault = await attachOrDeployProxy("StakeVault", "StakeVault", [
    T.address,
    TBTC.address,
    governanceDelay,
  ])

  const slashingModule = await attachOrDeployProxy(
    "SlashingModule",
    "SlashingModule",
    [stakeVault.address, governanceDelay]
  )

  const walletExposureLedger = await attachOrDeployProxy(
    "WalletExposureLedger",
    "WalletExposureLedger",
    [FrostWalletRegistry.address]
  )

  const seatAllocator = await attachOrDeployProxy(
    "SeatAllocator",
    "SeatAllocator",
    [
      FrostWalletRegistry.address,
      signerRegistry.address,
      stakeVault.address,
      slashingModule.address,
      walletExposureLedger.address,
      ethers.constants.AddressZero,
      governanceDelay,
    ]
  )

  const rewardsDistributor = await attachOrDeployProxy(
    "RewardsDistributor",
    "RewardsDistributor",
    [
      TBTC.address,
      stakeVault.address,
      signerRegistry.address,
      seatAllocator.address,
      ethers.constants.AddressZero,
    ]
  )

  const feeRouter = await attachOrDeployProxy("FeeRouter", "FeeRouter", [
    Bank.address,
    TBTCVault.address,
    TBTC.address,
    ethers.constants.AddressZero,
    treasury,
    0, // Phase 3 reward distribution remains default-off.
    governanceDelay,
  ])

  await setOnce(
    signerRegistry,
    "seatAllocator",
    "setSeatAllocator",
    seatAllocator.address
  )
  await setOnce(
    stakeVault,
    "signerRegistry",
    "setSignerRegistry",
    signerRegistry.address
  )
  await setOnce(
    stakeVault,
    "seatAllocator",
    "setSeatAllocator",
    seatAllocator.address
  )
  await setOnce(
    stakeVault,
    "slashingModule",
    "setSlashingModule",
    slashingModule.address
  )
  await setOnce(
    stakeVault,
    "rewardsDistributor",
    "setRewardsDistributor",
    rewardsDistributor.address
  )
  await setOnce(
    stakeVault,
    "walletExposureLedger",
    "setWalletExposureLedger",
    walletExposureLedger.address
  )
  await setOnce(
    slashingModule,
    "seatAllocator",
    "setSeatAllocator",
    seatAllocator.address
  )
  await setIfDifferent(slashingModule, "guardian", "setGuardian", governance)
  await setIfDifferent(
    slashingModule,
    "restitutionReserve",
    "setRestitutionReserve",
    treasury
  )
  await setOnce(
    seatAllocator,
    "rewardsDistributor",
    "setRewardsDistributor",
    rewardsDistributor.address
  )
  await setOnce(
    rewardsDistributor,
    "feeRouter",
    "setFeeRouter",
    feeRouter.address
  )
  await setOnce(
    feeRouter,
    "rewardsDistributor",
    "setRewardsDistributor",
    rewardsDistributor.address
  )

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
