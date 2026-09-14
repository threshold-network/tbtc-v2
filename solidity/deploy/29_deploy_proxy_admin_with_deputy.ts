import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import type { ProxyAdmin } from "../typechain"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { ethers, getNamedAccounts, upgrades, deployments } = hre
  const { deployer, dao, esdm } = await getNamedAccounts()

  const BridgeProxyAdminWithDeputy = await deployments.deploy(
    "BridgeProxyAdminWithDeputy",
    {
      contract: "ProxyAdminWithDeputy",
      from: deployer,
      args: [dao, esdm],
      log: true,
      waitConfirmations: 1,
    }
  )

  const Bridge = await deployments.get("Bridge")

  const proxyAdmin = (await ethers.getContractAt(
    "ProxyAdmin",
    await (await upgrades.admin.getInstance()).getAddress()
  )) as unknown as ProxyAdmin

  await proxyAdmin
    .connect(await ethers.getSigner(esdm))
    .changeProxyAdmin(Bridge.address, BridgeProxyAdminWithDeputy.address)
}

export default func

func.tags = ["BridgeProxyAdminWithDeputy"]
func.dependencies = ["Bridge"]

// TODO: For now we skip this script as DAO is not yet established.
func.skip = async () => true
