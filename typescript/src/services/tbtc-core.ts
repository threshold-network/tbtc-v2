import { DepositsService } from "./deposits"
import { MaintenanceService } from "./maintenance"
import { RedemptionsService } from "./redemptions"
import { Chains, TBTCContracts } from "../lib/contracts"
import { BitcoinClient, BitcoinNetwork } from "../lib/bitcoin"
import {
  ethereumAddressFromSigner,
  EthereumSigner,
  loadEthereumCoreContracts,
} from "../lib/ethereum"
import { ElectrumClient } from "../lib/electrum"
import { providers } from "ethers"

/**
 * Entrypoint component of the tBTC v2 SDK.
 *
 * This base class provides core tBTC functionality (deposits, maintenance,
 * redemptions) without importing chain-specific modules. Use this when only
 * the core functionality of Bitcoin-to-Ethereum bridging is needed.
 *
 * For cross-chain support (L2 bridging), import from the root entry point
 * which provides the full TBTC class with `initializeCrossChain`.
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

  protected constructor(
    tbtcContracts: TBTCContracts,
    bitcoinClient: BitcoinClient
  ) {
    this.deposits = new DepositsService(tbtcContracts, bitcoinClient)
    this.maintenance = new MaintenanceService(tbtcContracts, bitcoinClient)
    this.redemptions = new RedemptionsService(tbtcContracts, bitcoinClient)
    this.tbtcContracts = tbtcContracts
    this.bitcoinClient = bitcoinClient
  }

  /**
   * Initializes the tBTC v2 SDK entrypoint for Ethereum and Bitcoin mainnets.
   * The initialized instance uses default Electrum servers to interact
   * with Bitcoin mainnet
   * @param ethereumSignerOrProvider Ethereum signer or provider.
   * @returns Initialized tBTC v2 SDK entrypoint.
   * @throws Throws an error if the signer's Ethereum network is other than
   *         Ethereum mainnet.
   */
  static async initializeMainnet(
    ethereumSignerOrProvider: EthereumSigner | providers.Provider
  ): Promise<TBTC> {
    return this.initializeEthereum(
      ethereumSignerOrProvider,
      Chains.Ethereum.Mainnet,
      BitcoinNetwork.Mainnet
    )
  }

  /**
   * Initializes the tBTC v2 SDK entrypoint for Ethereum Sepolia and Bitcoin testnet.
   * The initialized instance uses default Electrum servers to interact
   * with Bitcoin testnet
   * @param ethereumSignerOrProvider Ethereum signer or provider.
   * @returns Initialized tBTC v2 SDK entrypoint.
   * @throws Throws an error if the signer's Ethereum network is other than
   *         Ethereum mainnet.
   */
  static async initializeSepolia(
    ethereumSignerOrProvider: EthereumSigner | providers.Provider
  ): Promise<TBTC> {
    return this.initializeEthereum(
      ethereumSignerOrProvider,
      Chains.Ethereum.Sepolia,
      BitcoinNetwork.Testnet
    )
  }

  /**
   * Initializes the tBTC v2 SDK entrypoint for the given Ethereum network
   * and Bitcoin network. The initialized instance uses default Electrum
   * servers to interact with Bitcoin network.
   * @param ethereumSignerOrProvider Ethereum signer or provider.
   * @param ethereumChainId Ethereum chain ID.
   * @param bitcoinNetwork Bitcoin network.
   * @returns Initialized tBTC v2 SDK entrypoint.
   * @throws Throws an error if the underlying signer's Ethereum network is
   *         other than the given Ethereum network.
   */
  protected static async initializeEthereum(
    ethereumSignerOrProvider: EthereumSigner | providers.Provider,
    ethereumChainId: Chains.Ethereum,
    bitcoinNetwork: BitcoinNetwork
  ): Promise<TBTC> {
    const signerAddress = await ethereumAddressFromSigner(
      ethereumSignerOrProvider
    )
    const tbtcContracts = await loadEthereumCoreContracts(
      ethereumSignerOrProvider,
      ethereumChainId
    )

    const bitcoinClient = ElectrumClient.fromDefaultConfig(bitcoinNetwork)

    const tbtc = new this(tbtcContracts, bitcoinClient)

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
    return new this(tbtcContracts, bitcoinClient)
  }
}
