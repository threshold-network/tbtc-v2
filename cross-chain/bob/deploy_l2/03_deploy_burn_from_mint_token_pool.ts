import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  // Set tBTC address based on network
  let tbtcAddress: string
  if (hre.network.name === "bobMainnet") {
    tbtcAddress = "0xBBa2eF945D523C4e2608C9E1214C2Cc64D4fc2e2"
  } else if (hre.network.name === "bobSepolia") {
    tbtcAddress = "0xD23F06550b0A7bC98B20eb81D4c21572a97598FA"
  } else if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    // Deploy a mock ERC20 for local testing
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock", await ethers.getSigner(deployer))
    const mockToken = await ERC20Mock.deploy("Mock tBTC", "tBTC", deployer, ethers.utils.parseEther("1000000"))
    await mockToken.deployed()
    tbtcAddress = mockToken.address
  } else {
    throw new Error("Unsupported network for BOB pool deployment")
  }

  // Minimal allowlist, rmnProxy, router for now (can be updated post-deploy)
  const allowlist: string[] = []
  const rmnProxy = ethers.constants.AddressZero
  const router = ethers.constants.AddressZero

  const [, proxyDeployment] = await helpers.upgrades.deployProxy(
    "BurnFromMintTokenPoolUpgradeable",
    {
      initializerArgs: [tbtcAddress, allowlist, rmnProxy, router],
      factoryOpts: { signer: await ethers.getSigner(deployer) },
      proxyOpts: { kind: "transparent" },
    }
  )

  // Verification for BOB explorer
  if (hre.network.tags.bobscan) {
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  // Transfer proxy admin ownership to council multisig on mainnet (manual step for tests)
  // if (hre.network.name === "bobMainnet" && proxyAdmin) {
  //   const councilMs = "0x694DeC29F197c76eb13d4Cc549cE38A1e06Cd24C"
  //   if (typeof helpers.upgrades.transferProxyAdminOwnership === "function") {
  //     await helpers.upgrades.transferProxyAdminOwnership(proxyAdmin.address, councilMs)
  //   }
  // }
}

export default func

func.tags = ["BurnFromMintTokenPoolUpgradeable"] 