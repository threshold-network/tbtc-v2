/* eslint-disable no-console */
import * as path from "path"

import {
  getReservationAbiSnapshot,
  writeReservationAbiSnapshot,
} from "../test/fixtures/reservationAbiSnapshot"

const SNAPSHOT_PATH = path.resolve(
  __dirname,
  "../test/fixtures/ReservationAbi.snapshot.json"
)

async function main(): Promise<void> {
  console.log(
    "Extracting current reservation ABI surface from compiled artifacts..."
  )
  const snapshot = await getReservationAbiSnapshot()

  await writeReservationAbiSnapshot(snapshot, SNAPSHOT_PATH)
  console.log(
    `Successfully updated reservation ABI snapshot at ${SNAPSHOT_PATH}`
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      "Reservation ABI snapshot update failed:",
      error.message || error
    )
    process.exit(1)
  })
