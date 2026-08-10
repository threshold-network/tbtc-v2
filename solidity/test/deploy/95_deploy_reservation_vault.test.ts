/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"

import { equal } from "@keep-network/hardhat-helpers/dist/address"
import { transferOwnership } from "@keep-network/hardhat-helpers/dist/ownable"

import func from "../../deploy/95_deploy_reservation_vault"

describe("Deploy Script 95: ReservationVault", () => {
  const deployer = "0x1000000000000000000000000000000000000001"
  const governance = "0x2000000000000000000000000000000000000002"
  const bank = "0x3000000000000000000000000000000000000003"
  const tbtcVault = "0x4000000000000000000000000000000000000004"
  const bridge = "0x5000000000000000000000000000000000000005"
  const reservationVault = "0x6000000000000000000000000000000000000006"

  function createMockHre({ failVerification = false, etherscan = true } = {}) {
    let currentOwner = deployer
    let verificationShouldFail = failVerification

    const getCalls: string[] = []
    const deployCalls: Array<{ name: string; options: any }> = []
    const executeCalls: Array<{
      name: string
      methodName: string
      args: any[]
    }> = []
    const verifyCalls: any[] = []

    const deploymentsByName: Record<string, { address: string }> = {
      Bank: { address: bank },
      TBTCVault: { address: tbtcVault },
      Bridge: { address: bridge },
    }

    const mockHre: any = {
      deployments: {
        get: async (name: string) => {
          getCalls.push(name)
          return deploymentsByName[name]
        },
        deploy: async (name: string, options: any) => {
          deployCalls.push({ name, options })
          return { address: reservationVault, newlyDeployed: false }
        },
        read: async () => currentOwner,
        execute: async (
          name: string,
          _options: any,
          methodName: string,
          ...args: any[]
        ) => {
          if (currentOwner !== deployer) {
            throw new Error("Ownable: caller is not the owner")
          }
          executeCalls.push({ name, methodName, args })
          const [newOwner] = args
          currentOwner = newOwner
          return {}
        },
        log: () => undefined,
      },
      getNamedAccounts: async () => ({ deployer, governance }),
      helpers: {
        address: { equal },
        etherscan: {
          verify: async (deployment: any) => {
            verifyCalls.push(deployment)
            if (verificationShouldFail) {
              throw new Error("mock verification failure")
            }
          },
        },
      },
      network: { tags: { etherscan } },
    }

    mockHre.helpers.ownable = {
      transferOwnership: (
        contractName: string,
        newOwnerAddress: string,
        from: string
      ) => transferOwnership(mockHre, contractName, newOwnerAddress, from),
    }

    return {
      mockHre,
      getCalls,
      deployCalls,
      executeCalls,
      verifyCalls,
      owner: () => currentOwner,
      setVerificationFailure: (value: boolean) => {
        verificationShouldFail = value
      },
    }
  }

  it("does not recursively execute the Bridge deployment", () => {
    expect(func.dependencies).to.deep.equal(["Bank", "TBTCVault"])
  })

  it("reads the existing Bridge address for the vault constructor", async () => {
    const harness = createMockHre({ etherscan: false })

    await func(harness.mockHre)

    expect(harness.getCalls).to.deep.equal(["Bank", "TBTCVault", "Bridge"])
    expect(harness.deployCalls).to.have.lengthOf(1)
    expect(harness.deployCalls[0]).to.deep.equal({
      name: "ReservationVault",
      options: {
        from: deployer,
        args: [bank, tbtcVault, bridge],
        log: true,
        waitConfirmations: 1,
      },
    })
  })

  it("resumes after ownership transfer when verification failed", async () => {
    const harness = createMockHre({ failVerification: true })

    let firstRunError: Error | undefined
    try {
      await func(harness.mockHre)
    } catch (error) {
      firstRunError = error as Error
    }

    expect(firstRunError?.message).to.equal("mock verification failure")
    expect(harness.owner()).to.equal(governance)
    expect(harness.executeCalls).to.have.lengthOf(1)
    expect(harness.executeCalls[0]).to.deep.equal({
      name: "ReservationVault",
      methodName: "transferOwnership",
      args: [governance],
    })

    harness.setVerificationFailure(false)
    await func(harness.mockHre)

    expect(harness.owner()).to.equal(governance)
    expect(harness.executeCalls).to.have.lengthOf(1)
    expect(harness.verifyCalls).to.have.lengthOf(2)
  })
})
