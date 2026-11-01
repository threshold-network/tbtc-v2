// Hardhat config for the mutation harness: the repository config with Mocha's reporter replaced by
// the one that writes a JSON report to the file named in MUTATION_JSON. The project root is pinned
// to solidity/ because this file lives outside it, so every relative path in the repository config
// resolves as it does for a normal `hardhat test`.
//
// Mocha takes the reporter as a constructor, not as a path, so the module is loaded here.
import path from "path"
import type { HardhatUserConfig } from "hardhat/config"
import base from "../../solidity/hardhat.config"

const root = path.resolve(__dirname, "../../solidity")
const reporter = require(path.resolve(__dirname, "mocha-json-report.cjs"))

const config: HardhatUserConfig = {
  ...base,
  paths: { ...base.paths, root },
  mocha: {
    ...base.mocha,
    reporter,
    reporterOptions: { output: process.env.MUTATION_JSON },
  },
}

export default config
