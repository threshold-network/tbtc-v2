import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy } = deployments
  const { deployer, governance } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")

  const bridgeGovernanceParametersV2 = await deployments.deploy(
    "BridgeGovernanceParametersV2",
    {
      contract: "BridgeGovernanceParameters",
      from: deployer,
      log: true,
      waitConfirmations: 1,
    }
  )

  // 60 seconds for Sepolia. 48 hours otherwise.
  const GOVERNANCE_DELAY = hre.network.name === "sepolia" ? 60 : 172800

  // Deployed under a distinct name ("BridgeGovernanceV2") from the existing
  // "BridgeGovernance" deployment so both instances stay independently
  // addressable. Reusing the "BridgeGovernance" name here would overwrite
  // the hardhat-deploy deployment record that
  // 96_transfer_bridge_governance_v2.ts reads (via deployments.get) to
  // resolve the old contract's address, even though the deployed bytecode
  // itself differs (new peg-keeper functions, relinked library) rather
  // than being a same-bytecode no-op.
  //
  // "BridgeGovernance" remains the currently-live governance contract until
  // 96_transfer_bridge_governance_v2.ts's calldata is executed by its owner;
  // "BridgeGovernanceV2" is the new instance being migrated to.
  const bridgeGovernanceV2 = await deploy("BridgeGovernanceV2", {
    contract: "BridgeGovernance",
    from: deployer,
    args: [Bridge.address, GOVERNANCE_DELAY],
    log: true,
    libraries: {
      BridgeGovernanceParameters: bridgeGovernanceParametersV2.address,
    },
    waitConfirmations: 1,
  })

  await helpers.ownable.transferOwnership(
    "BridgeGovernanceV2",
    governance,
    deployer
  )

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(bridgeGovernanceParametersV2)
    await helpers.etherscan.verify(bridgeGovernanceV2)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "BridgeGovernanceV2",
      address: bridgeGovernanceV2.address,
    })
  }
}

export default func

func.tags = ["BridgeGovernanceV2"]
func.dependencies = ["Bridge"]
// Set DEPLOY_BRIDGE_GOVERNANCE_V2=true when running the deployment.
// yarn deploy --tags BridgeGovernanceV2 --network <NETWORK>
func.skip = async () => process.env.DEPLOY_BRIDGE_GOVERNANCE_V2 !== "true"
