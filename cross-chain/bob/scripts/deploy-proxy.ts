// Script to deploy OptimismMintableUpgradableERC20 as a proxy
// This is useful for testing the upgrade process

import { ethers, upgrades } from "hardhat"

async function main() {
  const [deployer] = await ethers.getSigners()

  console.log(
    "Deploying OptimismMintableUpgradableERC20 proxy with account:",
    deployer.address
  )
  console.log("Account balance:", (await deployer.getBalance()).toString())

  // Configuration
  const BRIDGE_ADDRESS =
    process.env.BRIDGE_ADDRESS || "0x0000000000000000000000000000000000000001" // Replace with actual bridge
  const REMOTE_TOKEN =
    process.env.REMOTE_TOKEN || "0x0000000000000000000000000000000000000002" // Replace with L1 tBTC
  const TOKEN_NAME = "tBTC v2"
  const TOKEN_SYMBOL = "tBTC"
  const TOKEN_DECIMALS = 18

  // Get the contract factory
  const OptimismMintableUpgradableERC20 = await ethers.getContractFactory(
    "OptimismMintableUpgradableERC20"
  )

  console.log("Deploying proxy...")

  // Deploy as upgradeable proxy
  const proxy = await upgrades.deployProxy(
    OptimismMintableUpgradableERC20,
    [BRIDGE_ADDRESS, REMOTE_TOKEN, TOKEN_NAME, TOKEN_SYMBOL, TOKEN_DECIMALS],
    {
      initializer: "initialize",
      kind: "uups", // or "transparent" depending on your proxy type
    }
  )

  await proxy.deployed()

  console.log("Proxy deployed to:", proxy.address)
  console.log(
    "Implementation deployed to:",
    await upgrades.erc1967.getImplementationAddress(proxy.address)
  )
  console.log(
    "Admin address:",
    await upgrades.erc1967.getAdminAddress(proxy.address)
  )

  // Verify deployment
  console.log("\nDeployment verification:")
  console.log("Token name:", await proxy.name())
  console.log("Token symbol:", await proxy.symbol())
  console.log("Token decimals:", await proxy.decimals())
  console.log("Remote token:", await proxy.REMOTE_TOKEN())
  console.log("Bridge:", await proxy.BRIDGE())
  console.log("Version:", await proxy.version())

  // Save deployment info
  const deploymentInfo = {
    proxy: proxy.address,
    implementation: await upgrades.erc1967.getImplementationAddress(
      proxy.address
    ),
    admin: await upgrades.erc1967.getAdminAddress(proxy.address),
    bridge: BRIDGE_ADDRESS,
    remoteToken: REMOTE_TOKEN,
    deployedAt: new Date().toISOString(),
    network: (await ethers.provider.getNetwork()).name,
  }

  console.log("\nDeployment info:", JSON.stringify(deploymentInfo, null, 2))

  // You might want to save this to a file
  // fs.writeFileSync('deployment-info.json', JSON.stringify(deploymentInfo, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
