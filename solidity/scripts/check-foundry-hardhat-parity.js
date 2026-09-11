#!/usr/bin/env node
// Fails loudly if foundry.toml's base compiler settings ([profile.default])
// ever drift from hardhat.config.ts's base compiler settings (the first,
// override-free entry of solidity.compilers). Both files are small,
// hand-maintained configs, so plain line/regex extraction is used here
// instead of pulling in a TOML parser or ts-node.

const fs = require("fs")
const path = require("path")

const FOUNDRY_TOML_PATH = path.join(__dirname, "..", "foundry.toml")
const HARDHAT_CONFIG_PATH = path.join(__dirname, "..", "hardhat.config.ts")

// Extracts solc/evm_version/optimizer/optimizer_runs from foundry.toml's
// [profile.default] section. Scanning stops at the next `[`-prefixed section
// header or the `remappings = [` array opener, whichever comes first, so
// unrelated profiles (e.g. [profile.default.fuzz]) or the remappings array
// contents are never mistaken for compiler settings.
function extractFoundryDefaults(text) {
  const sectionHeaderMatch = text.match(/^\[profile\.default\]\s*$/m)
  if (!sectionHeaderMatch) {
    throw new Error(
      `Could not find [profile.default] section in ${FOUNDRY_TOML_PATH}`
    )
  }

  const rest = text.slice(
    sectionHeaderMatch.index + sectionHeaderMatch[0].length
  )
  const nextHeaderMatch = rest.match(/^\[/m)
  const remappingsMatch = rest.match(/^remappings\s*=\s*\[/m)
  const stopIndexes = [nextHeaderMatch, remappingsMatch]
    .filter(Boolean)
    .map((match) => match.index)
  const sectionEnd =
    stopIndexes.length > 0 ? Math.min(...stopIndexes) : rest.length
  const section = rest.slice(0, sectionEnd)

  const solcMatch = section.match(/^solc\s*=\s*"([^"]+)"/m)
  const evmVersionMatch = section.match(/^evm_version\s*=\s*"([^"]+)"/m)
  const optimizerMatch = section.match(/^optimizer\s*=\s*(true|false)/m)
  const optimizerRunsMatch = section.match(/^optimizer_runs\s*=\s*(\d+)/m)

  if (
    !solcMatch ||
    !evmVersionMatch ||
    !optimizerMatch ||
    !optimizerRunsMatch
  ) {
    throw new Error(
      "Could not extract solc/evm_version/optimizer/optimizer_runs from " +
        `[profile.default] in ${FOUNDRY_TOML_PATH}`
    )
  }

  return {
    solc: solcMatch[1],
    evmVersion: evmVersionMatch[1],
    optimizer: optimizerMatch[1] === "true",
    optimizerRuns: parseInt(optimizerRunsMatch[1], 10),
  }
}

// Extracts version/settings.optimizer from the FIRST object literal of
// hardhat.config.ts's `solidity.compilers` array — the base/default
// compiler config, not the per-path overrides that live later in the
// array or in the separate `overrides` map. Anchoring the regex directly
// on `compilers: [` guarantees only that first entry can match.
function extractHardhatBaseCompiler(text) {
  const match = text.match(
    /compilers\s*:\s*\[\s*\{\s*version\s*:\s*"([^"]+)"\s*,\s*settings\s*:\s*\{\s*optimizer\s*:\s*\{\s*enabled\s*:\s*(true|false)\s*,\s*runs\s*:\s*(\d+)\s*,?\s*\}\s*,?\s*\}\s*,?\s*\}/
  )

  if (!match) {
    throw new Error(
      "Could not extract the base solidity.compilers[0] entry from " +
        `${HARDHAT_CONFIG_PATH}`
    )
  }

  return {
    version: match[1],
    optimizerEnabled: match[2] === "true",
    optimizerRuns: parseInt(match[3], 10),
  }
}

function main() {
  const foundryText = fs.readFileSync(FOUNDRY_TOML_PATH, "utf8")
  const hardhatText = fs.readFileSync(HARDHAT_CONFIG_PATH, "utf8")

  const foundry = extractFoundryDefaults(foundryText)
  const hardhat = extractHardhatBaseCompiler(hardhatText)

  const mismatches = []

  if (foundry.solc !== hardhat.version) {
    mismatches.push(
      `solc version: foundry.toml [profile.default].solc = "${foundry.solc}", ` +
        `hardhat.config.ts compilers[0].version = "${hardhat.version}"`
    )
  }

  if (foundry.optimizerRuns !== hardhat.optimizerRuns) {
    mismatches.push(
      "optimizer runs: foundry.toml [profile.default].optimizer_runs = " +
        `${foundry.optimizerRuns}, hardhat.config.ts ` +
        `compilers[0].settings.optimizer.runs = ${hardhat.optimizerRuns}`
    )
  }

  if (!foundry.optimizer) {
    mismatches.push(
      "optimizer disabled: foundry.toml [profile.default].optimizer = " +
        `${foundry.optimizer} (expected true)`
    )
  }

  if (!hardhat.optimizerEnabled) {
    mismatches.push(
      "optimizer disabled: hardhat.config.ts " +
        `compilers[0].settings.optimizer.enabled = ${hardhat.optimizerEnabled} ` +
        "(expected true)"
    )
  }

  if (mismatches.length > 0) {
    console.error(
      "Foundry/Hardhat base compiler settings have drifted out of sync:"
    )
    mismatches.forEach((mismatch) => console.error(`  - ${mismatch}`))
    console.error(
      "\nUpdate solidity/foundry.toml's [profile.default] and/or the first " +
        "entry of hardhat.config.ts's solidity.compilers array so they match again."
    )
    process.exit(1)
  }

  console.log(
    "Foundry/Hardhat base compiler settings match: " +
      `solc ${foundry.solc} (evm_version ${foundry.evmVersion}), ` +
      `optimizer enabled, ${foundry.optimizerRuns} runs.`
  )
  process.exit(0)
}

main()
