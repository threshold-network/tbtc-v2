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
import { loadStarkNetCrossChainContracts, StarkNetProvider } from "../lib/starknet"

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
   */
  _l2Signer?: EthereumSigner | StarkNetProvider

  /**
   * Initializes cross-chain contracts for the given L2 chain, using the
   * given signer. Updates the signer on subsequent calls.
   *
   * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
   *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
   *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
   *               CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.
   *
   * @param l2ChainName Name of the L2 chain for which to initialize
   *                    cross-chain contracts.
   * @param l2Signer Signer to use with the L2 chain contracts. For StarkNet,
   *                 this can be a StarkNet Provider or Account instance, or
   *                 an Ethereum signer for backward compatibility.
   * @returns Void promise.
   * @throws Throws an error if:
   *         - Cross-chain contracts loader is not available for this TBTC SDK instance,
   *         - Chain mapping between the L1 and the given L2 chain is not defined,
   *         - StarkNet chain ID is not available in chain mapping (StarkNet only),
   *         - Could not extract wallet address from signer (StarkNet only).
   * @dev In case this function needs to support non-EVM L2 chains that can't
   *      use EthereumSigner as a signer type, the l2Signer parameter should
   *      probably be turned into a union of multiple supported types or
   *      generalized in some other way.
   */
  async initializeCrossChain(
    l2ChainName: L2Chain,
    l2Signer: EthereumSigner | StarkNetProvider
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
        this._l2Signer = l2Signer
        l2CrossChainContracts = await loadBaseCrossChainContracts(
          l2Signer as EthereumSigner,
          baseChainId
        )
        break
      case "Arbitrum":
        const arbitrumChainId = chainMapping.arbitrum
        if (!arbitrumChainId) {
          throw new Error("Arbitrum chain ID not available in chain mapping")
        }
        this._l2Signer = l2Signer
        l2CrossChainContracts = await loadArbitrumCrossChainContracts(
          l2Signer as EthereumSigner,
          arbitrumChainId
        )
        break
      case "StarkNet":
        const starknetChainId = chainMapping.starknet
        if (!starknetChainId) {
          throw new Error("StarkNet chain ID not available in chain mapping")
        }
        
        // Store the L2 signer/provider for later use
        this._l2Signer = l2Signer
        
        let walletAddressHex: string
        
        // Check if it's a StarkNet provider (Provider or Account)
        try {
          // Try to import Account class to check instanceof
          const { Account: StarkNetAccount } = await import("starknet")
          
          if (l2Signer instanceof StarkNetAccount) {
            // Extract address from Account
            walletAddressHex = l2Signer.address
          } else if ("getChainId" in l2Signer && typeof l2Signer.getChainId === "function") {
            // It's a StarkNet Provider - use placeholder address
            // This will be provided when setting deposit owner
            walletAddressHex = "0x0" // Placeholder, actual address set later
          } else {
            // Backward compatibility: Extract address from Ethereum signer
            const walletAddress = await ethereumAddressFromSigner(l2Signer as EthereumSigner)
            if (!walletAddress) {
              throw new Error("Could not extract wallet address from signer")
            }
            walletAddressHex = walletAddress.identifierHex
          }
        } catch (error) {
          // If we can't determine the type, try Ethereum signer for backward compatibility
          const walletAddress = await ethereumAddressFromSigner(l2Signer as EthereumSigner)
          if (!walletAddress) {
            throw new Error("Could not extract wallet address from signer")
          }
          walletAddressHex = walletAddress.identifierHex
        }
        
        // Store the l2Signer for provider access
        this._l2Signer = l2Signer
        
        // Determine chain ID based on whether we're on mainnet or testnet
        // We'll use Sepolia for now and can enhance this logic later
        const chainId = Chains.StarkNet.Sepolia
        
        l2CrossChainContracts = await loadStarkNetCrossChainContracts(
          walletAddressHex,
          l2Signer as StarkNetProvider,
          chainId
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
