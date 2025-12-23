import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  // Reuse existing Bridge deployment; do not redeploy core contracts.
  const bridgeDeployment = await deployments.getOrNull("Bridge")
  const bridgeAddress =
    process.env.BRIDGE_ADDRESS ?? bridgeDeployment?.address ?? ""

  if (!bridgeAddress) {
    throw new Error(
      "Bridge deployment not found. Set BRIDGE_ADDRESS or ensure deployments/mainnet contains Bridge.json."
    )
  }

  const bridgeGovernanceParameters = await deployments.deploy(
    "BridgeGovernanceParameters",
    {
      from: deployer,
      log: true,
      waitConfirmations: 1,
    }
  )

  const GOVERNANCE_DELAY = hre.network.name === "sepolia" ? 60 : 172800

  const bridgeGovernance = await deploy("BridgeGovernance", {
    contract: "BridgeGovernance",
    from: deployer,
    args: [bridgeAddress, GOVERNANCE_DELAY],
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
func.tags = ["DeployBridgeGovernanceRebate", "VerifyRebateDeployment"]
