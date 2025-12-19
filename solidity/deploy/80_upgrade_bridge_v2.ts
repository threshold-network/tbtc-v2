import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import fs from "fs"
import path from "path"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, deployments, getNamedAccounts } = hre
  const { get } = deployments
  const { deployer, treasury } = await getNamedAccounts()

  const Bank = await deployments.get("Bank")
  const LightRelay = await deployments.get("LightRelay")
  const WalletRegistry = await deployments.get("WalletRegistry")
  const ReimbursementPool = await deployments.get("ReimbursementPool")

  const txProofDifficultyFactor = 6

  // WARNING: This script expects no changes in the external libraries and uses
  // `get` function to load the ones that were already published before.
  // If there are any changes in the external libraries make sure to deploy fresh
  // versions of the libraries and link them to the implementation.
  const Deposit = await get("Deposit")
  const DepositSweep = await get("DepositSweep")
  const Redemption = await get("Redemption")
  const Wallets = await get("Wallets")
  const Fraud = await get("Fraud")
  const MovingFunds = await get("MovingFunds")

  const Bridge = await deployments.get("Bridge")

  const bridgeLibraries = {
    Deposit: Deposit.address,
    DepositSweep: DepositSweep.address,
    Redemption: Redemption.address,
    Wallets: Wallets.address,
    Fraud: Fraud.address,
    MovingFunds: MovingFunds.address,
  }

  const bridgeFactory = await ethers.getContractFactory("Bridge", {
    signer: await ethers.getSigner(deployer),
    libraries: bridgeLibraries,
  })

  const deployBridgeImplementation = async (): Promise<string> => {
    const implementationDeployment = await deployments.deploy(
      "BridgeImplementation",
      {
        contract: "Bridge",
        from: deployer,
        log: true,
        waitConfirmations: 1,
        skipIfAlreadyDeployed: false,
        libraries: bridgeLibraries,
      }
    )
    return implementationDeployment.address
  }

  let isProxyRegistered = false
  const ozNetworkFile = path.join(
    __dirname,
    `../.openzeppelin/${hre.network.name}.json`
  )
  if (fs.existsSync(ozNetworkFile)) {
    const ozData = JSON.parse(fs.readFileSync(ozNetworkFile, "utf8"))
    isProxyRegistered = (ozData.proxies || []).some(
      (proxy: { address?: string }) =>
        proxy.address?.toLowerCase() === Bridge.address.toLowerCase()
    )
  }
  if (!isProxyRegistered) {
    await hre.upgrades.forceImport(Bridge.address, bridgeFactory, {
      kind: "transparent",
    })
  }

  const adminSlot =
    "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
  const adminData = await ethers.provider.getStorageAt(
    Bridge.address,
    adminSlot
  )
  const proxyAdminAddress = ethers.utils.getAddress(`0x${adminData.slice(26)}`)
  const proxyAdmin = await ethers.getContractAt(
    ["function owner() view returns (address)"],
    proxyAdminAddress
  )
  const proxyAdminOwner = await proxyAdmin.owner()
  const deployerSigner = await ethers.getSigner(deployer)
  const deployerAddress = await deployerSigner.getAddress()

  const implementationAddress = await deployBridgeImplementation()
  const proxyAdminInterface = new ethers.utils.Interface([
    "function upgrade(address proxy, address implementation)",
  ])
  const upgradeCalldata = proxyAdminInterface.encodeFunctionData("upgrade", [
    Bridge.address,
    implementationAddress,
  ])

  if (proxyAdminOwner.toLowerCase() !== deployerAddress.toLowerCase()) {
    console.log("ProxyAdmin owner:", proxyAdminOwner)
    console.log("ProxyAdmin address:", proxyAdminAddress)
    console.log("Bridge implementation:", implementationAddress)
    console.log("Upgrade calldata:", upgradeCalldata)
    return
  }

  const proxyAdminWithUpgrade = await ethers.getContractAt(
    ["function upgrade(address proxy, address implementation)"],
    proxyAdminAddress
  )
  const upgradeTx = await proxyAdminWithUpgrade.upgrade(
    Bridge.address,
    implementationAddress
  )
  await upgradeTx.wait(1)
  console.log("ProxyAdmin owner:", proxyAdminOwner)
  console.log("ProxyAdmin address:", proxyAdminAddress)
  console.log("Bridge implementation:", implementationAddress)
  console.log("Upgrade tx:", upgradeTx.hash)
  console.log("Upgrade calldata:", upgradeCalldata)
}

export default func

func.tags = ["UpgradeBridge"]
// Set UPGRADE_BRIDGE=true when running an upgrade.
// yarn deploy --tags UpgradeBridge --network <NETWORK>
func.skip = async () => process.env.UPGRADE_BRIDGE !== "true"
