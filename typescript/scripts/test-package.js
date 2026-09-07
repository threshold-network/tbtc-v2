const { execFileSync } = require("child_process")
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("fs")
const { tmpdir } = require("os")
const { join, resolve } = require("path")
const manifest = require("../package.json")

const packageRoot = resolve(__dirname, "..")

if (!existsSync(join(packageRoot, manifest.main))) {
  throw new Error(
    "Build the SDK with yarn build before running yarn test:package"
  )
}

const consumerRoot = mkdtempSync(join(tmpdir(), "tbtc-sdk-consumer-"))

try {
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", consumerRoot],
    {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }
  )
  const [{ filename }] = JSON.parse(output)

  writeFileSync(
    join(consumerRoot, "package.json"),
    JSON.stringify({
      name: "tbtc-sdk-consumer",
      version: "1.0.0",
      private: true,
    })
  )

  const consumerOptions = {
    cwd: consumerRoot,
    // A consumer must resolve dependencies from its own installation.
    env: { ...process.env, NODE_PATH: "", CI: "true" },
    stdio: "inherit",
  }

  execFileSync(
    "npm",
    [
      "install",
      "--engine-strict",
      "--ignore-scripts=false",
      "--no-audit",
      "--no-fund",
      join(consumerRoot, filename),
    ],
    consumerOptions
  )

  for (const subpath of Object.keys(manifest.exports)) {
    const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1))

    // Use a separate process for each import so module caches cannot hide errors.
    execFileSync(
      process.execPath,
      ["--eval", "require(process.argv[1])", specifier],
      consumerOptions
    )
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "await import(process.argv[1])",
        specifier,
      ],
      consumerOptions
    )
    console.log(`Loaded ${specifier} with require() and import()`)
  }

  execFileSync(
    process.execPath,
    [join(__dirname, "test-package-electrum.js"), manifest.name],
    consumerOptions
  )
} finally {
  rmSync(consumerRoot, { recursive: true, force: true })
}
