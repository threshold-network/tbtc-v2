"use strict"
/**
 * Patched copy of @threshold-network/solidity-contracts/export/deploy/05_transfer_t.js
 *
 * Upstream always transfers 4.5B T to the vending machine. On a second deploy run the deployer
 * already sent those tokens → "Transfer amount exceeds balance".
 *
 * Idempotent: skip if the vending machine already holds the target amount; otherwise transfer only
 * the shortfall when the deployer can cover it.
 */
const func = async function (hre) {
  const { getNamedAccounts, deployments, helpers, ethers } = hre
  const { deployer } = await getNamedAccounts()
  const { execute, read, log } = deployments
  const { to1e18, from1e18 } = helpers.number

  const VendingMachineNuCypher = await deployments.get("VendingMachineNuCypher")
  const vendingMachines = [
    {
      tokenSymbol: "NU",
      vendingMachineAddress: VendingMachineNuCypher.address,
    },
  ]

  const T_TO_TRANSFER = to1e18("4500000000")
  const targetBn = ethers.BigNumber.from(T_TO_TRANSFER)

  for (const { tokenSymbol, vendingMachineAddress } of vendingMachines) {
    const vmBal = await read("T", "balanceOf", vendingMachineAddress)
    const deployerBal = await read("T", "balanceOf", deployer)

    const vmBn = ethers.BigNumber.from(vmBal)
    const deployerBn = ethers.BigNumber.from(deployerBal)

    if (vmBn.gte(targetBn)) {
      log(
        `Vending machine for ${tokenSymbol} already has >= ${from1e18(
          targetBn
        )} T; skipping transfer`
      )
      continue
    }

    const needed = targetBn.sub(vmBn)
    if (deployerBn.lt(needed)) {
      log(
        `Deployer T balance ${from1e18(deployerBn)} < needed ${from1e18(
          needed
        )}; skipping transfer (likely already sent in a prior deploy)`
      )
      continue
    }

    await execute(
      "T",
      { from: deployer, log: true, waitConfirmations: 1 },
      "transfer",
      vendingMachineAddress,
      needed
    )
    log(
      `transferred ${from1e18(needed)} T to the VendingMachine for ${tokenSymbol}`
    )
  }
}

module.exports = func
func.tags = ["TransferT"]
func.dependencies = ["MintT", "VendingMachineNuCypher"]
