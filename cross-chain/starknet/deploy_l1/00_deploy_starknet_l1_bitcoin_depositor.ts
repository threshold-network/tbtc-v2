import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const TBTC_BRIDGE_ADDRESS = "0x9b1a7fE5a16A15F2f9475C5B231750598b113403"
const TBTC_VAULT_ADDRESS = "0xB5679dE944A79732A75CE5561919DF11F489448d5"

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
  console.log(`Deployer address (L1 Testnet): ${deployer}`)

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
  let starkNetTBTCToken: string

  if (hre.network.name === "sepolia") {
    // StarkNet Sepolia testnet configuration
    starkGateBridge = "0x95fa1deDF00d6B3c6EF7DfDB36dD954Eb9Dbe829"
    starkNetTBTCToken =
      "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
  } else if (hre.network.name === "mainnet") {
    // StarkNet mainnet configuration
    starkGateBridge = "0xae0Ee0A63A2cE6BaeEFFE56e7714FB4EFE48D419" // StarkGate Ethereum Bridge
    // NOTE: Update this address with the actual mainnet tBTC token address on StarkNet before mainnet deployment
    starkNetTBTCToken = "0x" // TODO: Add actual mainnet tBTC token address on StarkNet
  } else if (["hardhat", "localhost", "development"].includes(hre.network.name)) {
    // Local testing configuration with mock addresses
    starkGateBridge = "0x1234567890123456789012345678901234567890" // Mock StarkGate bridge
    starkNetTBTCToken =
      "0x0123456789012345678901234567890123456789012345678901234567890123" // Mock StarkNet tBTC token (32 bytes)
    console.log("⚠️  Using mock addresses for local testing")
  } else {
    throw new Error(`Unsupported network: ${hre.network.name}`)
  }

  const L1_TO_L2_MESSAGE_FEE = ethers.utils.parseEther("0.01") // Initial fee, can be updated by owner

  console.log(`Using StarkGate Bridge for StarkNet: ${starkGateBridge}`)
  console.log(`Using StarkNet tBTC Token: ${starkNetTBTCToken}`)
  console.log(
    `Using L1->L2 Message Fee: ${ethers.utils.formatEther(
      L1_TO_L2_MESSAGE_FEE
    )} ETH`
  )

  const [starkNetBitcoinDepositorDeployment, proxyDeployment] =
    await helpers.upgrades.deployProxy(
      "StarkNetBitcoinDepositor", // Name of the contract to deploy
      {
        contractName: "StarkNetBitcoinDepositor", // Specifies the contract name for the proxy
        initializerArgs: [
          tbtcBridge.address,
          tbtcVault.address,
          starkGateBridge,
          starkNetTBTCToken,
          L1_TO_L2_MESSAGE_FEE,
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
    `StarkNetBitcoinDepositor (logic) deployed to: ${await starkNetBitcoinDepositor.address}`
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
