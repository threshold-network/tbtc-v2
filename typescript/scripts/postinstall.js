const { execFileSync } = require("child_process")
const {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("fs")
const { tmpdir } = require("os")
const { dirname, join, relative, resolve } = require("path")

// npm may hoist Electrum into the consumer's node_modules. Apply the patch
// beside the dependency that this SDK actually resolves, not beside the SDK.
const electrumDirectory = dirname(
  require.resolve("electrum-client-js/package.json")
)
const dependencyRoot = resolve(electrumDirectory, "../..")
const patchesDirectory = resolve(__dirname, "../patches")
let temporaryRoot

try {
  // npm can run postinstall before creating the consumer's package.json.
  // Give patch-package its own manifest in that case. Linking node_modules
  // still patches the resolved dependency without writing a consumer manifest.
  if (!existsSync(join(dependencyRoot, "package.json"))) {
    temporaryRoot = mkdtempSync(join(tmpdir(), "tbtc-electrum-patch-"))
    writeFileSync(join(temporaryRoot, "package.json"), "{}")
    symlinkSync(
      join(dependencyRoot, "node_modules"),
      join(temporaryRoot, "node_modules"),
      "junction"
    )
    cpSync(patchesDirectory, join(temporaryRoot, "patches"), {
      recursive: true,
    })
  }

  const patchRoot = temporaryRoot || dependencyRoot
  const patchDirectory = temporaryRoot
    ? "patches"
    : relative(dependencyRoot, patchesDirectory)

  execFileSync(
    process.execPath,
    [
      require.resolve("patch-package"),
      "--patch-dir",
      patchDirectory,
      "--error-on-fail",
    ],
    { cwd: patchRoot, stdio: "inherit" }
  )
} finally {
  if (temporaryRoot) {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}
