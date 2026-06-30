import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/solana
  // This ID is valid for both Solana Devnet and Mainnet
  const solanaWormholeChainID = 1

  await execute(
    "PolygonWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    solanaWormholeChainID,
    ethers.constants.HashZero
  )
}

export default func

func.tags = ["ClearSolanaGatewayAddress"]
func.dependencies = ["PolygonWormholeGateway"]
