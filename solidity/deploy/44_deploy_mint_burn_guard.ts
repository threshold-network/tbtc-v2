import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { deploy, log } = deployments

  const { deployer } = await getNamedAccounts()

  // Allow overriding the MintBurnGuard owner and controller via env vars.
  // Defaults:
  // - owner: deployer
  // - controller: unset (0x0) and configured later via governance.
  const owner =
    process.env.MINT_BURN_GUARD_OWNER &&
    process.env.MINT_BURN_GUARD_OWNER.length > 0
      ? process.env.MINT_BURN_GUARD_OWNER
      : deployer

  const controller =
    process.env.MINT_BURN_GUARD_CONTROLLER &&
    process.env.MINT_BURN_GUARD_CONTROLLER.length > 0
      ? process.env.MINT_BURN_GUARD_CONTROLLER
      : "0x0000000000000000000000000000000000000000"

  const initialTotalMinted =
    process.env.MINT_BURN_GUARD_INITIAL_TOTAL_MINTED &&
    process.env.MINT_BURN_GUARD_INITIAL_TOTAL_MINTED.length > 0
      ? ethers.utils.parseEther(
          process.env.MINT_BURN_GUARD_INITIAL_TOTAL_MINTED
        )
      : ethers.constants.Zero

  const initialGlobalMintCap =
    process.env.MINT_BURN_GUARD_GLOBAL_CAP &&
    process.env.MINT_BURN_GUARD_GLOBAL_CAP.length > 0
      ? ethers.utils.parseEther(process.env.MINT_BURN_GUARD_GLOBAL_CAP)
      : ethers.constants.Zero

  const deployment = await deploy("MintBurnGuard", {
    from: deployer,
    args: [owner, controller, initialTotalMinted, initialGlobalMintCap],
    log: true,
    waitConfirmations: 1,
  })

  log(`MintBurnGuard deployed at ${deployment.address}`)

  const mintBurnGuard = await ethers.getContractAt(
    "MintBurnGuard",
    deployment.address
  )

  const deployedOwner = await mintBurnGuard.owner()
  const deployedController = await mintBurnGuard.controller()
  const deployedTotalMinted = await mintBurnGuard.totalMinted()
  const deployedGlobalMintCap = await mintBurnGuard.globalMintCap()
  log(`MintBurnGuard owner: ${deployedOwner}`)
  log(`MintBurnGuard controller: ${deployedController}`)
  log(`MintBurnGuard totalMinted: ${deployedTotalMinted.toString()}`)
  log(`MintBurnGuard globalMintCap: ${deployedGlobalMintCap.toString()}`)

  if (deployedOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      "MintBurnGuard owner mismatch after deployment. Deployment aborted for safety."
    )
  }

  if (
    controller !== ethers.constants.AddressZero &&
    deployedController.toLowerCase() !== controller.toLowerCase()
  ) {
    throw new Error(
      "MintBurnGuard controller mismatch after deployment. Manual intervention required."
    )
  }

  if (!deployedTotalMinted.eq(initialTotalMinted)) {
    throw new Error(
      "MintBurnGuard totalMinted mismatch after deployment. Manual intervention required."
    )
  }

  if (!deployedGlobalMintCap.eq(initialGlobalMintCap)) {
    throw new Error(
      "MintBurnGuard globalMintCap mismatch after deployment. Manual intervention required."
    )
  }
}

export default func

func.tags = ["MintBurnGuard"]
func.dependencies = ["Bridge"]
