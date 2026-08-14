import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, helpers, getNamedAccounts } = hre
  const { deployer } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")

  const [redemptionWatchtower, proxyDeployment] =
    await helpers.upgrades.deployProxy("RedemptionWatchtower", {
      contractName: "RedemptionWatchtower",
      initializerArgs: [Bridge.address],
      factoryOpts: {
        signer: await ethers.getSigner(deployer),
      },
      proxyOpts: {
        kind: "transparent",
        // The watchtower imports the `Reservation` library for its shared
        // types; that library forwards reservation proofs to the external
        // `ReservationProofs` library, which trips the upgrades plugin's
        // source-closure check. The watchtower's own bytecode links no
        // external library (types and internal helpers are inlined), so
        // the linking is upgrade safe here — same rationale as the Bridge
        // deployment.
        unsafeAllow: ["external-library-linking"],
      },
    })

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
      name: "RedemptionWatchtower",
      address: redemptionWatchtower.address,
    })
  }
}

export default func

func.tags = ["RedemptionWatchtower"]
func.dependencies = ["Bridge"]
