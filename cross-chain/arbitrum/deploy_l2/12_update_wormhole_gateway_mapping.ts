import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#arbitrum
  // and https://docs.wormhole.com/wormhole/blockchain-environments/evm#arbitrum-sepolia
  // The value `23` is valid for both Arbitrum Mainnet. The value for Arbitrum
  // Sepolia is `10003`.
  const wormholeChainID = hre.network.name === "arbitrumSepolia" ? 10003 : 23

  const ArbitrumWormholeGateway = await deployments.get(
    "ArbitrumWormholeGateway"
  )

  await execute(
    "ArbitrumWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    wormholeChainID,
    ethers.utils.hexZeroPad(ArbitrumWormholeGateway.address, 32)
  )
}

export default func

func.tags = ["SetArbitrumGatewayAddress"]
func.dependencies = ["ArbitrumWormholeGateway"]
