import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function deployTbtcV2Token(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const tbtc = await deploy("TBTC", {
    from: deployer,
    log: true,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(tbtc)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "TBTC",
      address: tbtc.address,
    })
  }
}

export default func

func.tags = ["TBTC"]
