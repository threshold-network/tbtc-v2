import { ethers, upgrades, artifacts } from "hardhat"
import { expect } from "chai"
import * as fs from "fs"
import * as path from "path"

// The deploy script under test does not exist yet; this import binds the fork
// regression suite to the deliverable. Until the script is authored the import
// throws "Cannot find module", which fails this suite for the intended reason
// before any fork connection is attempted.
import func from "../../deploy/44_upgrade_native_btc_depositor_to_968"

// Native transparent proxy (unchanged across the implementation swap).
const NATIVE_PROXY = "0xad7c6d46F4a4bc2D3A227067d03218d6D7c9aaa5"
// Real on-chain ProxyAdmin for the Native proxy (EIP-1967 admin slot). The
// OpenZeppelin upgrades plugin resolves a DIFFERENT default admin for this
// rail, so the admin must be addressed explicitly here.
const NATIVE_PROXY_ADMIN = "0x92FcBD0b9D22bd2659c09A9aCD6E645F228b9A21"
// ProxyAdmin.owner() — the Council Safe authorized to execute the upgrade.
const PROXY_ADMIN_OWNER = "0x9F6e831c8F8939DC0C830C6e492e7cEf4f9C2F5f"
// Current (pre-upgrade) on-chain implementation; the new one must differ.
const CURRENT_IMPLEMENTATION = "0xc3ae0007dd495d3dbe8ad046623c0f9ae5610924"
// EIP-1967 implementation slot:
// bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1).
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
// `reimburseTxMaxFee()` getter selector — a post-gap application field whose
// value must survive the upgrade byte-for-byte.
const REIMBURSE_TX_MAX_FEE_SELECTOR = "0x7be04b6a"

// The OpenZeppelin upgrades manifest tracked in git. `forceImport` mutates it,
// so it is backed up before the suite and restored after to avoid disturbing
// concurrent work that shares this file.
const MANIFEST_PATH = path.join(
  __dirname,
  "..",
  "..",
  ".openzeppelin",
  "mainnet.json"
)

function pad32(hex: string): string {
  return ethers.utils.hexZeroPad(ethers.utils.getAddress(hex), 32)
}

describe("UpgradeNativeBTCDepositorTo968 fork regression", () => {
  // Binding the fork suite to the deliverable: the deploy script must exist for
  // this upgrade to be meaningful. This also keeps the import from being
  // flagged as unused.
  it("requires the upgrade deploy script to exist", () => {
    expect(func).to.be.a("function")
  })

  describe("against the live mainnet proxy", () => {
    let manifestBackup: string | null = null
    let newImplementation: string

    before(async () => {
      // Fork precondition: the Native proxy must have code at the forked block.
      // A mis-wired or too-old fork would return empty code; throwing here makes
      // that fail loudly instead of silently passing vacuous assertions.
      const proxyCode = await ethers.provider.getCode(NATIVE_PROXY)
      expect(proxyCode.length).to.be.greaterThan(
        2,
        "Native proxy has no code at the forked block; the fork is mis-wired or too old"
      )

      // Back up the OZ manifest before forceImport mutates it.
      if (fs.existsSync(MANIFEST_PATH)) {
        manifestBackup = fs.readFileSync(MANIFEST_PATH, "utf8")
      }

      const factory = await ethers.getContractFactory("NativeBTCDepositor")

      const implKeysBeforeImport = new Set(
        Object.keys(JSON.parse(manifestBackup ?? "{}").impls ?? {})
      )

      // The Native proxy is absent from the manifest, so its current storage
      // layout must be registered via forceImport before prepareUpgrade can
      // diff the new layout against it.
      await upgrades.forceImport(NATIVE_PROXY, factory, {
        kind: "transparent",
      })

      // forceImport registers the current implementation under the bytecode
      // version of the supplied factory. Because the upgrade is logic-only, that
      // version equals the one prepareUpgrade would deploy, so prepareUpgrade
      // would short-circuit to the already-registered current implementation
      // and never deploy the new bytecode. The current implementation's layout
      // is still needed as the upgrade-safety baseline, but the manifest
      // resolves that baseline by address scan rather than by version key. The
      // freshly injected entry is therefore re-keyed off the version slot: the
      // baseline-by-address lookup still finds it, while the version slot is
      // freed so prepareUpgrade deploys the new implementation.
      const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"))
      const injectedVersions = Object.keys(manifest.impls ?? {}).filter(
        (version) => !implKeysBeforeImport.has(version)
      )
      injectedVersions.forEach((version) => {
        manifest.impls[`imported-baseline-${version}`] = manifest.impls[version]
        delete manifest.impls[version]
      })
      fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))

      newImplementation = (await upgrades.prepareUpgrade(
        NATIVE_PROXY,
        factory,
        { kind: "transparent" }
      )) as string
    })

    after(async () => {
      // Restore the manifest so concurrent work sharing this file is undisturbed.
      if (manifestBackup !== null) {
        fs.writeFileSync(MANIFEST_PATH, manifestBackup)
      }
    })

    it("keeps the post-gap reimburseTxMaxFee field byte-unchanged across the upgrade", async () => {
      const readReimburseTxMaxFee = async () =>
        ethers.provider.call({
          to: NATIVE_PROXY,
          data: REIMBURSE_TX_MAX_FEE_SELECTOR,
        })

      const before = await readReimburseTxMaxFee()
      // The live value is `true`; the guard is that it is preserved exactly.
      expect(
        ethers.BigNumber.from(before).eq(1),
        "live reimburseTxMaxFee should be true before the upgrade"
      ).to.equal(true)

      // Impersonate the Council Safe owner and fund it to send the upgrade.
      await ethers.provider.send("hardhat_impersonateAccount", [
        PROXY_ADMIN_OWNER,
      ])
      await ethers.provider.send("hardhat_setBalance", [
        PROXY_ADMIN_OWNER,
        "0x3635c9adc5dea00000", // 1000 ETH
      ])
      const owner = await ethers.getSigner(PROXY_ADMIN_OWNER)

      const proxyAdmin = await ethers.getContractAt(
        "ProxyAdmin",
        NATIVE_PROXY_ADMIN,
        owner
      )
      await proxyAdmin.upgrade(NATIVE_PROXY, newImplementation)

      // The implementation slot must now hold the freshly deployed impl, and it
      // must differ from the current on-chain implementation.
      const implSlotRaw = await ethers.provider.getStorageAt(
        NATIVE_PROXY,
        EIP1967_IMPLEMENTATION_SLOT
      )
      // `getStorageAt` returns lowercase hex while `pad32` applies EIP-55
      // checksum casing; normalize both sides to lowercase so the comparison
      // turns on the address value, not its letter case.
      expect(ethers.utils.hexStripZeros(implSlotRaw).toLowerCase()).to.equal(
        ethers.utils.hexStripZeros(pad32(newImplementation)).toLowerCase(),
        "implementation slot should point to the new implementation"
      )
      expect(newImplementation.toLowerCase()).to.not.equal(
        CURRENT_IMPLEMENTATION,
        "new implementation must differ from the current one"
      )

      const after = await readReimburseTxMaxFee()
      expect(after).to.equal(
        before,
        "reimburseTxMaxFee must be byte-identical before and after the upgrade"
      )
    })

    it("ships the best-effort fee-reimbursement behavior and a distinct implementation", async () => {
      // The freshly compiled implementation carries the best-effort
      // fee-reimbursement path, signalled by its event in the ABI.
      const nativeArtifact = await artifacts.readArtifact("NativeBTCDepositor")
      const hasSkipEvent = nativeArtifact.abi.some(
        (entry: { type?: string; name?: string }) =>
          entry.type === "event" &&
          entry.name === "DepositTxMaxFeeReimbursementSkipped"
      )
      expect(
        hasSkipEvent,
        "implementation ABI must expose DepositTxMaxFeeReimbursementSkipped"
      ).to.equal(true)

      expect(newImplementation.toLowerCase()).to.not.equal(
        CURRENT_IMPLEMENTATION,
        "new implementation must differ from the current one"
      )
    })
  })
})
