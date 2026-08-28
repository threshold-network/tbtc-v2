import { assert } from "chai"

import func from "../deploy_l1/01_upgrade_arbitrum_l1_bitcoin_depositor_to_v2"

describe("UpgradeArbitrumL1BitcoinDepositorToV2 verification", () => {
  it("uses empty constructor args for implementation verification", async () => {
    const verifyCalls: Array<{ taskName: string; args: unknown }> = []
    const getNamedSigners = async () => ({ deployer: {} as unknown })
    const getDeployment = async () =>
      ({
        address: "0x1111111111111111111111111111111111111111",
        args: ["stale-proxy-arg"],
      } as unknown)
    const getContractFactory = async () => ({} as unknown)
    const prepareUpgrade = async () =>
      "0x2222222222222222222222222222222222222222"
    const encodeFunctionData = () => "0xdeadbeef"
    const getInstance = async () =>
      ({
        owner: async () => "0x3333333333333333333333333333333333333333",
        address: "0x4444444444444444444444444444444444444444",
        interface: { encodeFunctionData },
      } as unknown)
    const saveDeployment = async () => undefined
    const readArtifactSync = () => ({ abi: [] } as unknown)
    const run = async (taskName: string, args: unknown) => {
      verifyCalls.push({ taskName, args })
    }

    const hre = {
      ethers: { getContractFactory },
      helpers: { signers: { getNamedSigners } },
      deployments: {
        get: getDeployment,
        log: () => undefined,
        save: saveDeployment,
      },
      upgrades: { prepareUpgrade, admin: { getInstance } },
      artifacts: { readArtifactSync },
      run,
    } as unknown

    await func(hre as Parameters<typeof func>[0])

    const firstCall = verifyCalls[0] as {
      taskName: string
      args: { address: string; constructorArgsParams: unknown[] }
    }

    assert.equal(verifyCalls.length, 1)
    assert.equal(firstCall.taskName, "verify")
    assert.equal(
      firstCall.args.address,
      "0x2222222222222222222222222222222222222222"
    )
    assert.deepEqual(firstCall.args.constructorArgsParams, [])
  })
})
