import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function resolveReimbursementPool(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, helpers } = hre
  const { log } = deployments

  const ReimbursementPool = await deployments.getOrNull("ReimbursementPool")

  if (ReimbursementPool && helpers.address.isValid(ReimbursementPool.address)) {
    log(`using existing ReimbursementPool at ${ReimbursementPool.address}`)
  } else {
    if (hre.network.tags.allowStubs) {
      const { deployer } = await hre.getNamedAccounts()

      const staticGas = 40800
      const maxGasPrice = 500000000000

      const reimbursementPool = await deployments.deploy("ReimbursementPool", {
        from: deployer,
        args: [staticGas, maxGasPrice],
        log: true,
        waitConfirmations: 1,
      })

      log(
        `deployed ReimbursementPool for test network at ${reimbursementPool.address}`
      )
      return
    }

    throw new Error("deployed ReimbursementPool contract not found")
  }
}

export default func

func.tags = ["ReimbursementPool"]
