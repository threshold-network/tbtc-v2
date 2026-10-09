import { expect } from "chai"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import func from "../../deploy/97_set_reservation_parameters"

interface ExecuteCall {
  contract: string
  method: string
}

// Builds a minimal runtime for script 97 on a live (non-local) network:
// the Bridge reports the given deposit parameters and every governance
// transaction is recorded instead of sent.
function createLiveNetworkHre(depositParameters: {
  dustThreshold: bigint
  revealAheadPeriod: number
}): { hre: HardhatRuntimeEnvironment; executed: ExecuteCall[] } {
  const executed: ExecuteCall[] = []
  const hre = {
    network: { name: "sepolia" },
    ethers: {},
    helpers: {},
    getNamedAccounts: async () => ({
      governance: "0x0000000000000000000000000000000000000009",
    }),
    deployments: {
      log: () => undefined,
      get: async (name: string) => ({
        address: `0x${name.length.toString(16).padStart(40, "0")}`,
      }),
      read: async (contract: string, method: string) => {
        if (contract === "Bridge" && method === "depositParameters") {
          return [
            depositParameters.dustThreshold,
            BigInt(2000),
            BigInt(100000),
            depositParameters.revealAheadPeriod,
          ]
        }
        if (contract === "BridgeGovernance" && method === "governanceDelays") {
          return BigInt(60)
        }
        throw new Error(`Unexpected read: ${contract}.${method}`)
      },
      execute: async (contract: string, _options: unknown, method: string) => {
        executed.push({ contract, method })
      },
    },
  }
  // The script only touches the fields stubbed above.
  return { hre: hre as unknown as HardhatRuntimeEnvironment, executed }
}

describe("Deploy Script 97: Reservation Parameters", () => {
  describe("on a live network", () => {
    it("should refuse its local test values when the Bridge dust threshold is above the single-amount cap", async () => {
      // Sepolia's live deposit parameters: 1,000,000-sat dust threshold,
      // 15-day reveal-ahead period.
      const { hre, executed } = createLiveNetworkHre({
        dustThreshold: BigInt(1000000),
        revealAheadPeriod: 1296000,
      })

      let rejection: unknown
      try {
        await func(hre)
      } catch (error) {
        rejection = error
      }

      expect(rejection, "script 97 should reject").to.be.instanceOf(Error)
      expect((rejection as Error).message).to.match(/depositDustThreshold/)
      expect(executed, "no governance call may be sent").to.deep.equal([])
    })

    it("should stage the begin calls when its values fit the Bridge deposit parameters", async () => {
      const { hre, executed } = createLiveNetworkHre({
        dustThreshold: BigInt(100000),
        revealAheadPeriod: 0,
      })

      await func(hre)

      expect(executed.map((call) => call.method)).to.deep.equal([
        "beginReservationCapsUpdate",
        "beginReservationParametersUpdate",
      ])
    })
  })
})
