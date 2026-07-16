// This install-time hook must be plain CommonJS: it runs during `npm install`
// in a bare consumer tree with no ts-node/ESM loader, so `require` is required.
/* eslint-disable @typescript-eslint/no-var-requires */
// Guarded patch-package runner for @keep-network/tbtc-v2's postinstall hook.
//
// The tbtc-v2 Solidity package applies a local patch-package patch to
// @openzeppelin/upgrades-core during development (see patches/). That patch is
// the still-unmerged upstream workaround from OpenZeppelin upgrades-core issue
// #1227 / PR #1246 (cross-application of unrelated link references producing
// invalid bytecode in getUnlinkedBytecode), not a released upstream fix. Wiring
// a bare
// `patch-package` into postinstall breaks downstream consumers: patch-package is
// a devDependency (absent when this package is installed as a dependency) and
// the patches/ directory is intentionally excluded from the published tarball's
// `files` allowlist. npm still runs this package's postinstall in a consumer's
// tree, so a bare invocation would abort that consumer's `npm install`.
//
// This runner applies the patches only when BOTH the patch-package tool and the
// patches/ directory are present (the in-repo development case), and otherwise
// exits 0. It deliberately does NOT swallow a genuine patch-application failure:
// when both are present, patch-package's own non-zero exit still fails the
// install, so a broken patch is never silently ignored during development.
const fs = require("fs")
const path = require("path")
const { execFileSync } = require("child_process")

const packageRoot = path.join(__dirname, "..")
const patchesDir = path.join(packageRoot, "patches")

let patchPackageBin
try {
  // patch-package's package.json declares `bin: ./index.js`; resolving it throws
  // when patch-package is not installed, i.e. when this package is consumed as a
  // dependency (devDependencies are not installed for a transitive dependency).
  patchPackageBin = require.resolve("patch-package/index.js")
} catch (error) {
  // Nothing to run: this is a consumer install, not in-repo development.
  process.exit(0)
}

if (!fs.existsSync(patchesDir)) {
  // The published tarball ships no patches/ directory, so there is nothing to
  // apply even if patch-package happened to be resolvable.
  process.exit(0)
}

// Both the tool and the patches are present: apply them, letting any real
// patch-application error propagate as a non-zero exit code.
execFileSync(process.execPath, [patchPackageBin], {
  stdio: "inherit",
  cwd: packageRoot,
})
