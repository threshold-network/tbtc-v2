import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function transferLightRelayOwnership(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  await helpers.ownable.transferOwnership("LightRelay", governance, deployer)
}

export default func

func.tags = ["TransferLightRelayOwnership"]
func.dependencies = ["LightRelay"]
func.runAtTheEnd = true

// Only execute for mainnet.
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name !== "mainnet"
