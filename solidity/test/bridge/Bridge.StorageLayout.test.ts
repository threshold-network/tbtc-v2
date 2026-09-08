import { artifacts } from "hardhat"
import { assert } from "chai"
import {
  getStorageUpgradeReport,
  withValidationDefaults,
} from "@openzeppelin/upgrades-core"
import type { StorageLayout } from "@openzeppelin/upgrades-core"

import mainnetBridgeImplementation from "../../deployments/mainnet/BridgeTIP109HotfixImplementation.json"

// Hardhat's `CompilerOutputContract` type doesn't declare `storageLayout`
// (it's populated by `@openzeppelin/hardhat-upgrades` extending solc's
// `outputSelection`, not part of Hardhat core), so re-declare the field we
// actually read off the raw build info.
interface CompiledContractWithStorageLayout {
  storageLayout: StorageLayout
}

// Regression test guarding against accidental storage-layout breaks in the
// upgradeable `Bridge` contract.
//
// `deployments/mainnet/BridgeTIP109HotfixImplementation.json` is the deploy
// artifact for the Bridge implementation currently live on mainnet (see
// `deploy/86_deploy_tip109_hotfix.ts`). It embeds the exact `storageLayout`
// solc produced for that implementation at deploy time -- a real,
// pre-this-PR snapshot of `Bridge`'s storage, independent of whatever is
// currently checked out.
//
// This test reads that historical layout, compiles the currently checked
// out `contracts/bridge/Bridge.sol` (Hardhat always recompiles before
// running tests, and `@openzeppelin/hardhat-upgrades` extends solc's
// `outputSelection` to include `storageLayout` for every contract), and
// diffs the two layouts with the same
// `@openzeppelin/upgrades-core#getStorageUpgradeReport` comparator that
// `upgrades.prepareUpgrade` uses internally. Unlike comparing a freshly
// deployed proxy against a factory built from the same current source (which
// can never detect a regression, since both sides always move together),
// this compares against a fixed, real, already-deployed layout, so an
// incompatible reordering/retyping/removal of a `Bridge` storage slot in
// this PR (or any future one) actually fails this check -- with no live
// network access or proxy deployment required.
//
// Caveat: solc's `storageLayout` output does not include enum member names
// (only their byte size), so `unsafeAllowCustomTypes` is required to avoid
// false positives on `Bridge`'s enum fields (`Wallets.WalletState`,
// `MovingFunds.MovedFundsSweepRequestState`). That only weakens detection of
// enum *value reordering*; slot/offset positions, struct member order, and
// every other field's type are still fully checked.
describe("Bridge - Storage Layout", () => {
  describe("compatibility with the currently deployed mainnet implementation", () => {
    it("should not report a storage-layout incompatibility", async () => {
      const originalLayout =
        mainnetBridgeImplementation.storageLayout as unknown as StorageLayout

      assert.isAbove(
        originalLayout.storage.length,
        0,
        "baseline mainnet deployment artifact " +
          "(deployments/mainnet/BridgeTIP109HotfixImplementation.json) is " +
          "missing its storage layout"
      )

      const buildInfo = await artifacts.getBuildInfo(
        "contracts/bridge/Bridge.sol:Bridge"
      )

      if (buildInfo === undefined) {
        throw new Error(
          "no build info found for contracts/bridge/Bridge.sol:Bridge; " +
            "run `hardhat compile` before this test"
        )
      }

      // `storageLayout` isn't in Hardhat's `CompilerOutputContract` type;
      // see `CompiledContractWithStorageLayout` above.
      const compiledBridge = buildInfo.output.contracts[
        "contracts/bridge/Bridge.sol"
      ].Bridge as unknown as CompiledContractWithStorageLayout
      const updatedLayout = compiledBridge.storageLayout

      assert.isAbove(
        updatedLayout?.storage?.length ?? 0,
        0,
        "compiled contracts/bridge/Bridge.sol:Bridge is missing its storage " +
          "layout; ensure solc `outputSelection` includes `storageLayout`"
      )

      const report = getStorageUpgradeReport(
        originalLayout,
        updatedLayout,
        withValidationDefaults({ unsafeAllowCustomTypes: true })
      )

      assert.isTrue(
        report.pass,
        `${
          "Bridge storage layout is incompatible with the currently deployed " +
          `mainnet implementation at ${mainnetBridgeImplementation.address} ` +
          "(deployments/mainnet/BridgeTIP109HotfixImplementation.json):\n\n"
        }${report.explain(false)}`
      )
    })
  })
})
