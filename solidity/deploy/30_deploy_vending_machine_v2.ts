import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function deployVendingMachineV2(hre: HardhatRuntimeEnvironment) {
  const { deployments, helpers, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const TBTCToken = await deployments.get("TBTCToken")
  const TBTC = await deployments.get("TBTC") // tBTC v2

  const vendingMachineV2 = await deploy("VendingMachineV2", {
    from: deployer,
    args: [TBTCToken.address, TBTC.address],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(vendingMachineV2)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "VendingMachineV2",
      address: vendingMachineV2.address,
    })
  }
}

export default func

func.tags = ["VendingMachineV2"]
func.dependencies = ["TBTCToken", "TBTC"]
