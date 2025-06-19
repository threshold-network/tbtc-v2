import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const TBTC_BRIDGE_ADDRESS = "0x5e4861a80B55f035D899f66772117F00FA0E8e7B"
const TBTC_VAULT_ADDRESS = "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD"

// Wait for a specified number of blocks
async function waitForBlocks(
  hre: HardhatRuntimeEnvironment,
  blocks: number = 3
) {
  console.log(`Waiting for ${blocks} blocks...`)
  const provider = hre.ethers.provider
  const startBlock = await provider.getBlockNumber()

  while (true) {
    const currentBlock = await provider.getBlockNumber()
    if (currentBlock >= startBlock + blocks) {
      break
    }
    // Wait 12 seconds (average Ethereum block time)
    await new Promise((resolve) => setTimeout(resolve, 12000))
  }
  console.log(
    `Waited for ${blocks} blocks. Current block: ${await provider.getBlockNumber()}`
  )
}

// Retry verification with exponential backoff
async function retryVerification(
  hre: HardhatRuntimeEnvironment,
  address: string,
  constructorArguments?: any[],
  maxRetries: number = 3
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Verification attempt ${attempt}/${maxRetries}...`)
      await hre.run("verify:verify", {
        address,
        constructorArguments: constructorArguments || [],
      })
      console.log("Contract verification successful.")
      return true
    } catch (error: any) {
      console.error(`Verification attempt ${attempt} failed:`, error.message)

      if (attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 15000 // 30s, 60s, 120s
        console.log(`Waiting ${waitTime / 1000}s before retry...`)
        await new Promise((resolve) => setTimeout(resolve, waitTime))
      }
    }
  }
  return false
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments, getNamedAccounts } = hre
  const { deployer } = await getNamedAccounts()

  console.log("Deploying StarkNetBitcoinDepositor for StarkNet integration...")
  console.log(`Deployer address: ${deployer}`)

  // Validate that the private key matches the expected deployer address
  if (hre.network.name === "mainnet") {
    const signer = await ethers.getSigner(deployer)
    const signerAddress = await signer.getAddress()
    
    if (signerAddress.toLowerCase() !== deployer.toLowerCase()) {
      throw new Error(
        `Private key mismatch! The configured private key generates address ${signerAddress}, but expected deployer is ${deployer}. ` +
        `Please ensure L1_ACCOUNTS_PK_MAINNET contains the private key for address ${deployer}.`
      )
    }
    console.log("✅ Private key validation passed")
  }

  // Get core tBTC contracts from mainnet/sepolia deployment
  let tbtcBridge: any
  let tbtcVault: any

  try {
    tbtcBridge = await deployments.get("Bridge")
    tbtcVault = await deployments.get("TBTCVault")
  } catch (error) {
    console.log("Using hardcoded addresses for tBTC contracts...")
    tbtcBridge = { address: TBTC_BRIDGE_ADDRESS }
    tbtcVault = { address: TBTC_VAULT_ADDRESS }
  }

  // Network-specific StarkNet configuration
  let starkGateBridge: string

  if (hre.network.name === "sepolia") {
    // StarkNet Sepolia testnet configuration - Updated to correct address
    starkGateBridge = "0xF6217de888fD6E6b2CbFBB2370973BE4c36a152D"
  } else if (hre.network.name === "mainnet") {
    // StarkNet mainnet configuration
    starkGateBridge = "0x2111A49ebb717959059693a3698872a0aE9866b9" // StarkGate L1 Bridge
  } else if (["hardhat", "localhost", "development"].includes(hre.network.name)) {
    // Local testing configuration with mock addresses
    starkGateBridge = "0x123..." // Placeholder Address
    console.log("⚠️  Using mock addresses for local testing")
  } else {
    throw new Error(`Unsupported network: ${hre.network.name}`)
  }

  console.log(`Using StarkGate Bridge for StarkNet: ${starkGateBridge}`)

  const [starkNetBitcoinDepositorDeployment, proxyDeployment] =
    await helpers.upgrades.deployProxy(
      "StarkNetBitcoinDepositor", // Name of the contract to deploy
      {
        contractName: "StarkNetBitcoinDepositor", // Specifies the contract name for the proxy
        initializerArgs: [
          tbtcBridge.address,
          tbtcVault.address,
          starkGateBridge,
        ],
        factoryOpts: {
          signer: await ethers.getSigner(deployer),
        },
        proxyOpts: {
          kind: "transparent",
          // Allow external libraries linking. We need to ensure manually that the
          // external libraries we link are upgrade safe, as the OpenZeppelin plugin
          // doesn't perform such a validation yet.
          // See: https://docs.openzeppelin.com/upgrades-plugins/1.x/faq#why-cant-i-use-external-libraries
          unsafeAllow: ["external-library-linking"],
        },
      }
    )

  const starkNetBitcoinDepositor = starkNetBitcoinDepositorDeployment // The main contract instance

  console.log(
    `StarkNetBitcoinDepositor (logic) deployed to: ${starkNetBitcoinDepositor.address}`
  )
  console.log(
    `StarkNetBitcoinDepositorProxy deployed to: ${proxyDeployment.address}`
  )
  console.log(
    `StarkNetBitcoinDepositor implementation (logic contract for proxy) deployed to: ${await hre.upgrades.erc1967.getImplementationAddress(
      proxyDeployment.address
    )}`
  )

  // Verify contracts on supported networks with proper wait and retry logic
  const isTestNetwork = ["hardhat", "localhost", "development"].includes(
    hre.network.name
  )

  if (!isTestNetwork && hre.network.tags.etherscan) {
    // Wait for transactions to be indexed by Etherscan
    await waitForBlocks(hre)

    console.log("Verifying StarkNetBitcoinDepositorProxy...")
    const proxyVerified = await retryVerification(hre, proxyDeployment.address)

    if (!proxyVerified) {
      console.warn(
        "Proxy contract verification failed after all retries. You can verify manually later."
      )
    }
  }

  if (hre.network.tags.tenderly) {
    try {
      console.log(
        "Verifying StarkNetBitcoinDepositor implementation on Tenderly..."
      )
      await hre.tenderly.verify({
        name: "StarkNetBitcoinDepositor", // The name of the implementation contract
        address: await hre.upgrades.erc1967.getImplementationAddress(
          proxyDeployment.address
        ),
      })
      console.log("Tenderly verification successful.")
    } catch (error) {
      console.error("Tenderly verification failed:", error)
    }
  }
}

export default func

func.tags = ["StarkNetBitcoinDepositor"]
// It's good practice to add dependencies if this deploy script depends on others
// func.dependencies = ["OtherDeployScript"];
