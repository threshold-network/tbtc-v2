import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, helpers, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")

  // EcdsaFraudRouter is a plain (non-upgradeable) contract that
  // pins the Bridge address at construction. Post-slice-2, it no
  // longer calls back into Bridge and there is no Bridge-side router
  // setter to run after deployment.
  const ecdsaFraudRouter = await deploy("EcdsaFraudRouter", {
    from: deployer,
    args: [Bridge.address],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(ecdsaFraudRouter)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "EcdsaFraudRouter",
      address: ecdsaFraudRouter.address,
    })
  }
}

export default func

func.tags = ["EcdsaFraudRouter"]
func.dependencies = ["Bridge"]
