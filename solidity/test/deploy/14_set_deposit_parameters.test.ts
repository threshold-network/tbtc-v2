import { toBigInt, ethers as utils } from "ethers"
import { createRequire } from "module"
/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import func, {
  buildDepositRevealAheadPeriodGovernanceActions,
  DEPOSIT_REVEAL_AHEAD_PERIOD,
} from "../../deploy/14_set_deposit_parameters"

// Match the uint256 value returned by hardhat-deploy's ethers v5 reader.
const { BigNumber: DeployBigNumber } = createRequire(
  require.resolve("hardhat-deploy/package.json")
)("@ethersproject/bignumber")

describe("Deploy Script 14: deposit parameters", () => {
  const deployer = "0x1000000000000000000000000000000000000001"
  const bridgeGovernance = "0x2000000000000000000000000000000000000002"
  const depositDustThreshold = toBigInt("1000000")
  const depositTreasuryFeeDivisor = toBigInt("500")
  const depositTxMaxFee = toBigInt("100000")
  const governanceDelay = toBigInt("172800")

  function createMockHre(options: {
    bridgeGovernance: string
    depositRevealAheadPeriod: bigint
    bridgeGovernanceDeployment?: string | null
    pendingUpdate?: {
      newDepositRevealAheadPeriod: bigint
      timestamp: bigint
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
            if (toBigInt(index) === 0n) {
              return DeployBigNumber.from(governanceDelay.toString())
            }
            throw new Error(`Unexpected read: ${name}.${method}(${index})`)
          }

          throw new Error(`Unexpected read: ${name}.${method}`)
        },
      },
      ethers: {
        toBigInt,
        getContractAt: async (name: string, address: string) => ({
          filters: {
            DepositRevealAheadPeriodUpdateStarted: () => "started",
            DepositRevealAheadPeriodUpdated: () => "updated",
          },
          queryFilter: async (
            filter: any,
            fromBlock: number,
            toBlock: number
          ) => {
            if (fromBlock > toBlock) {
              throw new Error(`Invalid block range: ${fromBlock} > ${toBlock}`)
            }
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
        provider: {
          getBlockNumber: async () => 1000,
        },
      },
      getNamedAccounts: async () => ({ deployer }),
      network: { name: "mainnet" },
    } as unknown as HardhatRuntimeEnvironment

    return { executeCalls, getCalls, logs, mockHre }
  }

  it("updates Bridge directly before governance is transferred", async () => {
    const { executeCalls, getCalls, mockHre } = createMockHre({
      bridgeGovernance: deployer,
      depositRevealAheadPeriod: toBigInt("1296000"),
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
      depositRevealAheadPeriod: toBigInt("1296000"),
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
      depositRevealAheadPeriod: toBigInt("21945600"),
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
    const { executeCalls, logs, mockHre } = createMockHre({
      bridgeGovernance,
      depositRevealAheadPeriod: toBigInt("12960000") + 1n,
      pendingUpdate: {
        newDepositRevealAheadPeriod: toBigInt("100"),
        timestamp: toBigInt("1000"),
      },
    })

    let error: Error | undefined
    try {
      await func(mockHre)
    } catch (caught) {
      error = caught as Error
    }

    expect(error?.message).to.equal(
      "Deposit reveal-ahead period update is already pending (pending value 100 does not match target 12960000)"
    )
    expect(executeCalls).to.be.empty
    expect(logs).to.deep.equal([
      "Pending deposit reveal-ahead period update: new value 100, start timestamp 1000, ETA 173800",
    ])
  })

  it("throws without warning when pending deposit reveal-ahead period update matches target", async () => {
    const { executeCalls, logs, mockHre } = createMockHre({
      bridgeGovernance,
      depositRevealAheadPeriod: toBigInt("12960000") + 1n,
      pendingUpdate: {
        newDepositRevealAheadPeriod: DEPOSIT_REVEAL_AHEAD_PERIOD,
        timestamp: toBigInt("1000"),
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
    expect(executeCalls).to.be.empty
    expect(logs).to.deep.equal([
      "Pending deposit reveal-ahead period update: new value 12960000, start timestamp 1000, ETA 173800",
    ])
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
