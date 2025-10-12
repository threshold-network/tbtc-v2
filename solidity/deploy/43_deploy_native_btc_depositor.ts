import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments, getNamedAccounts } = hre
  const { deployer } = await getNamedAccounts()

  const tbtcBridge = await deployments.get("Bridge")
  const tbtcVault = await deployments.get("TBTCVault")

  const [, proxyDeployment] = await helpers.upgrades.deployProxy(
    "NativeBTCDepositor",
    {
      contractName: "NativeBTCDepositor",
      initializerArgs: [tbtcBridge.address, tbtcVault.address],
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

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "NativeBTCDepositor",
      address: await hre.upgrades.erc1967.getImplementationAddress(
        proxyDeployment.address
      ),
    })
  }
}

export default func

func.tags = ["NativeBTCDepositor"]
func.dependencies = ["Bridge", "TBTCVault"]



