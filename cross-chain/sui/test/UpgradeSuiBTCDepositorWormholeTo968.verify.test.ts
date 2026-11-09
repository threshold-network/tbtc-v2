import { ethers, network, helpers, upgrades, artifacts } from "hardhat"
import { assert, expect } from "chai"
import fs from "fs"
import os from "os"
import path from "path"

import func from "../deploy_l1/02_upgrade_sui_btc_depositor_to_968"

// -------------------------------------------------------------------
// Mainnet-fork regression harness for the Sui L1 Bitcoin Depositor
// (BTCDepositorWormhole) upgrade-in-place, plus calldata-shape
// characterization of the deploy script.
//
// Two orthogonal footguns are guarded:
//
//   1. Wrong VERSION. Sui resolves its implementation from the shared
//      `BTCDepositorWormhole`, which historically was compiled from the
//      published `@keep-network/tbtc-v2` npm package (pre-best-effort). The
//      best-effort tx-max-fee branch adds the event
//      `DepositTxMaxFeeReimbursementSkipped` and a balance-gated path in
//      `finalizeDeposit`; the pre-best-effort build lacks both. Presence is
//      checked via the staged artifact ABI; the upgraded proxy must also land
//      on a NEW implementation address distinct from the current one.
//
//   2. Storage integrity. A plain transparent `upgrade(address,address)`
//      must leave application storage untouched. The fork suite reads the
//      `destinationChainId` / `destinationChainWormholeGateway` getters before
//      and after the simulated upgrade and asserts they are unchanged.
//
// The fork contexts are gated on `FORKING_URL`; without it Hardhat runs an
// in-memory chain where the real proxy does not exist, so the fork suite is
// skipped rather than spuriously failing. The calldata-shape and ABI-presence
// assertions need no fork.
// -------------------------------------------------------------------

const CONTRACT_NAME = "BTCDepositorWormhole"
const DEPLOYMENT_NAME = "SuiBTCDepositorWormhole"

// Live Sui L1 depositor mainnet addresses. Hard-coding them is intentional:
// the regression asserts the live deployment specifically, not a clone.
const PROXY_ADDRESS = "0xb810AbD43d8FCFD812d6FEB14fefc236E92a341A"
// Current on-chain implementation (also the pre-best-effort build). The
// upgrade MUST land on a different address than this.
const CURRENT_IMPLEMENTATION = "0x9A5250c7beA10f7472eB9d50bB757B83d67FB5ED"

// EIP-1967 implementation slot:
//   bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

const isForking = !!process.env.FORKING_URL

// Patch ethers v5 Formatter to tolerate the empty-string `to` field some RPC
// providers return for contract-creation receipts. Mirrors the deploy script;
// without it `prepareUpgrade` throws "invalid address" after the
// implementation is already deployed on the fork.
function patchEthersFormatter(): void {
  const { providers } = ethers
  const originalFormat = providers.Formatter.prototype.transactionResponse
  providers.Formatter.prototype.transactionResponse = function (tx: any): any {
    const patched = tx.to === "" ? { ...tx, to: null } : tx
    return originalFormat.call(this, patched)
  }
}

// `deployments.get` is read indirectly so the helper stays testable in
// isolation from the hardhat-deploy plugin surface.
async function deploymentsGet() {
  const { deployments } = await import("hardhat")
  return deployments.get(DEPLOYMENT_NAME)
}

// Deploy the best-effort implementation on the fork and simulate the
// governance `ProxyAdmin.upgrade`. Returns the new implementation address.
async function simulateUpgrade(): Promise<string> {
  patchEthersFormatter()

  const proxyDeployment = await deploymentsGet()

  const factory = await ethers.getContractFactory(CONTRACT_NAME)
  // `unsafeAllowCustomTypes` relaxes ONLY the enum/struct comparison: the
  // inherited `DepositState` enum is unchanged, but OZ cannot auto-compare
  // custom types against the recorded baseline ("insufficient data to compare
  // enums"). The overall slot-layout check stays ON; the getter assertions
  // below are the real storage-integrity guard.
  const newImplementation = (await upgrades.prepareUpgrade(
    proxyDeployment,
    factory,
    {
      kind: "transparent",
      unsafeAllowCustomTypes: true,
    }
  )) as string

  // Resolve the ProxyAdmin and its owner (a single-key EOA on mainnet, managed
  // by the Sui integration team), then impersonate it to issue the plain
  // `upgrade(proxy, newImpl)` — no `upgradeAndCall`, no re-initialization.
  const proxyAdmin = await upgrades.admin.getInstance()
  const proxyAdminOwner: string = await proxyAdmin.owner()

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [proxyAdminOwner],
  })
  await network.provider.request({
    method: "hardhat_setBalance",
    params: [proxyAdminOwner, "0x21E19E0C9BAB2400000"],
  })

  const ownerSigner = await ethers.getSigner(proxyAdminOwner)
  await proxyAdmin
    .connect(ownerSigner)
    .upgrade(PROXY_ADDRESS, newImplementation)

  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [proxyAdminOwner],
  })

  return newImplementation
}

const describeFork = isForking ? describe : describe.skip
describeFork(
  "UpgradeSuiBTCDepositorWormholeTo968 - mainnet fork regression",
  () => {
    const { createSnapshot, restoreSnapshot } = helpers.snapshot

    let beforeChainId: number
    let beforeGateway: string
    let newImplementation: string

    before(async () => {
      await createSnapshot()

      const proxy = await ethers.getContractAt(CONTRACT_NAME, PROXY_ADDRESS)
      beforeChainId = await proxy.destinationChainId()
      beforeGateway = await proxy.destinationChainWormholeGateway()

      newImplementation = await simulateUpgrade()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("preserves the destinationChainId getter value across the simulated upgrade", async () => {
      const proxy = await ethers.getContractAt(CONTRACT_NAME, PROXY_ADDRESS)
      const afterChainId = await proxy.destinationChainId()

      expect(afterChainId).to.equal(beforeChainId)
    })

    it("preserves the destinationChainWormholeGateway getter value across the simulated upgrade", async () => {
      const proxy = await ethers.getContractAt(CONTRACT_NAME, PROXY_ADDRESS)
      const afterGateway = await proxy.destinationChainWormholeGateway()

      expect(afterGateway).to.equal(beforeGateway)
    })

    it("advances the implementation slot to a new address distinct from the current one", async () => {
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
  }
)

describe("UpgradeSuiBTCDepositorWormholeTo968 - staged artifact", () => {
  type AbiEntry = { type?: string; name?: string }

  const stagedArtifactPath = path.resolve(
    __dirname,
    "../build/contracts/BTCDepositorWormhole.sol",
    "BTCDepositorWormhole.json"
  )

  function getEventNames(abi: AbiEntry[]): string[] {
    return abi.flatMap((entry) =>
      entry.type === "event" && typeof entry.name === "string"
        ? [entry.name]
        : []
    )
  }

  it("includes the best-effort skip event in the staged implementation ABI", async () => {
    // The deploy script stages the implementation artifact from the solidity
    // package build via the `copyBTCDepositorWormholeArtifact` post-compile
    // hook. The best-effort event MUST be present in that staged ABI; its
    // absence means the staged build predates the best-effort change and the
    // script would re-deploy the current on-chain (pre-best-effort) bytecode.
    const raw = await fs.promises.readFile(stagedArtifactPath, "utf8")
    const artifact = JSON.parse(raw) as { abi: AbiEntry[] }
    const eventNames = getEventNames(artifact.abi)

    assert.include(eventNames, "DepositTxMaxFeeReimbursementSkipped")
  })

  it("resolves the same event through the Hardhat artifact reader", () => {
    const artifact = artifacts.readArtifactSync(CONTRACT_NAME)
    const eventNames = getEventNames(artifact.abi as AbiEntry[])

    assert.include(eventNames, "DepositTxMaxFeeReimbursementSkipped")
  })
})

describe("UpgradeSuiBTCDepositorWormholeTo968 - calldata shape", () => {
  it("verifies the implementation with empty constructor args and emits upgrade(address,address)", async () => {
    const verifyCalls: Array<{ taskName: string; args: unknown }> = []
    const encodeCalls: Array<{ fn: string; values: unknown[] }> = []

    const newImplementationAddress =
      "0x2222222222222222222222222222222222222222"
    const proxyAddress = "0x1111111111111111111111111111111111111111"
    const proxyAdminAddress = "0x4444444444444444444444444444444444444444"
    const proxyAdminOwnerAddress = "0x3333333333333333333333333333333333333333"
    const networkName = "mainnet"
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "tbtc-968-sui-calldata-")
    )

    // OpenZeppelin ProxyAdmin's plain upgrade entrypoint. The script must
    // encode THIS selector, never `upgradeAndCall` (which would re-run an
    // initializer).
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
        owner: async () => proxyAdminOwnerAddress,
        address: proxyAdminAddress,
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
      network: { name: networkName },
      config: { paths: { root: tmpRoot } },
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

    // Durable governance-calldata artifact. See the corresponding Arbitrum
    // test for the rationale; shape is asserted identically across rails.
    const calldataPath = path.join(
      tmpRoot,
      "governance-calldata",
      "968-SuiBTCDepositorWormhole.json"
    )
    assert.equal(fs.existsSync(calldataPath), true)
    const calldataPayload = JSON.parse(fs.readFileSync(calldataPath, "utf8"))
    const expectedUpgradeData = proxyAdminInterface.encodeFunctionData(
      "upgrade",
      [proxyAddress, newImplementationAddress]
    )
    assert.deepEqual(calldataPayload, {
      network: networkName,
      contract: "BTCDepositorWormhole",
      proxy: proxyAddress,
      newImpl: newImplementationAddress,
      proxyAdmin: proxyAdminAddress,
      proxyAdminOwner: proxyAdminOwnerAddress,
      upgradeTx: {
        from: proxyAdminOwnerAddress,
        to: proxyAdminAddress,
        data: expectedUpgradeData,
      },
    })

    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })
})

// Skip-guard surface. Two axes are guarded: (1) the script runs only on
// mainnet, never auto-executing against hardhat/sepolia during a full deploy;
// (2) an in-file `ALREADY_EXECUTED` sentinel must be flipped to `true` after
// the Sui-integration team's EOA broadcasts the upgrade, so a second mainnet
// run does not deploy a fresh implementation and overwrite the deployment
// artifact. The mainnet expectation below intentionally fails after that
// flip — that failure is the gate that forces the post-execution checklist
// to update both the script and this test together.
describe("UpgradeSuiBTCDepositorWormholeTo968 - skip guard", () => {
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
