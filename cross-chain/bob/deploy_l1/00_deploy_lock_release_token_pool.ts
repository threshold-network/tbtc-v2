import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  // Set tBTC address based on network
  let tbtcAddress: string
  let router: string
  let rmnProxy: string
  
  if (hre.network.name === "mainnet") {
    tbtcAddress = "0x18084fbA666a33d37592fA2633fD49a74DD93a88"
    router = "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D" // Ethereum Mainnet Router
    rmnProxy = "0x411dE17f12D1A34ecC7F45f49844626267c75e81" // Ethereum Mainnet RMN proxy
  } else if (hre.network.name === "sepolia") {
    tbtcAddress = "0x517f2982701695D4E52f1ECFBEf3ba31Df470161"
    router = "0x779877A7B0D9E8603169DdbD7836e478b4624789" // Ethereum Sepolia Router
    rmnProxy = "0xba3f6251de62dED61Ff98590cB2fDf6871FbB991" // Ethereum Sepolia RMN proxy
  } else {
    throw new Error("Unsupported network for LockReleaseTokenPoolUpgradeable deployment")
  }

  // Minimal allowlist for now (can be updated post-deploy)
  const allowlist: string[] = []
  const acceptLiquidity = false

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