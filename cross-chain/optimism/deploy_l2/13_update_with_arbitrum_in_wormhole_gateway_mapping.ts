import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { execute, log } = deployments
  const { deployer } = await getNamedAccounts()

  // Fake ArbitrumWormholeGateway for local development purposes only.
  const fakeArbitrumWormholeGateway =
    "0x1af5DC16568EFF2d480a43A77E6C409e497FcFb9"

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#arbitrum
  // and https://docs.wormhole.com/wormhole/blockchain-environments/evm#arbitrum-sepolia
  // The value `23` is valid for Arbitrum Mainnet. The value for Arbitrum
  // Sepolia is `10003`.
  const arbitrumWormholeChainID =
    hre.network.name === "optimismSepolia" ? 10003 : 23

  const arbitrumWormholeGateway = await deployments.getOrNull(
    "ArbitrumWormholeGateway"
  )

  let arbitrumWormholeGatewayAddress = arbitrumWormholeGateway?.address
  if (!arbitrumWormholeGatewayAddress && hre.network.name === "hardhat") {
    arbitrumWormholeGatewayAddress = fakeArbitrumWormholeGateway
    log(
      `fake ArbitrumWormholeGateway address ${arbitrumWormholeGatewayAddress}`
    )
  }

  await execute(
    "OptimismWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    arbitrumWormholeChainID,
    ethers.utils.hexZeroPad(arbitrumWormholeGatewayAddress, 32)
  )
}

export default func

func.tags = ["SetArbitrumGatewayAddress"]
func.dependencies = ["OptimismWormholeGateway", "ArbitrumWormholeGateway"]
