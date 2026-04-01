import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { execute, log } = deployments
  const { deployer } = await getNamedAccounts()

  // Fake OptimismWormholeGateway for local development purposes only.
  const fakeOptimismWormholeGateway =
    "0x1af5DC16568EFF2d480a43A77E6C409e497FcFb9"

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#optimism
  // and https://docs.wormhole.com/wormhole/blockchain-environments/evm#optimism-sepolia
  // The value `24` is valid for Optimism Mainnet. The value for Optimism
  // Sepolia is `10005`.
  const optimismWormholeChainID =
    hre.network.name === "arbitrumSepolia" ? 10005 : 24

  const optimismWormholeGateway = await deployments.getOrNull(
    "OptimismWormholeGateway"
  )

  let optimismWormholeGatewayAddress = optimismWormholeGateway?.address
  if (!optimismWormholeGatewayAddress && hre.network.name === "hardhat") {
    optimismWormholeGatewayAddress = fakeOptimismWormholeGateway
    log(
      `fake OptimismWormholeGateway address ${optimismWormholeGatewayAddress}`
    )
  }

  await execute(
    "ArbitrumWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    optimismWormholeChainID,
    ethers.utils.hexZeroPad(optimismWormholeGatewayAddress, 32)
  )
}

export default func

func.tags = ["SetOptimismGatewayAddress"]
func.dependencies = ["OptimismWormholeGateway", "ArbitrumWormholeGateway"]
