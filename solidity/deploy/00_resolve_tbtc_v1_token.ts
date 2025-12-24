import { HardhatRuntimeEnvironment, HardhatNetworkConfig } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function resolveTbtcV1Token(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, deployments, helpers } = hre
  const { log } = deployments
  const { deployer } = await getNamedAccounts()

  const TBTCToken = await deployments.getOrNull("TBTCToken")

  if (TBTCToken && helpers.address.isValid(TBTCToken.address)) {
    log(`using external TBTCToken at ${TBTCToken.address}`)
  } else if (
    !hre.network.tags.allowStubs ||
    (hre.network.config as HardhatNetworkConfig)?.forking?.enabled
  ) {
    throw new Error("deployed TBTCToken contract not found")
  } else {
    log("deploying TBTCToken stub")

    await deployments.deploy("TBTCToken", {
      contract: "TestERC20",
      from: deployer,
      log: true,
    })
  }
}

export default func

func.tags = ["TBTCToken"]
