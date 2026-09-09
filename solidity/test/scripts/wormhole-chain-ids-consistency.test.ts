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

    // Additionally, check that WORMHOLE_NTT_CHAIN_IDS correctly references
    // WORMHOLE_CHAIN_IDS for each EVM NTT destination (WORMHOLE_NTT_CHAIN_IDS
    // entries are defined as `WORMHOLE_CHAIN_IDS[Chains.X.Y]` lookups, not
    // literal numbers, so this checks the reference is wired to the correct
    // key rather than re-deriving a numeric literal that doesn't exist here;
    // the literal WORMHOLE_CHAIN_IDS values themselves are already
    // cross-checked against the config script above).
    const nttChains = [
      { key: "arbitrum", mainnet: "Arbitrum", sepolia: "ArbitrumSepolia" },
      { key: "base", mainnet: "Base", sepolia: "BaseSepolia" },
      { key: "optimism", mainnet: "Optimism", sepolia: "OptimismSepolia" },
    ]
    const nttChainIdsMatch = /WORMHOLE_NTT_CHAIN_IDS\s*=\s*{([\s\S]*?)\n}/.exec(
      utilContent
    )
    if (!nttChainIdsMatch) {
      throw new Error(
        `Could not find WORMHOLE_NTT_CHAIN_IDS definition in ${utilPath}`
      )
    }
    const nttChainIdsBody = nttChainIdsMatch[1]
    nttChains.forEach((chain) => {
      const mainnetRefMatch = new RegExp(
        `${chain.mainnet}:\\s*{[^}]*${chain.mainnet}:\\s*WORMHOLE_CHAIN_IDS\\[Chains\\.${chain.mainnet}\\.${chain.mainnet}\\]`
      ).test(nttChainIdsBody)
      expect(
        mainnetRefMatch,
        `WORMHOLE_NTT_CHAIN_IDS.${chain.mainnet}.${chain.mainnet} should reference WORMHOLE_CHAIN_IDS[Chains.${chain.mainnet}.${chain.mainnet}]`
      ).to.be.true

      const sepoliaRefMatch = new RegExp(
        `${chain.mainnet}:\\s*{[^}]*${chain.sepolia}:\\s*WORMHOLE_CHAIN_IDS\\[Chains\\.${chain.mainnet}\\.${chain.sepolia}\\]`
      ).test(nttChainIdsBody)
      expect(
        sepoliaRefMatch,
        `WORMHOLE_NTT_CHAIN_IDS.${chain.mainnet}.${chain.sepolia} should reference WORMHOLE_CHAIN_IDS[Chains.${chain.mainnet}.${chain.sepolia}]`
      ).to.be.true

      // Cross-check the underlying literal ID (already validated as
      // consistent with WORMHOLE_CHAIN_IDS above) also matches the config
      // script, closing the coverage gap for NTT-specific chains.
      const configMainnetMatch = new RegExp(
        `${chain.key.toLowerCase()}:\\s*{\\s*mainnet:\\s*(\\d+),`,
        "i"
      ).exec(configContent)
      if (!configMainnetMatch) {
        throw new Error(
          `Could not find mainnet ID for ${chain.key.toLowerCase()} in ${configPath}`
        )
      }
      const utilMainnetMatch = new RegExp(
        `\\[Chains\\.${chain.mainnet}\\.${chain.mainnet}\\]:\\s*(\\d+)`,
        "i"
      ).exec(utilContent)
      if (!utilMainnetMatch) {
        throw new Error(
          `Could not find literal mainnet ID for Chains.${chain.mainnet}.${chain.mainnet} in ${utilPath}`
        )
      }
      expect(
        configMainnetMatch[1],
        `Mainnet ID mismatch for ${chain.key} in WORMHOLE_NTT_CHAIN_IDS`
      ).to.equal(utilMainnetMatch[1])
    })
  })
})
