import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

async function getConfiguredSigner(
  hre: HardhatRuntimeEnvironment,
  address: string
) {
  const configuredAccounts = (await hre.ethers.provider.listAccounts()).map(
    (account) => account.toLowerCase()
  )

  if (!configuredAccounts.includes(address.toLowerCase())) {
    return undefined
  }

  return hre.ethers.getSigner(address)
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { getNamedAccounts, deployments, ethers } = hre
  const { deployer, governance } = await getNamedAccounts()

  const RandomBeacon = await deployments.get("RandomBeacon")
  const RandomBeaconGovernance = await deployments.get("RandomBeaconGovernance")
  const FrostWalletRegistry = await deployments.get("FrostWalletRegistry")

  const randomBeacon = await ethers.getContractAt(
    RandomBeacon.abi,
    RandomBeacon.address
  )
  const frostWalletRegistryAddress = FrostWalletRegistry.address

  const alreadyAuthorized = await randomBeacon.authorizedRequesters(
    frostWalletRegistryAddress
  )
  if (alreadyAuthorized) {
    console.log(
      `FrostWalletRegistry ${frostWalletRegistryAddress} is already authorized as a RandomBeacon requester`
    )
    return
  }

  const randomBeaconGovernance = await ethers.getContractAt(
    RandomBeaconGovernance.abi,
    RandomBeaconGovernance.address
  )
  const governanceOwner = await randomBeaconGovernance.owner()
  const signerAddress = [deployer, governance].find(
    (address) => address.toLowerCase() === governanceOwner.toLowerCase()
  )

  if (!signerAddress) {
    const message =
      "FrostWalletRegistry must be authorized as a RandomBeacon requester, " +
      `but RandomBeaconGovernance owner is ${governanceOwner}; neither ` +
      `deployer ${deployer} nor governance ${governance} can perform the call`

    if (hre.network.name === "mainnet") {
      console.log(`${message}; skipping for manual governance execution`)
      return
    }

    throw new Error(message)
  }

  const signer = await getConfiguredSigner(hre, signerAddress)
  if (!signer) {
    const message =
      "FrostWalletRegistry RandomBeacon requester authorization must be " +
      `executed by ${signerAddress}, but that address is not configured as ` +
      `a signer for network ${hre.network.name}`

    if (hre.network.name === "mainnet") {
      console.log(`${message}; skipping for manual governance execution`)
      return
    }

    throw new Error(message)
  }

  const authorizationTx = await randomBeaconGovernance
    .connect(signer)
    .setRequesterAuthorization(frostWalletRegistryAddress, true)
  await authorizationTx.wait(1)

  const finalAuthorized = await randomBeacon.authorizedRequesters(
    frostWalletRegistryAddress
  )
  if (!finalAuthorized) {
    throw new Error(
      "FrostWalletRegistry RandomBeacon requester authorization mismatch " +
        `after deploy for ${frostWalletRegistryAddress}`
    )
  }

  console.log(
    `authorized FrostWalletRegistry ${frostWalletRegistryAddress} as a RandomBeacon requester`
  )
}

export default func

func.tags = ["FrostWalletRegistryRandomBeaconAuthorization"]
func.dependencies = [
  "RandomBeacon",
  "RandomBeaconGovernance",
  "FrostWalletRegistry",
  "BridgeLifecycleRouter",
]
