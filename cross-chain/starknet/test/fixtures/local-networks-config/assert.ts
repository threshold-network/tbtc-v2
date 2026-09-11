// `hardhat run` executes this file as a script. The documented way to access
// the runtime environment in run scripts is require("hardhat"), which returns
// the HRE; the assertion logic below runs at top level (a default export would
// never be invoked). Expected values pin the CURRENT behavior of the frozen
// vendored plugin (deepmerge.concat arrays, home-entry precedence quirks) —
// see the known-quirks notes in local-networks-config/index.ts and
// threshold-network/tbtc-v2#1146.
import hre = require("hardhat")
import { writeFileSync } from "fs"

const env = hre as unknown as import("hardhat/types").HardhatRuntimeEnvironment

const scenario = process.env.TEST_SCENARIO
const outFile = process.env.OUT_FILE

function run(): void {
  if (!scenario) throw new Error("TEST_SCENARIO environment variable not set")
  if (!outFile) throw new Error("OUT_FILE environment variable not set")

  const { networks } = env.config

  function expect(actual: unknown, expected: unknown, label: string): void {
    const actualJson = JSON.stringify(actual)
    const expectedJson = JSON.stringify(expected)
    if (actualJson !== expectedJson) {
      throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`)
    }
  }

  switch (scenario) {
    case "scenario1": {
      // sepolia is declared in the fixture hardhat.config.ts, so the
      // user-declared loop merges [resolved, homeDefault, homeSepolia,
      // localDefault, userConfig, localSepolia].
      const sepolia = networks.sepolia
      if (!sepolia) throw new Error("sepolia network not found")
      // deepmerge concatenates arrays: resolved + userConfig accounts are the
      // same list, so the deployer accounts array is duplicated (quirk, #1146).
      expect(
        sepolia.accounts,
        [
          "0x1111111111111111111111111111111111111111111111111111111111111111",
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        ],
        "scenario1 accounts"
      )
      expect(
        sepolia.tags,
        [
          "home-default-tag",
          "home-sepolia-tag",
          "project-local-tag",
          "project-local-sepolia-tag",
        ],
        "scenario1 tags"
      )
      expect(
        sepolia.deploy,
        [
          "home-default-deploy",
          "home-sepolia-deploy",
          "project-local-deploy-script",
          "project-local-sepolia-deploy",
        ],
        "scenario1 deploy"
      )
      expect(sepolia.gasPrice, 30000000000, "scenario1 gasPrice")
      expect(sepolia.from, "0xprojectlocalfrom", "scenario1 from")
      expect(sepolia.url, "https://sepolia.example.invalid", "scenario1 url")
      expect(sepolia.chainId, 11155111, "scenario1 chainId")
      break
    }

    case "scenario2": {
      // localOnly exists only in the project-local config, so the
      // local-only loop merges [{}, homeDefault, localDefault, localNetwork].
      // The matching home per-network entry (home-localOnly-tag/deploy/
      // gasPrice 1.2e10) is intentionally NOT merged here — the home-drop
      // quirk, deliberately preserved (#1146).
      const localOnly = networks.localOnly
      if (!localOnly) throw new Error("localOnly network not found")
      expect(
        localOnly.accounts,
        ["0x2222222222222222222222222222222222222222222222222222222222222222"],
        "scenario2 accounts"
      )
      expect(
        localOnly.tags,
        ["home-default-tag", "project-local-tag", "project-local-only-tag"],
        "scenario2 tags"
      )
      expect(
        localOnly.deploy,
        [
          "home-default-deploy",
          "project-local-deploy-script",
          "project-local-only-deploy",
        ],
        "scenario2 deploy"
      )
      expect(localOnly.gasPrice, 40000000000, "scenario2 gasPrice")
      expect(localOnly.url, "http://localOnly.example.invalid", "scenario2 url")
      break
    }

    case "scenario3": {
      // homeOnly exists only in ~/.hardhat/networks.json, so the home-only
      // loop merges [{}, homeDefault, localDefault, homeNetwork]; the home
      // per-network entry is merged last and wins over the project-local
      // default (precedence quirk, #1146).
      const homeOnly = networks.homeOnly
      if (!homeOnly) throw new Error("homeOnly network not found")
      expect(
        homeOnly.accounts,
        ["0x4444444444444444444444444444444444444444444444444444444444444444"],
        "scenario3 accounts"
      )
      expect(
        homeOnly.tags,
        ["home-default-tag", "project-local-tag", "home-only-tag"],
        "scenario3 tags"
      )
      expect(
        homeOnly.deploy,
        [
          "home-default-deploy",
          "project-local-deploy-script",
          "home-only-deploy",
        ],
        "scenario3 deploy"
      )
      expect(homeOnly.gasPrice, 12000000000, "scenario3 gasPrice")
      expect(homeOnly.url, "http://homeOnly.example.invalid", "scenario3 url")
      break
    }

    case "scenario4": {
      // bothLocalAndHome exists in BOTH the project-local config and
      // ~/.hardhat/networks.json (absent from hardhat.config.ts). The
      // local-only loop runs first and its merge omits the home per-network
      // entry, so the home overrides (0x555 accounts, gasPrice 6e10,
      // home-both-tag/deploy) are silently dropped — the home-drop quirk,
      // deliberately preserved (#1146).
      const both = networks.bothLocalAndHome
      if (!both) throw new Error("bothLocalAndHome network not found")
      expect(
        both.accounts,
        ["0x3333333333333333333333333333333333333333333333333333333333333333"],
        "scenario4 accounts"
      )
      expect(
        both.tags,
        ["home-default-tag", "project-local-tag", "project-local-both-tag"],
        "scenario4 tags"
      )
      expect(
        both.deploy,
        [
          "home-default-deploy",
          "project-local-deploy-script",
          "project-local-both-deploy",
        ],
        "scenario4 deploy"
      )
      expect(both.gasPrice, 50000000000, "scenario4 gasPrice")
      expect(
        both.url,
        "http://bothLocalAndHome.example.invalid",
        "scenario4 url"
      )
      break
    }

    default:
      throw new Error(`Unknown scenario: ${scenario}`)
  }

  writeFileSync(outFile, JSON.stringify({ scenario, status: "passed" }))
}

try {
  run()
  console.log(`scenario ${scenario}: passed`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
