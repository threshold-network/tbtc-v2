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

  // 60 seconds for Sepolia. 48 hours otherwise.
  const GOVERNANCE_DELAY = hre.network.name === "sepolia" ? 60 : 172800

  // Deployed under a distinct name ("BridgeGovernanceV2") from the existing
  // "BridgeGovernance" deployment so both instances stay independently
  // addressable. Reusing the "BridgeGovernance" name here would make
  // hardhat-deploy treat this as a no-op redeploy of the existing contract
  // (same constructor args -> same artifact), never producing a second
  // instance to migrate governance to.
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
      BridgeGovernanceParameters: bridgeGovernanceParameters.address,
    },
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(bridgeGovernanceParameters)
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
