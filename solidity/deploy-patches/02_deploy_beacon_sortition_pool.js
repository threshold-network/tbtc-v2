/**
 * Patched copy of @keep-network/random-beacon@2.1.0-dev.18/export/deploy/02_deploy_beacon_sortition_pool.js
 * Ethers v6 confirmation handling for random-beacon 2.1.0-dev.18.
 */
const waitForConfirmations = require("../helpers/wait-for-confirmations")

const func = async (hre) => {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer, chaosnetOwner } = await getNamedAccounts()
  const { execute } = deployments
  const { to1e18 } = helpers.number

  const POOL_WEIGHT_DIVISOR = to1e18(1)

  const T = await deployments.get("T")

  const BeaconSortitionPool = await deployments.deploy("BeaconSortitionPool", {
    contract: "SortitionPool",
    from: deployer,
    args: [T.address, POOL_WEIGHT_DIVISOR],
    log: true,
    waitConfirmations: 1,
  })

  await execute(
    "BeaconSortitionPool",
    { from: deployer, log: true, waitConfirmations: 1 },
    "transferChaosnetOwnerRole",
    chaosnetOwner
  )

  if (hre.network.tags.etherscan) {
    await waitForConfirmations(
      hre.ethers.provider,
      BeaconSortitionPool.transactionHash,
      2,
      300000
    )
    await helpers.etherscan.verify(BeaconSortitionPool)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "BeaconSortitionPool",
      address: BeaconSortitionPool.address,
    })
  }
}

module.exports = func
func.tags = ["BeaconSortitionPool"]
// TokenStaking and T deployments are resolved from solidity-contracts.
func.dependencies = ["TokenStaking", "T"]
