/**
 * Patched copy of @keep-network/random-beacon@2.1.0-dev.18/export/deploy/07_deploy_random_beacon_governance.js
 * Ethers v6 confirmation handling for random-beacon 2.1.0-dev.18.
 */
const waitForConfirmations = require("../helpers/wait-for-confirmations")

const func = async (hre) => {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer } = await getNamedAccounts()

  const RandomBeacon = await deployments.get("RandomBeacon")

  const GOVERNANCE_DELAY = 604_800 // 1 week

  const RandomBeaconGovernance = await deployments.deploy(
    "RandomBeaconGovernance",
    {
      from: deployer,
      args: [RandomBeacon.address, GOVERNANCE_DELAY],
      log: true,
      waitConfirmations: 1,
    }
  )

  if (hre.network.tags.etherscan) {
    await waitForConfirmations(
      hre,
      RandomBeaconGovernance.transactionHash,
      2,
      300000
    )
    await helpers.etherscan.verify(RandomBeaconGovernance)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "RandomBeaconGovernance",
      address: RandomBeaconGovernance.address,
    })
  }
}

module.exports = func
func.tags = ["RandomBeaconGovernance"]
func.dependencies = ["RandomBeacon"]
