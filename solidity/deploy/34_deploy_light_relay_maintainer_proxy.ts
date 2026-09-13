import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function deployLightRelayMaintainerProxy(hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const ReimbursementPool = await deployments.get("ReimbursementPool")
  const LightRelay = await deployments.get("LightRelay")

  const lightRelayMaintainerProxy = await deploy("LightRelayMaintainerProxy", {
    contract: "LightRelayMaintainerProxy",
    from: deployer,
    args: [LightRelay.address, ReimbursementPool.address],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(lightRelayMaintainerProxy)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "LightRelayMaintainerProxy",
      address: lightRelayMaintainerProxy.address,
    })
  }
}

export default func

func.tags = ["LightRelayMaintainerProxy"]
func.dependencies = ["LightRelay", "ReimbursementPool"]
