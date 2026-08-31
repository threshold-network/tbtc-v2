// ////////////////////////////////////////////////////////////////////////
// DEPRECATED -- DO NOT USE
//
// This script targets Bridge.initializeV5_RepairRebateStaking, which is
// not declared in the Bridge source in this tree. The TIP-109 repair
// executed on mainnet at block 24800704; slot 50 (_initialized) reads
// 0x05 on both mainnet and Sepolia, so reinitializer(5) is permanently
// consumed on both networks (OpenZeppelin Initializable does not
// decrement). Encoding the missing selector through the Bridge factory
// would revert at runtime, after the script has already deployed a
// stray BridgeRebateRepairImplementation.
//
// Earlier deprecation notes are also accurate:
//
// This script requires the deployer EOA to be the ProxyAdmin owner.
// On mainnet the ProxyAdmin is owned by a governance Timelock contract,
// not any EOA, so this script will always throw:
//   "Deployer <addr> is not ProxyAdmin owner <addr>"
//
// The script has no governance integration path -- it cannot submit
// proposals, queue timelock actions, or generate governance calldata.
// ////////////////////////////////////////////////////////////////////////

import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import fs from "fs"
import path from "path"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, deployments, getNamedAccounts, upgrades } = hre
  const { get, log } = deployments
  const { deployer } = await getNamedAccounts()

  const repairTarget =
    process.env.REBATE_STAKING_REPAIR_TARGET ?? ethers.constants.AddressZero

  const artifactPath = path.resolve(
    __dirname,
    `../../typescript/src/lib/ethereum/artifacts/${hre.network.name}/Bridge.json`
  )
  const bridgeArtifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
    address: string
    libraries?: Record<string, string>
  }

  const resolveAddress = async (
    deploymentName: string,
    fallbackAddress?: string
  ): Promise<string> => {
    try {
      const deployment = await get(deploymentName)
      if (deployment.address) {
        return deployment.address
      }
    } catch {
      // Falls back to the SDK artifact below.
    }

    if (!fallbackAddress) {
      throw new Error(`No deployment found for: ${deploymentName}`)
    }

    return fallbackAddress
  }

  const bridgeAddress = await resolveAddress("Bridge", bridgeArtifact.address)

  const bridgeLibraries = {
    Deposit: await resolveAddress("Deposit", bridgeArtifact.libraries?.Deposit),
    DepositSweep: await resolveAddress(
      "DepositSweep",
      bridgeArtifact.libraries?.DepositSweep
    ),
    Redemption: await resolveAddress(
      "Redemption",
      bridgeArtifact.libraries?.Redemption
    ),
    Wallets: await resolveAddress("Wallets", bridgeArtifact.libraries?.Wallets),
    Fraud: await resolveAddress("Fraud", bridgeArtifact.libraries?.Fraud),
    MovingFunds: await resolveAddress(
      "MovingFunds",
      bridgeArtifact.libraries?.MovingFunds
    ),
  }

  const currentBridge = await ethers.getContractAt("Bridge", bridgeAddress)
  const currentRebateStaking = await currentBridge.getRebateStaking()

  log("=".repeat(80))
  log("Repairing Bridge rebate staking configuration")
  log("=".repeat(80))
  log(`Bridge proxy: ${bridgeAddress}`)
  log(`Current rebateStaking: ${currentRebateStaking}`)
  log(`Target rebateStaking:  ${repairTarget}`)
  log("Using libraries:")
  Object.entries(bridgeLibraries).forEach(([name, address]) => {
    log(`  ${name}: ${address}`)
  })

  const deployerSigner = await ethers.getSigner(deployer)
  const bridgeFactory = await ethers.getContractFactory("Bridge", {
    signer: deployerSigner,
    libraries: bridgeLibraries,
  })
  const implementationDeployment = await deployments.deploy(
    "BridgeRebateRepairImplementation",
    {
      contract: "Bridge",
      from: deployer,
      log: true,
      waitConfirmations: 1,
      skipIfAlreadyDeployed: false,
      libraries: bridgeLibraries,
    }
  )

  const proxyAdmin = await upgrades.admin.getInstance()
  const proxyAdminWithUpgrade = await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function upgradeAndCall(address proxy, address implementation, bytes data)",
    ],
    proxyAdmin.address,
    deployerSigner
  )
  const proxyAdminOwner = await proxyAdminWithUpgrade.owner()
  const deployerAddress = await deployerSigner.getAddress()

  if (proxyAdminOwner.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(
      `Deployer ${deployerAddress} is not ProxyAdmin owner ${proxyAdminOwner}`
    )
  }

  const initializationData = bridgeFactory.interface.encodeFunctionData(
    "initializeV5_RepairRebateStaking",
    [repairTarget]
  )

  log(`ProxyAdmin: ${proxyAdmin.address}`)
  log(`New implementation: ${implementationDeployment.address}`)

  const upgradeTx = await proxyAdminWithUpgrade.upgradeAndCall(
    bridgeAddress,
    implementationDeployment.address,
    initializationData
  )
  log(`Upgrade tx: ${upgradeTx.hash}`)
  await upgradeTx.wait(1)

  const repairedBridge = await ethers.getContractAt("Bridge", bridgeAddress)
  const repairedRebateStaking = await repairedBridge.getRebateStaking()
  log(`Updated rebateStaking: ${repairedRebateStaking}`)
  log("Bridge rebate staking repair complete")
}

export default func

func.tags = ["RepairBridgeRebateStaking"]
// Hard-disabled: the targeted Bridge.initializeV5_RepairRebateStaking
// selector is not declared in the Bridge source in this tree. Encoding it
// would revert at runtime, after the script has already deployed a stray
// BridgeRebateRepairImplementation. Kept for historical reference only.
func.skip = async () => true
