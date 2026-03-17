import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function deployMintBurnGuard(
  hre: HardhatRuntimeEnvironment
) {
  const { ethers, helpers, deployments, getNamedAccounts } = hre
  const { deployer } = await getNamedAccounts()

  const TBTCVault = await deployments.get("TBTCVault")

  // Allow overriding the MintBurnGuard owner and operator via env vars.
  // Defaults:
  // - owner: deployer
  // - operator: unset (0x0) and configured later via governance.
  const owner =
    process.env.MINT_BURN_GUARD_OWNER &&
    process.env.MINT_BURN_GUARD_OWNER.length > 0
      ? process.env.MINT_BURN_GUARD_OWNER
      : deployer

  const operator =
    process.env.MINT_BURN_GUARD_OPERATOR &&
    process.env.MINT_BURN_GUARD_OPERATOR.length > 0
      ? process.env.MINT_BURN_GUARD_OPERATOR
      : "0x0000000000000000000000000000000000000000"

  const [mintBurnGuard, proxyDeployment] = await helpers.upgrades.deployProxy(
    "MintBurnGuard",
    {
      contractName: "MintBurnGuard",
      initializerArgs: [owner, operator, TBTCVault.address],
      factoryOpts: {
        signer: await ethers.getSigner(deployer),
      },
      proxyOpts: {
        kind: "transparent",
      },
    }
  )

  if (hre.network.tags.etherscan) {
    // We use `verify` instead of `verify:verify` as the `verify` task is defined
    // in "@openzeppelin/hardhat-upgrades" to perform Etherscan verification
    // of Proxy and Implementation contracts.
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "MintBurnGuard",
      address: mintBurnGuard.address,
    })
  }

  deployments.log(`MintBurnGuard deployed at ${mintBurnGuard.address}`)
}

export default func

func.tags = ["MintBurnGuard"]
func.dependencies = ["TBTCVault"]
