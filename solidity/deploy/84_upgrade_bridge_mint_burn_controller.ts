import fs from "fs"
import path from "path"
import os from "os"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import type { Signer } from "ethers"

import {
  resolveLibrary,
  verifyLibraryBytecodes,
} from "./utils/library-resolution"

// Upgrades the Bridge proxy to the MintBurnGuard-aware implementation.
//
// This script is needed because PR#933 (rebate repair) upgraded the Sepolia
// Bridge proxy after the MintBurnGuard-capable implementation had been deployed
// from new/bank-decreaser. Running this script restores the proxy to the
// new/bank-decreaser version, which adds:
//   - setMintingController() / getMintingController()
//   - controllerIncreaseBalance() / controllerIncreaseBalances()
//
// No reinitializer is called: the new `mintingController` storage slot
// defaults to address(0) and is set post-upgrade via governance.
//
// To run on Sepolia:
//   1. Comment out `func.skip` at the bottom of this file.
//   2. Set environment variables (see below).
//   3. yarn deploy --tags UpgradeBridgeMintBurnController --network sepolia
//
// Required env vars:
//   PROXY_ADMIN_PK  — private key of the ProxyAdmin owner (required on live networks)
//
// Optional env vars (resolved from deployments cache if omitted):
//   BRIDGE_ADDRESS  — Bridge proxy address
//   STRICT_LIB_CHECK=true — fail on library bytecode mismatch

// EIP-1967 ProxyAdmin storage slot.
const PROXY_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, deployments, getNamedAccounts } = hre
  const { deployer } = await getNamedAccounts()
  const bridgeContractFqn = "contracts/bridge/Bridge.sol:Bridge"
  const isLiveNetwork = ![
    "hardhat",
    "localhost",
    "system_tests",
    "development",
  ].includes(hre.network.name)

  // Prefer explicit env override for one-off remediations, otherwise fallback to cache.
  const cachedBridge = await deployments.getOrNull("Bridge")
  const envBridgeAddress = process.env.BRIDGE_ADDRESS
  if (
    envBridgeAddress &&
    cachedBridge?.address &&
    envBridgeAddress.toLowerCase() !== cachedBridge.address.toLowerCase()
  ) {
    throw new Error(
      `BRIDGE_ADDRESS (${envBridgeAddress}) does not match cached Bridge deployment (${cachedBridge.address}).`
    )
  }
  const bridgeAddress = envBridgeAddress ?? cachedBridge?.address
  if (!bridgeAddress) {
    throw new Error(
      "Bridge address not found. Provide BRIDGE_ADDRESS or ensure deployments cache exists."
    )
  }

  // Use only the ProxyAdmin key for proxy operations; do not mix with
  // governance key to avoid role confusion.
  const proxyAdminPrivateKey = process.env.PROXY_ADMIN_PK

  let signer: Signer = await ethers.getSigner(deployer)
  let signerAddress = await signer.getAddress()
  if (proxyAdminPrivateKey) {
    signer = new ethers.Wallet(proxyAdminPrivateKey, ethers.provider)
    signerAddress = await signer.getAddress()
  } else if (isLiveNetwork) {
    throw new Error(
      "PROXY_ADMIN_PK is required on live networks for proxy upgrades."
    )
  } else {
    deployments.log(
      "⚠️  PROXY_ADMIN_PK not set; using deployer signer for proxy upgrade. Ensure deployer controls ProxyAdmin."
    )
  }

  // WARNING: This script expects no changes in the external libraries and uses
  // `get` function to load the ones that were already published before.
  // If there are any changes in the external libraries make sure to deploy fresh
  // versions of the libraries and link them to the implementation.
  const depositLib = await resolveLibrary(deployments, signerAddress, "Deposit")
  const depositSweepLib = await resolveLibrary(
    deployments,
    signerAddress,
    "DepositSweep"
  )
  const redemptionLib = await resolveLibrary(
    deployments,
    signerAddress,
    "Redemption"
  )
  const walletsLib = await resolveLibrary(deployments, signerAddress, "Wallets")
  const fraudLib = await resolveLibrary(deployments, signerAddress, "Fraud")
  const movingFundsLib = await resolveLibrary(
    deployments,
    signerAddress,
    "MovingFunds"
  )

  await ensureDeploymentRecord(deployments, "Bridge", bridgeAddress, "Bridge")

  const libraryAddresses = {
    Deposit: depositLib,
    DepositSweep: depositSweepLib,
    Redemption: redemptionLib,
    Wallets: walletsLib,
    Fraud: fraudLib,
    MovingFunds: movingFundsLib,
  }

  const strictLibraryCheck = process.env.STRICT_LIB_CHECK === "true"
  await verifyLibraryBytecodes(hre, libraryAddresses, strictLibraryCheck)

  // Read the ProxyAdmin address directly from the EIP-1967 admin slot.
  // This avoids any dependency on the OZ upgrades network manifest, which
  // may not exist when running against system_tests or a fresh fork.
  const adminSlotValue = await ethers.provider.getStorageAt(
    bridgeAddress,
    PROXY_ADMIN_SLOT
  )
  const proxyAdminAddress = ethers.utils.getAddress(
    `0x${adminSlotValue.slice(26)}`
  )
  const proxyAdmin = (
    await ethers.getContractAt("ProxyAdmin", proxyAdminAddress)
  ).connect(signer)
  const implBefore = await proxyAdmin.getProxyImplementation(bridgeAddress)

  const bridgeFactory = await ethers.getContractFactory(bridgeContractFqn, {
    signer,
    libraries: libraryAddresses,
  })
  const bridgeImpl = await bridgeFactory.deploy()
  await bridgeImpl.deployed()

  const upgradeTx = await proxyAdmin.upgrade(bridgeAddress, bridgeImpl.address)
  const upgradeReceipt = await upgradeTx.wait(1)
  const bridge = bridgeFactory.attach(bridgeAddress)
  const proxyDeployment = {
    address: bridgeAddress,
    args: [],
    transactionHash: upgradeTx.hash,
    receipt: upgradeReceipt,
  }

  const implAfter = await proxyAdmin.getProxyImplementation(bridgeAddress)
  if (implAfter.toLowerCase() === implBefore.toLowerCase()) {
    throw new Error(
      `Bridge implementation did not change (implBefore=${implBefore}, implAfter=${implAfter}).`
    )
  }

  if (hre.network.tags.etherscan) {
    // We use `verify` instead of `verify:verify` as the `verify` task is defined
    // in "@openzeppelin/hardhat-upgrades" to perform Etherscan verification
    // of Proxy and Implementation contracts.
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  if (hre.network.tags.tenderly) {
    const tenderlyConfigPath = path.join(
      os.homedir(),
      ".tenderly",
      "config.yaml"
    )
    if (fs.existsSync(tenderlyConfigPath)) {
      await hre.tenderly.verify({
        name: "Bridge",
        address: bridge.address,
      })
    } else {
      deployments.log(
        "Skipping Tenderly verification; /.tenderly/config.yaml not found."
      )
    }
  }
}

async function ensureDeploymentRecord(
  deployments: HardhatRuntimeEnvironment["deployments"],
  name: string,
  address: string,
  artifactName: string
): Promise<void> {
  const existing = await deployments.getOrNull(name)
  if (existing?.address) {
    return
  }
  const artifact = await deployments.getArtifact(artifactName)
  await deployments.save(name, {
    address,
    abi: artifact.abi,
  })
}

export default func

func.tags = ["UpgradeBridgeMintBurnController"]
// When running an upgrade uncomment the skip below and run the command:
// yarn deploy --tags UpgradeBridgeMintBurnController --network <NETWORK>
// func.skip = async () => true
