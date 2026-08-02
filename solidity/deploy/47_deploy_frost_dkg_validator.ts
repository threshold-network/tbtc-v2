import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer } = await getNamedAccounts()

  const FrostSortitionPool = await deployments.get("FrostSortitionPool")

  // Phase 0 starts from an incrementally bootstrapped FrostAllowlist whose
  // weights are not guaranteed to be uniform. Keep the rejection-based seat
  // cap disabled until SeatAllocator equal weights and at least 30 eligible
  // operators are live. Governance can then deploy a cap-12 validator and
  // install it through FrostWalletRegistry.updateDkgValidator while DKG is IDLE.
  const FrostDkgValidator = await deployments.deploy("FrostDkgValidator", {
    from: deployer,
    args: [FrostSortitionPool.address, 0],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(FrostDkgValidator)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "FrostDkgValidator",
      address: FrostDkgValidator.address,
    })
  }
}

export default func

func.tags = ["FrostDkgValidator"]
func.dependencies = ["FrostSortitionPool"]
