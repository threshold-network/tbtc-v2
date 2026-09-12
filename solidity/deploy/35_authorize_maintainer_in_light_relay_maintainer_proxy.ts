import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import { ethers } from "hardhat"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  const relayMaintainerMainnet = ethers.getAddress(
    "0xCb6Ed7E78d27FDff28127F9CbD61d861F09a2324"
  )

  await execute(
    "LightRelayMaintainerProxy",
    { from: deployer, log: true, waitConfirmations: 1 },
    "authorize",
    relayMaintainerMainnet
  )
}

export default func

func.tags = ["LightRelayMaintainerProxyAuthorizeMaintainer"]
func.dependencies = ["LightRelayMaintainerProxy"]
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name !== "mainnet"
