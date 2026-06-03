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
  const { getNamedAccounts, deployments, ethers, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  const FrostWalletRegistry = await deployments.get("FrostWalletRegistry")

  let FrostAllowlist = await deployments.getOrNull("FrostAllowlist")
  let frostAllowlistAddress: string

  if (FrostAllowlist) {
    frostAllowlistAddress = FrostAllowlist.address
    console.log(
      `FrostAllowlist already deployed at ${frostAllowlistAddress}; skipping deployment`
    )
  } else {
    const [frostAllowlist] = await helpers.upgrades.deployProxy(
      "FrostAllowlist",
      {
        contractName: "FrostAllowlist",
        initializerArgs: [FrostWalletRegistry.address],
        factoryOpts: {
          signer: await ethers.getSigner(deployer),
        },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )

    frostAllowlistAddress = frostAllowlist.address
    FrostAllowlist = await deployments.get("FrostAllowlist")

    console.log(`FrostAllowlist deployed at: ${frostAllowlistAddress}`)
    console.log(`FrostAllowlist owner: ${await frostAllowlist.owner()}`)
  }

  const frostWalletRegistry = await ethers.getContractAt(
    "FrostWalletRegistry",
    FrostWalletRegistry.address
  )

  const currentAuthorizationSource =
    await frostWalletRegistry.authorizationSource()
  if (currentAuthorizationSource === ethers.constants.AddressZero) {
    const registryGovernance = await frostWalletRegistry.governance()
    const initializerAddress = [deployer, governance].find(
      (address) => address.toLowerCase() === registryGovernance.toLowerCase()
    )

    if (!initializerAddress) {
      const message =
        "FrostWalletRegistry authorization source must be initialized by " +
        `registry governance ${registryGovernance}; neither deployer ` +
        `${deployer} nor governance ${governance} can execute it`

      if (hre.network.name === "mainnet") {
        console.log(`${message}; skipping for manual governance execution`)
      } else {
        throw new Error(message)
      }
    } else {
      const initializer = await getConfiguredSigner(hre, initializerAddress)
      if (!initializer) {
        const message =
          "FrostWalletRegistry authorization source initialization must be " +
          `executed by ${initializerAddress}, but that address is not ` +
          `configured as a signer for network ${hre.network.name}`

        if (hre.network.name === "mainnet") {
          console.log(`${message}; skipping for manual ownership transfer`)
        } else {
          throw new Error(message)
        }
      } else {
        const initializeTx = await frostWalletRegistry
          .connect(initializer)
          .initializeV2(frostAllowlistAddress)
        await initializeTx.wait(1)
        console.log(
          `initialized FrostWalletRegistry authorization source with FrostAllowlist ${frostAllowlistAddress}`
        )
      }
    }
  } else if (
    currentAuthorizationSource.toLowerCase() !==
    frostAllowlistAddress.toLowerCase()
  ) {
    throw new Error(
      `FrostWalletRegistry authorization source mismatch: current ${currentAuthorizationSource}, expected ${frostAllowlistAddress}`
    )
  } else {
    console.log(
      `FrostWalletRegistry already uses FrostAllowlist as authorization source ${frostAllowlistAddress}`
    )
  }

  const frostAllowlist = await ethers.getContractAt(
    "FrostAllowlist",
    frostAllowlistAddress
  )
  const frostAllowlistOwner = await frostAllowlist.owner()
  if (
    governance &&
    governance.toLowerCase() === frostAllowlistOwner.toLowerCase()
  ) {
    console.log(`FrostAllowlist is already owned by governance ${governance}`)
  } else if (
    governance &&
    governance.toLowerCase() !== deployer.toLowerCase() &&
    frostAllowlistOwner.toLowerCase() === deployer.toLowerCase()
  ) {
    const pendingOwner = await frostAllowlist.pendingOwner()
    let ownershipTransferPending =
      pendingOwner.toLowerCase() === governance.toLowerCase()
    if (!ownershipTransferPending) {
      const deployerSigner = await getConfiguredSigner(hre, deployer)
      if (!deployerSigner) {
        const message =
          "FrostAllowlist ownership transfer must be executed by deployer " +
          `${deployer}, but that address is not configured as a signer for ` +
          `network ${hre.network.name}`

        if (hre.network.name === "mainnet") {
          console.log(`${message}; skipping for manual governance execution`)
        } else {
          throw new Error(message)
        }
      } else {
        const transferTx = await frostAllowlist
          .connect(deployerSigner)
          .transferOwnership(governance)
        await transferTx.wait(1)
        ownershipTransferPending = true
        console.log(
          `started FrostAllowlist ownership transfer from deployer ${deployer} to governance ${governance}`
        )
      }
    }

    if (!ownershipTransferPending) {
      console.log(
        `FrostAllowlist ownership remains with deployer ${deployer}; deployer must transfer ownership to governance ${governance} before acceptOwnership`
      )
    } else {
      const governanceSigner = await getConfiguredSigner(hre, governance)
      if (governanceSigner) {
        const acceptTx = await frostAllowlist
          .connect(governanceSigner)
          .acceptOwnership()
        await acceptTx.wait(1)
        console.log(
          `FrostAllowlist ownership accepted by governance ${governance}`
        )
      } else {
        console.log(
          `FrostAllowlist ownership transfer is pending; governance ${governance} must call acceptOwnership`
        )
      }
    }
  } else if (
    governance &&
    frostAllowlistOwner.toLowerCase() !== governance.toLowerCase()
  ) {
    throw new Error(
      `FrostAllowlist owner is ${frostAllowlistOwner}; expected deployer ` +
        `${deployer} or governance ${governance}`
    )
  }

  if (hre.network.tags.etherscan && FrostAllowlist) {
    await hre.run("verify", {
      address: FrostAllowlist.address,
      constructorArgsParams: FrostAllowlist.args,
    })
  }
}

export default func

func.tags = ["FrostAllowlist"]
func.dependencies = ["FrostWalletRegistry"]
