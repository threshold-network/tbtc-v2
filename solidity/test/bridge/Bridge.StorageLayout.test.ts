import { artifacts } from "hardhat"
import { assert } from "chai"
import {
  getStorageUpgradeReport,
  withValidationDefaults,
} from "@openzeppelin/upgrades-core"
import type { StorageLayout } from "@openzeppelin/upgrades-core"

import mainnetBridgeImplementation from "../../deployments/mainnet/BridgeTIP109HotfixImplementation.json"
import mainnetRebateStakingImplementation from "../../deployments/mainnet/RebateStakingTIP109HotfixImplementation.json"

// Hardhat's `CompilerOutputContract` type doesn't declare `storageLayout`
// (it's populated by `@openzeppelin/hardhat-upgrades` extending solc's
// `outputSelection`, not part of Hardhat core), so re-declare the field we
// actually read off the raw build info.
interface CompiledContractWithStorageLayout {
  storageLayout: StorageLayout
}

// Regression test guarding against accidental storage-layout breaks in the
// upgradeable `Bridge` and `RebateStaking` contracts.
//
// `deployments/mainnet/BridgeTIP109HotfixImplementation.json` and
// `deployments/mainnet/RebateStakingTIP109HotfixImplementation.json` are the
// deploy artifacts for the Bridge and RebateStaking implementations
// currently live on mainnet (see `deploy/86_deploy_tip109_hotfix.ts`, which
// deploys both). Each embeds the exact `storageLayout` solc produced for
// that implementation at deploy time -- a real, pre-this-PR snapshot of the
// contract's storage, independent of whatever is currently checked out.
//
// This test reads each historical layout, compiles the currently checked
// out `contracts/bridge/Bridge.sol` / `contracts/bridge/RebateStaking.sol`
// (Hardhat always recompiles before running tests, and
// `@openzeppelin/hardhat-upgrades` extends solc's `outputSelection` to
// include `storageLayout` for every contract), and diffs the two layouts
// with the same `@openzeppelin/upgrades-core#getStorageUpgradeReport`
// comparator that `upgrades.prepareUpgrade` uses internally. Unlike
// comparing a freshly deployed proxy against a factory built from the same
// current source (which can never detect a regression, since both sides
// always move together), this compares against a fixed, real,
// already-deployed layout, so an incompatible reordering/retyping/removal
// of a storage slot in this PR (or any future one) actually fails this
// check -- with no live network access or proxy deployment required.
//
// Caveat: solc's `storageLayout` output does not include enum member names
// (only their byte size), so `unsafeAllowCustomTypes` is required to avoid
// false positives on `Bridge`'s enum fields (`Wallets.WalletState`,
// `MovingFunds.MovedFundsSweepRequestState`) as well as `RebateStaking`'s
// enum fields (`RebateTreasuryFeeMode`, `TreasuryFeeType`). That only
// weakens detection of enum *value reordering*; slot/offset positions,
// struct member order, and every other field's type are still fully
// checked.
const STORAGE_LAYOUT_TARGETS = [
  {
    contractLabel: "Bridge",
    fullyQualifiedName: "contracts/bridge/Bridge.sol:Bridge",
    sourceFile: "contracts/bridge/Bridge.sol",
    baseline:
      mainnetBridgeImplementation.storageLayout as unknown as StorageLayout,
    baselineArtifactPath:
      "deployments/mainnet/BridgeTIP109HotfixImplementation.json",
    baselineAddress: mainnetBridgeImplementation.address,
  },
  {
    contractLabel: "RebateStaking",
    fullyQualifiedName: "contracts/bridge/RebateStaking.sol:RebateStaking",
    sourceFile: "contracts/bridge/RebateStaking.sol",
    baseline:
      mainnetRebateStakingImplementation.storageLayout as unknown as StorageLayout,
    baselineArtifactPath:
      "deployments/mainnet/RebateStakingTIP109HotfixImplementation.json",
    baselineAddress: mainnetRebateStakingImplementation.address,
  },
]

STORAGE_LAYOUT_TARGETS.forEach((target) => {
  describe(`${target.contractLabel} - Storage Layout`, () => {
    describe("compatibility with the currently deployed mainnet implementation", () => {
      it("should not report a storage-layout incompatibility", async () => {
        const originalLayout = target.baseline

        assert.isAbove(
          originalLayout.storage.length,
          0,
          `baseline mainnet deployment artifact ` +
            `(${target.baselineArtifactPath}) is missing its storage layout`
        )

        const buildInfo = await artifacts.getBuildInfo(
          target.fullyQualifiedName
        )

        if (buildInfo === undefined) {
          throw new Error(
            `no build info found for ${target.fullyQualifiedName}; ` +
              "run `hardhat compile` before this test"
          )
        }

        // `storageLayout` isn't in Hardhat's `CompilerOutputContract` type;
        // see `CompiledContractWithStorageLayout` above.
        const compiledContract = buildInfo.output.contracts[target.sourceFile][
          target.contractLabel
        ] as unknown as CompiledContractWithStorageLayout
        const updatedLayout = compiledContract.storageLayout

        assert.isAbove(
          updatedLayout?.storage?.length ?? 0,
          0,
          `compiled ${target.fullyQualifiedName} is missing its storage ` +
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
            `${target.contractLabel} storage layout is incompatible with ` +
            "the currently deployed mainnet implementation at " +
            `${target.baselineAddress} (${target.baselineArtifactPath}):\n\n`
          }${report.explain(false)}`
        )
      })
    })
  })
})
