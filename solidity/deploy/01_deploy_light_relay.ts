import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function deployLightRelay(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer } = await getNamedAccounts()

  function resolveRelayContract() {
    if (hre.network.name === "sepolia") {
      return "SepoliaLightRelay"
    }
    if (hre.network.name === "system_tests") {
      return "SystemTestRelay"
    }

    return "LightRelay"
  }

  const lightRelay = await deployments.deploy("LightRelay", {
    contract: resolveRelayContract(),
    from: deployer,
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(lightRelay)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: resolveRelayContract(),
      address: lightRelay.address,
    })
  }
}

export default func

func.tags = ["LightRelay"]
