import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  // const { helpers, upgrades, deployments } = hre
  // const { governance, deployer } = await helpers.signers.getNamedSigners()
  // const { log } = deployments

  // const proxyAdmin = await upgrades.admin.getInstance()
  // const currentOwner = await proxyAdmin.owner()

  // // The `@openzeppelin/hardhat-upgrades` plugin deploys a single ProxyAdmin
  // // per network. We don't want to transfer the ownership if the owner is already
  // // set to the desired address.
  // if (!helpers.address.equal(currentOwner, governance.address)) {
  //   log(`transferring ownership of ProxyAdmin to ${governance.address}`)
  //   await (
  //     await proxyAdmin.connect(deployer).transferOwnership(governance.address)
  //   ).wait()
  // }
}

export default func

func.tags = ["TransferProxyAdminOwnership"]
func.dependencies = ["HyperEVMTBTC"]
func.runAtTheEnd = true
