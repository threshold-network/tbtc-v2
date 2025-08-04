import { HardhatRuntimeEnvironment } from "hardhat/types"

async function main() {
  const hre: HardhatRuntimeEnvironment = require("hardhat")
  const contractAddress = process.env.CONTRACT_ADDRESS
  const constructorArgs = process.env.CONSTRUCTOR_ARGS ? JSON.parse(process.env.CONSTRUCTOR_ARGS) : []
  
  if (!contractAddress) {
    console.error("Please provide CONTRACT_ADDRESS environment variable")
    process.exit(1)
  }

  console.log(`Waiting for contract ${contractAddress} to be indexed on Etherscan...`)
  
  // Wait for 30 seconds for Etherscan indexing
  console.log("Waiting 30 seconds for Etherscan indexing...")
  await new Promise(resolve => setTimeout(resolve, 30000))
  
  try {
    console.log("Attempting to verify contract...")
    await hre.run("verify", {
      address: contractAddress,
      constructorArgsParams: constructorArgs,
    })
    console.log("Contract verification successful!")
  } catch (error) {
    console.log("Contract verification failed, but deployment was successful.")
    console.log("You can manually verify the contract later on Etherscan.")
    console.log(`Contract address: ${contractAddress}`)
    console.log("Error:", error)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  }) 