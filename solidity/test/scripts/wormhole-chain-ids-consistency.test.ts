import { expect } from "chai"
import fs from "fs"
import path from "path"

describe("Wormhole Chain IDs Consistency Check", () => {
  it("should have consistent values between configuration and utility files", () => {
    // Relative paths from solidity/test/scripts/
    const configPath = path.resolve(
      __dirname,
      "../../scripts/configure-l1-btc-depositor-ntt.ts"
    )
    const utilPath = path.resolve(
      __dirname,
      "../../../typescript/src/lib/utils/wormhole.ts"
    )

    const configContent = fs.readFileSync(configPath, "utf8")
    const utilContent = fs.readFileSync(utilPath, "utf8")

    const chains = [
      { key: "arbitrum", mainnet: "arbitrum", sepolia: "arbitrumSepolia" },
      { key: "base", mainnet: "base", sepolia: "baseSepolia" },
      { key: "optimism", mainnet: "optimism", sepolia: "optimismSepolia" },
    ]
    chains.forEach((chain) => {
      const configMainnetMatch = new RegExp(
        `${chain.key}:\\s*{\\s*mainnet:\\s*(\\d+),`,
        "i"
      ).exec(configContent)
      if (!configMainnetMatch) {
        throw new Error(
          `Could not find mainnet ID for ${chain.key} in ${configPath}`
        )
      }
      const configSepoliaMatch = new RegExp(
        `${chain.key}:\\s*{\\s*mainnet:\\s*\\d+,\\s*sepolia:\\s*(\\d+),`,
        "i"
      ).exec(configContent)
      if (!configSepoliaMatch) {
        throw new Error(
          `Could not find sepolia ID for ${chain.key} in ${configPath}`
        )
      }

      const configMainnetId = configMainnetMatch[1]
      const configSepoliaId = configSepoliaMatch[1]

      const utilMainnetMatch = new RegExp(
        `\\[Chains\\.${
          chain.key.charAt(0).toUpperCase() + chain.key.slice(1)
        }\\.${
          chain.mainnet.charAt(0).toUpperCase() + chain.mainnet.slice(1)
        }\\]:\\s*(\\d+)`,
        "i"
      ).exec(utilContent)
      if (!utilMainnetMatch) {
        throw new Error(
          `Could not find mainnet ID for ${chain.key} in ${utilPath}`
        )
      }
      const utilSepoliaMatch = new RegExp(
        `\\[Chains\\.${
          chain.key.charAt(0).toUpperCase() + chain.key.slice(1)
        }\\.${
          chain.sepolia.charAt(0).toUpperCase() + chain.sepolia.slice(1)
        }\\]:\\s*(\\d+)`,
        "i"
      ).exec(utilContent)
      if (!utilSepoliaMatch) {
        throw new Error(
          `Could not find sepolia ID for ${chain.key} in ${utilPath}`
        )
      }

      const utilMainnetId = utilMainnetMatch[1]
      const utilSepoliaId = utilSepoliaMatch[1]

      expect(configMainnetId, `Mainnet ID mismatch for ${chain.key}`).to.equal(
        utilMainnetId
      )
      expect(configSepoliaId, `Sepolia ID mismatch for ${chain.key}`).to.equal(
        utilSepoliaId
      )
    })
  })
})
