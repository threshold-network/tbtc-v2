const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { test } = require("node:test")
const { ESLint } = require("eslint")

const root = path.resolve(__dirname, "..")

// Real files are required: import/no-cycle traverses the imported export maps.
// Keep them inside the lint tsconfig, and remove them even when a check fails.
test("the repository ESLint policy rejects regressions", async (context) => {
  const testDir = path.join(root, "test")
  fs.readdirSync(testDir).forEach((entry) => {
    if (entry.startsWith("eslint-policy-")) {
      fs.rmSync(path.join(testDir, entry), { recursive: true, force: true })
    }
  })
  const directory = fs.mkdtempSync(path.join(root, "test/eslint-policy-"))
  const sources = {
    "cycle-a.ts": `import next from "./cycle-b"

export default function current(value: number): number {
  return value > 0 ? next(value - 1) : value
}
`,
    "cycle-b.ts": `import next from "./cycle-a"

export default function current(value: number): number {
  return value > 0 ? next(value - 1) : value
}
`,
    "acyclic-a.ts": `import next from "./acyclic-b"

export default function current(value: number): number {
  return next(value)
}
`,
    "acyclic-b.ts": `export default function current(value: number): number {
  return value + 1
}
`,
    "example.test.ts": `describe.only("x", () => {})
`,
  }

  try {
    Object.entries(sources).forEach(([name, source]) => {
      fs.writeFileSync(path.join(directory, name), source)
    })
    const eslint = new ESLint({ cwd: root })
    const javascriptPath = path.join(
      root,
      "deploy-patches/lint-policy-check.js"
    )
    const lintJavaScript = async (source) => {
      const [result] = await eslint.lintText(source, {
        filePath: javascriptPath,
      })
      return result
    }
    // example.test.ts is written into the temp directory up front (with the
    // other .ts fixtures), before the typescript-eslint parser builds its
    // program, so it is covered by tsconfig.eslint.json's include glob.
    const lintTestTypescript = async () => {
      const [result] = await eslint.lintFiles([
        path.join(directory, "example.test.ts"),
      ])
      return result
    }

    await context.test(
      "detects a cycle through TypeScript exports",
      async () => {
        const results = await eslint.lintFiles([
          path.join(directory, "cycle-a.ts"),
          path.join(directory, "cycle-b.ts"),
        ])
        assert.equal(results.length, 2, "expected two files to be linted")
        results.forEach((result) => {
          assert.ok(
            result.messages.some(
              (message) =>
                message.ruleId === "import/no-cycle" && message.severity === 2
            ),
            `${result.filePath}: ${JSON.stringify(result.messages)}`
          )
        })
      }
    )

    await context.test("accepts an acyclic TypeScript import", async () => {
      const results = await eslint.lintFiles([
        path.join(directory, "acyclic-a.ts"),
        path.join(directory, "acyclic-b.ts"),
      ])
      assert.equal(results.length, 2, "expected two files to be linted")
      results.forEach((result) => {
        assert.equal(result.errorCount, 0, JSON.stringify(result.messages))
      })
    })

    const functionConstructors = [
      ["Function", "no-new-func"],
      ...["global", "globalThis", "window"].flatMap((object) =>
        [".Function", '["Function"]'].map((member) => [
          `${object}${member}`,
          "no-restricted-syntax",
        ])
      ),
    ]
    await Promise.all(
      functionConstructors.flatMap(([constructor, rule]) =>
        ["", "new "].map((prefix) =>
          context.test(
            `rejects JavaScript ${prefix}${constructor}`,
            async () => {
              const result =
                await lintJavaScript(`module.exports = function deploy() {
  return ${prefix}${constructor}("return 1")
}`)
              assert.ok(
                result.messages.some(
                  (message) => message.ruleId === rule && message.severity === 2
                ),
                JSON.stringify(result.messages)
              )
            }
          )
        )
      )
    )

    await context.test("allows Function references without calls", async () => {
      const result = await lintJavaScript(`module.exports = function deploy() {
  return [Function, global.Function, typeof globalThis.Function, globalThis.Function.prototype]
}`)
      assert.equal(result.errorCount, 0, JSON.stringify(result.messages))
      assert.equal(result.warningCount, 0, JSON.stringify(result.messages))
    })

    const violations = {
      "no-array-constructor": `module.exports = function deploy() {
  return new Array(1, 2)
}
`,
      "no-empty-function": `module.exports = class Deployment {
  constructor() {}
}
`,
      "dot-notation": `module.exports = function deploy(value) {
  return value["amount"]
}
`,
      "no-dupe-class-members": `module.exports = class Deployment {
  amount() { return 1 }
  amount() { return 2 }
}
`,
      "no-implied-eval": `module.exports = function deploy() {
  return setTimeout("deploy()", 1)
}
`,
      "no-redeclare": `module.exports = function deploy(value) {
  var value = 1
  return value
}
`,
      "no-useless-constructor": `module.exports = class Foo {
  constructor() {}
}
`,
      "no-unused-expressions": `module.exports = function deploy(value) {
  value === 1
}
`,
      "no-shadow": `const value = 1
module.exports = function deploy(value) {
  return value + 1
}
module.exports.value = value
`,
      "no-loop-func": `module.exports = function deploy() {
  const callbacks = []
  let index = 0
  for (; index < 2; index += 1) {
    callbacks.push(() => index)
  }
  return callbacks
}
`,
      "no-throw-literal": `module.exports = function deploy() {
  throw "deployment failed"
}
`,
    }
    await Promise.all(
      Object.entries(violations).map(([rule, source]) =>
        context.test(`rejects JavaScript ${rule}`, async () => {
          const result = await lintJavaScript(source)
          assert.ok(
            result.messages.some(
              (message) => message.ruleId === rule && message.severity === 2
            ),
            JSON.stringify(result.messages)
          )
        })
      )
    )

    await context.test(
      "retains JavaScript unused-variable warnings",
      async () => {
        const result =
          await lintJavaScript(`module.exports = function deploy(value) {
  const unused = value + 1
  return value
}`)
        assert.ok(
          result.messages.some(
            (message) =>
              message.ruleId === "no-unused-vars" && message.severity === 1
          ),
          JSON.stringify(result.messages)
        )
      }
    )

    await context.test(
      "allows omitted properties when collecting the rest",
      async () => {
        const result =
          await lintJavaScript(`module.exports = function deploy({ removed, ...rest }) {
  return rest
}`)
        assert.equal(result.errorCount, 0, JSON.stringify(result.messages))
        assert.equal(result.warningCount, 0, JSON.stringify(result.messages))
      }
    )

    await context.test(
      "preserves the JavaScript deployment overrides",
      async () => {
        const result =
          await lintJavaScript(`module.exports = async function () {
  const path = require("node:path")
  for (const entry of ["first", "second"]) {
    if (entry === "first") continue
    await Promise.resolve(entry)
    console.log(path.basename(entry))
  }
}`)
        assert.equal(result.errorCount, 0, JSON.stringify(result.messages))
        assert.equal(result.warningCount, 0, JSON.stringify(result.messages))
      }
    )

    // NEW TEST CASES
    await context.test(
      "flags waffle.loadFixture as restricted property",
      async () => {
        const result =
          await lintJavaScript(`module.exports = function deploy() {
  return waffle.loadFixture(fixture)
}`)
        assert.ok(
          result.messages.some(
            (message) =>
              message.ruleId === "no-restricted-properties" &&
              message.severity === 2
          ),
          JSON.stringify(result.messages)
        )
      }
    )

    await context.test("flags describe.only in test files", async () => {
      const result = await lintTestTypescript()
      assert.ok(
        result.messages.some(
          (message) =>
            message.ruleId === "no-only-tests/no-only-tests" &&
            message.severity === 2
        ),
        JSON.stringify(result.messages)
      )
    })

    await context.test("reports unused eslint-disable directive", async () => {
      const result =
        await lintJavaScript(`// eslint-disable-next-line no-console
module.exports = function deploy() {
  return 1
}`)
      // The message may have ruleId null or contain the text
      const unusedMsg = result.messages.find(
        (m) =>
          m.ruleId === null ||
          (m.message && m.message.includes("Unused eslint-disable directive"))
      )
      assert.ok(
        unusedMsg,
        `Expected unused eslint-disable directive message. Got: ${JSON.stringify(
          result.messages
        )}`
      )
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
