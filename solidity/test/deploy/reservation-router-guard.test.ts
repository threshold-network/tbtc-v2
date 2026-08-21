import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import { utils, constants } from "ethers"

import {
  assertReservationRouterNotSilentlyShipped,
  encodeBridgeUpgradeAndCall,
} from "../../deploy/85_deploy_tip109_governance_upgrade"

chai.use(chaiAsPromised)

const PROXY_ADMIN_ABI = [
  "function upgrade(address proxy, address implementation)",
  "function upgradeAndCall(address proxy, address implementation, bytes data)",
]
const proxyAdminInterface = new utils.Interface(PROXY_ADMIN_ABI)

function encodeBareUpgrade(proxy: string, newImpl: string): string {
  return proxyAdminInterface.encodeFunctionData("upgrade", [proxy, newImpl])
}

/** A fake address for the Wire-the-router-in-this-upgrade positive case. */
const BRIDGE_PROXY = "0x1111111111111111111111111111111111111111"
const NEW_IMPL = "0x2222222222222222222222222222222222222222"
const WIRED_ROUTER = "0x3333333333333333333333333333333333333333"

/**
 * Decodes an address from the raw `getReservationRouter` return. A
 * non-zero value means the router is already wired on-chain; a revert or a
 * zero value means it is not.
 */
const WIRED_CALL_RESULT = utils.defaultAbiCoder.encode(
  ["address"],
  [WIRED_ROUTER]
)
const NOT_WIRED_CALL_RESULT = utils.defaultAbiCoder.encode(
  ["address"],
  [constants.AddressZero]
)

function providerWith(callResult: string | "revert"): {
  call: (req: { to: string; data: string }) => Promise<string>
} {
  return {
    call: async () => {
      if (callResult === "revert") {
        throw new Error(
          "mock: call reverted (implementation predates getReservationRouter)"
        )
      }
      return callResult
    },
  }
}

describe("assertReservationRouterNotSilentlyShipped", () => {
  let originalAckEnv: string | undefined

  beforeEach(() => {
    originalAckEnv = process.env.DEPLOY_TIP109_ACK_RESERVATION_ROUTER
    delete process.env.DEPLOY_TIP109_ACK_RESERVATION_ROUTER
  })

  afterEach(() => {
    if (originalAckEnv === undefined) {
      delete process.env.DEPLOY_TIP109_ACK_RESERVATION_ROUTER
    } else {
      process.env.DEPLOY_TIP109_ACK_RESERVATION_ROUTER = originalAckEnv
    }
  })

  it("should throw when the upgrade calldata doesn't wire the router, it isn't wired on-chain, and no ack env var is set", async () => {
    // Script 85's `upgradeAndCall` inner call is
    // `initializeV5_RepairRebateStaking`, which does not wire the router.
    const upgradeCalldata = encodeBridgeUpgradeAndCall(BRIDGE_PROXY, NEW_IMPL)
    await expect(
      assertReservationRouterNotSilentlyShipped(
        BRIDGE_PROXY,
        providerWith(NOT_WIRED_CALL_RESULT),
        upgradeCalldata,
        "a `ProxyAdmin.upgradeAndCall()` whose inner call is " +
          "`initializeV5_RepairRebateStaking`, which does not wire the router " +
          "either"
      )
    ).to.be.rejectedWith(/would leave the UTXO-reservation router unwired/)
  })

  it("should embed the caller-supplied upgrade shape in the thrown error", async () => {
    const upgradeCalldata = encodeBridgeUpgradeAndCall(BRIDGE_PROXY, NEW_IMPL)
    await expect(
      assertReservationRouterNotSilentlyShipped(
        BRIDGE_PROXY,
        providerWith(NOT_WIRED_CALL_RESULT),
        upgradeCalldata,
        "a bare `ProxyAdmin.upgrade()` with no initializer call"
      )
    ).to.be.rejectedWith(/bare `ProxyAdmin.upgrade\(\)`/)
  })

  it("should not throw when the upgrade calldata itself wires the router via initializeV6", async () => {
    // A future script that really does wire the router in the same
    // `upgradeAndCall` must pass even though not currently wired.
    const initData = new utils.Interface([
      "function initializeV6_SetReservationRouter(address _reservationRouter)",
    ]).encodeFunctionData("initializeV6_SetReservationRouter", [WIRED_ROUTER])
    const upgradeCalldata = proxyAdminInterface.encodeFunctionData(
      "upgradeAndCall",
      [BRIDGE_PROXY, NEW_IMPL, initData]
    )

    await expect(
      assertReservationRouterNotSilentlyShipped(
        BRIDGE_PROXY,
        providerWith(NOT_WIRED_CALL_RESULT),
        upgradeCalldata,
        "a `ProxyAdmin.upgradeAndCall()` wiring the router"
      )
    ).to.not.be.rejected
  })

  it("should not throw when the router is already wired on-chain", async () => {
    // The distinguishing case the old ABI-presence check could never see:
    // the compiled implementation always contains the wiring functions
    // from this commit on, so the guard decides on live state -- an
    // already-wired proxy is safe to upgrade without rewiring.
    const upgradeCalldata = encodeBridgeUpgradeAndCall(BRIDGE_PROXY, NEW_IMPL)
    await expect(
      assertReservationRouterNotSilentlyShipped(
        BRIDGE_PROXY,
        providerWith(WIRED_CALL_RESULT),
        upgradeCalldata,
        "a `ProxyAdmin.upgradeAndCall()` whose inner call is " +
          "`initializeV5_RepairRebateStaking`, which does not wire the router " +
          "either"
      )
    ).to.not.be.rejected
  })

  it("should treat a reverting getReservationRouter call as not wired", async () => {
    // The current on-chain Bridge implementation predates the function.
    const upgradeCalldata = encodeBridgeUpgradeAndCall(BRIDGE_PROXY, NEW_IMPL)
    await expect(
      assertReservationRouterNotSilentlyShipped(
        BRIDGE_PROXY,
        providerWith("revert"),
        upgradeCalldata,
        "a `ProxyAdmin.upgradeAndCall()` whose inner call is " +
          "`initializeV5_RepairRebateStaking`, which does not wire the router " +
          "either"
      )
    ).to.be.rejectedWith(/would leave the UTXO-reservation router unwired/)
  })

  it("should not throw when the ack env var is set to true", async () => {
    process.env.DEPLOY_TIP109_ACK_RESERVATION_ROUTER = "true"
    const upgradeCalldata = encodeBareUpgrade(BRIDGE_PROXY, NEW_IMPL)
    await expect(
      assertReservationRouterNotSilentlyShipped(
        BRIDGE_PROXY,
        providerWith(NOT_WIRED_CALL_RESULT),
        upgradeCalldata,
        "a bare `ProxyAdmin.upgrade()` with no initializer call"
      )
    ).to.not.be.rejected
  })

  it("should detect a bare upgrade() (script 86) as not wiring the router", async () => {
    const upgradeCalldata = encodeBareUpgrade(BRIDGE_PROXY, NEW_IMPL)
    await expect(
      assertReservationRouterNotSilentlyShipped(
        BRIDGE_PROXY,
        providerWith(NOT_WIRED_CALL_RESULT),
        upgradeCalldata,
        "a bare `ProxyAdmin.upgrade()` with no initializer call"
      )
    ).to.be.rejectedWith(/unwired/)
  })
})
