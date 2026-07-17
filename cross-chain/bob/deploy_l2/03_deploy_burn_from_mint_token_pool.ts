import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  // Router addresses for different networks
  const ROUTER_ADDRESSES = {
    bobSepolia: "0x7808184405d6Cbc663764003dE21617fa640bc82",
    bobMainnet: "0x827716e74F769AB7b6bb374A29235d9c2156932C",
  }

  const TBTC_ADDRESS = {
    bobSepolia: "0xD23F06550b0A7bC98B20eb81D4c21572a97598FA",
    bobMainnet: "0xBBa2eF945D523C4e2608C9E1214C2Cc64D4fc2e2",
  }

  const RMN_PROXY_ADDRESS = {
    bobSepolia: "0xD642e08eeF81bb55B8282701234659A3233E2145",
    bobMainnet: "0xe4D8E0A02C61f6DDe95255E702fe1237428673D8",
  }

  // Set tBTC address, router, and rmnProxy based on network
  let tbtcAddress: string
  let router: string
  let rmnProxy: string

  if (hre.network.name === "bobMainnet") {
    tbtcAddress = TBTC_ADDRESS.bobMainnet
    router = ROUTER_ADDRESSES.bobMainnet
    rmnProxy = RMN_PROXY_ADDRESS.bobMainnet
  } else if (hre.network.name === "bobSepolia") {
    tbtcAddress = TBTC_ADDRESS.bobSepolia
    router = ROUTER_ADDRESSES.bobSepolia
    rmnProxy = RMN_PROXY_ADDRESS.bobSepolia
  } else if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    // Deploy a mock ERC20 for local testing
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock", await ethers.getSigner(deployer))
    const mockToken = await ERC20Mock.deploy("Mock tBTC", "tBTC", deployer, ethers.utils.parseEther("1000000"))
    await mockToken.deployed()
    tbtcAddress = mockToken.address
    router = ROUTER_ADDRESSES.bobSepolia
    rmnProxy = RMN_PROXY_ADDRESS.bobSepolia
  } else {
    throw new Error("Unsupported network for BurnFromMintTokenPoolUpgradeable deployment")
  }

  if (!router || router === ethers.constants.AddressZero) {
    throw new Error("Router address must be set and non-zero for deployment")
  }
  if (!rmnProxy || rmnProxy === ethers.constants.AddressZero) {
    throw new Error("RMN proxy address must be set and non-zero for deployment")
  }

  const allowlist: string[] = []

  console.log("Deploying BurnFromMintTokenPoolUpgradeable with parameters:")
  console.log(`  Network: ${hre.network.name}`)
  console.log(`  tBTC Token: ${tbtcAddress}`)
  console.log(`  Token Decimals: 18`)
  console.log(`  CCIP Router: ${router}`)
  console.log(`  RMN Proxy: ${rmnProxy}`)
  console.log(`  Allowlist: ${allowlist.length === 0 ? 'Empty (permissionless)' : allowlist.join(', ')}`)

  // Deploy using hardhat-deploy's built-in proxy support
  const deployment = await deploy("BurnFromMintTokenPoolUpgradeable", {
    contract: "BurnFromMintTokenPoolUpgradeable",
    from: deployer,
    log: true,
    waitConfirmations: 1,
    proxy: {
      owner: deployer,
      proxyContract: "TransparentUpgradeableProxy",
      execute: {
        init: {
          methodName: "initialize",
          args: [tbtcAddress, 18, allowlist, rmnProxy, router],
        },
      },
    },
  })

  console.log("BurnFromMintTokenPoolUpgradeable deployed successfully!")
  console.log(`  Proxy Address: ${deployment.address}`)
  if (deployment.implementation) {
    console.log(`  Implementation Address: ${deployment.implementation}`)
  }

  // Try to get the ProxyAdmin address from deployment
  try {
    const proxyAdminDeployment = await deployments.get("DefaultProxyAdmin")
    console.log(`  ProxyAdmin Address: ${proxyAdminDeployment.address}`)
  } catch (error) {
    console.log("  ProxyAdmin deployment not found (may be managed differently)")
  }

  // Verification for Bobscan
  if (hre.network.tags.bobscan) {
    console.log(`\nContract deployed at: ${deployment.address}`)
    console.log("For better verification results, run the verification script with delay:")
    console.log(`CONTRACT_ADDRESS=${deployment.address} npx hardhat run scripts/verify-with-delay.ts --network ${hre.network.name}`)
    
    try {
      // Verify implementation
      if (deployment.implementation) {
        await hre.run("verify:verify", {
          address: deployment.implementation,
          constructorArguments: [],
        })
      }

      // Verify proxy
      await hre.run("verify:verify", {
        address: deployment.address,
      })
    } catch (error) {
      console.log("Contract verification failed, but deployment was successful.")
      console.log("You can manually verify the contract later on Bobscan.")
    }
  }
}

export default func

func.tags = ["BurnFromMintTokenPoolUpgradeable"] 