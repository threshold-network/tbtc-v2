import { ethers } from "hardhat"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import type { ProxyAdmin } from "../typechain"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { helpers, upgrades, deployments } = hre
  const { esdm, deployer } = await helpers.signers.getNamedSigners()
  const { log } = deployments

  // TODO: Once a DAO is established we want to switch to ProxyAdminWithDeputy and
  // use the DAO as the proxy admin owner and ESDM as the deputy. Until then we
  // use ESDM as the owner of ProxyAdmin contract.
  const newProxyAdminOwner = esdm.address

  const proxyAdmin = (await ethers.getContractAt(
    "ProxyAdmin",
    await (await upgrades.admin.getInstance()).getAddress()
  )) as unknown as ProxyAdmin

  const currentOwner = await proxyAdmin.owner()

  // The `@openzeppelin/hardhat-upgrades` plugin deploys a single ProxyAdmin
  // per network. We don't want to transfer the ownership if the owner is already
  // set to the desired address.
  if (!helpers.address.equal(currentOwner, newProxyAdminOwner)) {
    log(`transferring ownership of ProxyAdmin to ${newProxyAdminOwner}`)
    await (
      await proxyAdmin.connect(deployer).transferOwnership(newProxyAdminOwner)
    ).wait()
  }
}

export default func

func.tags = ["TransferProxyAdminOwnership"]
func.dependencies = ["Bridge"]
