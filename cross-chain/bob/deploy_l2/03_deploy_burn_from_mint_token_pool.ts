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

  // Set tBTC address and router based on network
  let tbtcAddress: string
  let router: string
  if (hre.network.name === "bobMainnet") {
    tbtcAddress = "0xBBa2eF945D523C4e2608C9E1214C2Cc64D4fc2e2"
    router = ROUTER_ADDRESSES.bobMainnet
  } else if (hre.network.name === "bobSepolia") {
    tbtcAddress = "0xD23F06550b0A7bC98B20eb81D4c21572a97598FA"
    router = ROUTER_ADDRESSES.bobSepolia
  } else {
    throw new Error("Unsupported network for BurnFromMintTokenPoolUpgradeable deployment")
  }

  if (!router || router === ethers.constants.AddressZero) {
    throw new Error("Router address must be set and non-zero for deployment")
  }

  const allowlist: string[] = []
  const rmnProxy = ethers.constants.AddressZero

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