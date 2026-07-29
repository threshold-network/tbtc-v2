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
  ]

  scripts.forEach((script) => {
    it(`${script} deploys every current library before linking Bridge`, () => {
      const source = fs.readFileSync(path.join(deployDirectory, script), "utf8")

      bridgeLibraries.forEach((library) => {
        const deploymentName = script.startsWith("86_")
          ? `${library}TIP109Hotfix`
          : library

        expect(source).not.to.match(new RegExp(`get\\("${library}"\\)`))
        expect(source).to.match(new RegExp(`deploy\\("${deploymentName}"`))
        expect(source).to.match(
          new RegExp(`${library}:\\s*${library}\\.address`)
        )
      })
    })
  })
})
