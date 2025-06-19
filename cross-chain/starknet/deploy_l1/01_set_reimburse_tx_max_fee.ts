import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, deployments, getNamedAccounts } = hre
  const { deployer } = await getNamedAccounts()

  console.log("=== Setting ReimburseTxMaxFee to True ===")
  console.log(`Network: ${hre.network.name}`)
  console.log(`Deployer: ${deployer}`)

  // Get the deployed StarkNetBitcoinDepositor proxy
  const starkNetBitcoinDepositorDeployment = await deployments.get(
    "StarkNetBitcoinDepositor"
  )

  console.log(
    `StarkNetBitcoinDepositor proxy address: ${starkNetBitcoinDepositorDeployment.address}`
  )

  // Get the contract instance
  const starkNetBitcoinDepositor = await ethers.getContractAt(
    "StarkNetBitcoinDepositor",
    starkNetBitcoinDepositorDeployment.address
  )

  // Check current owner
  const currentOwner = await starkNetBitcoinDepositor.owner()
  console.log(`Current contract owner: ${currentOwner}`)

  if (currentOwner.toLowerCase() !== deployer.toLowerCase()) {
    throw new Error(
      `Deployer ${deployer} is not the current owner ${currentOwner}. Cannot proceed.`
    )
  }

  // Check current reimburseTxMaxFee value
  const currentValue = await starkNetBitcoinDepositor.reimburseTxMaxFee()
  console.log(`Current reimburseTxMaxFee value: ${currentValue}`)

  if (currentValue === true) {
    console.log("✅ reimburseTxMaxFee is already set to true. Skipping.")
    return
  }

  // Set reimburseTxMaxFee to true
  console.log("Setting reimburseTxMaxFee to true...")
  const tx = await starkNetBitcoinDepositor.setReimburseTxMaxFee(true)
  console.log(`Transaction hash: ${tx.hash}`)

  // Wait for confirmation
  console.log("Waiting for transaction confirmation...")
  const receipt = await tx.wait()
  console.log(`Transaction confirmed in block ${receipt.blockNumber}`)

  // Verify the value was set
  const newValue = await starkNetBitcoinDepositor.reimburseTxMaxFee()
  if (newValue === true) {
    console.log("✅ Successfully set reimburseTxMaxFee to true")
  } else {
    throw new Error("Failed to set reimburseTxMaxFee to true")
  }
}

export default func

func.tags = ["SetReimburseTxMaxFee"]
func.dependencies = ["StarkNetBitcoinDepositor"]