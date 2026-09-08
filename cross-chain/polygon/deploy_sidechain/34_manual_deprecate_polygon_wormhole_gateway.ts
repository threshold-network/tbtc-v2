import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { ethers } from "ethers"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deployer } = await getNamedAccounts()
  const polygonWormholeGateway = await deployments.get("PolygonWormholeGateway")

  const disabledGateway = ethers.utils.hexZeroPad("0x01", 32)
  // Arbitrum(23), Optimism(24), Base(30), Solana(1) -- matches 13-16_block_*.ts.
  // Ethereum(2) is the preserved exit route and is never touched.
  const chainIds = [23, 24, 30, 1]

  const iface = new ethers.utils.Interface([
    "function updateMintingLimit(uint256 limit)",
    "function updateGatewayAddress(uint16 chainId, bytes32 gatewayAddress)",
  ])

  // updateMintingLimit(0)
  const mintingLimitData = iface.encodeFunctionData("updateMintingLimit", [0])

  deployments.log(
    "Manual updateMintingLimit(0) call:\n" +
      `\t\tfrom: ${deployer}\n` +
      `\t\tto: ${polygonWormholeGateway.address}\n` +
      `\t\tdata: ${mintingLimitData}`
  )

  // updateGatewayAddress(chainId, DISABLED_GATEWAY())
  chainIds.forEach((chainId) => {
    const data = iface.encodeFunctionData("updateGatewayAddress", [
      chainId,
      disabledGateway,
    ])
    deployments.log(
      `Manual updateGatewayAddress(${chainId}, DISABLED_GATEWAY()) call:\n` +
        `\t\tfrom: ${deployer}\n` +
        `\t\tto: ${polygonWormholeGateway.address}\n` +
        `\t\tdata: ${data}`
    )
  })
}

export default func
func.tags = ["ManualDeprecatePolygonWormholeGateway", "DeprecatePolygon"]
func.skip = async () => true
