/** Ethers v6 confirmation handling for random-beacon 2.1.0-dev.18. */
const waitForConfirmations = require("../helpers/wait-for-confirmations")

const func = async (hre) => {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer } = await getNamedAccounts()

  const deployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  const RandomBeaconChaosnet = await deployments.deploy(
    "RandomBeaconChaosnet",
    {
      ...deployOptions,
    }
  )

  if (hre.network.tags.etherscan) {
    await waitForConfirmations(
      hre.ethers.provider,
      RandomBeaconChaosnet.transactionHash,
      2,
      300000
    )
    await helpers.etherscan.verify(RandomBeaconChaosnet)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "RandomBeaconChaosnet",
      address: RandomBeaconChaosnet.address,
    })
  }
}

module.exports = func
func.tags = ["RandomBeaconChaosnet"]
