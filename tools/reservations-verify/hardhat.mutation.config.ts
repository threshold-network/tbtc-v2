// Hardhat config for the mutation harness: the target worktree's own config, with Mocha's reporter
// replaced by the one that writes a JSON report to the file named in MUTATION_JSON.
//
// Nothing here is pinned to the checkout this file lives in: the project comes from
// MUTATION_TBTC_ROOT, which mutate.cjs sets from the worktree it was told to mutate. A harness in one
// directory can therefore drive a worktree in another, and a run without the variable fails here
// instead of quietly compiling the harness's own tree.
//
// Mocha takes the reporter as a constructor, not as a path, so the module is loaded here.
import path from "path"
import type { HardhatUserConfig } from "hardhat/config"

const root = process.env.MUTATION_TBTC_ROOT
if (!root)
  throw new Error(
    "hardhat.mutation.config.ts needs MUTATION_TBTC_ROOT set to the target worktree"
  )

const project = path.join(root, "solidity")
const base: HardhatUserConfig = require(path.join(
  project,
  "hardhat.config.ts"
)).default
const reporter = require(path.resolve(__dirname, "mocha-json-report.cjs"))

const config: HardhatUserConfig = {
  ...base,
  paths: { ...base.paths, root: project },
  mocha: {
    ...base.mocha,
    reporter,
    reporterOptions: { output: process.env.MUTATION_JSON },
  },
}

export default config
