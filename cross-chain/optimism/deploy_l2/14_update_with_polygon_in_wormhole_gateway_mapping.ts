import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#polygon
  // This ID is valid for both Polygon Goerli-based Testnet (Mumbai) and
  // Mainnet. Wormhole does not support the Sepolia-based Amoy Testnet yet.
  // TODO: Update the ID once the support is added.
  const polygonWormholeChainID = 5

  await execute(
    "OptimismWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    polygonWormholeChainID,
    ethers.constants.HashZero
  )
}

export default func

func.tags = ["ClearPolygonGatewayAddress"]
func.dependencies = ["OptimismWormholeGateway"]
