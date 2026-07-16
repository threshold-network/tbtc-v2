import { expect } from "chai"
import { providers } from "ethers"
import {
  BitcoinNetwork,
  Chains,
  EthereumActiveWalletIdentityQuorum,
  EthereumSigner,
  TBTC,
} from "../../src"

type InitializationCall = {
  ethereumChainID: Chains.Ethereum
  bitcoinNetwork: BitcoinNetwork
  crossChainSupport: boolean | EthereumActiveWalletIdentityQuorum
  activeWalletIdentityQuorum?: EthereumActiveWalletIdentityQuorum
}

class InitializationProbe extends TBTC {
  static calls: InitializationCall[] = []

  protected static async initializeEthereum(
    _ethereumSignerOrProvider: EthereumSigner | providers.Provider,
    ethereumChainID: Chains.Ethereum,
    bitcoinNetwork: BitcoinNetwork,
    crossChainSupport: boolean | EthereumActiveWalletIdentityQuorum = false,
    activeWalletIdentityQuorum?: EthereumActiveWalletIdentityQuorum
  ): Promise<TBTC> {
    this.calls.push({
      ethereumChainID,
      bitcoinNetwork,
      crossChainSupport,
      activeWalletIdentityQuorum,
    })

    return {} as TBTC
  }
}

describe("TBTC wallet-identity quorum initialization", () => {
  const primaryProvider = {} as providers.Provider
  const quorum: EthereumActiveWalletIdentityQuorum = {
    sourceTrustDomainID: "primary.example",
    canonicalProvider: {
      trustDomainID: "canonical.example",
      provider: {} as providers.Provider,
    },
  }

  beforeEach(() => {
    InitializationProbe.calls = []
  })

  const expectCall = (
    ethereumChainID: Chains.Ethereum,
    bitcoinNetwork: BitcoinNetwork,
    crossChainSupport: boolean,
    activeWalletIdentityQuorum?: EthereumActiveWalletIdentityQuorum
  ) => {
    expect(InitializationProbe.calls).to.deep.equal([
      {
        ethereumChainID,
        bitcoinNetwork,
        crossChainSupport,
        activeWalletIdentityQuorum,
      },
    ])
  }

  it("preserves the legacy mainnet boolean argument", async () => {
    await InitializationProbe.initializeMainnet(primaryProvider, false)

    expectCall(Chains.Ethereum.Mainnet, BitcoinNetwork.Mainnet, false)
  })

  it("accepts the mainnet quorum as the second argument", async () => {
    await InitializationProbe.initializeMainnet(primaryProvider, quorum)

    expectCall(Chains.Ethereum.Mainnet, BitcoinNetwork.Mainnet, false, quorum)
  })

  it("accepts the mainnet quorum as the third argument", async () => {
    await InitializationProbe.initializeMainnet(primaryProvider, false, quorum)

    expectCall(Chains.Ethereum.Mainnet, BitcoinNetwork.Mainnet, false, quorum)
  })

  it("preserves cross-chain support with a mainnet quorum", async () => {
    await InitializationProbe.initializeMainnet(primaryProvider, true, quorum)

    expectCall(Chains.Ethereum.Mainnet, BitcoinNetwork.Mainnet, true, quorum)
  })

  it("accepts the Sepolia quorum as the second argument", async () => {
    await InitializationProbe.initializeSepolia(primaryProvider, quorum)

    expectCall(Chains.Ethereum.Sepolia, BitcoinNetwork.Testnet4, false, quorum)
  })

  it("preserves cross-chain support with a Sepolia quorum", async () => {
    await InitializationProbe.initializeSepolia(primaryProvider, true, quorum)

    expectCall(Chains.Ethereum.Sepolia, BitcoinNetwork.Testnet4, true, quorum)
  })
})
