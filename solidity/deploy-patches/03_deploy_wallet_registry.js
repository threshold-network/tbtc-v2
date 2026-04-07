"use strict"
/**
 * Patched copy of @keep-network/ecdsa/export/deploy/03_deploy_wallet_registry.js
 *
 * helpers.upgrades.deployProxy throws if WalletRegistry is already in deployments/ (keep-core Phase F).
 * Phase G copies WalletRegistry.json into tbtc-v2 — Phase H must skip redeploying the proxy.
 */
const func = async function (hre) {
  const { getNamedAccounts, deployments, ethers, helpers } = hre
  const { deployer } = await getNamedAccounts()
  const { log } = deployments

  if (await deployments.getOrNull("WalletRegistry")) {
    log(
      "WalletRegistry already deployed (keep-core Phase F); skipping deployProxy and related steps"
    )
    return
  }

  const EcdsaSortitionPool = await deployments.get("EcdsaSortitionPool")
  const TokenStaking = await deployments.get("TokenStaking")
  const ReimbursementPool = await deployments.get("ReimbursementPool")
  const RandomBeacon = await deployments.get("RandomBeacon")
  const EcdsaDkgValidator = await deployments.get("EcdsaDkgValidator")

  const EcdsaInactivity = await deployments.deploy("EcdsaInactivity", {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  })

  const signer = await ethers.getSigner(deployer)

  const [walletRegistry, proxyDeployment] =
    await helpers.upgrades.deployProxy("WalletRegistry", {
      contractName:
        process.env.TEST_USE_STUBS_ECDSA === "true"
          ? "WalletRegistryStub"
          : undefined,
      initializerArgs: [
        EcdsaDkgValidator.address,
        RandomBeacon.address,
        ReimbursementPool.address,
      ],
      factoryOpts: {
        signer,
        libraries: {
          EcdsaInactivity: EcdsaInactivity.address,
        },
      },
      proxyOpts: {
        constructorArgs: [EcdsaSortitionPool.address, TokenStaking.address],
        unsafeAllow: ["external-library-linking"],
        kind: "transparent",
      },
    })

  await helpers.ownable.transferOwnership(
    "EcdsaSortitionPool",
    walletRegistry.address,
    deployer
  )

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(EcdsaInactivity)
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "WalletRegistry",
      address: walletRegistry.address,
    })
  }
}

module.exports = func
func.tags = ["WalletRegistry"]
func.dependencies = [
  "ReimbursementPool",
  "RandomBeacon",
  "EcdsaSortitionPool",
  "TokenStaking",
  "EcdsaDkgValidator",
]
