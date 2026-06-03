import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { getNamedAccounts, deployments, ethers, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  const FrostWalletRegistry = await deployments.get("FrostWalletRegistry")

  let FrostAllowlist = await deployments.getOrNull("FrostAllowlist")
  let frostAllowlistAddress: string

  if (FrostAllowlist) {
    frostAllowlistAddress = FrostAllowlist.address
    console.log(
      `FrostAllowlist already deployed at ${frostAllowlistAddress}; skipping deployment`
    )
  } else {
    const [frostAllowlist] = await helpers.upgrades.deployProxy(
      "FrostAllowlist",
      {
        contractName: "FrostAllowlist",
        initializerArgs: [FrostWalletRegistry.address],
        factoryOpts: {
          signer: await ethers.getSigner(deployer),
        },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )

    frostAllowlistAddress = frostAllowlist.address
    FrostAllowlist = await deployments.get("FrostAllowlist")

    console.log(`FrostAllowlist deployed at: ${frostAllowlistAddress}`)
    console.log(`FrostAllowlist owner: ${await frostAllowlist.owner()}`)
    if (governance && governance !== deployer) {
      console.log(
        `FrostAllowlist ownership remains with deployer for weight initialization; transfer to governance (${governance}) can be done after the allowlist is populated`
      )
    }
  }

  const frostWalletRegistry = await ethers.getContractAt(
    "FrostWalletRegistry",
    FrostWalletRegistry.address
  )

  const currentAuthorizationSource =
    await frostWalletRegistry.authorizationSource()
  if (currentAuthorizationSource === ethers.constants.AddressZero) {
    const registryGovernance = await frostWalletRegistry.governance()
    if (registryGovernance.toLowerCase() !== deployer.toLowerCase()) {
      throw new Error(
        "FrostWalletRegistry authorization source must be initialized by registry " +
          `governance ${registryGovernance}; deployer ${deployer} cannot execute it`
      )
    }

    await frostWalletRegistry
      .connect(await ethers.getSigner(deployer))
      .initializeV2(frostAllowlistAddress)
    console.log(
      `initialized FrostWalletRegistry authorization source with FrostAllowlist ${frostAllowlistAddress}`
    )
  } else if (
    currentAuthorizationSource.toLowerCase() !==
    frostAllowlistAddress.toLowerCase()
  ) {
    throw new Error(
      `FrostWalletRegistry authorization source mismatch: current ${currentAuthorizationSource}, expected ${frostAllowlistAddress}`
    )
  } else {
    console.log(
      `FrostWalletRegistry already uses FrostAllowlist as authorization source ${frostAllowlistAddress}`
    )
  }

  if (hre.network.tags.etherscan && FrostAllowlist) {
    await hre.run("verify", {
      address: FrostAllowlist.address,
      constructorArgsParams: FrostAllowlist.args,
    })
  }
}

export default func

func.tags = ["FrostAllowlist"]
func.dependencies = ["FrostWalletRegistry"]
