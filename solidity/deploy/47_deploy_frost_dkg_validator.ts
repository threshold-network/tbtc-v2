import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer } = await getNamedAccounts()

  const FrostSortitionPool = await deployments.get("FrostSortitionPool")

  // maxSeatsPerWallet = 0 keeps the per-wallet seat cap disabled at
  // initial deployment; enabling it is a governance decision executed
  // by deploying a new validator and pointing the registry's DKG
  // library at it.
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
