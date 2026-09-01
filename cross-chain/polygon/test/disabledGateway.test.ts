import { expect } from "chai"
import {
  isDisabledGatewaySupported,
  evaluateDisabledGatewaySupport,
  DisabledGatewayHardhatRuntimeEnvironment,
} from "../../deploy_helpers/disabled_gateway"

const DISABLED_GATEWAY =
  "0x0000000000000000000000000000000000000000000000000000000000000001"

function callException(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "CALL_EXCEPTION" })
}

describe("disabled_gateway", () => {
  let originalArgv: string[]
  let originalEnv: string | undefined

  beforeEach(() => {
    originalArgv = process.argv
    originalEnv = process.env.REQUIRE_DISABLED_GATEWAY_SUPPORT
  })

  afterEach(() => {
    process.argv = originalArgv
    if (originalEnv === undefined) {
      delete process.env.REQUIRE_DISABLED_GATEWAY_SUPPORT
    } else {
      process.env.REQUIRE_DISABLED_GATEWAY_SUPPORT = originalEnv
    }
  })

  function noopHre(): DisabledGatewayHardhatRuntimeEnvironment {
    return {
      network: { name: "polygon" },
      ethers: {
        provider: {
          call: async () => {
            throw new Error("should not be called")
          },
        },
        utils: { id: () => "0xdeadbeef" },
      },
      deployments: { log: () => {} },
    }
  }

  describe("evaluateDisabledGatewaySupport (pure decision logic)", () => {
    it("returns true when the call result matches the sentinel", () => {
      expect(
        evaluateDisabledGatewaySupport(
          DISABLED_GATEWAY,
          DISABLED_GATEWAY,
          undefined,
          false,
          undefined,
          noopHre(),
          "g",
          "d"
        )
      ).to.equal(true)
    })

    it("matches the sentinel case-insensitively", () => {
      expect(
        evaluateDisabledGatewaySupport(
          DISABLED_GATEWAY.toUpperCase(),
          DISABLED_GATEWAY,
          undefined,
          false,
          undefined,
          noopHre(),
          "g",
          "d"
        )
      ).to.equal(true)
    })

    it("returns false and logs when the result doesn't match and no strict mode applies", () => {
      let logged: string | undefined
      const hre: DisabledGatewayHardhatRuntimeEnvironment = {
        ...noopHre(),
        deployments: {
          log: (message: string) => {
            logged = message
          },
        },
      }
      expect(
        evaluateDisabledGatewaySupport(
          "0x",
          DISABLED_GATEWAY,
          undefined,
          false,
          undefined,
          hre,
          "g",
          "d"
        )
      ).to.equal(false)
      expect(logged).to.match(/is not upgraded/)
    })

    it("throws when tag-scoped to DeprecatePolygon even without the env var", () => {
      expect(() =>
        evaluateDisabledGatewaySupport(
          "0x",
          DISABLED_GATEWAY,
          undefined,
          true,
          undefined,
          noopHre(),
          "g",
          "d"
        )
      ).to.throw(/is not upgraded/)
    })

    it("throws when REQUIRE_DISABLED_GATEWAY_SUPPORT=true even without a tag filter", () => {
      expect(() =>
        evaluateDisabledGatewaySupport(
          "0x",
          DISABLED_GATEWAY,
          undefined,
          false,
          "true",
          noopHre(),
          "g",
          "d"
        )
      ).to.throw(/is not upgraded/)
    })

    it("includes the underlying call-failure message when strict", () => {
      const error = callException("reverted")
      expect(() =>
        evaluateDisabledGatewaySupport(
          undefined,
          DISABLED_GATEWAY,
          error,
          true,
          undefined,
          noopHre(),
          "g",
          "d"
        )
      ).to.throw(/Call failure: reverted/)
    })
  })

  describe("isDisabledGatewaySupported (hre-driven probe + tag/error handling)", () => {
    function makeHre(
      call: () => Promise<string>
    ): DisabledGatewayHardhatRuntimeEnvironment & { logs: string[] } {
      const logs: string[] = []
      return {
        network: { name: "polygon" },
        ethers: {
          provider: { call },
          utils: { id: () => "0xdeadbeef" },
        },
        deployments: {
          log: (message: string) => {
            logs.push(message)
          },
        },
        logs,
      }
    }

    it("short-circuits to true on the hardhat network without calling out", async () => {
      const hre = makeHre(() => {
        throw new Error("should not be called")
      })
      hre.network.name = "hardhat"
      expect(
        await isDisabledGatewaySupported(
          hre,
          "0xGateway",
          "Gateway",
          "Dest",
          DISABLED_GATEWAY
        )
      ).to.equal(true)
    })

    it("returns true when the on-chain probe matches the sentinel", async () => {
      const hre = makeHre(async () => DISABLED_GATEWAY)
      expect(
        await isDisabledGatewaySupported(
          hre,
          "0xGateway",
          "Gateway",
          "Dest",
          DISABLED_GATEWAY
        )
      ).to.equal(true)
    })

    it("permissively skips (logs, returns false) on CALL_EXCEPTION with no tag filter", async () => {
      const hre = makeHre(async () => {
        throw callException("reverted")
      })
      process.argv = ["node", "hardhat", "deploy"]
      expect(
        await isDisabledGatewaySupported(
          hre,
          "0xGateway",
          "Gateway",
          "Dest",
          DISABLED_GATEWAY
        )
      ).to.equal(false)
      expect(hre.logs[0]).to.match(/is not upgraded/)
    })

    it("throws on CALL_EXCEPTION when tag-scoped to DeprecatePolygon", async () => {
      const hre = makeHre(async () => {
        throw callException("reverted")
      })
      process.argv = ["node", "hardhat", "deploy", "--tags", "DeprecatePolygon"]
      try {
        await isDisabledGatewaySupported(
          hre,
          "0xGateway",
          "Gateway",
          "Dest",
          DISABLED_GATEWAY
        )
        expect.fail("expected isDisabledGatewaySupported to throw")
      } catch (error) {
        expect((error as Error).message).to.match(/is not upgraded/)
      }
    })

    it("throws on CALL_EXCEPTION when a comma-separated tag list includes DeprecatePolygon", async () => {
      const hre = makeHre(async () => {
        throw callException("reverted")
      })
      process.argv = [
        "node",
        "hardhat",
        "deploy",
        "--tags",
        "Foo,DeprecatePolygon",
      ]
      try {
        await isDisabledGatewaySupported(
          hre,
          "0xGateway",
          "Gateway",
          "Dest",
          DISABLED_GATEWAY
        )
        expect.fail("expected isDisabledGatewaySupported to throw")
      } catch (error) {
        expect((error as Error).message).to.match(/is not upgraded/)
      }
    })

    it("forces fatal via REQUIRE_DISABLED_GATEWAY_SUPPORT=true regardless of tags", async () => {
      const hre = makeHre(async () => {
        throw callException("reverted")
      })
      process.argv = ["node", "hardhat", "deploy"]
      process.env.REQUIRE_DISABLED_GATEWAY_SUPPORT = "true"
      try {
        await isDisabledGatewaySupported(
          hre,
          "0xGateway",
          "Gateway",
          "Dest",
          DISABLED_GATEWAY
        )
        expect.fail("expected isDisabledGatewaySupported to throw")
      } catch (error) {
        expect((error as Error).message).to.match(/is not upgraded/)
      }
    })

    it("rethrows a non-CALL_EXCEPTION error (e.g. an RPC timeout) regardless of tag scope", async () => {
      const hre = makeHre(async () => {
        throw new Error("timeout")
      })
      process.argv = ["node", "hardhat", "deploy"]
      try {
        await isDisabledGatewaySupported(
          hre,
          "0xGateway",
          "Gateway",
          "Dest",
          DISABLED_GATEWAY
        )
        expect.fail("expected isDisabledGatewaySupported to throw")
      } catch (error) {
        expect((error as Error).message).to.match(/timeout/)
      }
    })
  })
})
