import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#base
  // This ID is valid for both Base Goerli and Mainnet
  const baseWormholeChainID = 30

  await execute(
    "PolygonWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    baseWormholeChainID,
    ethers.constants.HashZero
  )
}

export default func

func.tags = ["ClearBaseGatewayAddress"]
func.dependencies = ["PolygonWormholeGateway"]
