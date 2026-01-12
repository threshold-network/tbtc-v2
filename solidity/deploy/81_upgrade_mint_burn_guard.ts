import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments, getNamedAccounts } = hre
  const { deployer } = await getNamedAccounts()

  // Prefer cached deployment; fall back to env if cache missing.
  const cachedMintBurnGuard = await deployments.getOrNull("MintBurnGuard")
  const mintBurnGuardAddress =
    cachedMintBurnGuard?.address ?? process.env.MINT_BURN_GUARD_ADDRESS
  if (!mintBurnGuardAddress) {
    throw new Error(
      "MintBurnGuard address not found. Provide MINT_BURN_GUARD_ADDRESS or ensure deployments cache exists."
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

  const tbtcVaultAddress = await resolveCoreAddress(
    deployments,
    "TBTCVault",
    "TBTC_VAULT_ADDRESS"
  )

  const owner =
    process.env.MINT_BURN_GUARD_OWNER ??
    signerAddress ??
    ethers.constants.AddressZero
  const operator =
    process.env.MINT_BURN_GUARD_OPERATOR ??
    "0x0000000000000000000000000000000000000000"

  await ensureDeploymentRecord(
    deployments,
    "MintBurnGuard",
    mintBurnGuardAddress,
    "MintBurnGuard"
  )

  const [mintBurnGuard, proxyDeployment] = await helpers.upgrades.upgradeProxy(
    "MintBurnGuard",
    "MintBurnGuard",
    {
      contractName: "MintBurnGuard",
      initializerArgs: [owner, operator, tbtcVaultAddress],
      factoryOpts: {
        signer,
      },
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

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "MintBurnGuard",
      address: mintBurnGuard.address,
    })
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

func.tags = ["UpgradeMintBurnGuard"]
// When running an upgrade uncomment the skip below and run the command:
// yarn deploy --tags UpgradeMintBurnGuard --network <NETWORK>
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
