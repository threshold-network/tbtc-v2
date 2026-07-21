import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")
  const existingGovernance = await deployments.getOrNull("BridgeGovernance")
  if (existingGovernance) {
    const bridge = await hre.ethers.getContractAt("Bridge", Bridge.address)
    const liveGovernance = await bridge.governance()
    if (liveGovernance.toLowerCase() !== deployer.toLowerCase()) {
      if (
        liveGovernance.toLowerCase() !==
        existingGovernance.address.toLowerCase()
      ) {
        throw new Error(
          `BridgeGovernance record ${existingGovernance.address} is stale; ` +
            `live Bridge.governance() is ${liveGovernance}`
        )
      }
      console.log(
        "Existing-network BridgeGovernance is live; preserving its canonical " +
          "deployment record. Use 87_deploy_ecdsa_cutover_bridge_governance.ts " +
          "for the delayed distinct-address handoff."
      )
      return
    }
  }

  const bridgeGovernanceParameters = await deployments.deploy(
    "BridgeGovernanceParameters",
    {
      from: deployer,
      log: true,
      waitConfirmations: 1,
    }
  )
  const ecdsaFraudRouterCutoverVerifier = await deployments.deploy(
    "EcdsaFraudRouterCutoverVerifier",
    {
      from: deployer,
      log: true,
      waitConfirmations: 1,
    }
  )
  const ecdsaFraudRouterCutover = await deployments.deploy(
    "EcdsaFraudRouterCutover",
    {
      from: deployer,
      libraries: {
        EcdsaFraudRouterCutoverVerifier:
          ecdsaFraudRouterCutoverVerifier.address,
      },
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
      EcdsaFraudRouterCutover: ecdsaFraudRouterCutover.address,
    },
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(bridgeGovernanceParameters)
    await helpers.etherscan.verify(ecdsaFraudRouterCutoverVerifier)
    await helpers.etherscan.verify(ecdsaFraudRouterCutover)
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
