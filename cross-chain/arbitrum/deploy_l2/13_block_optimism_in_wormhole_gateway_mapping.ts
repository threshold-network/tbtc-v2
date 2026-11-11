import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { isDisabledGatewaySupported } from "../../deploy_helpers/disabled_gateway"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, get } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#optimism
  // The value `24` is valid for Optimism Mainnet; Optimism Sepolia is `10005`.
  const optimismWormholeChainID =
    hre.network.name === "arbitrumSepolia" ? 10005 : 24
  const arbitrumWormholeGateway = await get("ArbitrumWormholeGateway")
  const disabledGateway = ethers.utils.hexZeroPad("0x01", 32)

  if (
    !(await isDisabledGatewaySupported(
      hre,
      arbitrumWormholeGateway.address,
      "ArbitrumWormholeGateway",
      "Optimism",
      disabledGateway
    ))
  ) {
    return
  }

  await execute(
    "ArbitrumWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    optimismWormholeChainID,
    disabledGateway
  )
}

export default func

func.tags = ["BlockOptimismGatewayAddress", "DeprecateOptimism"]
func.dependencies = ["ArbitrumWormholeGateway"]
