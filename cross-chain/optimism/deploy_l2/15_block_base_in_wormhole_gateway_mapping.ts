import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { isDisabledGatewaySupported } from "../deploy_helpers/disabled_gateway"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, get } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#base
  // The value `30` is valid for Base Mainnet; Base Sepolia is `10004`.
  const baseWormholeChainID =
    hre.network.name === "optimismSepolia" ? 10004 : 30
  const optimismWormholeGateway = await get("OptimismWormholeGateway")
  const disabledGateway = ethers.utils.hexZeroPad("0x01", 32)

  if (
    !(await isDisabledGatewaySupported(
      hre,
      optimismWormholeGateway.address,
      "OptimismWormholeGateway",
      "Base",
      disabledGateway
    ))
  ) {
    return
  }

  await execute(
    "OptimismWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    baseWormholeChainID,
    disabledGateway
  )
}

export default func

func.tags = ["BlockBaseGatewayAddress", "DeprecateOptimism"]
func.dependencies = ["OptimismWormholeGateway"]
