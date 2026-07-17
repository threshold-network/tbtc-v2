import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  // Deploy the new implementation contract
  const implementation = await deploy("OptimismMintableUpgradableTBTC", {
    contract: "OptimismMintableUpgradableTBTC",
    from: deployer,
    log: true,
    waitConfirmations: 1,
  })

  console.log(
    "OptimismMintableUpgradableTBTC implementation deployed at:",
    implementation.address
  )

  // Verify on Bobscan if applicable
  if (hre.network.tags.bobscan) {
    await hre.run("verify:verify", {
      address: implementation.address,
      constructorArguments: [],
    })
  }
}

export default func

func.tags = ["OptimismMintableUpgradableTBTC"]
