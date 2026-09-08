import { ethers } from "hardhat"
import { expect } from "chai"

import { loadFixture } from "./fixture"

describe("loadFixture", () => {
  it("performs a cold start on the first invocation", async () => {
    let count = 0
    const fixture = async () => {
      count += 1
      return { val: count }
    }
    const res = await loadFixture(fixture)
    expect(res.val).to.equal(1)
    expect(count).to.equal(1)
  })

  it("returns cached data on subsequent invocations with the same fixture", async () => {
    let count = 0
    const fixture = async () => {
      count += 1
      return { val: count }
    }
    await loadFixture(fixture)
    const res = await loadFixture(fixture)
    expect(res.val).to.equal(1)
    expect(count).to.equal(1)
  })

  it("re-runs the fixture when the snapshot is invalidated", async () => {
    let count = 0
    const fixture = async () => {
      count += 1
      return { val: count }
    }
    const initId = await ethers.provider.send("evm_snapshot", [])

    // First call caches the snapshot
    await loadFixture(fixture)
    expect(count).to.equal(1)

    // Revert to initial state, invalidating the snapshot cached by loadFixture
    await ethers.provider.send("evm_revert", [initId])

    // Should re-run the fixture
    const res = await loadFixture(fixture)
    expect(res.val).to.equal(2)
    expect(count).to.equal(2)
  })
})
