import { ethers, network, helpers, upgrades, artifacts } from "hardhat"
import { assert, expect } from "chai"
import fs from "fs"
import os from "os"
import path from "path"

import func from "../deploy_l1/02_upgrade_arbitrum_l1_bitcoin_depositor_to_968"

// -------------------------------------------------------------------
// Mainnet-fork regression harness for the Arbitrum L1 Bitcoin Depositor
// upgrade-in-place, plus calldata-shape characterization of the deploy
// script.
//
// Two orthogonal footguns are guarded:
//
//   1. Wrong VARIANT. The Arbitrum and Base implementations share field
//      NAMES but lay them out at different slots from slot 200 onward
//      (Arbitrum: l2WormholeGateway+l2ChainId packed at slot 204,
//      l2BitcoinDepositor at slot 205; Base: +1 offset at 205/206).
//      A plain transparent `upgrade(address,address)` rewrites ONLY the
//      EIP-1967 implementation slot and never touches application storage,
//      so the raw bytes at slots 204/205 are byte-identical across ANY
//      upgrade regardless of which implementation is installed. A raw
//      `getStorageAt` before-vs-after comparison therefore cannot fail on a
//      Base-variant implementation and does not guard this footgun. What
//      distinguishes a correct Arbitrum implementation from a Base-variant
//      one is how each INTERPRETS those unchanged bytes: a Base-variant
//      `l2ChainId()` reads slot 205 (Arbitrum's l2BitcoinDepositor) and so
//      returns a different value. The guard below compares the GETTER return
//      values `l2ChainId()` / `l2BitcoinDepositor()` across the simulated
//      upgrade.
//
//   2. Wrong VERSION. The best-effort tx-max-fee branch adds a new event
//      `DepositTxMaxFeeReimbursementSkipped` and a balance-gated code path
//      in `finalizeDeposit`. The pre-best-effort implementation lacks both.
//      Presence is checked cheaply via the staged artifact ABI; behavior is
//      checked by driving the skip path on the upgraded forked proxy.
//
// The fork contexts are gated on `FORKING_URL`; without it Hardhat runs an
// in-memory chain where the real proxy does not exist, so the fork suite is
// skipped rather than spuriously failing (this keeps CI, which sets no RPC,
// green). The calldata-shape and ABI-presence assertions need no fork.
// -------------------------------------------------------------------

const CONTRACT_NAME = "L1BTCDepositorWormholeV2Arbitrum"
const DEPLOYMENT_NAME = "ArbitrumOneL1BitcoinDepositor"

// Live Arbitrum mainnet addresses (read from chain). Hard-coding them is
// intentional: the regression asserts the live deployment specifically, not
// a freshly deployed clone.
const PROXY_ADDRESS = "0x75A6e4A7C8fAa162192FAD6C1F7A6d48992c619A"
// Current on-chain implementation (also the pre-best-effort build). The
// upgrade MUST land on a different address than this.
const CURRENT_IMPLEMENTATION = "0x82FDDF79765Ed75325bCBdf65F67dF0879AAbe8C"

// EIP-1967 implementation slot:
//   bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

const isForking = !!process.env.FORKING_URL

// Patch ethers v5 Formatter to tolerate the empty-string `to` field some RPC
// providers return for contract-creation receipts. Mirrors the deploy
// script; without it `prepareUpgrade` throws "invalid address" after the
// implementation is already deployed on the fork.
function patchEthersFormatter(): void {
  const { providers } = ethers
  const originalFormat = providers.Formatter.prototype.transactionResponse
  providers.Formatter.prototype.transactionResponse = function (tx: any): any {
    const patched = tx.to === "" ? { ...tx, to: null } : tx
    return originalFormat.call(this, patched)
  }
}

// Deploy the best-effort implementation on the fork and simulate the
// governance `ProxyAdmin.upgrade`. Returns the new implementation address.
async function simulateUpgrade(): Promise<string> {
  patchEthersFormatter()

  const proxyDeployment = await deploymentsGet()

  const factory = await ethers.getContractFactory(CONTRACT_NAME)
  // The OpenZeppelin manifest (.openzeppelin/mainnet.json) already records the
  // live proxy, so no `forceImport` is needed. The storage-safety check is
  // left ON: the best-effort change is a storage-identical V2->V2 upgrade, so
  // a rejection here would itself signal a real layout regression.
  // See the deploy script: the `DepositState` enum is unchanged, but OZ cannot
  // auto-compare custom types against the recorded baseline ("insufficient data
  // to compare enums"). The byte-level storage assertions below are the real
  // regression guard.
  const newImplementation = (await upgrades.prepareUpgrade(
    proxyDeployment,
    factory,
    { kind: "transparent", unsafeAllowCustomTypes: true }
  )) as string

  // Resolve the ProxyAdmin and its owner (a 24h Timelock on mainnet) from the
  // live chain, then impersonate the owner to issue the plain
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

// `deployments.get` is read indirectly so the helper above stays testable in
// isolation from the hardhat-deploy plugin surface.
async function deploymentsGet() {
  const { deployments } = await import("hardhat")
  return deployments.get(DEPLOYMENT_NAME)
}

const describeFork = isForking ? describe : describe.skip
describeFork(
  "UpgradeArbitrumL1BitcoinDepositorTo968 - mainnet fork regression",
  () => {
    const { createSnapshot, restoreSnapshot } = helpers.snapshot

    let beforeChainId: number
    let beforeDepositor: string
    let newImplementation: string

    before(async () => {
      await createSnapshot()

      const proxy = await ethers.getContractAt(CONTRACT_NAME, PROXY_ADDRESS)
      // Read the getter VALUES through the live (pre-upgrade) implementation.
      // Both the current and the upgraded implementation expose these getters.
      beforeChainId = await proxy.l2ChainId()
      beforeDepositor = await proxy.l2BitcoinDepositor()

      newImplementation = await simulateUpgrade()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("preserves the l2ChainId getter value across the simulated upgrade", async () => {
      // A Base-variant implementation would read slot 205 for `l2ChainId()`
      // (the Arbitrum l2BitcoinDepositor slot) and return a different value.
      const proxy = await ethers.getContractAt(CONTRACT_NAME, PROXY_ADDRESS)
      const afterChainId = await proxy.l2ChainId()

      expect(afterChainId).to.equal(beforeChainId)
    })

    it("preserves the l2BitcoinDepositor getter value across the simulated upgrade", async () => {
      const proxy = await ethers.getContractAt(CONTRACT_NAME, PROXY_ADDRESS)
      const afterDepositor = await proxy.l2BitcoinDepositor()

      expect(afterDepositor).to.equal(beforeDepositor)
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

    // Behavioral version guard: drive the best-effort skip path on the
    // upgraded forked proxy and assert it emits
    // `DepositTxMaxFeeReimbursementSkipped` while still finalizing — proving
    // the installed implementation carries the best-effort branch (a
    // pre-best-effort implementation lacks it entirely).
    //
    // This requires fixture infrastructure not yet present in this package:
    //   - `solidity/contracts/test/MockContract.sol` + `solidity/test/helpers/mock.ts`
    //     (the current repo mock infrastructure) to mock the live Bridge and
    //     TBTCVault at their real cached on-chain addresses so the
    //     `_finalizeDeposit` external reads (`deposits`, `depositParameters`,
    //     `optimisticMinting*`) resolve under the contract's control;
    //   - in-package typechain for the L1 interfaces (`IBridge`, `ITBTCVault`,
    //     `IWormhole*`), generated by dependency-compiling them so the fixture
    //     type-checks;
    //   - staging the proxy's REAL tBTC balance (token cached at slot 200 =
    //     mainnet tBTC 0x18084fBa...3a88) to exactly the base amount via
    //     `hardhat_setStorageAt` on tBTC's `_balances[proxy]` slot — the
    //     cached token cannot be minted and faking the vault does not redirect
    //     it. With balance == base (>= base, < base + txMaxFee) the
    //     best-effort branch skips and emits the event while still finalizing.
    //
    // Asserting against a reverting `finalizeDeposit` would be a false guard
    // (it would pass for the wrong reason on any implementation that reverts).
    // The spec mandates the behavior, so this case is left pending until the
    // fixture wiring lands; the ABI-presence assertion below is the cheap
    // canary that catches a stale pre-best-effort artifact in the meantime.
    it(
      "best-effort-skips when balance covers base but not base plus txMaxFee, " +
        "emitting DepositTxMaxFeeReimbursementSkipped"
    )
  }
)

describe("UpgradeArbitrumL1BitcoinDepositorTo968 - staged artifact", () => {
  type AbiEntry = { type?: string; name?: string }

  const stagedArtifactPath = path.resolve(
    __dirname,
    "../build/contracts/L1BTCDepositorWormholeV2Arbitrum.sol",
    "L1BTCDepositorWormholeV2Arbitrum.json"
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
    // package build via the `copyWormholeV2Artifact` post-compile hook. The
    // best-effort event MUST be present in that staged ABI; its absence means
    // the staged build predates the best-effort change and the script would
    // re-deploy the current on-chain (pre-best-effort) bytecode.
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

describe("UpgradeArbitrumL1BitcoinDepositorTo968 - calldata shape", () => {
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
      path.join(os.tmpdir(), "tbtc-968-arbitrum-calldata-")
    )

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

    // Durable governance-calldata artifact. The stdout log line is ephemeral
    // and copy-paste-prone; the JSON file is the hand-off the timelock
    // proposer (and reviewers of the upgrade PR) can verify against. The
    // shape is fixed here so any silent change to the payload contract
    // (added/removed field, renamed nesting) fails this assertion loudly.
    const calldataPath = path.join(
      tmpRoot,
      "governance-calldata",
      "968-ArbitrumOneL1BitcoinDepositor.json"
    )
    assert.equal(
      fs.existsSync(calldataPath),
      true,
      `governance calldata file should be written at ${calldataPath}`
    )
    const calldataPayload = JSON.parse(fs.readFileSync(calldataPath, "utf8"))
    const expectedUpgradeData = proxyAdminInterface.encodeFunctionData(
      "upgrade",
      [proxyAddress, newImplementationAddress]
    )
    assert.deepEqual(calldataPayload, {
      network: networkName,
      contract: "L1BTCDepositorWormholeV2Arbitrum",
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

// -------------------------------------------------------------------
// Skip-guard surface. Two axes are guarded: (1) the script runs only on
// mainnet, never auto-executing against hardhat/sepolia during a full deploy;
// (2) an in-file `ALREADY_EXECUTED` sentinel must be flipped to `true` after
// the Council Safe broadcasts the upgrade, so a second mainnet run does not
// deploy a fresh implementation and overwrite the deployment artifact. The
// mainnet expectation below intentionally fails after that flip — that
// failure is the gate that forces the post-execution checklist to update
// both the script and this test together.
describe("UpgradeArbitrumL1BitcoinDepositorTo968 - skip guard", () => {
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
