import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { getWormholeChains } from "../deploy_helpers/wormhole_chains"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, getNamedAccounts, helpers, deployments } = hre
  const { deployer } = await getNamedAccounts()

  const wormholeChains = getWormholeChains(hre.network.name)

  const tbtcBridge = await deployments.get("Bridge")
  const tbtcVault = await deployments.get("TBTCVault")
  const wormhole = await deployments.get("Wormhole")
  const wormholeTokenBridge = await deployments.get("TokenBridge")
  
  // For Sui, we use the external gateway address since Sui contracts are not deployed via Hardhat
  const suiWormholeGateway = await deployments.get("SuiWormholeGateway")

  const [, proxyDeployment] = await helpers.upgrades.deployProxy(
    "SuiBTCDepositorWormhole",
    {
      contractName:
        "@keep-network/tbtc-v2/contracts/cross-chain/wormhole/BTCDepositorWormhole.sol:BTCDepositorWormhole",
      initializerArgs: [
        tbtcBridge.address,
        tbtcVault.address,
        wormhole.address,
        wormholeTokenBridge.address,
        suiWormholeGateway.address,
        wormholeChains.l2ChainId,
      ],
      factoryOpts: { signer: await ethers.getSigner(deployer) },
      proxyOpts: {
        kind: "transparent",
      },
    }
  )

  if (hre.network.tags.etherscan) {
    // We use `verify` instead of `verify:verify` as the `verify` task is defined
    // in "@openzeppelin/hardhat-upgrades" to perform Etherscan verification
    // of Proxy and Implementation contracts.
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }
}

export default func

func.tags = ["SuiBTCDepositorWormhole"]
func.dependencies = ["Bridge", "TBTCVault", "Wormhole", "TokenBridge", "SuiWormholeGateway"]
