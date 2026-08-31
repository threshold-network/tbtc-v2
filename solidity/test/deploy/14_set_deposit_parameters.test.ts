/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"
import { BigNumber, utils } from "ethers"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import func, {
  buildDepositRevealAheadPeriodGovernanceActions,
  DEPOSIT_REVEAL_AHEAD_PERIOD,
} from "../../deploy/14_set_deposit_parameters"

describe("Deploy Script 14: deposit parameters", () => {
  const deployer = "0x1000000000000000000000000000000000000001"
  const bridgeGovernance = "0x2000000000000000000000000000000000000002"
  const depositDustThreshold = BigNumber.from("1000000")
  const depositTreasuryFeeDivisor = BigNumber.from("500")
  const depositTxMaxFee = BigNumber.from("100000")
  const governanceDelay = BigNumber.from("172800")

  function createMockHre(options: {
    bridgeGovernance: string
    depositRevealAheadPeriod: BigNumber
    bridgeGovernanceDeployment?: string | null
    pendingUpdate?: {
      newDepositRevealAheadPeriod: BigNumber
      timestamp: BigNumber
    } | null
  }) {
    const executeCalls: any[][] = []
    const getCalls: string[] = []
    const logs: string[] = []

    const mockHre = {
      deployments: {
        execute: async (...args: any[]) => executeCalls.push(args),
        getOrNull: async (name: string) => {
          getCalls.push(name)
          if (options.bridgeGovernanceDeployment === null) {
            return null
          }

          return {
            address: options.bridgeGovernanceDeployment ?? bridgeGovernance,
          }
        },
        log: (message: string) => logs.push(message),
        read: async (name: string, method: string, ...args: any[]) => {
          if (name === "Bridge" && method === "depositParameters") {
            return {
              depositDustThreshold,
              depositTreasuryFeeDivisor,
              depositTxMaxFee,
              depositRevealAheadPeriod: options.depositRevealAheadPeriod,
            }
          }

          if (name === "Bridge" && method === "governance") {
            return options.bridgeGovernance
          }

          if (name === "BridgeGovernance" && method === "governanceDelays") {
            const index = args[0]
            if (BigNumber.from(index).eq(0)) {
              return governanceDelay
            }
            throw new Error(`Unexpected read: ${name}.${method}(${index})`)
          }

          throw new Error(`Unexpected read: ${name}.${method}`)
        },
      },
      ethers: {
        BigNumber,
        getContractAt: async (name: string, address: string) => ({
          filters: {
            DepositRevealAheadPeriodUpdateStarted: () => "started",
            DepositRevealAheadPeriodUpdated: () => "updated",
          },
          queryFilter: async (filter: any) => {
            if (filter === "started") {
              return options.pendingUpdate
                ? [
                    {
                      args: [
                        options.pendingUpdate.newDepositRevealAheadPeriod,
                        options.pendingUpdate.timestamp,
                      ],
                      blockNumber: 100,
                    },
                  ]
                : []
            }
            return []
          },
        }),
      },
      getNamedAccounts: async () => ({ deployer }),
      network: { name: "mainnet" },
    } as unknown as HardhatRuntimeEnvironment

    return { executeCalls, getCalls, logs, mockHre }
  }

  it("updates Bridge directly before governance is transferred", async () => {
    const { executeCalls, getCalls, mockHre } = createMockHre({
      bridgeGovernance: deployer,
      depositRevealAheadPeriod: BigNumber.from("1296000"),
    })

    await func(mockHre)

    expect(getCalls).to.deep.equal(["BridgeGovernance"])
    expect(executeCalls).to.have.lengthOf(1)
    expect(executeCalls[0][0]).to.equal("Bridge")
    expect(executeCalls[0][2]).to.equal("updateDepositParameters")
    expect(executeCalls[0][3].toString()).to.equal(
      depositDustThreshold.toString()
    )
    expect(executeCalls[0][4].toString()).to.equal("0")
    expect(executeCalls[0][5].toString()).to.equal(depositTxMaxFee.toString())
    expect(executeCalls[0][6].toString()).to.equal(
      DEPOSIT_REVEAL_AHEAD_PERIOD.toString()
    )
  })

  it("updates a fresh Bridge when no BridgeGovernance deployment is loaded", async () => {
    const { executeCalls, getCalls, mockHre } = createMockHre({
      bridgeGovernance: deployer,
      bridgeGovernanceDeployment: null,
      depositRevealAheadPeriod: BigNumber.from("1296000"),
    })

    await func(mockHre)

    expect(getCalls).to.deep.equal(["BridgeGovernance"])
    expect(executeCalls).to.have.lengthOf(1)
    expect(executeCalls[0][2]).to.equal("updateDepositParameters")
  })

  it("does not call Bridge directly when governance already finalized the target", async () => {
    const { executeCalls, getCalls, logs, mockHre } = createMockHre({
      bridgeGovernance,
      depositRevealAheadPeriod: DEPOSIT_REVEAL_AHEAD_PERIOD,
    })

    await func(mockHre)

    expect(executeCalls).to.be.empty
    expect(getCalls).to.deep.equal(["BridgeGovernance"])
    expect(logs.join("\n")).to.include(
      "already finalized at 150 days; no governance transaction is required"
    )
  })

  it("emits delayed governance actions and blocks release when the live value differs", async () => {
    const { executeCalls, getCalls, logs, mockHre } = createMockHre({
      bridgeGovernance,
      depositRevealAheadPeriod: BigNumber.from("21945600"),
    })

    let error: Error | undefined
    try {
      await func(mockHre)
    } catch (caught) {
      error = caught as Error
    }

    expect(error?.message).to.include(
      "governance must finalize 12960000 seconds before releasing"
    )
    expect(executeCalls).to.be.empty
    expect(getCalls).to.deep.equal(["BridgeGovernance"])

    const emittedActions = JSON.parse(logs[1])
    expect(emittedActions.begin.data.slice(0, 10)).to.equal("0x71e7b693")
    expect(emittedActions.finalize.data.slice(0, 10)).to.equal("0x2df793c7")
    expect(emittedActions.finalize.executeAfterSeconds).to.equal("172800")
  })

  it("fails closed when Bridge has an unexpected governor", async () => {
    const unexpectedGovernor = "0x3000000000000000000000000000000000000003"
    const { executeCalls, mockHre } = createMockHre({
      bridgeGovernance: unexpectedGovernor,
      depositRevealAheadPeriod: DEPOSIT_REVEAL_AHEAD_PERIOD,
    })

    let error: Error | undefined
    try {
      await func(mockHre)
    } catch (caught) {
      error = caught as Error
    }

    expect(error?.message).to.equal(
      `Bridge is governed by unexpected address ${unexpectedGovernor}, expected deployer ${deployer}`
    )
    expect(executeCalls).to.be.empty
  })

  it("encodes Council Safe begin and finalize calls", () => {
    const actions = buildDepositRevealAheadPeriodGovernanceActions(
      bridgeGovernance,
      governanceDelay
    )
    const bridgeGovernanceInterface = new utils.Interface([
      "function beginDepositRevealAheadPeriodUpdate(uint32 newDepositRevealAheadPeriod)",
      "function finalizeDepositRevealAheadPeriodUpdate()",
    ])

    expect(actions.begin.to).to.equal(bridgeGovernance)
    expect(actions.finalize.to).to.equal(bridgeGovernance)
    expect(actions.finalize.executeAfterSeconds).to.equal("172800")
    expect(
      bridgeGovernanceInterface
        .decodeFunctionData(
          "beginDepositRevealAheadPeriodUpdate",
          actions.begin.data
        )[0]
        .toString()
    ).to.equal(DEPOSIT_REVEAL_AHEAD_PERIOD.toString())
    expect(
      bridgeGovernanceInterface.decodeFunctionData(
        "finalizeDepositRevealAheadPeriodUpdate",
        actions.finalize.data
      )
    ).to.have.lengthOf(0)
  })

  it("throws when a pending deposit reveal-ahead period update exists", async () => {
    const { mockHre } = createMockHre({
      bridgeGovernance,
      depositRevealAheadPeriod: BigNumber.from("12960000").add(1),
      pendingUpdate: {
        newDepositRevealAheadPeriod: BigNumber.from("100"),
        timestamp: BigNumber.from("1000"),
      },
    })

    let error: Error | undefined
    try {
      await func(mockHre)
    } catch (caught) {
      error = caught as Error
    }

    expect(error?.message).to.equal(
      "Deposit reveal-ahead period update is already pending"
    )
  })

  it("runs only on mainnet", async () => {
    const { skip } = func
    expect(skip).to.not.equal(undefined)
    if (!skip) {
      throw new Error("Deployment skip predicate is missing")
    }

    expect(await skip({ network: { name: "mainnet" } } as any)).to.equal(false)
    expect(await skip({ network: { name: "sepolia" } } as any)).to.equal(true)
  })
})
