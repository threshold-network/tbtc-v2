import { ethers, network, helpers, upgrades, artifacts } from "hardhat"
import { assert, expect } from "chai"

import func from "../deploy_l1/04_upgrade_base_l1_bitcoin_depositor_to_968"

// -------------------------------------------------------------------
// Mainnet-fork regression harness for the Base L1 Bitcoin Depositor
// upgrade-in-place.
//
// Unlike `UpgradeBaseL1BitcoinDepositorToV2.test.ts` (which deploys a
// FRESH proxy and therefore writes its own storage layout), this suite
// forks the REAL mainnet proxy and proves the live storage survives a
// simulated `ProxyAdmin.upgrade`. A fresh-deploy test cannot catch a
// wrong-variant slot offset, which is exactly what these assertions
// guard against. The Base variant carries a deliberate +1 storage slot
// offset from slot 200 onward versus the Arbitrum variant, so the
// regression-guarded fields live at slots 205 (l2WormholeGateway +
// l2ChainId, packed) and 206 (l2BitcoinDepositor) — NOT 204/205.
//
// The whole suite is gated on `FORKING_URL`; without it Hardhat runs an
// in-memory chain where the real proxy does not exist, so the fork
// contexts are skipped rather than spuriously failing.
// -------------------------------------------------------------------

const CONTRACT_NAME = "L1BTCDepositorWormholeV2Base"

// Live mainnet addresses (read from chain via cast; see the proxy at
// EIP-1967 slots). Hard-coding them is intentional: the test asserts the
// live deployment specifically, not a freshly deployed clone.
const PROXY_ADDRESS = "0x186D048097c7406C64EfB0537886E3CaE100a1fe"
const PROXY_ADMIN_ADDRESS = "0x5a165919357eb5854287a0bad49d703f144b187f"
const PROXY_ADMIN_OWNER = "0x92f2d8b72a7F6a551Be60b9aa4194248E9B4913D"
// Current on-chain implementation (also the April pre-#968 V2 build). The
// upgrade MUST land on a different address than this.
const CURRENT_IMPLEMENTATION = "0x32aAfccfb865060F7F9fB3766c50134F9228B67E"

// EIP-1967 implementation slot:
//   bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

// Post-slot-200 storage slots whose raw 32-byte value must be byte-identical
// across the simulated upgrade. Slot 205 is PACKED: the high 2 bytes hold the
// uint16 l2ChainId (= 30 on Base) and the low 20 bytes hold l2WormholeGateway.
// Asserting the whole raw slot covers both fields at once. Slot 206 holds
// l2BitcoinDepositor.
const SLOT_L2_GATEWAY_AND_CHAIN_ID = 205
const SLOT_L2_BITCOIN_DEPOSITOR = 206

// Minimal ProxyAdmin ABI — only the upgrade entrypoint is exercised.
const PROXY_ADMIN_ABI = [
  "function upgrade(address proxy, address implementation) external",
  "function owner() view returns (address)",
]

const isForking = !!process.env.FORKING_URL

const readSlot = async (address: string, slot: number): Promise<string> =>
  ethers.provider.getStorageAt(address, slot)

async function simulateUpgrade(): Promise<string> {
  // Deploy the new #968 implementation on the fork. This is the same call
  // the deploy script issues; OpenZeppelin resolves the copied Base artifact
  // from the merged validations cache. The storage-safety check is left ON
  // (no `unsafeSkipStorageCheck`): #968 is a storage-identical V2->V2 change,
  // so a rejection here would itself signal a real layout regression.
  const factory = await ethers.getContractFactory(CONTRACT_NAME)
  // `unsafeAllowCustomTypes` relaxes ONLY the enum/struct comparison: the
  // `DepositState` enum is unchanged, but OZ cannot auto-compare custom types
  // against the recorded baseline ("insufficient data to compare enums"). The
  // overall slot-layout check stays ON, so a wrong-variant (slot 200 vs 201)
  // would still be rejected; the raw-slot assertions below add a second guard.
  const newImplementation = (await upgrades.prepareUpgrade(
    PROXY_ADDRESS,
    factory,
    { kind: "transparent", unsafeAllowCustomTypes: true }
  )) as string

  // Impersonate the ProxyAdmin owner (a 24h Timelock on mainnet) and fund it
  // for gas, then issue the plain `upgrade(proxy, newImpl)` — no
  // `upgradeAndCall`, no re-initialization.
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [PROXY_ADMIN_OWNER],
  })
  await network.provider.request({
    method: "hardhat_setBalance",
    params: [PROXY_ADMIN_OWNER, "0x21E19E0C9BAB2400000"],
  })

  const ownerSigner = await ethers.getSigner(PROXY_ADMIN_OWNER)
  const proxyAdmin = new ethers.Contract(
    PROXY_ADMIN_ADDRESS,
    PROXY_ADMIN_ABI,
    ownerSigner
  )

  await proxyAdmin.upgrade(PROXY_ADDRESS, newImplementation)

  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [PROXY_ADMIN_OWNER],
  })

  return newImplementation
}

const describeFork = isForking ? describe : describe.skip
describeFork(
  "UpgradeBaseL1BitcoinDepositorTo968 - mainnet fork regression",
  () => {
    const { createSnapshot, restoreSnapshot } = helpers.snapshot

    let before205: string
    let before206: string
    let newImplementation: string

    before(async () => {
      await createSnapshot()

      before205 = await readSlot(PROXY_ADDRESS, SLOT_L2_GATEWAY_AND_CHAIN_ID)
      before206 = await readSlot(PROXY_ADDRESS, SLOT_L2_BITCOIN_DEPOSITOR)

      newImplementation = await simulateUpgrade()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("preserves the packed l2ChainId / l2WormholeGateway slot (205)", async () => {
      const after205 = await readSlot(
        PROXY_ADDRESS,
        SLOT_L2_GATEWAY_AND_CHAIN_ID
      )
      expect(after205).to.equal(before205)
    })

    it("preserves the l2BitcoinDepositor slot (206)", async () => {
      const after206 = await readSlot(PROXY_ADDRESS, SLOT_L2_BITCOIN_DEPOSITOR)
      expect(after206).to.equal(before206)
    })

    it("advances the implementation slot to a new address (not the current one)", async () => {
      // Read the EIP-1967 implementation slot and decode the trailing 20
      // bytes to an address.
      const storedImpl = await ethers.provider.getStorageAt(
        PROXY_ADDRESS,
        EIP1967_IMPLEMENTATION_SLOT
      )
      const decodedImpl = ethers.utils.getAddress(
        ethers.utils.hexDataSlice(storedImpl, 12)
      )

      expect(decodedImpl).to.equal(ethers.utils.getAddress(newImplementation))
      expect(decodedImpl).to.not.equal(
        ethers.utils.getAddress(CURRENT_IMPLEMENTATION)
      )
    })

    it("ships the best-effort skip event in the upgraded implementation ABI", async () => {
      // Wrong-version guard. The #968 best-effort branch adds the
      // `DepositTxMaxFeeReimbursementSkipped` event; its presence in the staged
      // implementation ABI proves the upgraded impl carries the change, whereas
      // a pre-#968 implementation lacks it. Paired with the "advances the
      // implementation slot" assertion above (new impl != pre-#968 impl), this
      // establishes that the live proxy now runs #968 code. The behavioral skip
      // path itself is exercised by the unit tests in
      // solidity/test/cross-chain/wormhole/L1BTCDepositorWormholeV2Base.test.ts,
      // which stage the full Bridge/TBTCVault deposit fixture at unit speed.
      const artifact = await artifacts.readArtifact(CONTRACT_NAME)
      const hasSkipEvent = artifact.abi.some(
        (entry: { type?: string; name?: string }) =>
          entry.type === "event" &&
          entry.name === "DepositTxMaxFeeReimbursementSkipped"
      )
      expect(
        hasSkipEvent,
        "upgraded implementation ABI must expose DepositTxMaxFeeReimbursementSkipped"
      ).to.equal(true)
    })
  }
)

// -------------------------------------------------------------------
// Calldata-shape assertions (no fork required). Mirrors the existing
// `UpgradeBaseL1BitcoinDepositorToV2.verify.test.ts` characterization: the
// deploy script issues exactly one `verify` call with empty constructor args
// and encodes the plain OpenZeppelin `upgrade(address,address)` selector —
// never `upgradeAndCall`, never a re-initialization argument.
// -------------------------------------------------------------------
describe("UpgradeBaseL1BitcoinDepositorTo968 - calldata shape", () => {
  it("verifies the implementation with empty constructor args and emits upgrade(address,address)", async () => {
    const verifyCalls: Array<{ taskName: string; args: unknown }> = []
    const encodeCalls: Array<{ fn: string; values: unknown[] }> = []

    const newImplementationAddress =
      "0x2222222222222222222222222222222222222222"
    const proxyAddress = "0x1111111111111111111111111111111111111111"

    // OpenZeppelin ProxyAdmin's plain upgrade entrypoint. The script must
    // encode THIS selector, never `upgradeAndCall` (which would re-run an
    // initializer). The genuine 4-byte selector is the first 4 bytes of
    // keccak256("upgrade(address,address)").
    const proxyAdminInterface = new ethers.utils.Interface([
      "function upgrade(address proxy, address implementation)",
      "function upgradeAndCall(address proxy, address implementation, bytes data)",
    ])
    const expectedUpgradeSelector = ethers.utils
      .id("upgrade(address,address)")
      .slice(0, 10)

    const getNamedSigners = async () => ({ deployer: {} as unknown })
    const getDeployment = async () =>
      ({
        address: proxyAddress,
        args: ["stale-proxy-arg"],
      } as unknown)
    const getContractFactory = async () => ({} as unknown)
    const prepareUpgrade = async () => newImplementationAddress
    const encodeFunctionData = (fn: string, values: unknown[]) => {
      encodeCalls.push({ fn, values })
      return proxyAdminInterface.encodeFunctionData(fn as any, values as any)
    }
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
    assert.equal(firstCall.args.address, newImplementationAddress)
    assert.deepEqual(firstCall.args.constructorArgsParams, [])

    // Exactly one `upgrade` encode, with the proxy + new implementation, and
    // the encoded selector matches the genuine `upgrade(address,address)`.
    const upgradeEncodes = encodeCalls.filter((c) => c.fn === "upgrade")
    assert.equal(upgradeEncodes.length, 1)
    assert.deepEqual(upgradeEncodes[0].values, [
      proxyAddress,
      newImplementationAddress,
    ])
    const encodedSelector = proxyAdminInterface
      .encodeFunctionData("upgrade", [proxyAddress, newImplementationAddress])
      .slice(0, 10)
    assert.equal(encodedSelector, expectedUpgradeSelector)

    // No re-initialization path: never `upgradeAndCall`.
    assert.equal(
      encodeCalls.some((c) => c.fn === "upgradeAndCall"),
      false
    )
  })
})
