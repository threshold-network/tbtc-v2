import fs from "fs"
import path from "path"
import { expect } from "chai"
import {
  FIXTURE_ENV,
  RESERVED_SWEEP_REVERT,
  SELECTOR_IS_RESERVED_DEPOSIT,
  SELECTOR_VALIDATE_RESERVATION_ANCHOR,
  SELECTOR_VALIDATE_RESERVATION_REANCHOR,
  assertNotFixtureMode,
  reservationActivationChecks,
  revertStringPresent,
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

  // solc emits the revert string as one PUSH32-and-MSTORE per 32-byte word,
  // with the store sequence between words. The fixtures below are the bytes
  // taken from the deployed build at 0xC717f7Ae74836d48d64CBb9349FFa49Ad3E1241A.
  describe("the reserved-deposit revert message", () => {
    const store = "6044820152"
    const word0 = Buffer.from(
      "Reserved deposits must not be sw",
      "ascii"
    ).toString("hex")
    const word1 = Buffer.concat([
      Buffer.from("ept", "ascii"),
      Buffer.alloc(29),
    ]).toString("hex")
    const build = `7f${word0}${store}7f${word1}`

    it("is found as the interleaved 32-byte words", () => {
      expect(revertStringPresent(build, RESERVED_SWEEP_REVERT)).to.equal(true)
    })

    it("is not a substring of the code that carries it", () => {
      const literal = Buffer.from(RESERVED_SWEEP_REVERT, "ascii").toString(
        "hex"
      )
      expect(build.includes(literal)).to.equal(false)
    })

    it("is not satisfied by its words far apart", () => {
      const code = `7f${word0}${"00".repeat(40)}7f${word1}`
      expect(revertStringPresent(code, RESERVED_SWEEP_REVERT)).to.equal(false)
    })

    it("is not satisfied by an unrelated swept literal after a matching prefix", () => {
      const swept = Buffer.from("Deposit already swept", "ascii").toString(
        "hex"
      )
      const code = `7f${word0}${store}${"11".repeat(8)}${swept}${"00".repeat(16)}`
      expect(revertStringPresent(code, RESERVED_SWEEP_REVERT)).to.equal(false)
    })
  })

  // The gate's verdict is decided by `reservationActivationChecks`, so these
  // drive the consuming path: the checks list, the probe target and the
  // failure count the script exits on.
  describe("the gate verdict", () => {
    const store = "6044820152"
    const word0 = Buffer.from(
      "Reserved deposits must not be sw",
      "ascii"
    ).toString("hex")
    const word1 = Buffer.concat([
      Buffer.from("ept", "ascii"),
      Buffer.alloc(29),
    ]).toString("hex")
    // A runtime that passes every discriminator check.
    const code = `7f${word0}${store}7f${word1}93df529b${SELECTOR_IS_RESERVED_DEPOSIT}${SELECTOR_VALIDATE_RESERVATION_ANCHOR}${SELECTOR_VALIDATE_RESERVATION_REANCHOR}`
    const VALIDATOR = "0x1111111111111111111111111111111111111111"

    interface Asked {
      to: string
      data: string
    }

    function provider(bridge: string | undefined, asked: Asked[]) {
      return {
        call: async (tx: Asked): Promise<string> => {
          asked.push(tx)
          if (tx.data === "0xe78cea92") {
            if (bridge === undefined) throw new Error("no bridge() here")
            return encodeAddress(bridge)
          }
          if (tx.data.startsWith(`0x${SELECTOR_IS_RESERVED_DEPOSIT}`)) {
            return `0x${"0".repeat(64)}`
          }
          throw new Error(`unexpected call ${tx.data}`)
        },
      }
    }

    function input(
      bridge: string | undefined,
      expected: string,
      asked: Asked[]
    ) {
      return {
        provider: provider(bridge, asked),
        chainId: 1,
        validatorAddress: VALIDATOR,
        validatorCode: code,
        expectedBridge: expected,
        activationBlock: 1000,
        releaseBlock: 900,
        setVaultStatusBlock: 1000,
      }
    }

    it("passes when the validator's Bridge is the expected one", async () => {
      const asked: Asked[] = []
      const result = await reservationActivationChecks(
        input(A_BRIDGE, A_BRIDGE, asked)
      )
      expect(result.failed).to.equal(0)
      expect(result.checks.length).to.equal(10)
    })

    it("probes the validator's Bridge, not the expected address", async () => {
      const asked: Asked[] = []
      await reservationActivationChecks(input(A_BRIDGE, A_BRIDGE, asked))
      const probes = asked.filter((tx) =>
        tx.data.startsWith(`0x${SELECTOR_IS_RESERVED_DEPOSIT}`)
      )
      expect(probes.length).to.equal(1)
      expect(probes[0].to).to.equal(A_BRIDGE.toLowerCase())
    })

    it("fails when the override names another Bridge the validator does not call", async () => {
      const asked: Asked[] = []
      const result = await reservationActivationChecks(
        input(A_BRIDGE, OTHER_BRIDGE, asked)
      )
      expect(result.failed).to.equal(1)
      const failed = result.checks.filter((check) => !check.ok)
      expect(failed[0].name).to.equal("validator points at the expected Bridge")
      // The probe still went to the validator's Bridge, never to the override.
      const probes = asked.filter((tx) =>
        tx.data.startsWith(`0x${SELECTOR_IS_RESERVED_DEPOSIT}`)
      )
      expect(probes.map((tx) => tx.to)).to.deep.equal([A_BRIDGE.toLowerCase()])
    })

    it("fails the binding and the probe when bridge() cannot be read", async () => {
      const asked: Asked[] = []
      const result = await reservationActivationChecks(
        input(undefined, A_BRIDGE, asked)
      )
      expect(result.failed).to.equal(2)
      expect(result.declaredBridge).to.equal(undefined)
      expect(
        result.checks.filter((check) => !check.ok).map((check) => check.name)
      ).to.deep.equal([
        "validator points at the expected Bridge",
        "Bridge answers isReservedDeposit",
      ])
      expect(
        asked.some((tx) =>
          tx.data.startsWith(`0x${SELECTOR_IS_RESERVED_DEPOSIT}`)
        )
      ).to.equal(false)
    })

    it("fails when the activation block is below the release block", async () => {
      const asked: Asked[] = []
      const result = await reservationActivationChecks({
        ...input(A_BRIDGE, A_BRIDGE, asked),
        activationBlock: 800,
      })
      expect(result.failed).to.equal(1)
      expect(result.checks.filter((check) => !check.ok)[0].name).to.equal(
        "activation block is above the release block"
      )
    })
  })

  // The gap bound is 16 bytes; `code` is a hex string, so the bound is 32
  // characters. Comparing the character distance with the byte limit rejects
  // the 9..16-byte gaps this rule is supposed to allow.
  describe("the revert-word gap bound", () => {
    const word0 = Buffer.from(
      "Reserved deposits must not be sw",
      "ascii"
    ).toString("hex")
    const word1 = Buffer.concat([
      Buffer.from("ept", "ascii"),
      Buffer.alloc(29),
    ]).toString("hex")
    const gap = (bytes: number): string => `${"00".repeat(bytes - 1)}7f`

    it("accepts the six-byte store sequence", () => {
      expect(
        revertStringPresent(
          `7f${word0}60448201527f${word1}`,
          RESERVED_SWEEP_REVERT
        )
      ).to.equal(true)
    })

    it("accepts a nine-byte gap", () => {
      const bridge = "60448201526000507f"
      expect(bridge.length / 2).to.equal(9)
      const code = `7f${word0}${bridge}${word1}`
      expect(revertStringPresent(code, RESERVED_SWEEP_REVERT)).to.equal(true)
    })

    it("accepts a gap of exactly sixteen bytes", () => {
      expect(
        revertStringPresent(
          `7f${word0}${gap(16)}${word1}`,
          RESERVED_SWEEP_REVERT
        )
      ).to.equal(true)
    })

    it("rejects a gap of seventeen bytes", () => {
      expect(
        revertStringPresent(
          `7f${word0}${gap(17)}${word1}`,
          RESERVED_SWEEP_REVERT
        )
      ).to.equal(false)
    })
  })
})
