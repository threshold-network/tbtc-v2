import { DepositsService } from "./deposits"
import { MaintenanceService } from "./maintenance"
import { RedemptionsService } from "./redemptions"
import {
  Chains,
  CrossChainInterfaces,
  CrossChainContractsLoader,
  L1CrossChainContracts,
  DestinationChainName,
  TBTCContracts,
  DestinationChainInterfaces,
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
import { providers } from "ethers"
import { loadSolanaCrossChainPrograms } from "../lib/solana"
import { AnchorProvider } from "@coral-xyz/anchor"

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
      (destinationChainName) => this.crossChainContracts(destinationChainName)
    )
    this.maintenance = new MaintenanceService(tbtcContracts, bitcoinClient)
    this.redemptions = new RedemptionsService(tbtcContracts, bitcoinClient)
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
    return TBTC.initializeEthereum(
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
    return TBTC.initializeEthereum(
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
  private static async initializeEthereum(
    ethereumSignerOrProvider: EthereumSigner | providers.Provider,
    ethereumChainId: Chains.Ethereum,
    bitcoinNetwork: BitcoinNetwork,
    crossChainSupport = false
  ): Promise<TBTC> {
    const signerAddress = await ethereumAddressFromSigner(
      ethereumSignerOrProvider
    )
    const tbtcContracts = await loadEthereumCoreContracts(
      ethereumSignerOrProvider,
      ethereumChainId
    )

    let crossChainContractsLoader: CrossChainContractsLoader | undefined =
      undefined
    if (crossChainSupport) {
      crossChainContractsLoader = await ethereumCrossChainContractsLoader(
        ethereumSignerOrProvider,
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
   * Initializes cross-chain contracts for the given L2 chain, using the
   * given signer. Updates the signer on subsequent calls.
   *
   * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
   *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
   *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
   *               CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.
   *
   * @param destinationChainName Name of the L2 chain for which to initialize
   *                    cross-chain contracts.
   * @param ethereumChainSigner Signer to use with the L2 chain contracts.
   * @param nonEvmProvider Provider of non EVM chain that contains connection and signer.
   * @returns Void promise.
   * @throws Throws an error if:
   *         - Cross-chain contracts loader is not available for this TBTC SDK instance,
   *         - Chain mapping between the L1 and the given L2 chain is not defined.
   * @dev In case this function needs to support non-EVM L2 chains that can't
   *      use EthereumSigner as a signer type, the l2Signer parameter should
   *      probably be turned into a union of multiple supported types or
   *      generalized in some other way.
   */
  async initializeCrossChain(
    destinationChainName: DestinationChainName,
    ethereumChainSigner: EthereumSigner,
    nonEvmProvider: AnchorProvider | null // Should add other chain types over time.
  ): Promise<void> {
    if (!this.#crossChainContractsLoader) {
      throw new Error(
        "L1 Cross-chain contracts loader not available for this instance"
      )
    }

    const chainMapping = this.#crossChainContractsLoader.loadChainMapping()
    if (!chainMapping) {
      throw new Error(
        "Chain mapping between Ethereum L1 and destination chains not defined"
      )
    }

    let l1CrossChainInterfaces: L1CrossChainContracts
    let destinationChainInterfaces: DestinationChainInterfaces

    switch (destinationChainName) {
      case "Base":
        const baseChainId = chainMapping.base
        if (!baseChainId) {
          throw new Error("Base chain ID not available in chain mapping")
        }
        l1CrossChainInterfaces =
          await this.#crossChainContractsLoader.loadL1Contracts(
            destinationChainName
          )

        destinationChainInterfaces = await loadBaseCrossChainContracts(
          ethereumChainSigner,
          baseChainId
        )
        break
      case "Arbitrum":
        const arbitrumChainId = chainMapping.arbitrum
        if (!arbitrumChainId) {
          throw new Error("Arbitrum chain ID not available in chain mapping")
        }
        l1CrossChainInterfaces =
          await this.#crossChainContractsLoader.loadL1Contracts(
            destinationChainName
          )

        destinationChainInterfaces = await loadArbitrumCrossChainContracts(
          ethereumChainSigner,
          arbitrumChainId
        )
        break
      case "Solana":
        if (!nonEvmProvider) {
          throw new Error("Solana provider is not defined")
        }

        l1CrossChainInterfaces =
          await this.#crossChainContractsLoader.loadL1Contracts(
            destinationChainName
          )

        destinationChainInterfaces = await loadSolanaCrossChainPrograms(
          nonEvmProvider
        )
        break
      default:
        throw new Error("Unsupported destination chain")
    }

    this.#crossChainContracts.set(destinationChainName, {
      ...l1CrossChainInterfaces,
      ...destinationChainInterfaces,
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
   * @param destinationChainName Name of the destination chain for which to get cross-chain contracts.
   * @returns Cross-chain contracts for the given L2 chain or
   *          undefined if not initialized.
   */
  crossChainContracts(
    destinationChainName: DestinationChainName
  ): CrossChainInterfaces | undefined {
    return this.#crossChainContracts.get(destinationChainName)
  }
}
