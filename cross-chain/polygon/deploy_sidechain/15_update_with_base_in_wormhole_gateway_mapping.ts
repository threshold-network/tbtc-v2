import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { execute, log } = deployments
  const { deployer } = await getNamedAccounts()

  // Fake BaseWormholeGateway for local development purposes only.
  const fakeBaseWormholeGateway = "0x2af5DC16568EFF2d480a43A77E6C409e497FcFb9"

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#base
  // This ID is valid for both Base Goerli and Mainnet
  // TODO: check if id is correct for Base Sepolia as well (once Wormhole
  // supports that testnet)
  const baseWormholeChainID = 30

  const baseWormholeGateway = await deployments.getOrNull("BaseWormholeGateway")

  let baseWormholeGatewayAddress = baseWormholeGateway?.address
  if (!baseWormholeGatewayAddress && hre.network.name === "hardhat") {
    baseWormholeGatewayAddress = fakeBaseWormholeGateway
    log(`fake BaseWormholeGateway address ${baseWormholeGatewayAddress}`)
  }

  await execute(
    "PolygonWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    baseWormholeChainID,
    ethers.utils.hexZeroPad(baseWormholeGatewayAddress, 32)
  )
}

export default func

func.tags = ["SetBaseGatewayAddress"]
func.dependencies = ["BaseWormholeGateway"]
