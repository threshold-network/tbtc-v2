/** Ethers v6 copy of solidity-contracts' published timelock deployment. */
const func = async function (hre) {
  const { getNamedAccounts, deployments, ethers } = hre
  const { deployer } = await getNamedAccounts()
  const proposers = []
  const executors = [ethers.ZeroAddress]
  const minDelay = 172800 // 2 days in seconds (2 * 24 * 60 * 60)

  const timelock = await deployments.deploy("TokenholderTimelock", {
    contract: "TimelockController",
    from: deployer,
    args: [minDelay, proposers, executors],
    log: true,
  })

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "TokenholderTimelock",
      address: timelock.address,
    })
  }
}

module.exports = func
func.tags = ["TokenholderTimelock"]
