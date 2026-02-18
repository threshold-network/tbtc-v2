import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#optimism
  // and https://docs.wormhole.com/wormhole/blockchain-environments/evm#optimism-sepolia
  // The value `24` is valid for Optimism Mainnet. The value for Optimism
  // Sepolia is `10005`.
  const wormholeChainID = hre.network.name === "optimismSepolia" ? 10005 : 24

  const optimismWormholeGateway = await deployments.get(
    "OptimismWormholeGateway"
  )

  await execute(
    "OptimismWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    wormholeChainID,
    ethers.utils.hexZeroPad(optimismWormholeGateway.address, 32)
  )
}

export default func

func.tags = ["SetOptimismGatewayAddress"]
func.dependencies = ["OptimismWormholeGateway"]
