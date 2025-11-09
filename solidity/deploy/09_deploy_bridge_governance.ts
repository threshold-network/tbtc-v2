import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import fs from "fs"
import path from "path"
import os from "os"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
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
    const tenderlyConfigPath = path.join(
      os.homedir(),
      ".tenderly",
      "config.yaml"
    )
    if (fs.existsSync(tenderlyConfigPath)) {
      await hre.tenderly.verify({
        name: "BridgeGovernance",
        address: bridgeGovernance.address,
      })
    } else {
      deployments.log(
        "Skipping Tenderly verification; /.tenderly/config.yaml not found."
      )
    }
  }
}

export default func

func.tags = ["BridgeGovernance"]
func.dependencies = ["Bridge"]
