import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, deployments } = hre
  const { execute } = deployments
  const { deployer, spvMaintainer } = await getNamedAccounts()

  await execute(
    "Bridge",
    { from: deployer, log: true, waitConfirmations: 1 },
    "setSpvMaintainerStatus",
    spvMaintainer,
    true
  )
}

export default func

func.tags = ["AuthorizeSpvMaintainer"]
func.dependencies = ["Bridge"]

// SPV maintainer can submit SPV proofs to the Bridge. We authorize spvMaintainer
// account for Hardhat network (unit tests) and Sepolia (testnet) but we DO NOT
// want to authorize it for Mainnet deployment. SPV maintainer will be
// authorized separately by the Governance when sweeping will be activated.
//
// Note that at this point MaintainerProxy contract is already authorized in the
// Bridge (see AuthorizeMaintainerProxyInBridge tag).
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name === "mainnet"
