"use strict"
/**
 * Patched copy of @threshold-network/solidity-contracts/export/deploy/07_deploy_token_staking.js
 *
 * Upstream always calls initialize() after deployments.deploy(), which fails when reusing an
 * already-initialized TokenStaking proxy from Phase A (solidity-contracts) with
 * "Initializable: contract is already initialized".
 *
 * Apply: scripts/apply-solidity-contracts-export-deploy-patch.sh (also run from full-redeploy-sepolia-stack.sh).
 */
const hardhat = require("hardhat")

const func = async function (hre) {
  const { getNamedAccounts, deployments } = hre
  const { execute, log } = deployments
  const { deployer } = await getNamedAccounts()

  const T = await deployments.get("T")
  const VendingMachineNuCypher = await deployments.get("VendingMachineNuCypher")

  const tokenStakingConstructorArgs = [T.address, VendingMachineNuCypher.address]
  const tokenStakingInitializerArgs = []

  let tokenStakingAddress

  if (hre.network.name == "mainnet") {
    const TokenStaking = await hardhat.ethers.getContractFactory("TokenStaking")

    const tokenStaking = await hardhat.upgrades.deployProxy(
      TokenStaking,
      tokenStakingInitializerArgs,
      {
        constructorArgs: tokenStakingConstructorArgs,
      }
    )
    tokenStakingAddress = tokenStaking.address
    log(`Deployed TokenStaking with TransparentProxy at ${tokenStakingAddress}`)

    const implementationInterface = tokenStaking.interface
    const jsonAbi = implementationInterface.format(
      hardhat.ethers.utils.FormatTypes.json
    )

    const tokenStakingDeployment = {
      address: tokenStakingAddress,
      abi: JSON.parse(jsonAbi),
    }
    const fs = require("fs")
    fs.writeFileSync(
      "TokenStaking.json",
      JSON.stringify(tokenStakingDeployment, null, 2),
      "utf8",
      function (err) {
        if (err) {
          console.log(err)
        }
      }
    )
    log(`Saved TokenStaking address and ABI in TokenStaking.json`)
  } else {
    const TokenStaking = await deployments.deploy("TokenStaking", {
      from: deployer,
      args: tokenStakingConstructorArgs,
      log: true,
    })
    tokenStakingAddress = TokenStaking.address

    if (TokenStaking.newlyDeployed) {
      await execute("TokenStaking", { from: deployer }, "initialize")
      log("Initialized TokenStaking.")
    } else {
      log(
        "TokenStaking already deployed on-chain; skipping initialize (reuse from Phase A / external deploy)."
      )
    }
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "TokenStaking",
      address: tokenStakingAddress,
    })
  }
}

module.exports = func
func.tags = ["TokenStaking"]
func.dependencies = ["T", "VendingMachineNuCypher", "MintT"]
