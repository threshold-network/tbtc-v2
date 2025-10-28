import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, helpers, getNamedAccounts } = hre
  const { log, deploy } = deployments

  const WalletRegistry = await deployments.getOrNull("WalletRegistry")

  if (WalletRegistry && helpers.address.isValid(WalletRegistry.address)) {
    log(`using existing WalletRegistry at ${WalletRegistry.address}`)
  } else {
    // For test environments, deploy a stub WalletRegistry
    if (hre.network.name === "hardhat") {
      const { deployer } = await getNamedAccounts()
      const deployment = await deploy("WalletRegistry", {
        contract: "WalletRegistryMock",
        from: deployer,
        args: [],
        log: true,
        waitConfirmations: 1,
      })
      log(`deployed WalletRegistry mock at ${deployment.address}`)
    } else {
      throw new Error("deployed WalletRegistry contract not found")
    }
  }
}

export default func

func.tags = ["WalletRegistry"]
