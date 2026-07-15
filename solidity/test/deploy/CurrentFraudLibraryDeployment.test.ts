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

  scripts.forEach((script) => {
    it(`${script} deploys current Fraud bytecode before linking Bridge`, () => {
      const source = fs.readFileSync(path.join(deployDirectory, script), "utf8")

      expect(source).not.to.match(/get\("Fraud"\)/)
      expect(source).to.match(/deploy\("Fraud(?:TIP109Hotfix)?"/)
      expect(source).to.match(/Fraud:\s*Fraud\.address/)
    })
  })
})
