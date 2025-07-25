import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  // Router addresses for different networks
  const ROUTER_ADDRESSES = {
    bobSepolia: process.env.ROUTER_ADDRESS || "0x7808184405d6Cbc663764003dE21617fa640bc82", // fallback fantasy/testnet address
    bobMainnet: "0x827716e74F769AB7b6bb374A29235d9c2156932C",
    ethereumSepolia: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
    ethereumMainnet: "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D"
  }

  const RMN_PROXY_ADDRESS = process.env.RMN_PROXY_ADDRESS || "0x1111111111111111111111111111111111111111"; // fallback fantasy/testnet address

  // Set tBTC address, router, and rmnProxy based on network
  let tbtcAddress: string
  let router: string
  let rmnProxy: string
  if (hre.network.name === "bobMainnet") {
    tbtcAddress = "0xBBa2eF945D523C4e2608C9E1214C2Cc64D4fc2e2"
    router = ROUTER_ADDRESSES.bobMainnet
    rmnProxy = "0xe4D8E0A02C61f6DDe95255E702fe1237428673D8" // BOB Mainnet RMN
  } else if (hre.network.name === "bobSepolia") {
    tbtcAddress = "0xD23F06550b0A7bC98B20eb81D4c21572a97598FA"
    router = ROUTER_ADDRESSES.bobSepolia
    rmnProxy = "0xD642e08eeF81bb55B8282701234659A3233E2145" // BOB Sepolia testnet RMN
  } else if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    // Deploy a mock ERC20 for local testing
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock", await ethers.getSigner(deployer))
    const mockToken = await ERC20Mock.deploy("Mock tBTC", "tBTC", deployer, ethers.utils.parseEther("1000000"))
    await mockToken.deployed()
    tbtcAddress = mockToken.address
    router = ROUTER_ADDRESSES.bobSepolia // Use a fantasy/testnet router address
    rmnProxy = RMN_PROXY_ADDRESS
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

  const [, proxyDeployment] = await helpers.upgrades.deployProxy(
    "BurnFromMintTokenPoolUpgradeable",
    {
      initializerArgs: [tbtcAddress, allowlist, rmnProxy, router],
      factoryOpts: { signer: await ethers.getSigner(deployer) },
      proxyOpts: { kind: "transparent" },
    }
  )

  if (hre.network.tags.bobscan) {
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }
}

export default func

func.tags = ["BurnFromMintTokenPoolUpgradeable"] 