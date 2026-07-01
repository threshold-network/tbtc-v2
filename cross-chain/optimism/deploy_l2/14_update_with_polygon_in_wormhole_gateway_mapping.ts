import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, get } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#polygon
  // This ID is valid for both Polygon Goerli-based Testnet (Mumbai) and
  // Mainnet. Wormhole does not support the Sepolia-based Amoy Testnet yet.
  // TODO: Update the ID once the support is added.
  const polygonWormholeChainID = 5
  const optimismWormholeGateway = await get("OptimismWormholeGateway")
  const disabledGateway = ethers.utils.hexZeroPad("0x01", 32)

  if (hre.network.name !== "hardhat") {
    const encodedDisabledGateway = await ethers.provider.call({
      to: optimismWormholeGateway.address,
      data: ethers.utils.id("DISABLED_GATEWAY()").slice(0, 10),
    })

    if (encodedDisabledGateway.toLowerCase() !== disabledGateway) {
      throw new Error(
        "OptimismWormholeGateway must be upgraded before blocking Polygon"
      )
    }
  }

  await execute(
    "OptimismWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    polygonWormholeChainID,
    disabledGateway
  )
}

export default func

func.tags = ["BlockPolygonGatewayAddress"]
func.dependencies = ["OptimismWormholeGateway"]
