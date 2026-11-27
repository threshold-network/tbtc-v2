import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { ethers } from "ethers"
import { isDisabledGatewaySupported } from "../deploy_helpers/disabled_gateway"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments } = hre
  const polygonWormholeGateway = await deployments.get("PolygonWormholeGateway")
  // On live deployments the owner is a governance Safe, not the deployer.
  const owner: string = await deployments.read(
    "PolygonWormholeGateway",
    "owner"
  )

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
      `\t\tfrom: ${owner}\n` +
      `\t\tto: ${polygonWormholeGateway.address}\n` +
      `\t\tdata: ${mintingLimitData}`
  )

  // A gateway without DISABLED_GATEWAY support treats the sentinel as a real
  // peer and sends every later transfer to 0x...01, where nobody can redeem
  // it, so the mapping calls are printed only for an upgraded gateway.
  if (
    !(await isDisabledGatewaySupported(
      hre,
      polygonWormholeGateway.address,
      "PolygonWormholeGateway",
      "Arbitrum, Optimism, Base and Solana",
      disabledGateway
    ))
  ) {
    return
  }

  // updateGatewayAddress(chainId, DISABLED_GATEWAY())
  chainIds.forEach((chainId) => {
    const data = iface.encodeFunctionData("updateGatewayAddress", [
      chainId,
      disabledGateway,
    ])
    deployments.log(
      `Manual updateGatewayAddress(${chainId}, DISABLED_GATEWAY()) call:\n` +
        `\t\tfrom: ${owner}\n` +
        `\t\tto: ${polygonWormholeGateway.address}\n` +
        `\t\tdata: ${data}`
    )
  })
}

export default func
func.tags = ["ManualDeprecatePolygonWormholeGateway", "DeprecatePolygon"]

// Comment this line when printing the governance calls.
// yarn deploy --tags ManualDeprecatePolygonWormholeGateway --network <network>
func.skip = async () => true
