import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const STATIC_GAS_DEFAULT = 200_000
const MAX_GAS_PRICE_DEFAULT = 200n * 10n ** 9n

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, helpers, getNamedAccounts, ethers } = hre
  const { log, deploy } = deployments

  const reimbursementPoolDeployment =
    await deployments.getOrNull("ReimbursementPool")

  if (
    reimbursementPoolDeployment &&
    helpers.address.isValid(reimbursementPoolDeployment.address)
  ) {
    log(
      `using existing ReimbursementPool at ${reimbursementPoolDeployment.address}`
    )
    return
  }

  const { deployer } = await getNamedAccounts()

  const staticGas = STATIC_GAS_DEFAULT
  const maxGasPrice = ethers.BigNumber.from(MAX_GAS_PRICE_DEFAULT.toString())

  const deployment = await deploy("ReimbursementPool", {
    contract: "ReimbursementPool",
    from: deployer,
    args: [staticGas, maxGasPrice],
    log: true,
    waitConfirmations: 1,
  })

  log(`deployed ReimbursementPool to ${deployment.address}`)
}

export default func

func.tags = ["ReimbursementPool"]
