import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import fs from "fs"
import path from "path"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, deployments, getNamedAccounts } = hre
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
  for (const [name, address] of Object.entries(bridgeLibraries)) {
    log(`  ${name}: ${address}`)
  }

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

  const adminSlot =
    "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
  const adminData = await ethers.provider.getStorageAt(bridgeAddress, adminSlot)
  const proxyAdminAddress = ethers.utils.getAddress(`0x${adminData.slice(26)}`)

  const proxyAdmin = await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function upgradeAndCall(address proxy, address implementation, bytes data)",
    ],
    proxyAdminAddress,
    deployerSigner
  )
  const proxyAdminOwner = await proxyAdmin.owner()
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

  log(`ProxyAdmin: ${proxyAdminAddress}`)
  log(`New implementation: ${implementationDeployment.address}`)

  const upgradeTx = await proxyAdmin.upgradeAndCall(
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
func.skip = async () => process.env.REPAIR_BRIDGE_REBATE_STAKING !== "true"
