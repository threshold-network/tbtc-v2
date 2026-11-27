import { expect } from "chai"
import { ethers } from "ethers"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import manualDeprecate from "../deploy_sidechain/34_manual_deprecate_polygon_wormhole_gateway"

const DISABLED_GATEWAY = ethers.utils.hexZeroPad("0x01", 32)
const GATEWAY = "0x09959798B95d00a3183d20FaC298E4594E599eab"
const OWNER = "0x9F6e831c8F8939DC0C830C6e492e7cEf4f9C2F5f"
const DEPLOYER = "0x123694886DBf5Ac94DDA07135349534536D14cAf"

const iface = new ethers.utils.Interface([
  "function updateMintingLimit(uint256 limit)",
  "function updateGatewayAddress(uint16 chainId, bytes32 gatewayAddress)",
])

function callException(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "CALL_EXCEPTION" })
}

describe("34_manual_deprecate_polygon_wormhole_gateway", () => {
  let originalArgv: string[]
  let originalEnv: string | undefined

  beforeEach(() => {
    originalArgv = process.argv
    originalEnv = process.env.REQUIRE_DISABLED_GATEWAY_SUPPORT
    process.argv = ["node", "hardhat", "deploy"]
    delete process.env.REQUIRE_DISABLED_GATEWAY_SUPPORT
  })

  afterEach(() => {
    process.argv = originalArgv
    if (originalEnv === undefined) {
      delete process.env.REQUIRE_DISABLED_GATEWAY_SUPPORT
    } else {
      process.env.REQUIRE_DISABLED_GATEWAY_SUPPORT = originalEnv
    }
  })

  function makeHre(probe: () => Promise<string>) {
    const logs: string[] = []
    const probes: { to: string; data: string }[] = []
    const hre = {
      network: { name: "polygon" },
      ethers: {
        provider: {
          call: async (transaction: { to: string; data: string }) => {
            probes.push(transaction)
            return probe()
          },
        },
        utils: { id: ethers.utils.id },
      },
      deployments: {
        get: async (name: string) => {
          expect(name).to.equal("PolygonWormholeGateway")
          return { address: GATEWAY }
        },
        read: async (name: string, method: string) => {
          expect(name).to.equal("PolygonWormholeGateway")
          expect(method).to.equal("owner")
          return OWNER
        },
        log: (message: string) => {
          logs.push(message)
        },
      },
      getNamedAccounts: async () => ({ deployer: DEPLOYER }),
    } as unknown as HardhatRuntimeEnvironment
    return { hre, logs, probes }
  }

  const gatewayCalls = (logs: string[]) =>
    logs.filter((message) => message.includes("updateGatewayAddress"))

  it("stays skipped unless the skip line is commented out", async () => {
    const { hre } = makeHre(async () => DISABLED_GATEWAY)
    expect(await manualDeprecate.skip?.(hre)).to.equal(true)
  })

  it("prints updateMintingLimit(0) for the gateway owner", async () => {
    const { hre, logs } = makeHre(async () => "0x")

    await manualDeprecate(hre)

    expect(logs[0]).to.include("updateMintingLimit(0)")
    expect(logs[0]).to.include(`from: ${OWNER}`)
    expect(logs[0]).to.include(`to: ${GATEWAY}`)
    expect(logs[0]).to.include(
      `data: ${iface.encodeFunctionData("updateMintingLimit", [0])}`
    )
    expect(logs.join("\n")).to.not.include(DEPLOYER)
  })

  it("withholds the sentinel calls when the gateway returns no DISABLED_GATEWAY value", async () => {
    const { hre, logs, probes } = makeHre(async () => "0x")

    await manualDeprecate(hre)

    expect(probes).to.deep.equal([
      {
        to: GATEWAY,
        data: ethers.utils.id("DISABLED_GATEWAY()").slice(0, 10),
      },
    ])
    expect(gatewayCalls(logs)).to.deep.equal([])
    expect(logs.join("\n")).to.match(
      /is not upgraded with disabled gateway support/
    )
  })

  it("withholds the sentinel calls when the DISABLED_GATEWAY probe reverts", async () => {
    const { hre, logs } = makeHre(async () => {
      throw callException("reverted")
    })

    await manualDeprecate(hre)

    expect(gatewayCalls(logs)).to.deep.equal([])
    expect(logs.join("\n")).to.match(
      /is not upgraded with disabled gateway support/
    )
  })

  it("fails without printing the sentinel calls when support is required", async () => {
    process.env.REQUIRE_DISABLED_GATEWAY_SUPPORT = "true"
    const { hre, logs } = makeHre(async () => "0x")

    try {
      await manualDeprecate(hre)
      expect.fail("expected the manual deprecation to throw")
    } catch (error) {
      expect((error as Error).message).to.match(/is not upgraded/)
    }
    expect(gatewayCalls(logs)).to.deep.equal([])
  })

  it("prints the sentinel calls for the owner once the gateway supports DISABLED_GATEWAY", async () => {
    const { hre, logs } = makeHre(async () => DISABLED_GATEWAY)

    await manualDeprecate(hre)

    const calls = gatewayCalls(logs)
    expect(calls).to.have.length(4)
    ;[23, 24, 30, 1].forEach((chainId, i) => {
      expect(calls[i]).to.include(
        `updateGatewayAddress(${chainId}, DISABLED_GATEWAY())`
      )
      expect(calls[i]).to.include(`from: ${OWNER}`)
      expect(calls[i]).to.include(`to: ${GATEWAY}`)
      expect(calls[i]).to.include(
        `data: ${iface.encodeFunctionData("updateGatewayAddress", [
          chainId,
          DISABLED_GATEWAY,
        ])}`
      )
    })
  })
})
