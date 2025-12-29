import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function deployMintBurnGuard(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts } = hre
  const { deploy, log } = deployments

  const { deployer } = await getNamedAccounts()

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

  const deployment = await deploy("MintBurnGuard", {
    from: deployer,
    args: [owner, operator],
    log: true,
    waitConfirmations: 1,
  })

  log(`MintBurnGuard deployed at ${deployment.address}`)
}

export default func

func.tags = ["MintBurnGuard"]
