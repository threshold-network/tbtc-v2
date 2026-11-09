#!/usr/bin/env node
// Fails loudly if foundry.toml's base compiler settings ([profile.default])
// ever drift from hardhat.config.ts's base compiler settings (the first,
// override-free entry of solidity.compilers), or if foundry.toml's
// per-contract compilation_restrictions ever drift from hardhat.config.ts's
// solidity.overrides map. Both files are small, hand-maintained configs, so
// plain line/regex extraction is used here instead of pulling in a TOML
// parser or ts-node.

const fs = require("fs")
const path = require("path")

const FOUNDRY_TOML_PATH = path.join(__dirname, "..", "foundry.toml")
const HARDHAT_CONFIG_PATH = path.join(__dirname, "..", "hardhat.config.ts")

// Finds the index of the `}` that matches the `{` at `openBraceIndex`, using
// brace counting so nested object literals (e.g. an inline override's
// `settings: { optimizer: { ... } }`) are handled correctly instead of
// stopping at the first `}` encountered.
function findMatchingBrace(text, openBraceIndex) {
  let depth = 0
  for (let i = openBraceIndex; i < text.length; i += 1) {
    if (text[i] === "{") {
      depth += 1
    } else if (text[i] === "}") {
      depth -= 1
      if (depth === 0) {
        return i
      }
    }
  }
  throw new Error(`Unbalanced braces starting at offset ${openBraceIndex}`)
}

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
// array or in the separate `overrides` map. The compilers[0] object span is
// located first via brace matching (the first `{...}` after `compilers: [`),
// then version/enabled/runs are searched for independently within that
// span, so reordering those keys, adding fields (e.g. `viaIR`), or
// inserting a comment inside the object does not break extraction.
function extractHardhatBaseCompiler(text) {
  const compilersHeaderMatch = text.match(/compilers\s*:\s*\[\s*\{/)
  if (!compilersHeaderMatch) {
    throw new Error(
      "Could not find the start of the solidity.compilers array in " +
        `${HARDHAT_CONFIG_PATH}`
    )
  }

  const openBraceIndex =
    compilersHeaderMatch.index + compilersHeaderMatch[0].length - 1
  const closeBraceIndex = findMatchingBrace(text, openBraceIndex)
  const compilerEntry = text.slice(openBraceIndex, closeBraceIndex + 1)

  const versionMatch = compilerEntry.match(/version\s*:\s*"([^"]+)"/)
  const enabledMatch = compilerEntry.match(/enabled\s*:\s*(true|false)/)
  const runsMatch = compilerEntry.match(/runs\s*:\s*(\d+)/)

  if (!versionMatch || !enabledMatch || !runsMatch) {
    throw new Error(
      "Could not extract the base solidity.compilers[0] entry from " +
        `${HARDHAT_CONFIG_PATH}`
    )
  }

  return {
    version: versionMatch[1],
    optimizerEnabled: enabledMatch[1] === "true",
    optimizerRuns: parseInt(runsMatch[1], 10),
  }
}

// Extracts the `paths -> optimizer_runs` entries from foundry.toml's
// `compilation_restrictions` array, which mirrors hardhat.config.ts's
// `solidity.overrides` map (see extractHardhatOverrides below) for the same
// per-contract optimizer_runs overrides. Scanning stops at the array's
// closing `]`.
function extractFoundryCompilationRestrictions(text) {
  const arrayHeaderMatch = text.match(/^compilation_restrictions\s*=\s*\[/m)
  if (!arrayHeaderMatch) {
    throw new Error(
      `Could not find compilation_restrictions array in ${FOUNDRY_TOML_PATH}`
    )
  }

  const rest = text.slice(arrayHeaderMatch.index + arrayHeaderMatch[0].length)
  const arrayEndMatch = rest.match(/\]/)
  if (!arrayEndMatch) {
    throw new Error(
      "Could not find the end of compilation_restrictions array in " +
        `${FOUNDRY_TOML_PATH}`
    )
  }
  const arrayBody = rest.slice(0, arrayEndMatch.index)

  const entryPattern =
    /\{\s*paths\s*=\s*"([^"]+)"\s*,\s*optimizer_runs\s*=\s*(\d+)\s*,?\s*\}/g
  const restrictions = new Map()
  let entryMatch = entryPattern.exec(arrayBody)
  while (entryMatch !== null) {
    restrictions.set(entryMatch[1], parseInt(entryMatch[2], 10))
    entryMatch = entryPattern.exec(arrayBody)
  }

  if (restrictions.size === 0) {
    throw new Error(
      "Could not extract any entries from compilation_restrictions in " +
        `${FOUNDRY_TOML_PATH}`
    )
  }

  return restrictions
}

// Resolves the `runs` value of a top-level `const NAME = { ... }` compiler
// config declared earlier in hardhat.config.ts (e.g.
// `ecdsaSolidityCompilerConfig`, `bridgeGovernanceCompilerConfig`), so
// overrides that reference these named constants by identifier can be
// compared against foundry.toml's compilation_restrictions just like inline
// overrides are.
function extractNamedCompilerConfigRuns(text, name) {
  const declarationMatch = text.match(
    new RegExp(`const\\s+${name}\\s*=\\s*\\{`)
  )
  if (!declarationMatch) {
    throw new Error(
      `Could not find "const ${name} = {" declaration in ${HARDHAT_CONFIG_PATH}`
    )
  }

  const openBraceIndex = declarationMatch.index + declarationMatch[0].length - 1
  const closeBraceIndex = findMatchingBrace(text, openBraceIndex)
  const configBody = text.slice(openBraceIndex, closeBraceIndex + 1)

  const runsMatch = configBody.match(/runs\s*:\s*(\d+)/)
  if (!runsMatch) {
    throw new Error(
      `Could not extract "runs" from ${name} in ${HARDHAT_CONFIG_PATH}`
    )
  }

  return parseInt(runsMatch[1], 10)
}

// Extracts the `path -> optimizer runs` entries from hardhat.config.ts's
// `solidity.overrides` map, which mirrors foundry.toml's
// `compilation_restrictions` array (see extractFoundryCompilationRestrictions
// above). Each entry's value is either an inline compiler config object or a
// reference to a named `const` declared earlier in the file; both forms are
// resolved down to their `runs` value. The overrides object's span is
// located via brace matching so nested inline configs don't confuse the
// per-entry scan.
function extractHardhatOverrides(text) {
  const headerMatch = text.match(/overrides\s*:\s*\{/)
  if (!headerMatch) {
    throw new Error(
      `Could not find solidity.overrides map in ${HARDHAT_CONFIG_PATH}`
    )
  }

  const openBraceIndex = headerMatch.index + headerMatch[0].length - 1
  const closeBraceIndex = findMatchingBrace(text, openBraceIndex)
  const body = text.slice(openBraceIndex + 1, closeBraceIndex)

  const overrides = new Map()
  const entryHeaderPattern = /"([^"]+)"\s*:\s*/g
  let entryMatch = entryHeaderPattern.exec(body)
  while (entryMatch !== null) {
    const overridePath = entryMatch[1]
    const valueStart = entryHeaderPattern.lastIndex

    if (body[valueStart] === "{") {
      const valueEnd = findMatchingBrace(body, valueStart)
      const inlineConfig = body.slice(valueStart, valueEnd + 1)
      const runsMatch = inlineConfig.match(/runs\s*:\s*(\d+)/)
      if (!runsMatch) {
        throw new Error(
          `Could not extract "runs" from the inline override for "${overridePath}" in ${HARDHAT_CONFIG_PATH}`
        )
      }
      overrides.set(overridePath, parseInt(runsMatch[1], 10))
      entryHeaderPattern.lastIndex = valueEnd + 1
    } else {
      const identifierMatch = body
        .slice(valueStart)
        .match(/^([A-Za-z_$][A-Za-z0-9_$]*)/)
      if (!identifierMatch) {
        throw new Error(
          `Could not resolve the override value for "${overridePath}" in ` +
            `${HARDHAT_CONFIG_PATH}`
        )
      }
      overrides.set(
        overridePath,
        extractNamedCompilerConfigRuns(text, identifierMatch[1])
      )
      entryHeaderPattern.lastIndex = valueStart + identifierMatch[0].length
    }

    entryMatch = entryHeaderPattern.exec(body)
  }

  if (overrides.size === 0) {
    throw new Error(
      `Could not extract any entries from solidity.overrides in ${HARDHAT_CONFIG_PATH}`
    )
  }

  return overrides
}

// Foundry (via forge's node_modules-relative import resolution) references
// library contracts with a leading `node_modules/`, while hardhat.config.ts's
// overrides map keys are plain package-relative paths (Node module
// resolution already implies node_modules/). Strip that prefix before
// comparing paths so this known, harmless convention difference doesn't get
// flagged as a drift.
function normalizeCompilationPath(compilationPath) {
  return compilationPath.replace(/^node_modules\//, "")
}

function main() {
  const foundryText = fs.readFileSync(FOUNDRY_TOML_PATH, "utf8")
  const hardhatText = fs.readFileSync(HARDHAT_CONFIG_PATH, "utf8")

  const foundry = extractFoundryDefaults(foundryText)
  const hardhat = extractHardhatBaseCompiler(hardhatText)
  const foundryOverrides = extractFoundryCompilationRestrictions(foundryText)
  const hardhatOverrides = extractHardhatOverrides(hardhatText)

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

  // hardhat.config.ts sets no explicit evmVersion, so it inherits solc
  // 0.8.17's own default target (london, per solc's release-time default at
  // that version). foundry.toml's evm_version has no hardhat.config.ts
  // counterpart to diff against directly, so pin it against that known
  // implicit default instead of leaving it unchecked.
  if (foundry.evmVersion !== "london") {
    mismatches.push(
      "evm_version: foundry.toml [profile.default].evm_version = " +
        `"${foundry.evmVersion}", but hardhat.config.ts sets no explicit ` +
        "evmVersion so it relies on solc 0.8.17's own default target " +
        "of london - update this check if the pinned solc version changes."
    )
  }

  if (!hardhat.optimizerEnabled) {
    mismatches.push(
      "optimizer disabled: hardhat.config.ts " +
        `compilers[0].settings.optimizer.enabled = ${hardhat.optimizerEnabled} ` +
        "(expected true)"
    )
  }

  // foundry.toml's compilation_restrictions paths are node_modules-relative
  // (forge's own import resolution convention); hardhat.config.ts's
  // overrides map keys are package-relative (Node resolution already
  // implies node_modules/). Normalize both sides to the same convention
  // before diffing so that known, harmless path-prefix difference doesn't
  // get flagged as a drift.
  const normalizedFoundryOverrides = new Map(
    Array.from(foundryOverrides, ([overridePath, runs]) => [
      normalizeCompilationPath(overridePath),
      runs,
    ])
  )

  const overridePaths = new Set([
    ...normalizedFoundryOverrides.keys(),
    ...hardhatOverrides.keys(),
  ])

  overridePaths.forEach((overridePath) => {
    const foundryRuns = normalizedFoundryOverrides.get(overridePath)
    const hardhatRuns = hardhatOverrides.get(overridePath)

    if (foundryRuns === undefined) {
      mismatches.push(
        `per-contract optimizer_runs: "${overridePath}" is overridden in ` +
          `hardhat.config.ts's solidity.overrides (runs = ${hardhatRuns}) ` +
          "but has no matching entry in foundry.toml's " +
          "compilation_restrictions"
      )
    } else if (hardhatRuns === undefined) {
      mismatches.push(
        `per-contract optimizer_runs: "${overridePath}" is restricted in ` +
          "foundry.toml's compilation_restrictions " +
          `(optimizer_runs = ${foundryRuns}) but has no matching entry in ` +
          "hardhat.config.ts's solidity.overrides"
      )
    } else if (foundryRuns !== hardhatRuns) {
      mismatches.push(
        `per-contract optimizer_runs: "${overridePath}" foundry.toml ` +
          `compilation_restrictions.optimizer_runs = ${foundryRuns}, ` +
          `hardhat.config.ts solidity.overrides runs = ${hardhatRuns}`
      )
    }
  })

  if (mismatches.length > 0) {
    console.error(
      "Foundry/Hardhat base compiler settings have drifted out of sync:"
    )
    mismatches.forEach((mismatch) => console.error(`  - ${mismatch}`))
    console.error(
      "\nUpdate solidity/foundry.toml's [profile.default]/" +
        "compilation_restrictions and/or hardhat.config.ts's first " +
        "solidity.compilers entry/overrides map so they match again."
    )
    process.exit(1)
  }

  console.log(
    "Foundry/Hardhat base compiler settings match: " +
      `solc ${foundry.solc} (evm_version ${foundry.evmVersion}), ` +
      `optimizer enabled, ${foundry.optimizerRuns} runs. ` +
      `${overridePaths.size} per-contract optimizer_runs override(s) also match.`
  )
  process.exit(0)
}

main()
