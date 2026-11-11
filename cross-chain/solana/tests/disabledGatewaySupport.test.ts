import { expect } from "chai"
import { assertDisabledGatewaySupport } from "../deploy/deprecate_polygon"
import { Idl } from "@coral-xyz/anchor"
import { Keypair, PublicKey } from "@solana/web3.js"
import { resolveAuthorityMode } from "../deploy/helpers/deprecate_peer"

describe("assertDisabledGatewaySupport", () => {
  it("should throw if GatewayDisabled error is missing", () => {
    const idl: Idl = {
      version: "0.1.0",
      name: "test",
      instructions: [
        {
          name: "sendTbtcWrapped",
          accounts: [{ name: "gatewayInfo", isMut: false, isSigner: false }],
          args: [],
        },
      ],
      errors: [],
    }
    expect(() => assertDisabledGatewaySupport(idl, "test")).to.throw()
  })

  it("should throw if gatewayInfo account is missing", () => {
    const idl: Idl = {
      version: "0.1.0",
      name: "test",
      instructions: [{ name: "sendTbtcWrapped", accounts: [], args: [] }],
      errors: [{ code: 1, name: "GatewayDisabled" }],
    }
    expect(() => assertDisabledGatewaySupport(idl, "test")).to.throw()
  })

  it("should not throw if both present", () => {
    const idl: Idl = {
      version: "0.1.0",
      name: "test",
      instructions: [
        {
          name: "sendTbtcWrapped",
          accounts: [{ name: "gatewayInfo", isMut: false, isSigner: false }],
          args: [],
        },
      ],
      errors: [{ code: 1, name: "GatewayDisabled" }],
    }
    expect(() => assertDisabledGatewaySupport(idl, "test")).to.not.throw()
  })

  it("should throw if both missing", () => {
    const idl: Idl = {
      version: "0.1.0",
      name: "test",
      instructions: [{ name: "sendTbtcWrapped", accounts: [], args: [] }],
      errors: [],
    }
    expect(() => assertDisabledGatewaySupport(idl, "test")).to.throw()
  })
})

describe("resolveAuthorityMode", () => {
  // The mainnet custodian authority, a Squads v3 vault: an off-curve PDA.
  const squadsVault = new PublicKey(
    "814TqVmhQGKB3srSLRuMcH6m8qWFHRSbNpRxC5Xnador"
  )

  it("should build a multisig instruction when no signer is given", () => {
    expect(PublicKey.isOnCurve(squadsVault.toBytes())).to.equal(false)
    expect(resolveAuthorityMode(squadsVault)).to.equal("multisig")
  })

  it("should sign directly when the signer is the custodian authority", () => {
    const signer = Keypair.generate()
    expect(resolveAuthorityMode(signer.publicKey, signer)).to.equal("sign")
  })

  it("should refuse a signer that is not the custodian authority", () => {
    expect(() =>
      resolveAuthorityMode(squadsVault, Keypair.generate())
    ).to.throw("is not the gateway custodian authority")
  })
})
