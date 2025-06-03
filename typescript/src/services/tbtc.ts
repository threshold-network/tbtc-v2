import { DepositsService } from "./deposits"
import { MaintenanceService } from "./maintenance"
import { RedemptionsService } from "./redemptions"
import {
  Chains,
  CrossChainContracts,
  CrossChainContractsLoader,
  L1CrossChainContracts,
  L2Chain,
  L2CrossChainContracts,
  TBTCContracts,
} from "../lib/contracts"
import { BitcoinClient, BitcoinNetwork } from "../lib/bitcoin"
import {
  ethereumAddressFromSigner,
  EthereumSigner,
  ethereumCrossChainContractsLoader,
  loadEthereumCoreContracts,
} from "../lib/ethereum"
import { ElectrumClient } from "../lib/electrum"
import { loadBaseCrossChainContracts } from "../lib/base"
import { loadArbitrumCrossChainContracts } from "../lib/arbitrum"
import {
  loadStarkNetCrossChainContracts,
  StarkNetProvider,
} from "../lib/starknet"

/**
 * Entrypoint component of the tBTC v2 SDK.
 */
export class TBTC {
  /**
   * Service supporting the tBTC v2 deposit flow.
   */
  public readonly deposits: DepositsService
  /**
   * Service supporting authorized operations of tBTC v2 system maintainers
   * and operators.
   */
  public readonly maintenance: MaintenanceService
  /**
   * Service supporting the tBTC v2 redemption flow.
   */
  public readonly redemptions: RedemptionsService
  /**
   * Handle to tBTC contracts for low-level access.
   */
  public readonly tbtcContracts: TBTCContracts
  /**
   * Bitcoin client handle for low-level access.
   */
  public readonly bitcoinClient: BitcoinClient
  /**
   * Reference to the cross-chain contracts loader.
   */
  readonly #crossChainContractsLoader?: CrossChainContractsLoader
  /**
   * Mapping of cross-chain contracts for different supported L2 chains.
   * Each set of cross-chain contracts must be first initialized using
   * the `initializeCrossChain` method.
   */
  readonly #crossChainContracts: Map<L2Chain, CrossChainContracts>

  private constructor(
    tbtcContracts: TBTCContracts,
    bitcoinClient: BitcoinClient,
    crossChainContractsLoader?: CrossChainContractsLoader
  ) {
    this.deposits = new DepositsService(
      tbtcContracts,
      bitcoinClient,
      (l2ChainName) => this.crossChainContracts(l2ChainName)
    )
    this.maintenance = new MaintenanceService(tbtcContracts, bitcoinClient)
    this.redemptions = new RedemptionsService(tbtcContracts, bitcoinClient)
    this.tbtcContracts = tbtcContracts
    this.bitcoinClient = bitcoinClient
    this.#crossChainContractsLoader = crossChainContractsLoader
    this.#crossChainContracts = new Map<L2Chain, CrossChainContracts>()
  }

  /**
   * Initializes the tBTC v2 SDK entrypoint for Ethereum and Bitcoin mainnets.
   * The initialized instance uses default Electrum servers to interact
   * with Bitcoin mainnet
   * @param signer Ethereum signer.
   * @param crossChainSupport Whether to enable cross-chain support. False by default.
   * @returns Initialized tBTC v2 SDK entrypoint.
   * @throws Throws an error if the signer's Ethereum network is other than
   *         Ethereum mainnet.
   */
  static async initializeMainnet(
    signer: EthereumSigner,
    crossChainSupport: boolean = false
  ): Promise<TBTC> {
    return TBTC.initializeEthereum(
      signer,
      Chains.Ethereum.Mainnet,
      BitcoinNetwork.Mainnet,
      crossChainSupport
    )
  }

  /**
   * Initializes the tBTC v2 SDK entrypoint for Ethereum Sepolia and Bitcoin testnet.
   * The initialized instance uses default Electrum servers to interact
   * with Bitcoin testnet
   * @param signer Ethereum signer.
   * @param crossChainSupport Whether to enable cross-chain support. False by default.
   * @returns Initialized tBTC v2 SDK entrypoint.
   * @throws Throws an error if the signer's Ethereum network is other than
   *         Ethereum mainnet.
   */
  static async initializeSepolia(
    signer: EthereumSigner,
    crossChainSupport: boolean = false
  ): Promise<TBTC> {
    return TBTC.initializeEthereum(
      signer,
      Chains.Ethereum.Sepolia,
      BitcoinNetwork.Testnet,
      crossChainSupport
    )
  }

  /**
   * Initializes the tBTC v2 SDK entrypoint for the given Ethereum network and Bitcoin network.
   * The initialized instance uses default Electrum servers to interact
   * with Bitcoin network.
   * @param signer Ethereum signer.
   * @param ethereumChainId Ethereum chain ID.
   * @param bitcoinNetwork Bitcoin network.
   * @param crossChainSupport Whether to enable cross-chain support. False by default.
   * @returns Initialized tBTC v2 SDK entrypoint.
   * @throws Throws an error if the underlying signer's Ethereum network is
   *         other than the given Ethereum network.
   */
  private static async initializeEthereum(
    signer: EthereumSigner,
    ethereumChainId: Chains.Ethereum,
    bitcoinNetwork: BitcoinNetwork,
    crossChainSupport = false
  ): Promise<TBTC> {
    const signerAddress = await ethereumAddressFromSigner(signer)
    const tbtcContracts = await loadEthereumCoreContracts(
      signer,
      ethereumChainId
    )

    let crossChainContractsLoader: CrossChainContractsLoader | undefined =
      undefined
    if (crossChainSupport) {
      crossChainContractsLoader = await ethereumCrossChainContractsLoader(
        signer,
        ethereumChainId
      )
    }

    const bitcoinClient = ElectrumClient.fromDefaultConfig(bitcoinNetwork)

    const tbtc = new TBTC(
      tbtcContracts,
      bitcoinClient,
      crossChainContractsLoader
    )

    // If signer address can be resolved, set it as default depositor.
    if (signerAddress !== undefined) {
      tbtc.deposits.setDefaultDepositor(signerAddress)
    }

    return tbtc
  }

  /**
   * Initializes the tBTC v2 SDK entrypoint with custom tBTC contracts and
   * Bitcoin client.
   * @param tbtcContracts Custom tBTC contracts handle.
   * @param bitcoinClient Custom Bitcoin client implementation.
   * @returns Initialized tBTC v2 SDK entrypoint.
   * @dev This function is especially useful for local development as it gives
   *      flexibility to combine different implementations of tBTC v2 contracts
   *      with different Bitcoin networks.
   */
  static async initializeCustom(
    tbtcContracts: TBTCContracts,
    bitcoinClient: BitcoinClient
  ): Promise<TBTC> {
    return new TBTC(tbtcContracts, bitcoinClient)
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
   * @deprecated Will be removed in next major version. Use two-parameter pattern instead.
   */
  _l2Signer?: EthereumSigner | StarkNetProvider

  /**
   * Initializes cross-chain contracts for the given L2 chain.
   *
   * For StarkNet, this method now supports single-parameter initialization:
   * ```
   * // Recommended: Single-parameter (StarkNet wallet only)
   * await tbtc.initializeCrossChain("StarkNet", starknetProvider)
   * ```
   *
   * The two-parameter pattern is deprecated but still supported:
   * ```
   * // Deprecated: Two-parameter (requires Ethereum wallet)
   * await tbtc.initializeCrossChain("StarkNet", ethereumSigner, starknetProvider)
   * ```
   *
   * For other L2 chains, continue using the standard pattern:
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
   * @param signerOrProvider For StarkNet: StarkNet provider/account.
   *                        For other L2s: Ethereum signer.
   * @param l2Provider [DEPRECATED] For StarkNet two-parameter mode only.
   * @returns Void promise
   * @throws Throws an error if:
   *         - Cross-chain contracts loader not available
   *         - Invalid provider type for StarkNet
   *         - No connected account in StarkNet provider
   *
   * @example
   * // StarkNet with single parameter (recommended)
   * const starknetAccount = await starknet.connect();
   * await tbtc.initializeCrossChain("StarkNet", starknetAccount);
   *
   * @deprecated The two-parameter variant for StarkNet is deprecated.
   *            Use single-parameter initialization instead.
   */
  async initializeCrossChain(
    l2ChainName: L2Chain,
    signerOrEthereumSigner: EthereumSigner | StarkNetProvider,
    l2Provider?: StarkNetProvider
  ): Promise<void> {
    if (!this.#crossChainContractsLoader) {
      throw new Error(
        "Cross-chain contracts loader not available for this instance"
      )
    }

    const chainMapping = this.#crossChainContractsLoader.loadChainMapping()
    if (!chainMapping) {
      throw new Error("Chain mapping between L1 and L2 chains not defined")
    }

    const l1CrossChainContracts: L1CrossChainContracts =
      await this.#crossChainContractsLoader.loadL1Contracts(l2ChainName)
    let l2CrossChainContracts: L2CrossChainContracts

    switch (l2ChainName) {
      case "Base":
        const baseChainId = chainMapping.base
        if (!baseChainId) {
          throw new Error("Base chain ID not available in chain mapping")
        }
        // For EVM chains, l2Provider should not be provided
        if (l2Provider !== undefined) {
          throw new Error("Base does not support two-parameter initialization")
        }
        this._l2Signer = signerOrEthereumSigner
        l2CrossChainContracts = await loadBaseCrossChainContracts(
          signerOrEthereumSigner as EthereumSigner,
          baseChainId
        )
        break
      case "Arbitrum":
        const arbitrumChainId = chainMapping.arbitrum
        if (!arbitrumChainId) {
          throw new Error("Arbitrum chain ID not available in chain mapping")
        }
        // For EVM chains, l2Provider should not be provided
        if (l2Provider !== undefined) {
          throw new Error(
            "Arbitrum does not support two-parameter initialization"
          )
        }
        this._l2Signer = signerOrEthereumSigner
        l2CrossChainContracts = await loadArbitrumCrossChainContracts(
          signerOrEthereumSigner as EthereumSigner,
          arbitrumChainId
        )
        break
      case "StarkNet":
        const starknetChainId = chainMapping.starknet
        if (!starknetChainId) {
          throw new Error("StarkNet chain ID not available in chain mapping")
        }

        let walletAddressHex: string
        let starknetProvider: StarkNetProvider | undefined

        // Detect single vs two-parameter mode
        const isSingleParameterMode = l2Provider === undefined

        if (isSingleParameterMode) {
          // Single-parameter mode: StarkNet provider only (recommended)
          // Note: _l2Signer is NOT stored in this mode to encourage the new pattern
          if (!signerOrEthereumSigner) {
            throw new Error("StarkNet provider is required")
          }

          starknetProvider = signerOrEthereumSigner as StarkNetProvider

          // Extract address from StarkNet provider using the new method
          try {
            walletAddressHex = await TBTC.extractStarkNetAddress(
              starknetProvider
            )
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
        } else {
          // Two-parameter mode: Ethereum signer + StarkNet provider (deprecated)
          console.warn(
            "Two-parameter initializeCrossChain for StarkNet is deprecated. " +
              "Please use: initializeCrossChain('StarkNet', starknetProvider)"
          )

          if (!signerOrEthereumSigner) {
            throw new Error("Ethereum signer is required")
          }

          if (!l2Provider) {
            throw new Error(
              "StarkNet provider is required for two-parameter initialization"
            )
          }

          // Store _l2Signer for backward compatibility in two-parameter mode
          this._l2Signer = signerOrEthereumSigner

          // Extract wallet address from Ethereum signer
          const walletAddress = await ethereumAddressFromSigner(
            signerOrEthereumSigner as EthereumSigner
          )
          if (!walletAddress) {
            throw new Error(
              "Could not extract wallet address from Ethereum signer"
            )
          }
          walletAddressHex = walletAddress.identifierHex
          starknetProvider = l2Provider
        }

        l2CrossChainContracts = await loadStarkNetCrossChainContracts(
          walletAddressHex,
          starknetProvider,
          starknetChainId
        )
        break
      default:
        throw new Error("Unsupported L2 chain")
    }

    this.#crossChainContracts.set(l2ChainName, {
      ...l1CrossChainContracts,
      ...l2CrossChainContracts,
    })
  }

  /**
   * Gets cross-chain contracts for the given supported L2 chain.
   * The given L2 chain contracts must be first initialized using the
   * `initializeCrossChain` method.
   *
   * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
   *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
   *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
   *               CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.
   *
   * @param l2ChainName Name of the L2 chain for which to get cross-chain contracts.
   * @returns Cross-chain contracts for the given L2 chain or
   *          undefined if not initialized.
   */
  crossChainContracts(l2ChainName: L2Chain): CrossChainContracts | undefined {
    return this.#crossChainContracts.get(l2ChainName)
  }
}
