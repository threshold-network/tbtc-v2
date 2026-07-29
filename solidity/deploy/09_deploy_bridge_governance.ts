import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")

  const bridgeGovernanceParameters = await deployments.deploy(
    "BridgeGovernanceParameters",
    {
      from: deployer,
      log: true,
      waitConfirmations: 1,
    }
  )

  // 1 hour for Sepolia. 48 hours otherwise.
  const GOVERNANCE_DELAY = hre.network.name === "sepolia" ? 3600 : 172800

  const bridgeGovernance = await deploy("BridgeGovernance", {
    contract: "BridgeGovernance",
    from: deployer,
    args: [Bridge.address, GOVERNANCE_DELAY],
    log: true,
    libraries: {
      BridgeGovernanceParameters: bridgeGovernanceParameters.address,
    },
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(bridgeGovernanceParameters)
    await helpers.etherscan.verify(bridgeGovernance)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "BridgeGovernance",
      address: bridgeGovernance.address,
    })
  }
}

export default func

func.tags = ["BridgeGovernance"]
func.dependencies = ["Bridge"]
