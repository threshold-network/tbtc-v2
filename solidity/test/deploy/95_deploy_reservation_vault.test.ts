/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"
import func from "../../deploy/95_deploy_reservation_vault"

describe("Deploy Script 95: ReservationVault", () => {
  const deployer = "0x1234567890123456789012345678901234567890"
  const bank = "0x0000000000000000000000000000000000000001"
  const tbtcVault = "0x0000000000000000000000000000000000000002"
  const bridge = "0x0000000000000000000000000000000000000003"
  const reservationVault = "0x0000000000000000000000000000000000000004"

  it("declares the Bridge as a dependency so it deploys before the vault", () => {
    // The vault constructor and this script both read the deployed Bridge
    // address directly, so running `--tags ReservationVault` on a network
    // without an existing Bridge must resolve it via hardhat-deploy's
    // dependency-ordering rather than failing inside `deployments.get`.
    expect(func.dependencies).to.deep.equal(["Bank", "TBTCVault", "Bridge"])
  })

  it("reads the existing Bridge address for the vault constructor", async () => {
    const getCalls: string[] = []
    const deployCalls: Array<{ name: string; options: any }> = []
    const addresses: Record<string, string> = {
      Bank: bank,
      TBTCVault: tbtcVault,
      Bridge: bridge,
    }

    const mockHre: any = {
      deployments: {
        get: async (name: string) => {
          getCalls.push(name)
          return { address: addresses[name] }
        },
        deploy: async (name: string, options: any) => {
          deployCalls.push({ name, options })
          return { address: reservationVault }
        },
      },
      getNamedAccounts: async () => ({ deployer }),
      helpers: {
        etherscan: {
          verify: async () => undefined,
        },
      },
      network: { tags: {} },
    }

    await func(mockHre)

    expect(getCalls).to.deep.equal(["Bank", "TBTCVault", "Bridge"])
    expect(deployCalls).to.have.lengthOf(1)
    expect(deployCalls[0]).to.deep.equal({
      name: "ReservationVault",
      options: {
        from: deployer,
        args: [bank, tbtcVault, bridge],
        log: true,
        waitConfirmations: 1,
      },
    })
  })
})
