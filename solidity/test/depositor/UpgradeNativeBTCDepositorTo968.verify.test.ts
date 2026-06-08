import { assert } from "chai"

// The deploy script under test does not exist yet; this import binds the test
// to the deliverable. Until the script is authored the import throws
// "Cannot find module", which is the intended failure for these assertions.
import func from "../../deploy/44_upgrade_native_btc_depositor_to_968"

// The Native transparent proxy under upgrade (unchanged across the swap).
const NATIVE_PROXY = "0xad7c6d46F4a4bc2D3A227067d03218d6D7c9aaa5"
// The real on-chain ProxyAdmin for the Native proxy (EIP-1967 admin slot).
const NATIVE_PROXY_ADMIN = "0x92FcBD0b9D22bd2659c09A9aCD6E645F228b9A21"
// ProxyAdmin.owner() — the Council Safe that must execute the upgrade.
const PROXY_ADMIN_OWNER = "0x9F6e831c8F8939DC0C830C6e492e7cEf4f9C2F5f"
// The OpenZeppelin plugin's manifest-wide default ProxyAdmin. Resolving the
// ProxyAdmin through `upgrades.admin.getInstance()` returns THIS address for
// the Native rail, not the real on-chain admin above; the script must avoid it.
const PLUGIN_DEFAULT_PROXY_ADMIN = "0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706"
// Canned address the mocked prepareUpgrade returns for the new implementation.
const NEW_IMPLEMENTATION = "0x2222222222222222222222222222222222222222"

describe("UpgradeNativeBTCDepositorTo968 verification", () => {
  it("emits upgrade(address,address) calldata to the explicit ProxyAdmin and verifies with empty constructor args", async () => {
    const callOrder: string[] = []
    const verifyCalls: Array<{ taskName: string; args: unknown }> = []
    const encodeFunctionDataCalls: Array<{
      fragment: string
      values: unknown[]
    }> = []
    let getInstanceCalled = false
    let deploymentsGetCalled = false

    const getNamedSigners = async () => ({ deployer: {} as unknown })

    const getContractFactory = async () => ({} as unknown)

    // The explicitly-resolved ProxyAdmin must surface the REAL on-chain admin
    // address and owner so the emitted calldata targets governance correctly.
    const proxyAdminInstance = {
      address: NATIVE_PROXY_ADMIN,
      owner: async () => PROXY_ADMIN_OWNER,
      interface: {
        encodeFunctionData: (fragment: string, values: unknown[]) => {
          encodeFunctionDataCalls.push({ fragment, values })
          return "0xdeadbeef"
        },
      },
    }

    // `getContractAt("ProxyAdmin", <addr>)` is the explicit resolution path the
    // script must use instead of `upgrades.admin.getInstance()`.
    const getContractAt = async (name: string, address: string) => {
      assert.equal(name, "ProxyAdmin")
      assert.equal(address, NATIVE_PROXY_ADMIN)
      return proxyAdminInstance as unknown
    }

    const forceImport = async (proxy: string, _factory: unknown, opts: any) => {
      callOrder.push("forceImport")
      assert.equal(proxy, NATIVE_PROXY)
      assert.equal(opts.kind, "transparent")
      return undefined
    }

    const prepareUpgrade = async (
      proxy: string,
      _factory: unknown,
      opts: any
    ) => {
      callOrder.push("prepareUpgrade")
      assert.equal(proxy, NATIVE_PROXY)
      assert.equal(opts.kind, "transparent")
      return NEW_IMPLEMENTATION
    }

    // Resolving through the plugin returns the WRONG admin for Native. The
    // script must NOT use this; tracking the call lets the test fail loudly if
    // a future edit regresses to `getInstance()`.
    const getInstance = async () => {
      getInstanceCalled = true
      return {
        address: PLUGIN_DEFAULT_PROXY_ADMIN,
        owner: async () => PROXY_ADMIN_OWNER,
        interface: { encodeFunctionData: () => "0xbadbad" },
      } as unknown
    }

    // Native has NO committed deployment artifact; the script must take the
    // proxy literally and never call `deployments.get`.
    const getDeployment = async () => {
      deploymentsGetCalled = true
      throw new Error("deployments.get must not be called for Native")
    }

    const saveDeployment = async () => undefined
    const readArtifactSync = () => ({ abi: [] } as unknown)
    const run = async (taskName: string, args: unknown) => {
      verifyCalls.push({ taskName, args })
    }

    const hre = {
      ethers: { getContractFactory, getContractAt },
      helpers: { signers: { getNamedSigners } },
      deployments: {
        get: getDeployment,
        log: () => undefined,
        save: saveDeployment,
      },
      upgrades: { forceImport, prepareUpgrade, admin: { getInstance } },
      artifacts: { readArtifactSync },
      run,
    } as unknown

    await func(hre as Parameters<typeof func>[0])

    // AC-G4: verify called exactly once with empty constructor args.
    assert.equal(verifyCalls.length, 1, "verify should be called exactly once")
    const firstCall = verifyCalls[0] as {
      taskName: string
      args: { address: string; constructorArgsParams: unknown[] }
    }
    assert.equal(firstCall.taskName, "verify")
    assert.equal(firstCall.args.address, NEW_IMPLEMENTATION)
    assert.deepEqual(firstCall.args.constructorArgsParams, [])

    // AC-G3: emitted selector is `upgrade(address,address)`, never
    // `upgradeAndCall`, with the proxy and new implementation as arguments.
    assert.equal(
      encodeFunctionDataCalls.length,
      1,
      "calldata should be encoded exactly once"
    )
    assert.equal(encodeFunctionDataCalls[0].fragment, "upgrade")
    assert.deepEqual(encodeFunctionDataCalls[0].values, [
      NATIVE_PROXY,
      NEW_IMPLEMENTATION,
    ])

    // AC-N1: forceImport must run BEFORE prepareUpgrade.
    assert.isAtLeast(
      callOrder.indexOf("prepareUpgrade"),
      0,
      "prepareUpgrade should be called"
    )
    assert.isBelow(
      callOrder.indexOf("forceImport"),
      callOrder.indexOf("prepareUpgrade"),
      "forceImport must precede prepareUpgrade"
    )

    // AC-N1: ProxyAdmin resolved explicitly to the on-chain admin, never via
    // the plugin default through `getInstance()`.
    assert.isFalse(
      getInstanceCalled,
      "upgrades.admin.getInstance() must not be used for Native"
    )

    // AC-N1: no committed artifact, so `deployments.get` must never run.
    assert.isFalse(
      deploymentsGetCalled,
      "deployments.get must not be called for Native"
    )
  })
})

// Skip-guard surface. Two axes are guarded: (1) the script runs only on
// mainnet, never auto-executing against hardhat/sepolia during a full deploy;
// (2) an in-file `ALREADY_EXECUTED` sentinel must be flipped to `true` after
// the Council Safe broadcasts the upgrade, so a second mainnet run does not
// deploy a fresh implementation and overwrite the deployment artifact. The
// mainnet expectation below intentionally fails after that flip — that
// failure is the gate that forces the post-execution checklist to update
// both the script and this test together.
describe("UpgradeNativeBTCDepositorTo968 - skip guard", () => {
  type SkipHre = Parameters<NonNullable<typeof func.skip>>[0]

  it("defines func.skip", () => {
    assert.isFunction(func.skip)
  })

  it("skips on hardhat (no auto-run during a full deploy)", async () => {
    const skipped = await func.skip!({
      network: { name: "hardhat" },
    } as unknown as SkipHre)
    assert.equal(skipped, true)
  })

  it("skips on sepolia (no auto-run during a full deploy)", async () => {
    const skipped = await func.skip!({
      network: { name: "sepolia" },
    } as unknown as SkipHre)
    assert.equal(skipped, true)
  })

  it("runs on mainnet while ALREADY_EXECUTED is false", async () => {
    const skipped = await func.skip!({
      network: { name: "mainnet" },
    } as unknown as SkipHre)
    assert.equal(skipped, false)
  })
})
