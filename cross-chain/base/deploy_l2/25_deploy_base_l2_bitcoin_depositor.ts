import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { getWormholeChains } from "../deploy_helpers/wormhole_chains"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, getNamedAccounts, helpers, deployments } = hre
  const { deployer } = await getNamedAccounts()

  const wormholeChains = getWormholeChains(hre.network.name)

  const baseWormholeRelayer = "0x706F82e9bb5b0813501714Ab5974216704980e31"
  const baseWormholeGateway = await deployments.get("BaseWormholeGateway")

  const [, proxyDeployment] = await helpers.upgrades.deployProxy(
    "BaseL2BitcoinDepositor",
    {
      contractName:
        "@keep-network/tbtc-v2/contracts/l2/L2BitcoinDepositor.sol:L2BitcoinDepositor",
      initializerArgs: [
        baseWormholeRelayer,
        baseWormholeGateway.address,
        wormholeChains.l1ChainId,
      ],
      factoryOpts: { signer: await ethers.getSigner(deployer) },
      proxyOpts: {
        kind: "transparent",
      },
    }
  )

  // Contracts can be verified on L2 Base Etherscan in a similar way as we
  // do it on L1 Etherscan
  if (hre.network.tags.basescan) {
    // We use `verify` instead of `verify:verify` as the `verify` task is defined
    // in "@openzeppelin/hardhat-upgrades" to verify the proxy’s implementation
    // contract, the proxy itself and any proxy-related contracts, as well as
    // link the proxy to the implementation contract’s ABI on (Ether)scan.
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: [],
    })
  }
}

export default func

func.tags = ["BaseL2BitcoinDepositor"]
func.dependencies = ["BaseWormholeGateway", "BaseWormholeRelayer"]
