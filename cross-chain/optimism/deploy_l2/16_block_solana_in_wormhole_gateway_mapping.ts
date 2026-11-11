import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { isDisabledGatewaySupported } from "../deploy_helpers/disabled_gateway"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, get } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/solana
  // This ID is valid for both Solana Devnet and Mainnet
  const solanaWormholeChainID = 1
  const optimismWormholeGateway = await get("OptimismWormholeGateway")
  const disabledGateway = ethers.utils.hexZeroPad("0x01", 32)

  if (
    !(await isDisabledGatewaySupported(
      hre,
      optimismWormholeGateway.address,
      "OptimismWormholeGateway",
      "Solana",
      disabledGateway
    ))
  ) {
    return
  }

  await execute(
    "OptimismWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    solanaWormholeChainID,
    disabledGateway
  )
}

export default func

func.tags = ["BlockSolanaGatewayAddress", "DeprecateOptimism"]
func.dependencies = ["OptimismWormholeGateway"]

// Solana is outside the supported Sepolia routing topology.
func.skip = async (hre) => hre.network.name === "optimismSepolia"
