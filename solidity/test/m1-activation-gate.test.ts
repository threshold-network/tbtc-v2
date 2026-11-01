import fs from "fs"
import path from "path"
import { expect } from "chai"
import {
  FIXTURE_ENV,
  assertNotFixtureMode,
  validatorBridgeCheck,
  validatorDeclaredBridge,
} from "../scripts/validator-runtime-guard"

const A_BRIDGE = "0x5e4861a80B55f035D899f66772117F00FA0E8e7B"
const OTHER_BRIDGE = "0x2220acE07d86B508742D511478e517716B675940"
const ZERO = `0x${"0".repeat(40)}`

function source(...parts: string[]): string {
  return fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8")
}

function encodeAddress(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`
}

describe("M1 activation gate", () => {
  // Fixture mode swaps the deployment record directory, so both entry points
  // must refuse it before their first record read. hardhat-deploy treats the
  // variable as set whenever it is non-empty; "0" and "false" included.
  describe("fixture mode", () => {
    ;["1", "0", "false", "true", "mainnet", " "].forEach((raw) => {
      it(`refuses ${FIXTURE_ENV}=${JSON.stringify(raw)}`, () => {
        expect(() => assertNotFixtureMode({ [FIXTURE_ENV]: raw })).to.throw(
          FIXTURE_ENV
        )
      })
    })

    it("accepts the variable unset or empty", () => {
      expect(() => assertNotFixtureMode({})).to.not.throw()
      expect(() => assertNotFixtureMode({ [FIXTURE_ENV]: "" })).to.not.throw()
    })

    it("is called by the gate before its first deployment record read", () => {
      const gate = source("scripts", "check-reservation-activation-gate.ts")
      const guard = gate.indexOf("assertNotFixtureMode(")
      const record = gate.indexOf("deployments.get(")
      expect(guard).to.be.greaterThan(-1)
      expect(record).to.be.greaterThan(-1)
      expect(guard).to.be.lessThan(record)
    })

    it("is called by the deploy script before its first record read", () => {
      const deploy = source("scripts", "deploy-reservation-validator.ts")
      const guard = deploy.indexOf("assertNotFixtureMode()")
      const record = deploy.indexOf('get("Bridge")')
      expect(guard).to.be.greaterThan(-1)
      expect(record).to.be.greaterThan(-1)
      expect(guard).to.be.lessThan(record)
    })
  })

  describe("the validator's Bridge", () => {
    it("is read from the validator, not from the deployment record", async () => {
      const asked: string[] = []
      const bridge = await validatorDeclaredBridge(
        {
          call: async (tx) => {
            asked.push(tx.to)
            return encodeAddress(A_BRIDGE)
          },
        },
        "0x1111111111111111111111111111111111111111"
      )
      expect(bridge).to.equal(A_BRIDGE.toLowerCase())
      expect(asked).to.deep.equal([
        "0x1111111111111111111111111111111111111111",
      ])
    })

    it("fails when the override names another Bridge", () => {
      const check = validatorBridgeCheck(A_BRIDGE, OTHER_BRIDGE)
      expect(check.ok).to.equal(false)
      expect(check.detail).to.contain(OTHER_BRIDGE)
    })

    it("passes when the override names the same Bridge in another case", () => {
      expect(
        validatorBridgeCheck(A_BRIDGE, A_BRIDGE.toLowerCase()).ok
      ).to.equal(true)
    })

    it("fails on the zero address", () => {
      const check = validatorBridgeCheck(ZERO, A_BRIDGE)
      expect(check.ok).to.equal(false)
      expect(check.detail).to.contain("zero address")
    })

    it("cannot be read from an address that does not answer bridge()", async () => {
      let error: Error | undefined
      try {
        await validatorDeclaredBridge({ call: async () => "0x" }, A_BRIDGE)
      } catch (caught) {
        error = caught as Error
      }
      expect(error?.message).to.contain("did not answer bridge()")
    })
  })
})
