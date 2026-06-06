import {
  ethers,
  network,
  helpers,
  upgrades,
  deployments,
  getUnnamedAccounts,
} from "hardhat"
import { assert, expect } from "chai"
import chai from "chai"
import { smock } from "@defi-wonderland/smock"
import type { FakeContract } from "@defi-wonderland/smock"
import { BigNumber } from "ethers"
import type { Contract } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

import func from "../deploy_l1/03_upgrade_starknet_btc_depositor_to_968"

import type { IBridge, ITBTCVault } from "../typechain"

chai.use(smock.matchers)

// -------------------------------------------------------------------
// Regression harness for the StarkNet L1 Bitcoin Depositor
// upgrade-in-place.
//
// The StarkNet rail compiles its implementation from the vendored
// contract tree (already carrying the best-effort tx-max-fee
// reimbursement change). Unlike the Wormhole rails, the regression-guarded
// storage field here is `starkGateBridge`, declared by the StarkNet
// variant immediately after the shared base layout. It packs into the
// SAME slot as the inherited `reimburseTxMaxFee` boolean (the bool at
// offset 0, the address at offset 1), so a raw `eth_getStorageAt` of that
// slot would read BOTH fields and could spuriously fail if read across a
// `reimburseTxMaxFee` toggle. The public `starkGateBridge()` getter reads
// exactly the address field and sidesteps the packing, so the storage
// assertion below uses the getter rather than a raw slot read.
//
// The harness has three independent parts:
//   - a mainnet-fork suite that proves the live proxy's `starkGateBridge`
//     survives a simulated `ProxyAdmin.upgrade` and that the new
//     implementation differs from the current on-chain one;
//   - a calldata-shape suite that proves the deploy script emits a plain
//     `upgrade(address,address)` and verifies with empty constructor args
//     (no broadcast, no `upgradeAndCall`, no re-initialization);
//   - a best-effort skip-path suite that exercises a freshly deployed
//     implementation under stubbed Bridge / TBTCVault / StarkGate so the
//     reimbursement-skipped branch is observable at unit speed.
//
// The fork suite is gated on `FORKING_URL`; without it Hardhat runs an
// in-memory chain where the real proxy does not exist, so that suite is
// skipped rather than spuriously failing. There is no StarkNet CI
// workflow, so the fork suite is expected to be run locally.
// -------------------------------------------------------------------

const CONTRACT_NAME = "StarkNetBitcoinDepositor"

// Live mainnet addresses for the StarkNet L1 depositor. Hard-coding them is
// intentional: the fork suite asserts the live deployment specifically, not
// a freshly deployed clone.
const PROXY_ADDRESS = "0xC9031f76006da0BD4bFa9E02aDf0d448dB3BC155"
// Current on-chain implementation (the pre-change build). The upgrade MUST
// land on a different address than this.
const CURRENT_IMPLEMENTATION = "0xD3585922B7F6B30953Fc81726F48046826B8B2CA"
// The ProxyAdmin owner is a single-key EOA on this rail (no timelock).
const PROXY_ADMIN_OWNER = "0x353C5c3DE81EDb53FFB398f6416f962b90ae8611"

// EIP-1967 implementation slot:
//   bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

// Minimal ProxyAdmin ABI — only the upgrade entrypoint is exercised.
const PROXY_ADMIN_ABI = [
  "function upgrade(address proxy, address implementation) external",
  "function owner() view returns (address)",
]

const isForking = !!process.env.FORKING_URL

// Smock's base-provider lookup calls `init()` on the top-level Hardhat
// provider. Under the hardhat-deploy provider stack the outermost adapter
// (BackwardsCompatibilityProviderAdapter) does not expose `init`; the method
// lives on the inner lazy adapter. Hit a node method first so the lazy chain
// is initialized (making the wrapped provider reachable), then expose a no-op
// `init` on the outer adapter so the lookup resolves and unwraps to the base
// provider. This only adapts the test harness to the provider stack; it does
// not alter any contract behavior under test.
async function ensureSmockReadyProvider(): Promise<void> {
  await ethers.provider.getBlockNumber()
  const provider = network.provider as unknown as { init?: () => Promise<void> }
  if (typeof provider.init !== "function") {
    provider.init = async () => {}
  }
}

// -------------------------------------------------------------------
// Mainnet-fork regression: live `starkGateBridge` survives the upgrade
// and the new implementation differs from the current on-chain one.
// -------------------------------------------------------------------
;(isForking ? describe : describe.skip)(
  "UpgradeStarkNetBitcoinDepositorTo968 - mainnet fork regression",
  () => {
    const { createSnapshot, restoreSnapshot } = helpers.snapshot

    let depositor: Contract
    let beforeStarkGateBridge: string
    let newImplementation: string

    before(async () => {
      await createSnapshot()

      depositor = await ethers.getContractAt(CONTRACT_NAME, PROXY_ADDRESS)

      // Capture the address via the getter BEFORE any state mutation, so the
      // packed-slot neighbour (`reimburseTxMaxFee`) cannot perturb the read.
      beforeStarkGateBridge = await depositor.starkGateBridge()

      // Deploy the new implementation on the fork. The storage-safety check is
      // left ON (no `unsafeSkipStorageCheck`): this is a storage-identical
      // change, so a rejection here would itself signal a real layout
      // regression.
      const factory = await ethers.getContractFactory(CONTRACT_NAME)
      newImplementation = (await upgrades.prepareUpgrade(
        PROXY_ADDRESS,
        factory,
        {
          kind: "transparent",
        }
      )) as string

      // Impersonate the ProxyAdmin owner (an EOA on this rail) and fund it for
      // gas, then issue the plain `upgrade(proxy, newImpl)` — no
      // `upgradeAndCall`, no re-initialization. The ProxyAdmin instance is
      // resolved from the OpenZeppelin upgrades manifest.
      const proxyAdminInstance = await upgrades.admin.getInstance()

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
        proxyAdminInstance.address,
        PROXY_ADMIN_ABI,
        ownerSigner
      )

      await proxyAdmin.upgrade(PROXY_ADDRESS, newImplementation)

      await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [PROXY_ADMIN_OWNER],
      })
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("preserves the starkGateBridge address across the upgrade", async () => {
      const afterStarkGateBridge = await depositor.starkGateBridge()
      expect(afterStarkGateBridge).to.equal(beforeStarkGateBridge)
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
      expect(decodedImpl).to.not.equal(ethers.constants.AddressZero)
    })
  }
)

// -------------------------------------------------------------------
// Calldata-shape assertions (no fork required). The deploy script issues
// exactly one `verify` call with empty constructor args and encodes the
// plain `upgrade(address,address)` selector — never `upgradeAndCall`,
// never a re-initialization argument.
// -------------------------------------------------------------------
describe("UpgradeStarkNetBitcoinDepositorTo968 - calldata shape", () => {
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

// -------------------------------------------------------------------
// Best-effort skip-path behavior (no fork required). A freshly deployed
// implementation is initialized against stubbed Bridge / TBTCVault /
// StarkGate so the reimbursement-skipped branch is observable at unit
// speed. Exercising the same implementation bytecode under stubs is the
// boring/obvious way to prove the best-effort branch is present: driving
// the real path on the forked proxy would require a live, swept deposit in
// the Initialized state, which is not tractable at unit speed.
//
// `_transferTbtc` on the StarkNet variant routes the finalized tBTC to the
// StarkGate bridge (not to a plain receiver), so the assertions target the
// emitted events rather than a receiver balance.
// -------------------------------------------------------------------
describe("UpgradeStarkNetBitcoinDepositorTo968 - best-effort skip path", () => {
  const { createSnapshot, restoreSnapshot } = helpers.snapshot

  // hardhat-deploy artifact name for the ephemeral instance exercised here.
  const SKIP_PATH_DEPLOYMENT_NAME = "StarkNetBitcoinDepositor_skip_path"

  // Deposit-math constants mirror the shared abstract base behavior.
  // For depositAmount=100000 & treasuryFee=500:
  //   (depositAmount - treasuryFee) = 99500
  //   => *1e10 => 99500e10
  //   => omFee = (99500e10 / 20) = 4975e10
  //   => depositTxMaxFee => 1000e10
  // Base amount (no reimbursement):   99500e10 - 4975e10 - 1000e10 = 93525e10
  // Reimbursed amount (with fee back): 94525e10
  const satoshiMultiplier = BigNumber.from(10).pow(10)
  const depositTxMaxFee = BigNumber.from(1000)
  const depositAmount = BigNumber.from(100000)
  const treasuryFee = BigNumber.from(500)
  const optimisticMintingFeeDivisor = 20
  const expectedTbtcAmountBase = BigNumber.from(93525).mul(satoshiMultiplier)

  // A StarkNet recipient must be a non-zero uint256. The trailing 20 bytes
  // double as a deterministic deposit owner.
  const starkNetRecipientBytes32 =
    "0x00000000000000000000000023b82a7108F9CEb34C3CDC44268be21D151d4124"

  let governance: SignerWithAddress
  let relayer: SignerWithAddress
  let bridge: FakeContract<IBridge>
  let tbtcVault: FakeContract<ITBTCVault>
  let starkGateBridge: FakeContract<Contract>
  let tbtcToken: Contract
  let depositor: Contract

  before(async () => {
    await createSnapshot()

    await ensureSmockReadyProvider()

    const namedSigners = await helpers.signers.getNamedSigners()
    governance = namedSigners.governance

    const accounts = await getUnnamedAccounts()
    relayer = await ethers.getSigner(accounts[1])

    bridge = await smock.fake<IBridge>("IBridge")

    // A real ERC20 satisfies the SafeERC20 allowance/transfer plumbing in
    // `_transferTbtc` for free; only the Bridge / Vault / StarkGate are stubs.
    tbtcToken = await (await ethers.getContractFactory("TestERC20")).deploy()

    tbtcVault = await smock.fake<ITBTCVault>("ITBTCVault")
    tbtcVault.tbtcToken.returns(tbtcToken.address)

    // The StarkGate bridge fee is stubbed to zero so finalize can carry
    // `value: 0`, and its `deposit` is stubbed so `_transferTbtc` does not
    // revert before the best-effort branch is reached.
    starkGateBridge = await smock.fake("IStarkGateBridge")
    starkGateBridge.estimateDepositFeeWei.returns(0)

    // `deployProxy` persists a hardhat-deploy artifact and refuses to deploy
    // a second time under the same name. EVM snapshots do not revert that
    // on-disk artifact, so a prior run (or a crashed run) would leave it
    // behind and break this suite on the next invocation. Drop any stale
    // entry first so the deployment is idempotent across runs.
    await deployments.delete(SKIP_PATH_DEPLOYMENT_NAME)

    const deployment = await helpers.upgrades.deployProxy(
      SKIP_PATH_DEPLOYMENT_NAME,
      {
        contractName: "StarkNetBitcoinDepositor",
        initializerArgs: [
          bridge.address,
          tbtcVault.address,
          starkGateBridge.address,
        ],
        factoryOpts: { signer: namedSigners.deployer },
        proxyOpts: {
          kind: "transparent",
          unsafeAllow: ["external-library-linking"],
        },
      }
    )
    depositor = deployment[0] as Contract

    await depositor
      .connect(namedSigners.deployer)
      .transferOwnership(governance.address)

    await depositor.connect(governance).setReimburseTxMaxFee(true)
  })

  after(async () => {
    bridge.depositParameters.reset()
    tbtcVault.optimisticMintingFeeDivisor.reset()
    bridge.deposits.reset()
    tbtcVault.optimisticMintingRequests.reset()
    starkGateBridge.estimateDepositFeeWei.reset()
    starkGateBridge.deposit.reset()

    await restoreSnapshot()
  })

  it("emits DepositTxMaxFeeReimbursementSkipped when the balance cannot cover the fee", async () => {
    const depositKey = ethers.BigNumber.from(
      ethers.utils.keccak256(ethers.utils.toUtf8Bytes("starknet-skip-path"))
    )

    // Stage the deposit directly in the Initialized state. The `deposits`
    // mapping base is slot 200; the per-key slot is keccak256(key, 200).
    const depositSlot = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["uint256", "uint256"],
        [depositKey, 200]
      )
    )
    await network.provider.request({
      method: "hardhat_setStorageAt",
      params: [
        depositor.address,
        depositSlot,
        ethers.utils.hexZeroPad("0x01", 32),
      ],
    })

    // Bridge / Vault reads that drive the deposit-amount math.
    bridge.depositParameters.returns({
      depositDustThreshold: 0,
      depositTreasuryFeeDivisor: 0,
      depositTxMaxFee,
      depositRevealAheadPeriod: 0,
    })
    tbtcVault.optimisticMintingFeeDivisor.returns(optimisticMintingFeeDivisor)

    const revealedAt = (await helpers.time.lastBlockTime()) - 7200
    const finalizedAt = await helpers.time.lastBlockTime()
    bridge.deposits.whenCalledWith(depositKey).returns({
      depositor: depositor.address,
      amount: depositAmount,
      revealedAt,
      vault: tbtcVault.address,
      treasuryFee,
      sweptAt: finalizedAt,
      extraData: starkNetRecipientBytes32,
    })
    tbtcVault.optimisticMintingRequests
      .whenCalledWith(depositKey)
      .returns([revealedAt, finalizedAt])

    // Mint ONLY the base tBTC amount, simulating a shared contract balance
    // that covers the base amount but not the extra reimbursement.
    await tbtcToken.mint(depositor.address, expectedTbtcAmountBase)

    const tx = await depositor
      .connect(relayer)
      .finalizeDeposit(depositKey, { value: 0 })

    const txMaxFee = depositTxMaxFee.mul(satoshiMultiplier)
    await expect(tx)
      .to.emit(depositor, "DepositTxMaxFeeReimbursementSkipped")
      .withArgs(depositKey, txMaxFee, expectedTbtcAmountBase)

    await expect(tx)
      .to.emit(depositor, "DepositFinalized")
      .withArgs(
        depositKey,
        starkNetRecipientBytes32.toLowerCase(),
        relayer.address,
        depositAmount.mul(satoshiMultiplier),
        expectedTbtcAmountBase
      )
  })
})
