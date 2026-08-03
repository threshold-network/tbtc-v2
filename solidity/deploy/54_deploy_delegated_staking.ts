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

  // This exported tag is intentionally recovery-only: prerequisite deployment
  // tags contain non-idempotent proxy helpers and must not be traversed again.
  // Validate that the complete Phase-0 registry handoff already happened
  // before writing any delegated-staking deployment record.
  const frostWalletRegistry = await ethers.getContractAt(
    "FrostWalletRegistry",
    FrostWalletRegistry.address,
    signer
  )
  const [authorizationSource, lifecycleOwner, registryGovernance] =
    await Promise.all([
      frostWalletRegistry.authorizationSource(),
      frostWalletRegistry.lifecycleOwner(),
      frostWalletRegistry.governance(),
    ])
  if (authorizationSource === ethers.constants.AddressZero) {
    throw new Error("FrostWalletRegistry authorization source is not ready")
  }
  if (lifecycleOwner === ethers.constants.AddressZero) {
    throw new Error("FrostWalletRegistry lifecycle owner is not ready")
  }
  if (registryGovernance.toLowerCase() !== governance.toLowerCase()) {
    throw new Error(
      `FrostWalletRegistry governance is ${registryGovernance}; expected ${governance}`
    )
  }

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

  const existingSlashingModule = await deployments.getOrNull("SlashingModule")
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
  const slashingOwner: string = await slashingModule.owner()
  const ownerIsDeployer = slashingOwner.toLowerCase() === deployer.toLowerCase()
  const ownerIsGovernance =
    slashingOwner.toLowerCase() === governance.toLowerCase()
  if (!ownerIsDeployer && !ownerIsGovernance) {
    throw new Error(
      `SlashingModule owner is ${slashingOwner}; expected ${deployer} or ${governance}`
    )
  }

  const guardian: string = await slashingModule.guardian()
  const restitutionReserve: string = await slashingModule.restitutionReserve()
  const sameDeploymentAndGovernanceActor =
    deployer.toLowerCase() === governance.toLowerCase()
  const initializeSlashingDefaults =
    !existingSlashingModule ||
    (ownerIsDeployer && !sameDeploymentAndGovernanceActor) ||
    guardian === ethers.constants.AddressZero ||
    restitutionReserve === ethers.constants.AddressZero

  if (initializeSlashingDefaults) {
    if (!ownerIsDeployer) {
      throw new Error(
        "SlashingModule defaults are unset after governance ownership handoff"
      )
    }
    await setIfDifferent(slashingModule, "guardian", "setGuardian", governance)
    await setIfDifferent(
      slashingModule,
      "restitutionReserve",
      "setRestitutionReserve",
      treasury
    )
  }
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
