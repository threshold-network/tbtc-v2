import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, getNamedAccounts, helpers, deployments } = hre
  const { deployer } = await getNamedAccounts()

  // Get core tBTC contracts from mainnet/sepolia deployment
  const tbtcBridge = await deployments.get("Bridge")
  const tbtcVault = await deployments.get("TBTCVault")

  // StarkNet Sepolia testnet configuration
  const STARKGATE_BRIDGE_SEPOLIA = "0x95fa1deDF00d6B3c6EF7DfDB36dD954Eb9Dbe829"
  const STARKNET_TBTC_TOKEN_SEPOLIA = "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
  const L1_TO_L2_MESSAGE_FEE = ethers.utils.parseEther("0.01") // Initial fee, can be updated by owner

  const [, proxyDeployment] = await helpers.upgrades.deployProxy(
    "StarkNetL1BitcoinDepositor",
    {
      contractName:
        "@keep-network/tbtc-v2/contracts/l1/StarkNetBitcoinDepositor.sol:StarkNetBitcoinDepositor",
      initializerArgs: [
        tbtcBridge.address,
        tbtcVault.address,
        STARKGATE_BRIDGE_SEPOLIA,
        STARKNET_TBTC_TOKEN_SEPOLIA,
        L1_TO_L2_MESSAGE_FEE,
      ],
      factoryOpts: { signer: await ethers.getSigner(deployer) },
      proxyOpts: {
        kind: "transparent",
      },
    }
  )

  if (hre.network.tags.etherscan) {
    // We use `verify` instead of `verify:verify` as the `verify` task is defined
    // in "@openzeppelin/hardhat-upgrades" to perform Etherscan verification
    // of Proxy and Implementation contracts.
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  // Log deployment info
  console.log("StarkNetL1BitcoinDepositor deployed to:", proxyDeployment.address)
  console.log("With parameters:")
  console.log("  tBTC Bridge:", tbtcBridge.address)
  console.log("  tBTC Vault:", tbtcVault.address)  
  console.log("  StarkGate Bridge:", STARKGATE_BRIDGE_SEPOLIA)
  console.log("  StarkNet tBTC Token:", STARKNET_TBTC_TOKEN_SEPOLIA)
  console.log("  L1->L2 Message Fee:", ethers.utils.formatEther(L1_TO_L2_MESSAGE_FEE), "ETH")
}

export default func

func.tags = ["StarkNetL1BitcoinDepositor"]
func.dependencies = ["Bridge", "TBTCVault"]