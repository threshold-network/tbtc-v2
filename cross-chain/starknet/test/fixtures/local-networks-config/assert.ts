// `hardhat run` executes this file as a script and exposes the runtime
// environment as a global `hre`. Assertions run at top level (a default
// export would never be invoked); on mismatch the thrown error propagates
// to hardhat, which exits non-zero — the mocha driver treats non-zero
// exit + stderr as the failure signal. On success the resolved network
// summary is written to OUT_FILE for the driver.
// Expected values pin the merge behavior of the threshold-network fork of
// @keep-network/hardhat-local-networks-config: the deepmerge array-concat
// quirk is kept, and the home per-network override now merges at lower
// precedence in the local-only path (the fork's recorded deviation (a),
// replacing the upstream home-drop quirk; remaining quirks tracked in
// threshold-network/tbtc-v2#1146).
import { writeFileSync } from "fs"

declare const hre: import("hardhat/types").HardhatRuntimeEnvironment

const scenario = process.env.TEST_SCENARIO
const outFile = process.env.OUT_FILE

function run(): void {
  if (!scenario) throw new Error("TEST_SCENARIO environment variable not set")
  if (!outFile) throw new Error("OUT_FILE environment variable not set")

  const { networks } = hre.config

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
      const sepolia = networks.sepolia as unknown as
        | Record<string, unknown>
        | undefined
      if (!sepolia) throw new Error("sepolia network not found")
      // deepmerge concatenates arrays: resolved + userConfig carry the same
      // accounts list, so the deployer accounts array is duplicated (quirk).
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
      // local-only loop merges [{}, homeDefault, homeLocalOnly,
      // localDefault, localNetwork]. The matching home per-network entry
      // merges at lower precedence than the project-local values (fork
      // deviation (a): the upstream home-drop quirk is fixed).
      const localOnly = networks.localOnly as unknown as
        | Record<string, unknown>
        | undefined
      if (!localOnly) throw new Error("localOnly network not found")
      expect(
        localOnly.accounts,
        ["0x2222222222222222222222222222222222222222222222222222222222222222"],
        "scenario2 accounts"
      )
      expect(
        localOnly.tags,
        ["home-default-tag", "home-localOnly-tag", "project-local-tag", "project-local-only-tag"],
        "scenario2 tags"
      )
      expect(
        localOnly.deploy,
        [
          "home-default-deploy",
          "home-localOnly-deploy",
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
      const homeOnly = networks.homeOnly as unknown as
        | Record<string, unknown>
        | undefined
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
      // local-only loop merges the home per-network entry at lower
      // precedence, so the home overrides (0x555 accounts, gasPrice 6e10,
      // home-both-tag/deploy) merge in but the project-local per-network
      // values still win (fork deviation (a); upstream silently dropped the
      // home entry — the home-drop quirk, now fixed).
      const both = networks.bothLocalAndHome as unknown as
        | Record<string, unknown>
        | undefined
      if (!both) throw new Error("bothLocalAndHome network not found")
      expect(
        both.accounts,
        ["0x5555555555555555555555555555555555555555555555555555555555555555", "0x3333333333333333333333333333333333333333333333333333333333333333"],
        "scenario4 accounts"
      )
      expect(
        both.tags,
        ["home-default-tag", "home-both-tag", "project-local-tag", "project-local-both-tag"],
        "scenario4 tags"
      )
      expect(
        both.deploy,
        [
          "home-default-deploy",
          "home-both-deploy",
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

// Guard: when the full suite runs (`hardhat test` without a path), mocha
// collects this file as a spec alongside the driver; only execute when
// spawned via `hardhat run` with the driver's env.
if (scenario && outFile) {
  run()
}
