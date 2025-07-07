import { DepositsService } from "./deposits"
import { MaintenanceService } from "./maintenance"
import { RedemptionsService } from "./redemptions"
import {
  Chains,
  CrossChainInterfaces,
  CrossChainContractsLoader,
  L1CrossChainContracts,
  DestinationChainName,
  DestinationChainInterfaces,
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
import { loadBaseCrossChainInterfaces } from "../lib/base"
import { loadArbitrumCrossChainInterfaces } from "../lib/arbitrum"
import {
  loadStarkNetCrossChainInterfaces,
  StarkNetProvider,
} from "../lib/starknet"
import { loadSuiCrossChainInterfaces, SuiSignerWithAddress } from "../lib/sui"

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
  readonly #crossChainContracts: Map<DestinationChainName, CrossChainInterfaces>

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
    this.redemptions = new RedemptionsService(
      tbtcContracts,
      bitcoinClient,
      (l2ChainName) => this.crossChainContracts(l2ChainName)
    )
    this.tbtcContracts = tbtcContracts
    this.bitcoinClient = bitcoinClient
    this.#crossChainContractsLoader = crossChainContractsLoader
    this.#crossChainContracts = new Map<
      DestinationChainName,
      CrossChainInterfaces
    >()
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
   * @deprecated Will be removed in next major version.
   */
  _l2Signer?: EthereumSigner | StarkNetProvider | SuiSignerWithAddress

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
   *                               For other L2s: Ethereum signer.
   * @param l2Provider Deprecated parameter - will throw error if provided
   * @returns Void promise
   * @throws Throws an error if:
   *         - Cross-chain contracts loader not available
   *         - Invalid provider type for StarkNet or SUI
   *         - No connected account in StarkNet provider
   *         - Two-parameter mode is used for StarkNet or SUI (no longer supported)
   *
   * @example
   * // StarkNet with single parameter
   * const starknetAccount = await starknet.connect();
   * await tbtc.initializeCrossChain("StarkNet", starknetAccount);
   *
   * // SUI with single parameter
   * const suiWallet = await wallet.connect();
   * await tbtc.initializeCrossChain("Sui", suiWallet);
   */
  async initializeCrossChain(
    l2ChainName: DestinationChainName,
    signerOrEthereumSigner:
      | EthereumSigner
      | StarkNetProvider
      | SuiSignerWithAddress,
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
    let l2CrossChainContracts: DestinationChainInterfaces

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
        // For EVM chains, l2Provider should not be provided
        if (l2Provider !== undefined) {
          throw new Error(
            "Arbitrum does not support two-parameter initialization"
          )
        }
        this._l2Signer = signerOrEthereumSigner
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

        // StarkNet only supports single-parameter mode
        if (l2Provider !== undefined) {
          throw new Error(
            "StarkNet does not support two-parameter initialization. " +
              "Please use: initializeCrossChain('StarkNet', starknetProvider)"
          )
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
        // SUI only supports single-parameter mode
        if (l2Provider !== undefined) {
          throw new Error(
            "SUI does not support two-parameter initialization. " +
              "Please use: initializeCrossChain('Sui', suiSigner)"
          )
        }
        this._l2Signer = signerOrEthereumSigner as SuiSignerWithAddress
        l2CrossChainContracts = await loadSuiCrossChainInterfaces(
          signerOrEthereumSigner as SuiSignerWithAddress,
          suiChainId
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
  crossChainContracts(
    l2ChainName: DestinationChainName
  ): CrossChainInterfaces | undefined {
    return this.#crossChainContracts.get(l2ChainName)
  }
}
