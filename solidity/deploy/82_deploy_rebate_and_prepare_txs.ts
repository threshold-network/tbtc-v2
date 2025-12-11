import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import fs from "fs"
import path from "path"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments, getNamedAccounts } = hre
  const { get } = deployments
  const { deployer } = await getNamedAccounts()

  console.log("\n========== REBATE DEPLOYMENT STARTING ==========")
  console.log("Network:", hre.network.name)
  console.log("Deployer:", deployer)
  console.log("=================================================\n")

  // Verify we're using existing mainnet deployments - do NOT redeploy!
  console.log("Verifying existing mainnet infrastructure...")
  try {
    const Bridge = await deployments.get("Bridge")
    const BridgeGovernance = await deployments.get("BridgeGovernance")
    console.log("✓ Using existing Bridge at:", Bridge.address)
    console.log(
      "✓ Using existing BridgeGovernance at:",
      BridgeGovernance.address
    )
  } catch (error) {
    console.log("❌ Error: Missing required mainnet deployments!")
    throw error
  }

  // Step 1: Deploy RebateStaking
  console.log("Step 1: Deploying RebateStaking contract...")

  const Bridge = await deployments.get("Bridge")

  // Use the mainnet T token address directly (Threshold Network token)
  const T_TOKEN_ADDRESS = "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5" // Mainnet T token
  const t = { address: T_TOKEN_ADDRESS }

  let rebateStaking: any
  let rebateProxyDeployment: any

  try {
    // Try to get existing deployment first
    const existingRebateStaking = await deployments.get("RebateStaking")
    console.log(
      "✓ Using existing RebateStaking at:",
      existingRebateStaking.address
    )
    rebateStaking = await ethers.getContractAt(
      "RebateStaking",
      existingRebateStaking.address
    )
    rebateProxyDeployment = existingRebateStaking
  } catch (error) {
    // Deploy if doesn't exist
    const [deployedRebateStaking, deployedRebateProxy] =
      await helpers.upgrades.deployProxy("RebateStaking", {
        contractName: "RebateStaking",
        initializerArgs: [
          Bridge.address,
          t.address,
          30 * 24 * 60 * 60, // 30 days rolling window
          30 * 24 * 60 * 60, // 30 days unstaking delay
          100000000, // 0.001 BTC fee rebate per 100000 T tokens staked
        ],
        factoryOpts: {
          signer: await ethers.getSigner(deployer),
        },
        proxyOpts: {
          kind: "transparent",
        },
      })
    rebateStaking = deployedRebateStaking
    rebateProxyDeployment = deployedRebateProxy
    console.log("✓ RebateStaking deployed at:", rebateStaking.address)
  }

  // Step 2: Use existing libraries for Bridge
  console.log("\nStep 2: Using existing libraries...")

  const Deposit = await get("Deposit")
  const Redemption = await get("Redemption")

  console.log("✓ Using existing Deposit library at:", Deposit.address)
  console.log("✓ Using existing Redemption library at:", Redemption.address)

  // Step 3: Get existing libraries for Bridge upgrade
  console.log("\nStep 3: Collecting existing libraries...")

  const DepositSweep = await get("DepositSweep")
  const Wallets = await get("Wallets")
  const Fraud = await get("Fraud")
  const MovingFunds = await get("MovingFunds")

  console.log("✓ Using existing DepositSweep at:", DepositSweep.address)
  console.log("✓ Using existing Wallets at:", Wallets.address)
  console.log("✓ Using existing Fraud at:", Fraud.address)
  console.log("✓ Using existing MovingFunds at:", MovingFunds.address)

  // Step 4: Deploy Bridge implementation
  console.log("\nStep 4: Deploying Bridge implementation...")

  // Get required addresses for Bridge initialization
  const Bank = await deployments.get("Bank")
  const LightRelay = await deployments.get("LightRelay")
  const WalletRegistry = await deployments.get("WalletRegistry")
  const ReimbursementPool = await deployments.get("ReimbursementPool")

  // Deploy the Bridge implementation with linked libraries
  // This is just the implementation, not the proxy
  const BridgeFactory = await ethers.getContractFactory("Bridge", {
    signer: await ethers.getSigner(deployer),
    libraries: {
      Deposit: Deposit.address,
      DepositSweep: DepositSweep.address,
      Redemption: Redemption.address,
      Wallets: Wallets.address,
      Fraud: Fraud.address,
      MovingFunds: MovingFunds.address,
    },
  })

  const bridgeImplementation = await BridgeFactory.deploy()
  await bridgeImplementation.deployed()

  console.log(
    "✓ Bridge implementation deployed at:",
    bridgeImplementation.address
  )

  // Step 5: Find ProxyAdmin address
  console.log("\nStep 5: Finding ProxyAdmin...")

  // The ProxyAdmin is typically deployed by OpenZeppelin's upgrade plugin
  // We need to find it from the .openzeppelin network file
  let proxyAdminAddress: string | undefined

  try {
    const ozNetworkFile = path.join(
      __dirname,
      `../.openzeppelin/${hre.network.name}.json`
    )

    if (fs.existsSync(ozNetworkFile)) {
      const ozData = JSON.parse(fs.readFileSync(ozNetworkFile, "utf8"))
      proxyAdminAddress = ozData.admin?.address
    }
  } catch (error) {
    console.log("⚠ Could not read OpenZeppelin network file")
  }

  if (!proxyAdminAddress) {
    // Try to get it from the proxy slot
    // The admin slot for TransparentUpgradeableProxy is at:
    // 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103
    const adminSlot =
      "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
    const adminData = await ethers.provider.getStorageAt(
      Bridge.address,
      adminSlot
    )
    proxyAdminAddress = ethers.utils.getAddress(`0x${adminData.slice(26)}`)
  }

  console.log("✓ ProxyAdmin found at:", proxyAdminAddress)

  // Step 6: Generate encoded transactions
  console.log("\nStep 6: Generating encoded transactions...")

  // 6a: Encode the ProxyAdmin upgrade call
  const proxyAdminABI = [
    "function upgrade(address proxy, address implementation)",
    "function upgradeAndCall(address proxy, address implementation, bytes data)",
  ]
  const proxyAdminInterface = new ethers.utils.Interface(proxyAdminABI)

  const upgradeCalldata = proxyAdminInterface.encodeFunctionData("upgrade", [
    Bridge.address,
    bridgeImplementation.address,
  ])

  // 6b: Encode setRebateStaking transaction for BridgeGovernance
  const bridgeGovernanceAddress = (await deployments.get("BridgeGovernance"))
    .address
  const bridgeGovernanceABI = [
    "function beginGovernanceUpdate(bytes4[] memory functionSelectors, address[] memory targets, uint256[] memory values, bytes[] memory calldatas)",
  ]
  const bridgeGovernanceInterface = new ethers.utils.Interface(
    bridgeGovernanceABI
  )

  // Encode the Bridge.setRebateStaking call
  const bridgeABI = ["function setRebateStaking(address rebateStaking)"]
  const bridgeInterface = new ethers.utils.Interface(bridgeABI)
  const setRebateStakingCalldata = bridgeInterface.encodeFunctionData(
    "setRebateStaking",
    [rebateStaking.address]
  )

  // Prepare governance proposal
  const functionSelector = bridgeInterface.getSighash("setRebateStaking")
  const governanceCalldata = bridgeGovernanceInterface.encodeFunctionData(
    "beginGovernanceUpdate",
    [
      [functionSelector], // function selectors
      [Bridge.address], // targets
      [0], // values
      [setRebateStakingCalldata], // calldatas
    ]
  )

  // Step 7: Save deployment summary
  const deploymentSummary = {
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    deployer,
    deployedContracts: {
      rebateStaking: rebateStaking.address,
      depositLibrary: Deposit.address,
      redemptionLibrary: Redemption.address,
      bridgeImplementation: bridgeImplementation.address,
    },
    existingContracts: {
      bridge: Bridge.address,
      bridgeGovernance: bridgeGovernanceAddress,
      proxyAdmin: proxyAdminAddress,
      bank: Bank.address,
      lightRelay: LightRelay.address,
      walletRegistry: WalletRegistry.address,
      reimbursementPool: ReimbursementPool.address,
    },
    requiredActions: {
      proxyAdminOwner: {
        description: "Upgrade Bridge proxy to new implementation",
        to: proxyAdminAddress,
        data: upgradeCalldata,
        method: "upgrade(address proxy, address implementation)",
        params: {
          proxy: Bridge.address,
          implementation: bridgeImplementation.address,
        },
        note: "Simple upgrade call to ProxyAdmin contract",
      },
      governance: {
        description:
          "Set RebateStaking contract in Bridge via governance (AFTER proxy upgrade)",
        to: bridgeGovernanceAddress,
        data: governanceCalldata,
        method: "beginGovernanceUpdate",
        params: {
          functionSelector,
          target: Bridge.address,
          value: 0,
          calldata: setRebateStakingCalldata,
        },
        note: "This action has a 48-hour timelock on mainnet, 60 seconds on Sepolia. Must be done AFTER proxy upgrade.",
      },
    },
  }

  const summaryPath = path.join(
    __dirname,
    `../deployments/${hre.network.name}/rebate-deployment-${Date.now()}.json`
  )
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
  fs.writeFileSync(summaryPath, JSON.stringify(deploymentSummary, null, 2))

  // Step 8: Print summary
  console.log("\n========== REBATE DEPLOYMENT SUMMARY ==========")
  console.log("\nDEPLOYED CONTRACTS:")
  console.log("  RebateStaking:         ", rebateStaking.address)
  console.log("  Deposit Library:       ", Deposit.address)
  console.log("  Redemption Library:    ", Redemption.address)
  console.log("  Bridge Implementation: ", bridgeImplementation.address)

  console.log("\n================================================")
  console.log("ACTION REQUIRED BY PROXY ADMIN OWNER:")
  console.log("================================================")
  console.log("To:  ", proxyAdminAddress)
  console.log("Data:", upgradeCalldata)
  console.log("\nDecoded:")
  console.log("  Method: upgrade(address,address)")
  console.log("  Params:")
  console.log("    proxy:         ", Bridge.address)
  console.log("    implementation:", bridgeImplementation.address)

  console.log("\n================================================")
  console.log("ACTION REQUIRED BY GOVERNANCE (after proxy upgrade):")
  console.log("================================================")
  console.log("To:  ", bridgeGovernanceAddress)
  console.log("Data:", governanceCalldata)
  console.log("\nDecoded:")
  console.log("  Method: beginGovernanceUpdate")
  console.log("  Will call Bridge.setRebateStaking with:")
  console.log("    rebateStaking:", rebateStaking.address)
  console.log(
    "\nNOTE: Governance action has a",
    hre.network.name === "sepolia" ? "60 second" : "48-hour",
    "timelock"
  )

  console.log("\n================================================")
  console.log("Deployment summary saved to:", summaryPath)
  console.log("================================================\n")

  // Verify on Etherscan if applicable
  if (hre.network.tags.etherscan) {
    console.log("Verifying contracts on Etherscan...")

    await helpers.etherscan.verify(Deposit)
    await helpers.etherscan.verify(Redemption)

    await hre.run("verify", {
      address: rebateProxyDeployment.address,
      constructorArgsParams: rebateProxyDeployment.args,
    })

    // Verify Bridge implementation with linked libraries
    try {
      await hre.run("verify:verify", {
        address: bridgeImplementation.address,
        constructorArguments: [],
        libraries: {
          Deposit: Deposit.address,
          DepositSweep: DepositSweep.address,
          Redemption: Redemption.address,
          Wallets: Wallets.address,
          Fraud: Fraud.address,
          MovingFunds: MovingFunds.address,
        },
      })
    } catch (error) {
      console.log(
        "Bridge implementation verification may have failed:",
        error.message
      )
    }
  }

  // Verify on Tenderly if applicable
  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "RebateStaking",
      address: rebateStaking.address,
    })

    await hre.tenderly.verify({
      name: "Bridge",
      address: bridgeImplementation.address,
    })
  }
}

export default func

func.tags = ["DeployRebateAndPrepareTxs"]
// Dependencies removed to avoid redeploying existing mainnet contracts
// func.dependencies = ["Bridge", "BridgeGovernance"]
