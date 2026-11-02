const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const crypto = require("node:crypto")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")

// Execute the workflows' actual shell blocks against small local packages.
// This only extracts the literal run block of a named step, not arbitrary YAML.
function stepBlock(workflow, name) {
  const lines = fs
    .readFileSync(path.join(__dirname, "../workflows", workflow), "utf8")
    .split("\n")
  const start = lines.indexOf(`      - name: ${name}`)
  assert.notEqual(start, -1, `missing step: ${name}`)
  const next = lines.findIndex(
    (line, index) => index > start && line.startsWith("      - ")
  )
  return lines.slice(start, next === -1 ? undefined : next)
}

function step(workflow, name) {
  const body = stepBlock(workflow, name)
  const run = body.indexOf("        run: |")
  assert.notEqual(run, -1, `missing literal run block: ${name}`)
  return body
    .slice(run + 1)
    .filter((line) => line.startsWith("          "))
    .map((line) => line.slice(10))
    .join("\n")
}

function preparationEnvironment(workflow, name) {
  const body = stepBlock(workflow, name)
  const env = body.indexOf("        env:")
  assert.notEqual(env, -1, "preparation environment missing")
  const run = body.indexOf("        run: |")
  return Object.fromEntries(
    body.slice(env + 1, run).map((line) => {
      const match = /^          ([a-z_]+): ([a-z]+)$/.exec(line)
      assert.ok(match, `unsupported literal environment: ${line}`)
      return [match[1], match[2]]
    })
  )
}

function job(workflow, name) {
  const lines = fs
    .readFileSync(path.join(__dirname, "../workflows", workflow), "utf8")
    .split("\n")
  const start = lines.indexOf(`  ${name}:`)
  assert.notEqual(start, -1, `missing job: ${name}`)
  const next = lines.findIndex(
    (line, index) => index > start && /^  [a-z][a-z-]*:$/.test(line)
  )
  return lines.slice(start, next === -1 ? undefined : next).join("\n")
}

function fixture(t, hooks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-publication-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, "package")
  fs.mkdirSync(directory)
  for (const config of ["user.npmrc", "global.npmrc"]) {
    fs.writeFileSync(path.join(root, config), "")
  }
  fs.writeFileSync(path.join(directory, "index.js"), "module.exports = 1\n")
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "publication-fixture",
      version: "1.0.0",
      files: ["index.js", "artifacts", "export"],
      scripts: hooks,
    })
  )
  return {
    root,
    directory,
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: root,
      GITHUB_OUTPUT: path.join(root, "outputs"),
      npm_config_cache: path.join(root, "cache"),
      npm_config_userconfig: path.join(root, "user.npmrc"),
      npm_config_globalconfig: path.join(root, "global.npmrc"),
      // Publication tests are dry runs and cannot contact the real registry.
      npm_config_registry: "http://127.0.0.1:9",
      npm_config_fetch_retries: "0",
      npm_config_fetch_timeout: "1000",
      npm_config_update_notifier: "false",
    },
  }
}

function run(command, f, env = {}) {
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", command], {
    cwd: f.directory,
    env: { ...f.env, ...env },
    encoding: "utf8",
    timeout: 30000,
  })
}

function succeeds(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

function publisherFixture(t) {
  const f = fixture(t, {})
  fs.rmSync(f.directory, { recursive: true })
  fs.mkdirSync(f.directory)
  return f
}

function transferPackage(t, f, workflow) {
  succeeds(run(step(workflow, "Prepare publication artifact"), f))
  const publisher = publisherFixture(t)
  const hash = fs
    .readFileSync(f.env.GITHUB_OUTPUT, "utf8")
    .match(/^sha256=([a-f0-9]{64})$/m)
  assert.ok(hash, "missing tarball digest output")
  publisher.env.PACKAGE_SHA256 = hash[1]
  publisher.env.ARTIFACT_ID = "12345" // The service-provided upload output in CI.
  const destination = path.join(publisher.root, "npm-package")
  fs.mkdirSync(destination)
  fs.copyFileSync(
    path.join(f.root, "npm-artifact/package.tgz"),
    path.join(destination, "package.tgz")
  )
  assert.deepEqual(fs.readdirSync(publisher.directory), [])
  succeeds(run(step(workflow, "Validate artifact identity"), publisher))
  succeeds(run(step(workflow, "Verify prepared package"), publisher))
  return publisher
}

function dryRunPublish(workflow, f) {
  succeeds(run(step(workflow, "Inspect package metadata"), f))
  const publish = step(workflow, "Publish prepared package")
    .replace("npm publish ", "npm publish --dry-run ")
    .replace(
      "--registry=https://registry.npmjs.org",
      "--registry=http://127.0.0.1:9"
    )
  succeeds(run(publish, f, { NODE_AUTH_TOKEN: "test-only-not-a-real-token" }))
}

const lifecycle = [
  "prepublishOnly",
  "prepack",
  "prepare",
  "postpack",
  "publish",
  "postpublish",
]
const forbiddenHook = "node -e 'throw Error(\"unexpected lifecycle script\")'"
// Neither package defines prepare; npm 10 can invoke it despite ignore-scripts.
const packHooks = Object.fromEntries(
  lifecycle
    .filter((name) => name !== "prepare")
    .map((name) => [name, forbiddenHook])
)

function mutateArchiveManifest(f, update) {
  // Include every forbidden lifecycle hook in the credentialed publication test,
  // without running a hook while creating the fixture's archive.
  const archive = path.join(f.root, "npm-package/publication-fixture-1.0.0.tgz")
  const unpacked = path.join(f.root, "unpacked")
  fs.mkdirSync(unpacked)
  succeeds(
    spawnSync("tar", ["-xzf", archive, "-C", unpacked], { encoding: "utf8" })
  )
  const manifestPath = path.join(unpacked, "package/package.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath))
  update(manifest)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  succeeds(
    spawnSync("tar", ["-czf", archive, "-C", unpacked, "package"], {
      encoding: "utf8",
    })
  )
}

test("every package preparation hook is accounted for by its publishing workflow", () => {
  for (const [directory, expected] of [
    ["typescript", []],
    ["solidity", ["prepack", "prepublishOnly"]],
  ]) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../..", directory, "package.json"))
    )
    const hooks = Object.keys(manifest.scripts).filter((name) =>
      lifecycle.includes(name)
    )
    assert.deepEqual(
      hooks.sort(),
      expected,
      `${directory} hooks need explicit preparation`
    )
  }
})

test("checked-in package manifests can be packed by the publishing npm version", (t) => {
  for (const directory of ["typescript", "solidity"]) {
    const f = fixture(t, {})
    fs.copyFileSync(
      path.join(__dirname, "../..", directory, "package.json"),
      path.join(f.directory, "package.json")
    )
    // Validate real dependency/override metadata without building or installing.
    succeeds(
      run(
        step(
          "npm-typescript.yml",
          "Pack package without publishing credentials"
        ),
        f
      )
    )
  }
})

test("SDK packing and credentialed tarball publication skip lifecycle scripts", (t) => {
  const f = fixture(t, packHooks)
  succeeds(
    run(
      step("npm-typescript.yml", "Pack package without publishing credentials"),
      f
    )
  )
  mutateArchiveManifest(f, (manifest) => {
    manifest.scripts.prepare = forbiddenHook
  })
  const publisher = transferPackage(t, f, "npm-typescript.yml")
  dryRunPublish("npm-typescript.yml", publisher)
})

test("contract artifacts are prepared once before the token is introduced", (t) => {
  const hooks = { ...packHooks }
  hooks.prepublishOnly = "node prepare.cjs artifacts"
  hooks.prepack = "node prepare.cjs export"
  const f = fixture(t, hooks)
  fs.writeFileSync(
    path.join(f.directory, "prepare.cjs"),
    `const fs = require("node:fs")
const path = require("node:path")
if (process.env.NODE_AUTH_TOKEN) throw Error("token exposed to preparation")
if (process.env.npm_config_network !== "hardhat") throw Error("wrong network")
const name = process.argv[2]
fs.mkdirSync(name, { recursive: true })
fs.writeFileSync(path.join(name, "prepared.json"), JSON.stringify({ network: "hardhat" }))
fs.appendFileSync(path.join(process.env.RUNNER_TEMP, "hooks.log"), name + "\\n")
`
  )
  succeeds(
    run(
      step(
        "npm-contracts.yml",
        "Prepare and pack package without publishing credentials"
      ),
      f,
      preparationEnvironment(
        "npm-contracts.yml",
        "Prepare and pack package without publishing credentials"
      )
    )
  )
  const archive = path.join(f.root, "npm-package/publication-fixture-1.0.0.tgz")
  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" })
  succeeds(listing)
  assert.match(listing.stdout, /package\/artifacts\/prepared\.json/)
  assert.match(listing.stdout, /package\/export\/prepared\.json/)
  mutateArchiveManifest(f, (manifest) => {
    manifest.scripts.prepare = forbiddenHook
  })
  const publisher = transferPackage(t, f, "npm-contracts.yml")
  dryRunPublish("npm-contracts.yml", publisher)
  assert.equal(
    fs.readFileSync(path.join(f.root, "hooks.log"), "utf8"),
    "artifacts\nexport\n"
  )
})

test("packing cannot execute an unexpected prepare hook on npm 10 or newer", (t) => {
  const f = fixture(t, {
    prepare:
      'node -e \'require("node:fs").writeFileSync("hook-ran", "unexpected")\'',
  })
  const result = run(
    step("npm-typescript.yml", "Pack package without publishing credentials"),
    f
  )
  // npm 10 rejects the disabled shell; newer npm versions skip the hook.
  assert.ok([0, 1].includes(result.status), result.stderr)
  assert.equal(fs.existsSync(path.join(f.directory, "hook-ran")), false)
})

test("artifact preparation rejects zero or multiple archives", (t) => {
  const f = fixture(t, {})
  const prepare = step("npm-typescript.yml", "Prepare publication artifact")
  assert.notEqual(run(prepare, f).status, 0)
  fs.mkdirSync(path.join(f.root, "npm-package"))
  for (const name of ["one.tgz", "two.tgz"]) {
    fs.writeFileSync(path.join(f.root, "npm-package", name), "not an archive")
  }
  assert.notEqual(run(prepare, f).status, 0)
})

test("publication identity validation rejects missing or malformed build outputs", (t) => {
  const f = publisherFixture(t)
  const validate = step("npm-typescript.yml", "Validate artifact identity")
  for (const [id, hash] of [
    ["", "a".repeat(64)],
    ["123,456", "a".repeat(64)],
    ["123junk", "a".repeat(64)],
    ["123", ""],
    ["123", "../../package.tgz"],
  ]) {
    assert.notEqual(
      run(validate, f, { ARTIFACT_ID: id, PACKAGE_SHA256: hash }).status,
      0
    )
  }
})

test("publication verifies one regular tarball and rejects altered or extra files", (t) => {
  for (const scenario of ["missing", "extra", "changed", "symlink"]) {
    const f = publisherFixture(t)
    const directory = path.join(f.root, "npm-package")
    fs.mkdirSync(directory)
    const archive = path.join(directory, "package.tgz")
    fs.writeFileSync(archive, "expected package")
    f.env.PACKAGE_SHA256 = crypto
      .createHash("sha256")
      .update("expected package")
      .digest("hex")
    const verify = step("npm-typescript.yml", "Verify prepared package")
    succeeds(run(verify, f))
    if (scenario === "missing") fs.unlinkSync(archive)
    if (scenario === "extra")
      fs.writeFileSync(path.join(directory, ".npmrc"), "malicious config")
    if (scenario === "changed") fs.writeFileSync(archive, "different package")
    if (scenario === "symlink") {
      const other = path.join(f.root, "other.tgz")
      fs.renameSync(archive, other)
      fs.symlinkSync(other, archive)
    }
    assert.notEqual(run(verify, f).status, 0, scenario)
  }
})

test("publish jobs receive only the same-run tarball without build code or cache", () => {
  for (const workflow of ["npm-typescript.yml", "npm-contracts.yml"]) {
    const prepare = job(workflow, "prepare")
    const publish = job(workflow, "publish")
    assert.match(prepare, /^    runs-on: ubuntu-latest$/m)
    assert.match(publish, /^    runs-on: ubuntu-latest$/m)
    assert.match(publish, /^    needs: prepare$/m)
    assert.doesNotMatch(prepare, /NODE_AUTH_TOKEN|secrets\./)
    assert.match(
      prepare,
      /artifact-id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/
    )
    assert.match(
      prepare,
      /package-sha256: \$\{\{ steps\.package\.outputs\.sha256 \}\}/
    )
    assert.match(
      prepare,
      /path: \$\{\{ runner\.temp \}\}\/npm-artifact\/package\.tgz/
    )
    assert.match(
      prepare,
      /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/
    )
    const allowedActions = [
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    ]
    const actions = [...publish.matchAll(/uses: ([^ \n]+)/g)].map(
      (match) => match[1]
    )
    assert.deepEqual(actions, allowedActions)
    assert.doesNotMatch(
      publish,
      /^ {10}(?:cache|cache-dependency-path|github-token|run-id|name|pattern):/m
    )
    assert.match(
      publish,
      /artifact-ids: \$\{\{ needs\.prepare\.outputs\.artifact-id \}\}/
    )
    assert.match(publish, /merge-multiple: true/)
    assert.match(
      publish,
      /PACKAGE_SHA256: \$\{\{ needs\.prepare\.outputs\.package-sha256 \}\}/
    )
    assert.equal((publish.match(/NODE_AUTH_TOKEN/g) || []).length, 1)
    assert.deepEqual(
      [...publish.matchAll(/^      - name: (.+)$/gm)].map((match) => match[1]),
      [
        "Validate artifact identity",
        "Download this run's prepared package",
        "Verify prepared package",
        "Inspect package metadata",
        "Publish prepared package",
      ]
    )
    assert.match(
      stepBlock(workflow, "Publish prepared package").join("\n"),
      /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/
    )
    assert.match(
      step(workflow, "Publish prepared package"),
      /--ignore-scripts --script-shell=\/usr\/bin\/false/
    )
  }
})

test("publisher rejects package-controlled npm configuration before receiving credentials", (t) => {
  for (const publishConfig of [
    { proxy: "http://127.0.0.1:9", "strict-ssl": false },
    {},
    null,
  ]) {
    const f = fixture(t, packHooks)
    succeeds(
      run(
        step(
          "npm-typescript.yml",
          "Pack package without publishing credentials"
        ),
        f
      )
    )
    mutateArchiveManifest(f, (manifest) => {
      manifest.publishConfig = publishConfig
    })
    const publisher = transferPackage(t, f, "npm-typescript.yml")
    const result = run(
      step("npm-typescript.yml", "Inspect package metadata"),
      publisher
    )
    assert.notEqual(result.status, 0)
    assert.match(
      result.stderr,
      /publishConfig must not override publisher settings/
    )
  }
})
