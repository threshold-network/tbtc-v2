import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function deployTbtcVault(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const Bank = await deployments.get("Bank")
  const TBTC = await deployments.get("TBTC")
  const Bridge = await deployments.get("Bridge")

  const tbtcVault = await deploy("TBTCVault", {
    contract: "TBTCVault",
    from: deployer,
    args: [Bank.address, TBTC.address, Bridge.address],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(tbtcVault)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "TBTCVault",
      address: tbtcVault.address,
    })
  }
}

export default func

func.tags = ["TBTCVault"]
func.dependencies = ["Bank", "TBTC"]
