import { spawnSync } from "child_process"
import { join } from "path"
import { mkdirSync, readFileSync, rmSync } from "fs"

const FIXTURE_DIR = join(__dirname, "fixtures", "local-networks-config")
const HARDHAT_CONFIG = join(FIXTURE_DIR, "hardhat.config.ts")
const ERROR_CONFIG = join(FIXTURE_DIR, "error-config", "hardhat.config.ts")
const ASSERT_SCRIPT = join(FIXTURE_DIR, "assert.ts")
const HARDHAT_CLI = join(
  __dirname,
  "..",
  "node_modules",
  "hardhat",
  "internal",
  "cli",
  "cli.js"
)
const STARKNET_ROOT = join(__dirname, "..")
const OUT_DIR = join(FIXTURE_DIR, "out")

const scenarios = [
  {
    name: "scenario1",
    homeDir: join(FIXTURE_DIR, "home-files", "scenario1"),
    description:
      "network declared in hardhat.config.ts merges home/project-local defaults",
  },
  {
    name: "scenario2",
    homeDir: join(FIXTURE_DIR, "home-files", "scenario2"),
    description:
      "network only in project-local config is added; matching home entry dropped (#1146)",
  },
  {
    name: "scenario3",
    homeDir: join(FIXTURE_DIR, "home-files", "scenario3"),
    description: "network only in ~/.hardhat/networks.json is added",
  },
  {
    name: "scenario4",
    homeDir: join(FIXTURE_DIR, "home-files", "scenario4"),
    description:
      "network in both project-local and home config keeps project-local values, home dropped (#1146)",
  },
  {
    name: "scenario5",
    homeDir: join(FIXTURE_DIR, "home-files", "scenario1"),
    config: ERROR_CONFIG,
    expectFailure: true,
    description:
      "configured localNetworksConfig file that does not exist fails hardhat with a plugin error",
  },
]

function runHardhatRun(scenario: (typeof scenarios)[0]): void {
  const outFile = join(OUT_DIR, `${scenario.name}.json`)
  rmSync(outFile, { force: true })

  const env = {
    ...process.env,
    HOME: scenario.homeDir,
    TEST_SCENARIO: scenario.name,
    OUT_FILE: outFile,
  }

  const result = spawnSync(
    process.execPath,
    [
      HARDHAT_CLI,
      "--config",
      scenario.config || HARDHAT_CONFIG,
      "run",
      ASSERT_SCRIPT,
    ],
    { cwd: STARKNET_ROOT, env, encoding: "utf8", timeout: 180000 }
  )

  if (scenario.expectFailure) {
    if (result.status === 0) {
      throw new Error(
        `scenario ${scenario.name}: expected hardhat run to fail, but it exited 0`
      )
    }
    const stderr = result.stderr || ""
    if (!stderr.includes("configuration file not found")) {
      throw new Error(
        `scenario ${scenario.name}: expected a plugin 'configuration file not found' error, got:\n` +
          stderr.slice(-2000)
      )
    }
    return
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").slice(-3000)
    const stdout = (result.stdout || "").slice(-3000)
    throw new Error(
      `scenario ${scenario.name}: hardhat run exited ${result.status}\n` +
        `stdout:\n${stdout}\nstderr:\n${stderr}`
    )
  }

  const summary = JSON.parse(readFileSync(outFile, "utf8")) as {
    scenario: string
    status: string
  }
  if (summary.status !== "passed" || summary.scenario !== scenario.name) {
    throw new Error(
      `scenario ${scenario.name}: unexpected summary ${JSON.stringify(summary)}`
    )
  }
}

describe("local-networks-config plugin merge behavior", function () {
  this.timeout(600000)

  before(() => {
    mkdirSync(OUT_DIR, { recursive: true })
  })

  for (const scenario of scenarios) {
    it(scenario.description, function () {
      runHardhatRun(scenario)
    })
  }
})
