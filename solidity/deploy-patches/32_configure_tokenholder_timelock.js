"use strict"
/**
 * Patched copy of @threshold-network/solidity-contracts/export/deploy/32_configure_tokenholder_timelock.js
 *
 * After the first successful run, deployer renounces TIMELOCK_ADMIN_ROLE and can no longer grantRole.
 * Re-running Phase H replays this script and reverts with AccessControl missing admin role.
 *
 * Idempotent: grant only if governor lacks PROPOSER_ROLE; renounce only if deployer still has admin.
 */
const func = async function (hre) {
  const { getNamedAccounts, deployments } = hre
  const { deployer } = await getNamedAccounts()
  const { execute, read, log } = deployments

  const TokenholderGovernor = await deployments.get("TokenholderGovernor")
  const PROPOSER_ROLE = await read("TokenholderTimelock", "PROPOSER_ROLE")
  const TIMELOCK_ADMIN_ROLE = await read("TokenholderTimelock", "TIMELOCK_ADMIN_ROLE")

  const governorHasProposer = await read(
    "TokenholderTimelock",
    "hasRole",
    PROPOSER_ROLE,
    TokenholderGovernor.address
  )

  if (!governorHasProposer) {
    await execute(
      "TokenholderTimelock",
      { from: deployer, log: true, waitConfirmations: 1 },
      "grantRole",
      PROPOSER_ROLE,
      TokenholderGovernor.address
    )
    log(`Granted PROPOSER_ROLE to ${TokenholderGovernor.address}`)
  } else {
    log(
      `TokenholderGovernor already has PROPOSER_ROLE; skipping grantRole`
    )
  }

  const deployerHasTimelockAdmin = await read(
    "TokenholderTimelock",
    "hasRole",
    TIMELOCK_ADMIN_ROLE,
    deployer
  )

  if (deployerHasTimelockAdmin) {
    await execute(
      "TokenholderTimelock",
      { from: deployer, log: true, waitConfirmations: 1 },
      "renounceRole",
      TIMELOCK_ADMIN_ROLE,
      deployer
    )
    log(`Address ${deployer} renounced TIMELOCK_ADMIN_ROLE`)
  } else {
    log(`Deployer no longer has TIMELOCK_ADMIN_ROLE; skipping renounceRole`)
  }
}

module.exports = func
func.tags = ["ConfigTokenholderTimelock"]
func.dependencies = ["TokenholderGovernor"]
