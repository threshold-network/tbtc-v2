import { expect } from "chai"
import fs from "fs"
import path from "path"

describe("active Bridge upgrade scripts", () => {
  const deployDirectory = path.resolve(__dirname, "../../deploy")
  const scripts = [
    "82_deploy_rebate_and_prepare_txs.ts",
    "84_upgrade_bridge_c2_1_counter.ts",
    "85_deploy_tip109_governance_upgrade.ts",
    "86_deploy_tip109_hotfix.ts",
  ]
  const bridgeLibraries = [
    "Deposit",
    "DepositSweep",
    "Redemption",
    "Wallets",
    "Fraud",
    "MovingFunds",
    // Bridge links these two as external libraries as well, so they are
    // equally exposed to the stale-bytecode hazard this guard exists to catch.
    "P2TRPreSigning",
    "P2TRReservation",
  ]

  scripts.forEach((script) => {
    it(`${script} deploys every current library before linking Bridge`, () => {
      const source = fs.readFileSync(path.join(deployDirectory, script), "utf8")

      bridgeLibraries.forEach((library) => {
        const deploymentName = script.startsWith("86_")
          ? `${library}TIP109Hotfix`
          : library

        expect(source).not.to.match(new RegExp(`get\\("${library}"\\)`))
        // Prettier wraps a `deploy(` call that exceeds the 80-column print
        // width, so the deployment name can start on the next line -- which is
        // what happened to DepositSweep once its options identifier grew to
        // `p2trReservationLinkedOptions`. Tolerate that whitespace: the
        // assertion is about the script calling deploy() for this library, not
        // about how the call is formatted.
        expect(source).to.match(new RegExp(`deploy\\(\\s*"${deploymentName}"`))
        expect(source).to.match(
          new RegExp(`${library}:\\s*${library}\\.address`)
        )
      })
    })
  })
})
