/**
 * Patched copy of @keep-network/ecdsa/export/deploy/09_deploy_wallet_registry_governance.js
 *
 * Phase G copies a reused WalletRegistry from keep-core Phase F — governance was already
 * transferred off the deployer to the live WalletRegistryGovernance. Deploying a *new* WRG in
 * Phase H orphans that contract: WalletRegistry.updateWalletOwner checks Governable.onlyGovernance,
 * so msg.sender (the WRG contract) must equal WR.governance(). If deployments record a freshly
 * deployed WRG while WR still points at the Phase-F WRG, initializeWalletOwner reverts with
 * "Caller is not the governance".
 *
 * When governance is already externalized, persist the on-chain WRG address into hardhat-deploy
 * instead of deploying a duplicate.
 */
const func = async function (hre) {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer } = await getNamedAccounts()
  const { deploy, read, log, save, getArtifact } = deployments

  const WalletRegistry = await deployments.get("WalletRegistry")
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

  const currentGov = await read("WalletRegistry", {}, "governance")

  if (
    currentGov &&
    currentGov !== ZERO_ADDRESS &&
    !helpers.address.equal(currentGov, deployer)
  ) {
    log(
      `WalletRegistry governance (${currentGov}) already externalized; recording as WalletRegistryGovernance (skip deploy)`
    )
    const artifact = await getArtifact("WalletRegistryGovernance")
    await save("WalletRegistryGovernance", {
      abi: artifact.abi,
      address: currentGov,
    })
    const wrLinked = await read(
      "WalletRegistryGovernance",
      {},
      "walletRegistry"
    )
    if (!helpers.address.equal(WalletRegistry.address, wrLinked)) {
      throw new Error(
        `WalletRegistryGovernance at ${currentGov} points at WalletRegistry ${wrLinked}, expected ${WalletRegistry.address}. ` +
          "On-chain WRG does not match this deployment's WalletRegistry; fix keep-core Phase F / Phase G copies."
      )
    }
    return
  }

  const GOVERNANCE_DELAY = hre.network.name === "sepolia" ? 60 : 604800

  const WalletRegistryGovernance = await deploy("WalletRegistryGovernance", {
    from: deployer,
    args: [WalletRegistry.address, GOVERNANCE_DELAY],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(WalletRegistryGovernance)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "WalletRegistryGovernance",
      address: WalletRegistryGovernance.address,
    })
  }
}

module.exports = func
func.tags = ["WalletRegistryGovernance"]
func.dependencies = ["WalletRegistry"]
