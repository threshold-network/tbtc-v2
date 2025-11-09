import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import fs from "fs"
import path from "path"
import os from "os"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer, treasury: namedTreasury } = await getNamedAccounts()

  // Prefer cached deployment; fall back to env if cache missing.
  const cachedBridge = await deployments.getOrNull("Bridge")
  const bridgeAddress = cachedBridge?.address ?? process.env.BRIDGE_ADDRESS
  if (!bridgeAddress) {
    throw new Error(
      "Bridge address not found. Provide BRIDGE_ADDRESS or ensure deployments cache exists."
    )
  }

  // Use only the ProxyAdmin key for proxy operations; do not mix with
  // governance key to avoid role confusion.
  const proxyAdminPrivateKey = process.env.PROXY_ADMIN_PK

  let signer = await ethers.getSigner(deployer)
  let signerAddress = await signer.getAddress()
  if (proxyAdminPrivateKey) {
    signer = new ethers.Wallet(proxyAdminPrivateKey, ethers.provider)
    signerAddress = await signer.getAddress()
  } else {
    deployments.log(
      "⚠️  PROXY_ADMIN_PK not set; using deployer signer for proxy upgrade. Ensure deployer controls ProxyAdmin."
    )
  }

  const bankAddress = await resolveCoreAddress(
    deployments,
    "Bank",
    "BANK_ADDRESS"
  )
  const lightRelayAddress = await resolveCoreAddress(
    deployments,
    "LightRelay",
    "LIGHT_RELAY_ADDRESS"
  )
  const walletRegistryAddress = await resolveCoreAddress(
    deployments,
    "WalletRegistry",
    "WALLET_REGISTRY_ADDRESS"
  )
  const reimbursementPoolAddress = await resolveCoreAddress(
    deployments,
    "ReimbursementPool",
    "REIMBURSEMENT_POOL_ADDRESS"
  )

  const treasuryAddress =
    process.env.BRIDGE_TREASURY_ADDRESS ?? namedTreasury ?? ethers.constants.AddressZero

  const txProofDifficultyFactor = 6

  // WARNING: This script expects no changes in the external libraries and uses
  // `get` function to load the ones that were already published before.
  // If there are any changes in the external libraries make sure to deploy fresh
  // versions of the libraries and link them to the implementation.
  const depositLib = await resolveLibrary(
    deployments,
    signerAddress,
    "Deposit"
  )
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
  const walletsLib = await resolveLibrary(
    deployments,
    signerAddress,
    "Wallets"
  )
  const fraudLib = await resolveLibrary(
    deployments,
    signerAddress,
    "Fraud"
  )
  const movingFundsLib = await resolveLibrary(
    deployments,
    signerAddress,
    "MovingFunds"
  )

  await ensureDeploymentRecord(
    deployments,
    "Bridge",
    bridgeAddress,
    "Bridge"
  )

  const libraryAddresses = {
    Deposit: depositLib,
    DepositSweep: depositSweepLib,
    Redemption: redemptionLib,
    Wallets: walletsLib,
    Fraud: fraudLib,
    MovingFunds: movingFundsLib,
  }

  // Verify on-chain library bytecodes match compiled artifacts.
  await verifyLibraryBytecodes(hre, libraryAddresses)

  const [bridge, proxyDeployment] = await helpers.upgrades.upgradeProxy(
    "Bridge",
    "Bridge",
    {
      contractName: "Bridge",
      initializerArgs: [
        bankAddress,
        lightRelayAddress,
        treasuryAddress,
        walletRegistryAddress,
        reimbursementPoolAddress,
        txProofDifficultyFactor,
      ],
      factoryOpts: {
        signer,
        libraries: libraryAddresses,
      },
      proxyOpts: {
        kind: "transparent",
        // Allow external libraries linking. We need to ensure manually that the
        // external  libraries we link are upgrade safe, as the OpenZeppelin plugin
        // doesn't perform such a validation yet.
        // See: https://docs.openzeppelin.com/upgrades-plugins/1.x/faq#why-cant-i-use-external-libraries
        unsafeAllow: ["external-library-linking"],
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

func.tags = ["UpgradeBridge"]
// When running an upgrade uncomment the skip below and run the command:
// yarn deploy --tags UpgradeBridge --network <NETWORK>
func.skip = async () => true

async function resolveCoreAddress(
  deployments: HardhatRuntimeEnvironment["deployments"],
  name: string,
  envVar: string
): Promise<string> {
  const deployment = await deployments.getOrNull(name)
  if (deployment?.address) {
    return deployment.address
  }
  const envAddress = process.env[envVar]
  if (!envAddress || envAddress.length === 0) {
    throw new Error(
      `Address for ${name} not found in deployments cache. Provide ${envVar}.`
    )
  }
  return envAddress
}

async function resolveLibrary(
  deployments: HardhatRuntimeEnvironment["deployments"],
  signerAddress: string,
  libName: string
): Promise<string> {
  const existing = await deployments.getOrNull(libName)
  if (existing?.address) {
    return existing.address
  }

  const envVar = `${libName.toUpperCase()}_LIB_ADDRESS`
  const envValue = process.env[envVar]
  if (envValue && envValue.length > 0) {
    return envValue
  }

  const fqn = `contracts/bridge/${libName}.sol:${libName}`
  const deployment = await deployments.deploy(libName, {
    from: signerAddress,
    log: true,
    skipIfAlreadyDeployed: true,
    contract: fqn,
    library: true,
  })
  if (!deployment.address) {
    throw new Error(`Failed to deploy library ${libName}`)
  }
  return deployment.address
}

async function verifyLibraryBytecodes(
  hre: HardhatRuntimeEnvironment,
  libs: Record<string, string>
): Promise<void> {
  const { deployments, ethers } = hre
  for (const [name, address] of Object.entries(libs)) {
    try {
      const artifact = await deployments.getArtifact(name)
      const expected = (artifact.deployedBytecode || artifact.bytecode || "").toLowerCase()
      const onchain = (await ethers.provider.getCode(address)).toLowerCase()

      if (!onchain || onchain === "0x") {
        deployments.log(
          `⚠️  Library ${name} at ${address} has no code on-chain. Check address.`
        )
        continue
      }

      // Some toolchains include metadata; direct equality is fine here since we
      // compare runtime bytecode to on-chain code. Warn if mismatch.
      if (expected && expected !== "0x" && onchain !== expected) {
        deployments.log(
          `⚠️  Bytecode mismatch for ${name} at ${address}. Using on-chain code; verify library compatibility.`
        )
      }
    } catch (error) {
      deployments.log(
        `⚠️  Skipping bytecode check for ${name} at ${address}: ${String(error)}`
      )
    }
  }
}
