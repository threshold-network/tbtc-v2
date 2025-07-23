import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  // Set tBTC address based on network
  let tbtcAddress: string
  if (hre.network.name === "mainnet") {
    tbtcAddress = "0x18084fbA666a33d37592fA2633fD49a74DD93a88"
  } else if (hre.network.name === "sepolia") {
    tbtcAddress = "0x517f2982701695D4E52f1ECFBEf3ba31Df470161"
  } else {
    throw new Error("Unsupported network for LockReleaseTokenPoolUpgradeable deployment")
  }

  // Minimal allowlist, rmnProxy, router for now (can be updated post-deploy)
  const allowlist: string[] = []
  const rmnProxy = ethers.constants.AddressZero
  const acceptLiquidity = false
  const router = ethers.constants.AddressZero

  const [, proxyDeployment, proxyAdmin] = await helpers.upgrades.deployProxy(
    "LockReleaseTokenPoolUpgradeable",
    {
      initializerArgs: [tbtcAddress, allowlist, rmnProxy, acceptLiquidity, router],
      factoryOpts: { signer: await ethers.getSigner(deployer) },
      proxyOpts: { kind: "transparent" },
    }
  )

  // Verification for Etherscan
  if (hre.network.tags.etherscan) {
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  // Transfer proxy admin ownership to council multisig on mainnet
  if (hre.network.name === "mainnet") {
    const councilMs = "0x9F6e831c8F8939DC0C830C6e492e7cEf4f9c2F5f"
    await helpers.upgrades.transferProxyAdminOwnership(proxyAdmin.address, councilMs)
  }
}

export default func

func.tags = ["LockReleaseTokenPoolUpgradeable"] 