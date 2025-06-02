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
   * Internal property to store L2 signer/provider for advanced use cases.
   * @internal
   * @deprecated Will be removed in next major version. Use two-parameter pattern instead.
   */
  _l2Signer?: EthereumSigner | StarkNetProvider

  /**
   * Initializes cross-chain contracts for the given L2 chain.
   *
   * For StarkNet, use the two-parameter pattern:
   * ```
   * await tbtc.initializeCrossChain("StarkNet", ethereumSigner, starknetProvider)
   * ```
   *
   * For other L2 chains, use the single-parameter pattern:
   * ```
   * await tbtc.initializeCrossChain("Base", ethereumSigner)
   * ```
   *
   * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
   *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
   *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
   *               CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.
   *
   * @param l2ChainName Name of the L2 chain for which to initialize
   *                    cross-chain contracts.
   * @param signerOrEthereumSigner For two-parameter: Ethereum signer (L1 operations).
   *                               For single-parameter: L2 signer/provider.
   * @param l2Provider Optional StarkNet provider for two-parameter pattern.
   * @returns Void promise.
   * @throws Throws an error if:
   *         - Cross-chain contracts loader is not available,
   *         - Chain mapping is not defined,
   *         - Required chain ID is not available,
   *         - StarkNet provider is missing (two-parameter mode),
   *         - Could not extract wallet address.
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

        // Check if using two-parameter pattern
        if (l2Provider !== undefined) {
          // Two-parameter pattern: signerOrEthereumSigner is Ethereum signer
          if (!signerOrEthereumSigner) {
            throw new Error("Ethereum signer is required")
          }

          if (!l2Provider) {
            throw new Error(
              "StarkNet provider is required for two-parameter initialization"
            )
          }

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

          // Do NOT store _l2Signer in two-parameter mode
        } else {
          // Single-parameter pattern (deprecated)
          console.warn(
            "Single-parameter initializeCrossChain for StarkNet is deprecated. " +
              "Please use: initializeCrossChain('StarkNet', ethereumSigner, starknetProvider)"
          )

          // Store for backward compatibility
          this._l2Signer = signerOrEthereumSigner

          // Legacy type detection logic
          try {
            // Check if it's a StarkNet Account (has address property)
            if (
              signerOrEthereumSigner &&
              typeof signerOrEthereumSigner === "object" &&
              "address" in signerOrEthereumSigner &&
              typeof (signerOrEthereumSigner as any).address === "string"
            ) {
              walletAddressHex = (signerOrEthereumSigner as any).address
              starknetProvider = signerOrEthereumSigner as StarkNetProvider
            } else if (
              "getChainId" in signerOrEthereumSigner &&
              typeof signerOrEthereumSigner.getChainId === "function"
            ) {
              walletAddressHex = "0x0" // Placeholder for Provider-only case
              starknetProvider = signerOrEthereumSigner as StarkNetProvider
            } else {
              // Ethereum signer for backward compatibility
              const walletAddress = await ethereumAddressFromSigner(
                signerOrEthereumSigner as EthereumSigner
              )
              if (!walletAddress) {
                throw new Error("Could not extract wallet address from signer")
              }
              walletAddressHex = walletAddress.identifierHex
              starknetProvider = undefined // No provider in this case
            }
          } catch (error) {
            // Fallback to Ethereum signer
            const walletAddress = await ethereumAddressFromSigner(
              signerOrEthereumSigner as EthereumSigner
            )
            if (!walletAddress) {
              throw new Error("Could not extract wallet address from signer")
            }
            walletAddressHex = walletAddress.identifierHex
            starknetProvider = undefined
          }
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
