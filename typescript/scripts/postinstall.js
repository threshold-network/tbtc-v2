const { execFileSync } = require("child_process")
const { dirname, relative, resolve } = require("path")

// npm may hoist Electrum into the consumer's node_modules. Apply the patch
// beside the dependency that this SDK actually resolves, not beside the SDK.
const electrumDirectory = dirname(
  require.resolve("electrum-client-js/package.json")
)
const dependencyRoot = resolve(electrumDirectory, "../..")
const patchDirectory = relative(
  dependencyRoot,
  resolve(__dirname, "../patches")
)

execFileSync(
  process.execPath,
  [
    require.resolve("patch-package"),
    "--patch-dir",
    patchDirectory,
    "--error-on-fail",
  ],
  { cwd: dependencyRoot, stdio: "inherit" }
)
