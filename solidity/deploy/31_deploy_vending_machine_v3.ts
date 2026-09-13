import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function deployVendingMachineV3(hre: HardhatRuntimeEnvironment) {
  const { deployments, helpers, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const TBTCToken = await deployments.get("TBTCToken")
  const TBTC = await deployments.get("TBTC") // tBTC v2

  const vendingMachineV3 = await deploy("VendingMachineV3", {
    from: deployer,
    args: [TBTCToken.address, TBTC.address],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(vendingMachineV3)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "VendingMachineV",
      address: vendingMachineV3.address,
    })
  }
}

export default func

func.tags = ["VendingMachineV3"]
func.dependencies = ["TBTCToken", "TBTC"]
