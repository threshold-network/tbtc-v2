import { expect } from "chai"
import { assertDisabledGatewaySupport } from "../deploy/deprecate_polygon"
import { Idl } from "@coral-xyz/anchor"

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
