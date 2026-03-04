import {
  Chains,
  CrossChainContractsLoader,
  CrossChainInterfaces,
  L1CrossChainContracts,
  DestinationChainName,
  DestinationChainInterfaces,
  TBTCContracts,
} from "../lib/contracts"
import { BitcoinClient, BitcoinNetwork } from "../lib/bitcoin"
import { EthereumSigner } from "../lib/ethereum"
import type { AnchorProvider } from "@coral-xyz/anchor"
import type { StarkNetProvider } from "../lib/starknet"
import type { SuiSignerWithAddress } from "../lib/sui"
import { TBTC as TBTCCore } from "./tbtc-core"
import { providers } from "ethers"

// Re-export everything from the base module so that consumers importing
// from the root entry point get the same symbols as from /core.
export { TBTC as TBTCCore } from "./tbtc-core"

/**
 * Full tBTC v2 SDK entrypoint with cross-chain (L2) support.
 *
 * Extends the base TBTC class with `initializeCrossChain` for L2 bridging.
 * Chain-specific modules (Solana, StarkNet, Sui, Base, Arbitrum) are loaded
 * on demand when `initializeCrossChain` is called.
 *
 * For consumers not interested in the cross-chain (L2) support, use the `/core`
 * subpath which exports the base TBTC class.
 */
export class TBTC extends TBTCCore {
  private _crossChainContractsLoader?: CrossChainContractsLoader

  private readonly _crossChainContracts = new Map<
    DestinationChainName,
    CrossChainInterfaces
  >()

  protected constructor(
    tbtcContracts: TBTCContracts,
    bitcoinClient: BitcoinClient,
    crossChainContractsLoader?: CrossChainContractsLoader
  ) {
    super(tbtcContracts, bitcoinClient)
    this._crossChainContractsLoader = crossChainContractsLoader
  }

  /**
   * Initializes the tBTC v2 SDK entrypoint for Ethereum and Bitcoin mainnets.
   * The initialized instance uses default Electrum servers to interact
   * with Bitcoin mainnet
   * @param ethereumSignerOrProvider Ethereum signer or provider.
   * @param crossChainSupport Whether to enable cross-chain support. False by default.
   * @returns Initialized tBTC v2 SDK entrypoint.
   * @throws Throws an error if the signer's Ethereum network is other than
   *         Ethereum mainnet.
   */
  static async initializeMainnet(
    ethereumSignerOrProvider: EthereumSigner | providers.Provider,
    crossChainSupport: boolean = false
  ): Promise<TBTC> {
    return this.initializeEthereum(
      ethereumSignerOrProvider,
      Chains.Ethereum.Mainnet,
      BitcoinNetwork.Mainnet,
      crossChainSupport
    )
  }

  /**
   * Initializes the tBTC v2 SDK entrypoint for Ethereum Sepolia and Bitcoin testnet.
   * The initialized instance uses default Electrum servers to interact
   * with Bitcoin testnet
   * @param ethereumSignerOrProvider Ethereum signer or provider.
   * @param crossChainSupport Whether to enable cross-chain support. False by default.
   * @returns Initialized tBTC v2 SDK entrypoint.
   * @throws Throws an error if the signer's Ethereum network is other than
   *         Ethereum mainnet.
   */
  static async initializeSepolia(
    ethereumSignerOrProvider: EthereumSigner | providers.Provider,
    crossChainSupport: boolean = false
  ): Promise<TBTC> {
    return this.initializeEthereum(
      ethereumSignerOrProvider,
      Chains.Ethereum.Sepolia,
      BitcoinNetwork.Testnet,
      crossChainSupport
    )
  }

  /**
   * Initializes the tBTC v2 SDK entrypoint for the given Ethereum network and Bitcoin network.
   * The initialized instance uses default Electrum servers to interact
   * with Bitcoin network.
   * @param ethereumSignerOrProvider Ethereum signer or provider.
   * @param ethereumChainId Ethereum chain ID.
   * @param bitcoinNetwork Bitcoin network.
   * @param crossChainSupport Whether to enable cross-chain support. False by default.
   * @returns Initialized tBTC v2 SDK entrypoint.
   * @throws Throws an error if the underlying signer's Ethereum network is
   *         other than the given Ethereum network.
   */
  protected static async initializeEthereum(
    ethereumSignerOrProvider: EthereumSigner | providers.Provider,
    ethereumChainId: Chains.Ethereum,
    bitcoinNetwork: BitcoinNetwork,
    crossChainSupport = false
  ): Promise<TBTC> {
    const tbtc = (await super.initializeEthereum(
      ethereumSignerOrProvider,
      ethereumChainId,
      bitcoinNetwork
    )) as TBTC

    if (crossChainSupport) {
      const { ethereumCrossChainContractsLoader } = await import(
        "../lib/ethereum/cross-chain"
      )
      tbtc._crossChainContractsLoader = await ethereumCrossChainContractsLoader(
        ethereumSignerOrProvider,
        ethereumChainId
      )

      // Wire up cross-chain contract resolution for deposits and redemptions.
      tbtc.deposits.setCrossChainContractsResolver((name) =>
        tbtc.crossChainContracts(name)
      )
      tbtc.redemptions.setCrossChainContractsResolver((name) =>
        tbtc.crossChainContracts(name)
      )
    }

    return tbtc
  }

  /**
   * Extracts StarkNet wallet address from a provider or account object.
   * @param provider StarkNet provider or account object.
   * @returns The StarkNet wallet address in hex format.
   * @throws Throws an error if the provider is invalid or address cannot be extracted.
   * @internal
   */
  static async extractStarkNetAddress(
    provider: StarkNetProvider | null | undefined
  ): Promise<string> {
    if (!provider) {
      throw new Error("StarkNet provider is required")
    }

    let address: string | undefined

    // Check if it's an Account object with address property
    if ("address" in provider && typeof provider.address === "string") {
      address = provider.address
    }
    // Check if it's a Provider with connected account
    else if (
      "account" in provider &&
      provider.account &&
      typeof provider.account === "object" &&
      "address" in provider.account &&
      typeof provider.account.address === "string"
    ) {
      address = provider.account.address
    }

    if (!address) {
      throw new Error(
        "StarkNet provider must be an Account object or Provider with connected account. " +
          "Ensure your StarkNet wallet is connected."
      )
    }

    // Validate address format (basic check for hex string)
    // StarkNet addresses are felt252 values represented as hex strings
    if (!/^0x[0-9a-fA-F]+$/.test(address)) {
      throw new Error("Invalid StarkNet address format")
    }

    // Normalize to lowercase for consistency
    return address.toLowerCase()
  }

  /**
   * Internal property to store L2 signer/provider for advanced use cases.
   * @internal
   * @deprecated Will be removed in next major version.
   */
  _l2Signer?:
    | EthereumSigner
    | StarkNetProvider
    | SuiSignerWithAddress
    | AnchorProvider

  /**
   * Initializes cross-chain contracts for the given L2 chain.
   *
   * For StarkNet, use single-parameter initialization:
   * ```
   * await tbtc.initializeCrossChain("StarkNet", starknetProvider)
   * ```
   *
   * For SUI, use single-parameter initialization:
   * ```
   * await tbtc.initializeCrossChain("Sui", suiSigner)
   * ```
   *
   * For other L2 chains, use the standard pattern:
   * ```
   * await tbtc.initializeCrossChain("Base", ethereumSigner)
   * ```
   *
   * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
   *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
   *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
   *               CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.
   *
   * @param l2ChainName Name of the L2 chain
   * @param signerOrEthereumSigner For StarkNet: StarkNet provider/account.
   *                               For SUI: SUI signer/wallet.
   *                               For Solana: Solana provider.
   *                               For other L2s: Ethereum signer.
   * @returns Void promise
   * @throws Throws an error if:
   *         - Cross-chain contracts loader not available
   *         - Invalid provider type for StarkNet or SUI
   *         - No connected account in StarkNet provider
   */
  async initializeCrossChain(
    l2ChainName: DestinationChainName,
    signerOrEthereumSigner:
      | EthereumSigner
      | StarkNetProvider
      | SuiSignerWithAddress
      | AnchorProvider
  ): Promise<void> {
    if (!this._crossChainContractsLoader) {
      throw new Error(
        "L1 Cross-chain contracts loader not available for this instance"
      )
    }

    const chainMapping = this._crossChainContractsLoader.loadChainMapping()
    if (!chainMapping) {
      throw new Error("Chain mapping between L1 and L2 chains not defined")
    }

    const l1CrossChainContracts: L1CrossChainContracts =
      await this._crossChainContractsLoader.loadL1Contracts(l2ChainName)
    let l2CrossChainContracts: DestinationChainInterfaces

    switch (l2ChainName) {
      case "Base":
        const baseChainId = chainMapping.base
        if (!baseChainId) {
          throw new Error("Base chain ID not available in chain mapping")
        }
        this._l2Signer = signerOrEthereumSigner
        const { loadBaseCrossChainInterfaces } = await import("../lib/base")
        l2CrossChainContracts = await loadBaseCrossChainInterfaces(
          signerOrEthereumSigner as EthereumSigner,
          baseChainId
        )
        break
      case "Arbitrum":
        const arbitrumChainId = chainMapping.arbitrum
        if (!arbitrumChainId) {
          throw new Error("Arbitrum chain ID not available in chain mapping")
        }
        this._l2Signer = signerOrEthereumSigner
        const { loadArbitrumCrossChainInterfaces } = await import(
          "../lib/arbitrum"
        )
        l2CrossChainContracts = await loadArbitrumCrossChainInterfaces(
          signerOrEthereumSigner as EthereumSigner,
          arbitrumChainId
        )
        break
      case "StarkNet":
        const starknetChainId = chainMapping.starknet
        if (!starknetChainId) {
          throw new Error("StarkNet chain ID not available in chain mapping")
        }

        if (!signerOrEthereumSigner) {
          throw new Error("StarkNet provider is required")
        }

        const starknetProvider = signerOrEthereumSigner as StarkNetProvider
        let walletAddressHex: string

        // Extract address from StarkNet provider using the new method
        try {
          walletAddressHex = await TBTC.extractStarkNetAddress(starknetProvider)
        } catch (error) {
          // Check if it's a Provider-only (no account) for backward compatibility
          // Only apply backward compatibility if it's NOT an Account object
          if (
            !("address" in starknetProvider) &&
            !("account" in starknetProvider) &&
            "getChainId" in starknetProvider &&
            typeof starknetProvider.getChainId === "function"
          ) {
            // Provider-only - use placeholder address for backward compatibility
            walletAddressHex = "0x0"
          } else {
            // Re-throw the error for invalid providers or invalid addresses
            throw error
          }
        }

        const { loadStarkNetCrossChainInterfaces } = await import(
          "../lib/starknet"
        )
        l2CrossChainContracts = await loadStarkNetCrossChainInterfaces(
          walletAddressHex,
          starknetProvider,
          starknetChainId
        )
        break
      case "Sui":
        const suiChainId = chainMapping.sui
        if (!suiChainId) {
          throw new Error("SUI chain ID not available in chain mapping")
        }
        this._l2Signer = signerOrEthereumSigner as SuiSignerWithAddress
        const { loadSuiCrossChainInterfaces } = await import("../lib/sui")
        l2CrossChainContracts = await loadSuiCrossChainInterfaces(
          signerOrEthereumSigner as SuiSignerWithAddress,
          suiChainId
        )
        break
      case "Solana":
        if (!signerOrEthereumSigner) {
          throw new Error("Solana provider is required")
        }
        this._l2Signer = signerOrEthereumSigner as AnchorProvider
        const { loadSolanaCrossChainInterfaces } = await import("../lib/solana")
        l2CrossChainContracts = await loadSolanaCrossChainInterfaces(
          signerOrEthereumSigner as AnchorProvider
        )
        break
      default:
        throw new Error("Unsupported destination chain")
    }

    this._crossChainContracts.set(l2ChainName, {
      ...l1CrossChainContracts,
      ...l2CrossChainContracts,
    })
  }

  /**
   * Gets cross-chain contracts for the given supported L2 chain.
   * The given destination chain contracts must be first initialized using the
   * `initializeCrossChain` method.
   *
   * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
   *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
   *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
   *               CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.
   *
   * @param l2ChainName Name of the destination chain for which to get cross-chain contracts.
   * @returns Cross-chain contracts for the given L2 chain or
   *          undefined if not initialized.
   */
  crossChainContracts(
    l2ChainName: DestinationChainName
  ): CrossChainInterfaces | undefined {
    return this._crossChainContracts.get(l2ChainName)
  }
}
