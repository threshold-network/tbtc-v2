import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  // TODO: waiting for the addresses to be defined
  const L2_BRIDGE = "0x4200000000000000000000000000000000000010"
  const L1_TBTC = "0x517f2982701695D4E52f1ECFBEf3ba31Df470161"

  // Deploy using hardhat-deploy's built-in proxy support
  const deployment = await deploy("OptimismMintableUpgradableERC20", {
    contract: "OptimismMintableUpgradableERC20",
    from: deployer,
    log: true,
    waitConfirmations: 1,
    proxy: {
      owner: deployer,
      proxyContract: "TransparentUpgradeableProxy",
      execute: {
        init: {
          methodName: "initialize",
          args: [L2_BRIDGE, L1_TBTC, "BOB tBTC v2", "tBTC", 18],
        },
      },
    },
  })

  console.log("Proxy deployed at:", deployment.address)
  if (deployment.implementation) {
    console.log("Implementation deployed at:", deployment.implementation)
  }

  // Try to get the ProxyAdmin address from deployment (it may not always exist)
  try {
    const proxyAdminDeployment = await deployments.get("DefaultProxyAdmin")
    console.log("ProxyAdmin deployed at:", proxyAdminDeployment.address)
  } catch (error) {
    console.log("ProxyAdmin deployment not found (may be managed differently)")
  }

  // TODO: Investigate the possibility of adding Tenderly verification for
  // L2 and upgradable proxy.

  // Contracts can be verified on L2 Bobscan in a similar way as we do it on
  // L1 Etherscan
  if (hre.network.tags.bobscan) {
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
  }
}

export default func

func.tags = ["OptimismMintableUpgradableERC20"]
