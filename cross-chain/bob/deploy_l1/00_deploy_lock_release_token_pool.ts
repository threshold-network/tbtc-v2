import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  // Set tBTC address based on network
  let tbtcAddress: string
  let router: string
  let rmnProxy: string
  let supportedRemoteChainId: string
  let acceptLiquidity: boolean
  
  if (hre.network.name === "mainnet") {
    tbtcAddress = "0x18084fbA666a33d37592fA2633fD49a74DD93a88"
    router = "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D" // Ethereum Mainnet Router
    rmnProxy = "0x411dE17f12D1A34ecC7F45f49844626267c75e81" // Ethereum Mainnet RMN proxy
    supportedRemoteChainId = "3849287863852499584" // BOB Mainnet
    acceptLiquidity = true // Enable liquidity management for mainnet
  } else if (hre.network.name === "sepolia") {
    tbtcAddress = "0x517f2982701695D4E52f1ECFBEf3ba31Df470161"
    router = "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59" // Ethereum Sepolia Router
    rmnProxy = "0xba3f6251de62dED61Ff98590cB2fDf6871FbB991" // Ethereum Sepolia RMN proxy
    supportedRemoteChainId = "5535534526963509396" // BOB Sepolia
    acceptLiquidity = true // Enable liquidity management for testing
  } else {
    throw new Error("Unsupported network for LockReleaseTokenPoolUpgradeable deployment")
  }

  // Minimal allowlist for now (can be updated post-deploy)
  const allowlist: string[] = []

  console.log("🚀 Deploying LockReleaseTokenPoolUpgradeable with parameters:")
  console.log(`  📍 Network: ${hre.network.name}`)
  console.log(`  🪙 tBTC Token: ${tbtcAddress}`)
  console.log(`  🔢 Token Decimals: 18`)
  console.log(`  🌐 CCIP Router: ${router}`)
  console.log(`  🔒 RMN Proxy: ${rmnProxy}`)
  console.log(`  💧 Accept Liquidity: ${acceptLiquidity}`)
  console.log(`  📝 Allowlist: ${allowlist.length === 0 ? 'Empty (permissionless)' : allowlist.join(', ')}`)

  const [, proxyDeployment, proxyAdmin] = await helpers.upgrades.deployProxy(
    "LockReleaseTokenPoolUpgradeable",
    {
      initializerArgs: [tbtcAddress, 18, allowlist, rmnProxy, acceptLiquidity, router],
      factoryOpts: { signer: await ethers.getSigner(deployer) },
      proxyOpts: { kind: "transparent" },
    }
  )

  console.log("✅ LockReleaseTokenPoolUpgradeable deployed successfully!")
  console.log(`  📍 Proxy Address: ${proxyDeployment.address}`)
  if (proxyAdmin) {
    console.log(`  🔧 Proxy Admin: ${proxyAdmin.address}`)
  }

  // Verification for Etherscan
  if (hre.network.tags.etherscan) {
    console.log(`Contract deployed at: ${proxyDeployment.address}`)
    console.log("For better verification results, run the verification script with delay:")
    console.log(`CONTRACT_ADDRESS=${proxyDeployment.address} npx hardhat run scripts/verify-with-delay.ts --network sepolia`)
    
    try {
      await hre.run("verify", {
        address: proxyDeployment.address,
        constructorArgsParams: proxyDeployment.args,
      })
    } catch (error) {
      console.log("⚠️  Contract verification failed, but deployment was successful.")
      console.log("You can manually verify the contract later on Etherscan.")
    }
  }

  // Post-deployment configuration info
  console.log("\n💡 Post-deployment configuration options:")
  console.log("  🔧 Set Rebalancer: Use setRebalancer(address) to configure liquidity manager")
  console.log("  💧 Liquidity Management Available:")
  console.log("    - provideLiquidity(uint256): Add liquidity to the pool")
  console.log("    - withdrawLiquidity(uint256): Remove liquidity from the pool")
  console.log("    - transferLiquidity(address, uint256): Transfer liquidity from another pool")
  console.log("  🔍 View Functions:")
  console.log("    - getRebalancer(): Get current rebalancer address")
  console.log("    - canAcceptLiquidity(): Check if pool accepts external liquidity")
  console.log("    - getToken(): Get the managed token address")
  console.log("    - supportsInterface(): Check interface support (IPoolV1, ILiquidityContainer, IERC165)")

  // Transfer proxy admin ownership to council multisig on mainnet
  if (hre.network.name === "mainnet") {
    console.log("\n🏛️ Transferring proxy admin ownership to council multisig...")
    const councilMs = "0x9F6e831c8F8939DC0C830C6e492e7cEf4f9c2F5f"
    await helpers.upgrades.transferProxyAdminOwnership(proxyAdmin.address, councilMs)
    console.log(`✅ Proxy admin ownership transferred to: ${councilMs}`)
  } else {
    console.log(`\n🔐 Current proxy admin owner: ${deployer}`)
    console.log("   Note: Consider transferring ownership to a multisig for production use")
  }
}

export default func

func.tags = ["LockReleaseTokenPoolUpgradeable"] 