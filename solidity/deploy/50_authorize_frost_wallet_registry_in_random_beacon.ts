import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

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
    throw new Error(
      "FrostWalletRegistry must be authorized as a RandomBeacon requester, " +
        `but RandomBeaconGovernance owner is ${governanceOwner}; neither ` +
        `deployer ${deployer} nor governance ${governance} can perform the call`
    )
  }

  await randomBeaconGovernance
    .connect(await ethers.getSigner(signerAddress))
    .setRequesterAuthorization(frostWalletRegistryAddress, true)

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
