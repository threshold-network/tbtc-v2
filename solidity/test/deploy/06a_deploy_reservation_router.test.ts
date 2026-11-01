import { expect } from "chai"
import func from "../../deploy/06a_deploy_reservation_router"

/**
 * The router script must not pull the Bridge deploy script in.
 *
 * hardhat-deploy resolves a script's `dependencies` *before* it consults
 * `skip` (1.0.4, `DeploymentsManager.executeDeployScripts`), so a
 * `"Bridge"` dependency here runs `06_deploy_bridge.ts` on every network
 * even when this script then skips itself, and 06 has neither a `skip` nor a
 * mainnet guard. On mainnet the Bridge is already deployed, so the run
 * aborts inside 06 -- after 06 has re-deployed `Deposit`, `DepositSweep`
 * and `Wallets` (their sources change in this release, so hardhat-deploy
 * finds the recorded deployment transaction stale) and rewritten those
 * records to name implementations the live Bridge does not link.
 *
 * This script reads the `Bridge` *record*, never the deploy script that
 * writes it, so the dependency was never needed. #1188 removed the same
 * dependency from `99_deploy_rebate_staking_reservation_implementation.ts`;
 * this pins the same property here.
 */
describe("deploy/06a the ReservationRouter script declares no dependencies", () => {
  it("declares no dependencies at all", () => {
    expect(func.dependencies ?? []).to.deep.equal([])
  })

  it("carries the tag the runbook names", () => {
    expect(func.tags).to.include("ReservationRouter")
  })
})
