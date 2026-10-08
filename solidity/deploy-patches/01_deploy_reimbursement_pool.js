/**
 * Patched copy of @keep-network/random-beacon@2.1.0-dev.18/export/deploy/01_deploy_reimbursement_pool.js
 * Ethers v6 confirmation handling for random-beacon 2.1.0-dev.18.
 */
const waitForConfirmations = require("../helpers/wait-for-confirmations")

const func = async (hre) => {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer } = await getNamedAccounts()

  const staticGas = 40_800 // gas amount consumed by the refund() + tx cost
  const maxGasPrice = 500_000_000_000 // 500 Gwei

  const ReimbursementPool = await deployments.deploy("ReimbursementPool", {
    from: deployer,
    args: [staticGas, maxGasPrice],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await waitForConfirmations(
      hre,
      ReimbursementPool.transactionHash,
      2,
      300000
    )
    await helpers.etherscan.verify(ReimbursementPool)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "ReimbursementPool",
      address: ReimbursementPool.address,
    })
  }
}

module.exports = func
func.tags = ["ReimbursementPool"]
