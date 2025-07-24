import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, helpers, getNamedAccounts } = hre
  const { deployer } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")
  const t = await helpers.contracts.getContract("T")

  const [redemptionWatchtower, proxyDeployment] =
    await helpers.upgrades.deployProxy("RebateStaking", {
      contractName: "RebateStaking",
      initializerArgs: [
        Bridge.address,
        t.address,
        30 * 24 * 60 * 60, // 30 days rolling window
        30 * 24 * 60 * 60, // 30 days unstaking delay
        450000, // 0.1 BTC fee rebate per 45000 T tokens staked
      ],
      factoryOpts: {
        signer: await ethers.getSigner(deployer),
      },
      proxyOpts: {
        kind: "transparent",
      },
    })

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
      name: "RebateStaking",
      address: redemptionWatchtower.address,
    })
  }
}

export default func

func.tags = ["RebateStaking"]
func.dependencies = ["Bridge"]
