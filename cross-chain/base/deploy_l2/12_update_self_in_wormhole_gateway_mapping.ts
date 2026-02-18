import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#base and
  // https://docs.wormhole.com/wormhole/blockchain-environments/evm#base-sepolia
  // The value `30` is valid for Base Mainnet. The value for Base Sepolia is
  // `10004`.
  const wormholeChainID = hre.network.name === "baseSepolia" ? 10004 : 30

  const baseWormholeGateway = await deployments.get("BaseWormholeGateway")

  await execute(
    "BaseWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    wormholeChainID,
    ethers.utils.hexZeroPad(baseWormholeGateway.address, 32)
  )
}

export default func

func.tags = ["SetBaseGatewayAddress"]
func.dependencies = ["BaseWormholeGateway"]
