/**
 * Patched copy of @threshold-network/solidity-contracts@1.3.0-dev.12/export/deploy/05_transfer_t.js
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
      // The idempotent-rerun case is already handled by the vmBn.gte(targetBn)
      // branch above. Reaching here means the vending machine is still under
      // the target AND the deployer cannot cover the shortfall, i.e. a broken
      // / underfunded deploy. Fail loudly instead of masking it as a successful
      // replay, otherwise later phases run with less T than this stack expects.
      throw new Error(
        `VendingMachine for ${tokenSymbol} is short ${from1e18(
          needed
        )} T (has ${from1e18(vmBn)} of ${from1e18(
          targetBn
        )}) and deployer only holds ${from1e18(deployerBn)} T`
      )
    }

    await execute(
      "T",
      { from: deployer, log: true, waitConfirmations: 1 },
      "transfer",
      vendingMachineAddress,
      needed
    )
    log(
      `transferred ${from1e18(
        needed
      )} T to the VendingMachine for ${tokenSymbol}`
    )
  }
}

module.exports = func
func.tags = ["TransferT"]
func.dependencies = ["MintT", "VendingMachineNuCypher"]
