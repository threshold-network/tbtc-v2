import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { isDisabledGatewaySupported } from "../deploy_helpers/disabled_gateway"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, get } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#arbitrum
  // The value `23` is valid for Arbitrum Mainnet; Arbitrum Sepolia is `10003`.
  const arbitrumWormholeChainID =
    hre.network.name === "optimismSepolia" ? 10003 : 23
  const optimismWormholeGateway = await get("OptimismWormholeGateway")
  const disabledGateway = ethers.utils.hexZeroPad("0x01", 32)

  if (
    !(await isDisabledGatewaySupported(
      hre,
      optimismWormholeGateway.address,
      "OptimismWormholeGateway",
      "Arbitrum",
      disabledGateway
    ))
  ) {
    return
  }

  await execute(
    "OptimismWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    arbitrumWormholeChainID,
    disabledGateway
  )
}

export default func

func.tags = ["BlockArbitrumGatewayAddress", "DeprecateOptimism"]
func.dependencies = ["OptimismWormholeGateway"]
