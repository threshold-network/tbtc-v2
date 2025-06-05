import { expect } from "chai"
import { Provider, Account, Contract } from "starknet"

describe("StarkNet.js Integration", () => {
  it("should import Provider from starknet", () => {
    // Assert - if import succeeded, Provider should exist
    expect(Provider).to.exist
    expect(Provider).to.be.a("function")
  })

  it("should import Account from starknet", () => {
    // Assert - if import succeeded, Account should exist
    expect(Account).to.exist
    expect(Account).to.be.a("function")
  })

  it("should import Contract from starknet", () => {
    // Assert - if import succeeded, Contract should exist
    expect(Contract).to.exist
    expect(Contract).to.be.a("function")
  })
})
