import { expect } from "chai"

import func from "../deploy_l1/01_upgrade_arbitrum_l1_bitcoin_depositor_to_v2"

describe("UpgradeArbitrumL1BitcoinDepositorToV2 - Deploy Script Structure", () => {
  it("should export a default deploy function", () => {
    expect(func).to.be.a("function")
  })

  it("should define tags with the correct upgrade tag", () => {
    expect(func.tags).to.be.an("array")
    expect(func.tags).to.include("UpgradeArbitrumL1BitcoinDepositorToV2")
  })

  it("should define a skip function", () => {
    expect(func.skip).to.be.a("function")
  })

  it("should have skip return false by default", async () => {
    const shouldSkip = await func.skip!({} as any)
    expect(shouldSkip).to.equal(false)
  })
})
