import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, get } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/solana
  // This ID is valid for both Solana Devnet and Mainnet
  const solanaWormholeChainID = 1
  const polygonWormholeGateway = await get("PolygonWormholeGateway")
  const disabledGateway = ethers.utils.hexZeroPad("0x01", 32)

  if (hre.network.name !== "hardhat") {
    const encodedDisabledGateway = await ethers.provider.call({
      to: polygonWormholeGateway.address,
      data: ethers.utils.id("DISABLED_GATEWAY()").slice(0, 10),
    })

    if (encodedDisabledGateway.toLowerCase() !== disabledGateway) {
      throw new Error(
        "PolygonWormholeGateway must be upgraded before blocking Solana"
      )
    }
  }

  await execute(
    "PolygonWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    solanaWormholeChainID,
    disabledGateway
  )
}

export default func

func.tags = ["BlockSolanaGatewayAddress"]
func.dependencies = ["PolygonWormholeGateway"]
