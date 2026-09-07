/** Ethers v6 confirmation handling for random-beacon 2.1.0-dev.18. */
const waitForConfirmations = require("../helpers/wait-for-confirmations")

const func = async (hre) => {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer } = await getNamedAccounts()

  const BeaconSortitionPool = await deployments.get("BeaconSortitionPool")

  const BeaconDkgValidator = await deployments.deploy("BeaconDkgValidator", {
    from: deployer,
    args: [BeaconSortitionPool.address],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await waitForConfirmations(
      hre.ethers.provider,
      BeaconDkgValidator.transactionHash,
      2,
      300000
    )
    await helpers.etherscan.verify(BeaconDkgValidator)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "BeaconDkgValidator",
      address: BeaconDkgValidator.address,
    })
  }
}

module.exports = func
func.tags = ["BeaconDkgValidator"]
func.dependencies = ["BeaconSortitionPool"]
