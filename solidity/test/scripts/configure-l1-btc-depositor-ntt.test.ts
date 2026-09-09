import { expect } from "chai"
import {
  selectDestination,
  NetworkConfiguration,
} from "../../scripts/configure-l1-btc-depositor-ntt"

describe("selectDestination", () => {
  const sepoliaConfig: NetworkConfiguration = {
    networkName: "Ethereum Sepolia",
    destinations: {
      arbitrum: {
        chainId: 10003,
        name: "Arbitrum Sepolia",
        peerAddress:
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        peerDecimals: 0,
        inboundLimitAmount: "1000",
        outboundLimitAmount: "1000",
      },
      base: {
        chainId: 10004,
        name: "Base Sepolia",
        peerAddress: "0x8b9E328bE1b1Bc7501B413d04EBF7479B110775c",
        peerDecimals: 6,
        inboundLimitAmount: "1000",
        outboundLimitAmount: "1000",
      },
      optimism: {
        chainId: 10005,
        name: "Optimism Sepolia",
        peerAddress:
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        peerDecimals: 0,
        inboundLimitAmount: "1000",
        outboundLimitAmount: "1000",
      },
    },
  }

  it("should resolve case-insensitive destination keys", () => {
    // Test mixed case
    const [key, config] = selectDestination(sepoliaConfig, "Base")
    expect(key).to.equal("base")
    expect(config.name).to.equal("Base Sepolia")

    // Test upper case
    const [key2, config2] = selectDestination(sepoliaConfig, "OPTIMISM")
    expect(key2).to.equal("optimism")
    expect(config2.name).to.equal("Optimism Sepolia")
  })

  it("should throw for blocked destinations (solana, sui)", () => {
    expect(() => selectDestination(sepoliaConfig, "solana")).to.throw(
      /NTT destination "solana" is blocked/
    )
    expect(() => selectDestination(sepoliaConfig, "SOLANA")).to.throw(
      /NTT destination "solana" is blocked/
    )
    expect(() => selectDestination(sepoliaConfig, "sui")).to.throw(
      /NTT destination "sui" is blocked/
    )
    expect(() => selectDestination(sepoliaConfig, "SUI")).to.throw(
      /NTT destination "sui" is blocked/
    )
  })

  it("should throw for unsupported destination", () => {
    expect(() => selectDestination(sepoliaConfig, "polygon")).to.throw(
      /Unsupported NTT_DESTINATION "polygon" for Ethereum Sepolia. Supported values: arbitrum, base, optimism/
    )
    expect(() => selectDestination(sepoliaConfig, "")).to.throw(
      /Set NTT_DESTINATION to one of: arbitrum, base, optimism/
    )
  })
})
