const assert = require("assert/strict")
const { execFileSync } = require("child_process")
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require("fs")
const { createRequire } = require("module")
const { tmpdir } = require("os")
const { join, resolve } = require("path")
const manifest = require("../package.json")

const packageRoot = resolve(__dirname, "..")

if (!existsSync(join(packageRoot, manifest.main))) {
  throw new Error(
    "Build the SDK with yarn build before running yarn test:package"
  )
}

const testRoot = mkdtempSync(join(tmpdir(), "tbtc-sdk-consumer-"))

try {
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", testRoot],
    {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }
  )
  const [{ filename }] = JSON.parse(output)

  const cases = [
    { name: "without-manifest", initialized: false, strategy: "hoisted" },
    { name: "initialized", initialized: true, strategy: "hoisted" },
    { name: "nested", initialized: true, strategy: "nested" },
  ]

  for (const { name, initialized, strategy } of cases) {
    const consumerRoot = join(testRoot, name)
    mkdirSync(consumerRoot)
    if (initialized) {
      writeFileSync(
        join(consumerRoot, "package.json"),
        JSON.stringify({
          name: "tbtc-sdk-consumer",
          version: "1.0.0",
          private: true,
        })
      )
    }

    assert.equal(existsSync(join(consumerRoot, "package.json")), initialized)
    console.log(`Checking packed SDK install: ${name} (${strategy})`)

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
        `--install-strategy=${strategy}`,
        "--engine-strict",
        "--ignore-scripts=false",
        "--no-audit",
        "--no-fund",
        join(testRoot, filename),
      ],
      consumerOptions
    )

    // Verify that each case exercises the intended Electrum installation layout.
    const consumerRequire = createRequire(join(consumerRoot, "package.json"))
    const sdkRequire = createRequire(consumerRequire.resolve(manifest.name))
    const dependencyRoot =
      strategy === "nested"
        ? join(consumerRoot, "node_modules", manifest.name)
        : consumerRoot
    assert.equal(
      realpathSync(sdkRequire.resolve("electrum-client-js/package.json")),
      realpathSync(
        join(dependencyRoot, "node_modules/electrum-client-js/package.json")
      )
    )

    for (const subpath of Object.keys(manifest.exports)) {
      const specifier =
        manifest.name + (subpath === "." ? "" : subpath.slice(1))

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
  }
} finally {
  rmSync(testRoot, { recursive: true, force: true })
}
