import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy, getOrNull } = deployments
  const { deployer } = await getNamedAccounts()

  const existing = await getOrNull("Redemption")
  if (existing) {
    console.log("Existing Redemption library at:", existing.address)
  }

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
    skipIfAlreadyDeployed: false,
  }

  const Redemption = await deploy("Redemption", deployOptions)
  console.log("Redemption library deployed at:", Redemption.address)

  if (hre.network.tags.etherscan) {
    try {
      await helpers.etherscan.verify(Redemption)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("Redemption verification failed:", message)
      throw error
    }
  }
}

export default func

func.tags = ["RedemptionLibrary"]
