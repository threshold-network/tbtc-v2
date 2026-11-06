import { ethers } from "hardhat"
import { expect } from "chai"

describe("GasAccounting", () => {
  it("clamps a reading that increased instead of reverting", async () => {
    const meter = await (
      await ethers.getContractFactory("GasAccountingTest")
    ).deploy()
    expect(await meter.gasSpent(0)).to.equal(0)
  })

  it("returns a positive delta when the later reading is lower", async () => {
    const meter = await (
      await ethers.getContractFactory("GasAccountingTest")
    ).deploy()
    const start = ethers.constants.MaxUint256
    const used = await meter.gasSpent(start)
    expect(used.gt(0)).to.equal(true)
    expect(used.lt(start)).to.equal(true)
  })
})
