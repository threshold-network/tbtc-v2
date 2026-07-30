import { expect } from "chai"

import { WalletState } from "../../src/lib/contracts/bridge"

describe("WalletState", () => {
  it("should parse COMPLETE_V2 quarantine and recovery states", () => {
    expect(WalletState.parse(6)).to.equal(WalletState.Quarantined)
    expect(WalletState.parse(7)).to.equal(WalletState.RecoveryRequired)
  })

  it("should preserve existing states and unknown-value fallback", () => {
    expect(WalletState.parse(0)).to.equal(WalletState.Unknown)
    expect(WalletState.parse(5)).to.equal(WalletState.Terminated)
    expect(WalletState.parse(8)).to.equal(WalletState.Unknown)
  })
})
