import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, getNamedAccounts, helpers } = hre
  const { deployer } = await getNamedAccounts()

  const [, proxyDeployment] = await helpers.upgrades.deployProxy(
    "HyperEVMTBTC",
    {
      contractName: "@keep-network/tbtc-v2/contracts/l2/L2TBTC.sol:L2TBTC",
      initializerArgs: ["HyperEVM tBTC v2", "tBTC"],
      factoryOpts: { signer: await ethers.getSigner(deployer) },
      proxyOpts: {
        kind: "transparent",
      },
    }
  )
}

export default func

func.tags = ["HyperEVMTBTC"]
