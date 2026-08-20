import { expect } from "chai"

import { assertReservationRouterNotSilentlyShipped } from "../../deploy/85_deploy_tip109_governance_upgrade"

describe("assertReservationRouterNotSilentlyShipped", () => {
  const bridgeAbiWithSetReservationRouter = [
    {
      type: "function",
      name: "setReservationRouter",
    },
  ]
  const bridgeAbiWithInitializeV6 = [
    {
      type: "function",
      name: "initializeV6_SetReservationRouter",
    },
  ]
  const bridgeAbiWithNeither = [
    {
      type: "function",
      name: "initializeV5_RepairRebateStaking",
    },
  ]

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

  // Shared by both deploy scripts 85 (`upgradeAndCall` shipping an
  // unrelated inner call) and 86 (a bare `upgrade()`); the two call sites
  // differ only in the `upgradeShape` string, so this test exercises the
  // guard once for both scripts instead of duplicating a mock deploy
  // harness per script.
  it("should throw when the compiled Bridge ABI includes setReservationRouter and no ack env var is set", () => {
    expect(() =>
      assertReservationRouterNotSilentlyShipped(
        { abi: bridgeAbiWithSetReservationRouter },
        "a bare `ProxyAdmin.upgrade()` with no initializer call"
      )
    ).to.throw(/UTXO-reservation router wiring/)
  })

  it("should throw when the compiled Bridge ABI includes initializeV6_SetReservationRouter and no ack env var is set", () => {
    expect(() =>
      assertReservationRouterNotSilentlyShipped(
        { abi: bridgeAbiWithInitializeV6 },
        "a bare `ProxyAdmin.upgrade()` with no initializer call"
      )
    ).to.throw(/UTXO-reservation router wiring/)
  })

  it("should embed the caller-supplied upgrade shape in the thrown error", () => {
    expect(() =>
      assertReservationRouterNotSilentlyShipped(
        { abi: bridgeAbiWithInitializeV6 },
        "a `ProxyAdmin.upgradeAndCall()` whose inner call is " +
          "`initializeV5_RepairRebateStaking`, which does not wire the " +
          "router either"
      )
    ).to.throw(/initializeV5_RepairRebateStaking/)
  })

  it("should not throw when the ack env var is set to true", () => {
    process.env.DEPLOY_TIP109_ACK_RESERVATION_ROUTER = "true"
    expect(() =>
      assertReservationRouterNotSilentlyShipped(
        { abi: bridgeAbiWithSetReservationRouter },
        "a bare `ProxyAdmin.upgrade()` with no initializer call"
      )
    ).to.not.throw()
  })

  it("should not throw when the compiled Bridge ABI has neither router-wiring function", () => {
    expect(() =>
      assertReservationRouterNotSilentlyShipped(
        { abi: bridgeAbiWithNeither },
        "a bare `ProxyAdmin.upgrade()` with no initializer call"
      )
    ).to.not.throw()
  })
})
