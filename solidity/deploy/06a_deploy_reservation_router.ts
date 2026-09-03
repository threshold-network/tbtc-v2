import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

/**
 * 06a_deploy_reservation_router.ts
 *
 * Deploys the `ReservationRouter` facet and points the Bridge at it.
 *
 * The router is never called directly: the Bridge `delegatecall`s it from
 * `Bridge.fallback()`, so router code executes on the Bridge's own storage
 * (`ReservationRouter` invariant 1). Consequently the router needs no
 * initialization and is deployed as a plain, non-proxied logic contract.
 *
 * Ordering matters twice:
 *
 *   1. AFTER `06_deploy_bridge.ts`, because `setReservationRouter` is a Bridge
 *      call.
 *   2. BEFORE `97_set_reservation_parameters.ts`, because every reservation
 *      setter (`updateReservationCaps`, `updateReservationParameters`) is a
 *      router selector reached through the fallback. With no router set the
 *      fallback reverts with "Reservation router not set" and script 97 fails.
 *
 * It must also run BEFORE `21_transfer_bridge_governance.ts`
 * (`runAtTheEnd`), because `Bridge.setReservationRouter` is `onlyGovernance`
 * and governance is still the `deployer` account at this point. `21` hands
 * governance to `BridgeGovernance`, which has no `setReservationRouter`
 * passthrough — the router address is write-once and is meant to be fixed
 * before governance is handed over. Filename ordering ("06_" < "06a" < "07_")
 * places this script exactly there.
 */
const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, helpers, ethers } = hre
  const { deploy, execute, read, log } = deployments
  const { deployer } = await getNamedAccounts()

  const deployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  // `ReservationProofs` is linked into `Reservation`, which in turn is the
  // single external library the router links (`ReservationRouter` reaches the
  // proof handlers through `Reservation`).
  const ReservationProofs = await deploy("ReservationProofs", deployOptions)
  const Reservation = await deploy("Reservation", {
    ...deployOptions,
    libraries: {
      ReservationProofs: ReservationProofs.address,
    },
  })

  const reservationRouter = await deploy("ReservationRouter", {
    ...deployOptions,
    libraries: {
      Reservation: Reservation.address,
    },
  })

  // `setReservationRouter` is write-once and reverts with "Reservation
  // router already set" on a second call, so a retry of a
  // partially-failed deploy pipeline must not re-invoke it once the
  // Bridge already points at a router.
  const currentReservationRouter = await read(
    "Bridge",
    { from: deployer },
    "getReservationRouter"
  )

  if (currentReservationRouter === ethers.constants.AddressZero) {
    await execute(
      "Bridge",
      { from: deployer, log: true, waitConfirmations: 1 },
      "setReservationRouter",
      reservationRouter.address
    )
  } else {
    log(`Bridge reservation router already set to ${currentReservationRouter}`)
  }

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(ReservationProofs)
    await helpers.etherscan.verify(Reservation)
    await helpers.etherscan.verify(reservationRouter)
  }
}

export default func

func.tags = ["ReservationRouter"]
func.dependencies = ["Bridge"]
