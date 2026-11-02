import { BigNumber, BigNumberish } from "@ethersproject/bignumber"
import {
  Contract as EthersContract,
  Event as EthersEvent,
} from "@ethersproject/contracts"
import { AddressZero } from "@ethersproject/constants"
import {
  Reservations,
  ReservationRecord,
  ReservationActionRecord,
  ReservationParameters,
  ReservationCaps,
  ReservationOccupancy,
  ChainIdentifier,
  WalletState,
  GetChainEvents,
  NewWalletRegisteredEvent,
  ChainEvent,
} from "../contracts"
import { BitcoinRawTxVectors, BitcoinSpvProof } from "../bitcoin"
import { Hex } from "../utils"
import { backoffRetrier } from "../utils"
import {
  EthersContractConfig,
  EthersContractDeployment,
  EthersContractHandle,
} from "./adapter"
import { EthereumAddress } from "./address"
import { Chains } from "../contracts/chain"
import { reservationBridgeAbiFragments } from "./artifacts/reservation-bridge-fragments"

import MainnetBridgeDeployment from "./artifacts/mainnet/Bridge.json"
import SepoliaBridgeDeployment from "./artifacts/sepolia/Bridge.json"
import LocalBridgeDeployment from "@keep-network/tbtc-v2/artifacts/Bridge.json"

/**
 * Array-typed views of the raw on-chain tuple returns. Ethers returns
 * struct outputs as arrays indexed by component position; these aliases
 * name the shapes the handle reads.
 */
type ReservationsRecord = [
  string,
  BigNumberish,
  BigNumberish,
  string,
  BigNumberish,
  BigNumberish,
  string,
  BigNumberish,
  number,
  BigNumberish
]

type ReservationActionsRecord = [
  string,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  number,
  number,
  boolean,
  string,
  string,
  string,
  BigNumberish,
  boolean,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  boolean
]

type ReservationParametersRecord = [
  string,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish
]

type ReservationCapsRecord = [
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish
]

type OccupancyRecord = [BigNumberish, BigNumberish]

type DepositRecord = [
  string,
  BigNumberish,
  BigNumberish,
  string,
  BigNumberish,
  BigNumberish,
  string
]

type WalletRecord = [
  string,
  string,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish,
  number,
  string
]

type DepositParametersRecord = [
  BigNumberish,
  BigNumberish,
  BigNumberish,
  BigNumberish
]

/**
 * Converts an event argument to a 0x-prefixed hex string, accepting both
 * 0x-prefixed and bare values.
 * @param value The raw value.
 * @returns The 0x-prefixed hex string.
 */
function with0x(value: unknown): string {
  const str = String(value)
  return str.startsWith("0x") ? str : "0x" + str
}

/**
 * Merges the reservation router ABI fragments into the Bridge deployment
 * artifact. The reservation surface is reached through the Bridge address:
 * the Bridge fallback routes every unmatched selector to the reservation
 * router, so the handle binds the combined ABI at the Bridge address.
 *
 * @param bridgeDeployment Base Bridge deployment artifact.
 * @returns Deployment artifact with the reservation fragments appended to
 *          the ABI.
 */
function withReservationFragments(
  bridgeDeployment: EthersContractDeployment
): EthersContractDeployment {
  return {
    ...bridgeDeployment,
    abi: [
      ...(bridgeDeployment.abi as object[]),
      ...reservationBridgeAbiFragments,
    ],
  }
}

/**
 * Implementation of the Reservations handle: the reservation surface of
 * the Bridge, reached through the Bridge address with the combined
 * Bridge + reservation router ABI.
 */
export class EthereumReservations
  extends EthersContractHandle<EthersContract>
  implements Reservations
{
  constructor(
    config: EthersContractConfig,
    chainId: Chains.Ethereum = Chains.Ethereum.Local
  ) {
    let bridgeDeployment: EthersContractDeployment

    switch (chainId) {
      case Chains.Ethereum.Local:
        bridgeDeployment = LocalBridgeDeployment
        break
      case Chains.Ethereum.Sepolia:
        bridgeDeployment = SepoliaBridgeDeployment
        break
      case Chains.Ethereum.Mainnet:
        bridgeDeployment = MainnetBridgeDeployment
        break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, withReservationFragments(bridgeDeployment))
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#requestReservationAcceptance}
   */
  async requestReservationAcceptance(
    fundingTx: BitcoinRawTxVectors,
    fundingProof: BitcoinSpvProof,
    fundingOutputIndex: number,
    walletPublicKeyHash: Hex
  ): Promise<Hex> {
    const fundingTxParam = {
      version: `0x${fundingTx.version}`,
      inputVector: `0x${fundingTx.inputs}`,
      outputVector: `0x${fundingTx.outputs}`,
      locktime: `0x${fundingTx.locktime}`,
    }

    const fundingProofParam = {
      merkleProof: fundingProof.merkleProof.toPrefixedString(),
      txIndexInBlock: fundingProof.txIndexInBlock,
      bitcoinHeaders: fundingProof.bitcoinHeaders.toPrefixedString(),
      coinbasePreimage: fundingProof.coinbasePreimage.toPrefixedString(),
      coinbaseProof: fundingProof.coinbaseProof.toPrefixedString(),
    }

    const tx = await this._instance.functions["requestReservationAcceptance"](
      fundingTxParam,
      fundingProofParam,
      fundingOutputIndex,
      walletPublicKeyHash.toPrefixedString()
    )

    return Hex.from(tx.hash)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#releaseReservedDepositToPool}
   */
  async releaseReservedDepositToPool(
    depositKey: BigNumber,
    vault: ChainIdentifier
  ): Promise<Hex> {
    const tx = await this._instance.functions["releaseReservedDepositToPool"](
      depositKey,
      vault === undefined ? AddressZero : `0x${vault.identifierHex}`
    )

    return Hex.from(tx.hash)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#reservations}
   */
  async reservations(depositKey: BigNumber): Promise<ReservationRecord> {
    const record: ReservationsRecord = await backoffRetrier<ReservationsRecord>(
      this._totalRetryAttempts
    )(async () => {
      return await this._instance.callStatic["reservations"](depositKey)
    })

    return {
      owner:
        record[0] === AddressZero || record[0] === "0x" + "0".repeat(40)
          ? undefined
          : EthereumAddress.from(String(record[0])),
      mintedAmount: BigNumber.from(record[1]),
      acceptedAt: BigNumber.from(record[2]).toNumber(),
      walletPublicKeyHash: Hex.from(with0x(record[3])),
      anchorAmount: BigNumber.from(record[4]),
      expiresAt: BigNumber.from(record[5]).toNumber(),
      anchorTxHash: Hex.from(with0x(record[6])),
      anchorTxOutputIndex: BigNumber.from(record[7]).toNumber(),
      state: record[8],
      requestNonce: BigNumber.from(record[9]).toNumber(),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#reservationActions}
   */
  async reservationActions(
    depositKey: BigNumber,
    requestNonce: number
  ): Promise<ReservationActionRecord> {
    const record: ReservationActionsRecord =
      await backoffRetrier<ReservationActionsRecord>(this._totalRetryAttempts)(
        async () => {
          return await this._instance.callStatic["reservationActions"](
            depositKey,
            requestNonce
          )
        }
      )

    return {
      targetWalletPublicKeyHash: Hex.from(with0x(record[0])),
      requestedAt: BigNumber.from(record[1]).toNumber(),
      timeoutAt: BigNumber.from(record[2]).toNumber(),
      txMaxFee: BigNumber.from(record[3]),
      actionType: record[4],
      state: record[5],
      amount: BigNumber.from(record[10]),
      termSeconds: BigNumber.from(record[17]).toNumber(),
      minAmount: BigNumber.from(record[18]),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#reservationParameters}
   */
  async reservationParameters(): Promise<ReservationParameters> {
    const record: ReservationParametersRecord =
      await backoffRetrier<ReservationParametersRecord>(
        this._totalRetryAttempts
      )(async () => {
        return await this._instance.callStatic["reservationParameters"]()
      })

    return {
      vault:
        record[0] === AddressZero ? undefined : EthereumAddress.from(record[0]),
      minAmount: BigNumber.from(record[1]),
      txMaxFee: BigNumber.from(record[2]),
      termSeconds: BigNumber.from(record[3]).toNumber(),
      dissolutionDelaySeconds: BigNumber.from(record[4]).toNumber(),
      maxTotalAmount: BigNumber.from(record[5]),
      totalAmount: BigNumber.from(record[6]),
      maxReservationsPerWallet: BigNumber.from(record[7]).toNumber(),
      actionTimeoutSeconds: BigNumber.from(record[8]).toNumber(),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#reservationCaps}
   */
  async reservationCaps(): Promise<ReservationCaps> {
    const record: ReservationCapsRecord =
      await backoffRetrier<ReservationCapsRecord>(this._totalRetryAttempts)(
        async () => {
          return await this._instance.callStatic["reservationCaps"]()
        }
      )

    return {
      maxAmountPerWallet: BigNumber.from(record[0]),
      maxSingleAmount: BigNumber.from(record[1]),
      maxActiveReservations: BigNumber.from(record[2]).toNumber(),
      maxThirdPartyReanchorHoldsPerWallet: BigNumber.from(record[3]).toNumber(),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#reservationHandoffReserveWallets}
   */
  async reservationHandoffReserveWallets(): Promise<number> {
    return backoffRetrier<number>(this._totalRetryAttempts)(async () => {
      return BigNumber.from(
        await this._instance.callStatic["reservationHandoffReserveWallets"]()
      ).toNumber()
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#activeReservationsCount}
   */
  async activeReservationsCount(): Promise<ReservationOccupancy> {
    const record: OccupancyRecord = await backoffRetrier<OccupancyRecord>(
      this._totalRetryAttempts
    )(async () => {
      return await this._instance.callStatic["activeReservationsCount"]()
    })

    return {
      count: BigNumber.from(record[0]).toNumber(),
      maxActive: BigNumber.from(record[1]).toNumber(),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#liveWalletsCount}
   */
  async liveWalletsCount(): Promise<number> {
    return backoffRetrier<number>(this._totalRetryAttempts)(async () => {
      return BigNumber.from(
        await this._instance.callStatic["liveWalletsCount"]()
      ).toNumber()
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#walletReservationsAmount}
   */
  async walletReservationsAmount(walletPublicKeyHash: Hex): Promise<BigNumber> {
    return backoffRetrier<BigNumber>(this._totalRetryAttempts)(async () => {
      return BigNumber.from(
        await this._instance.callStatic["walletReservationsAmount"](
          walletPublicKeyHash.toPrefixedString()
        )
      )
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#walletReservationsCount}
   */
  async walletReservationsCount(walletPublicKeyHash: Hex): Promise<number> {
    return backoffRetrier<number>(this._totalRetryAttempts)(async () => {
      return BigNumber.from(
        await this._instance.callStatic["walletReservationsCount"](
          walletPublicKeyHash.toPrefixedString()
        )
      ).toNumber()
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#pendingReservedDeposits}
   */
  async pendingReservedDeposits(): Promise<number> {
    return backoffRetrier<number>(this._totalRetryAttempts)(async () => {
      return BigNumber.from(
        await this._instance.callStatic["pendingReservedDeposits"]()
      ).toNumber()
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#reservedDepositWallet}
   */
  async reservedDepositWallet(depositKey: BigNumber): Promise<Hex> {
    return backoffRetrier<Hex>(this._totalRetryAttempts)(async () => {
      return Hex.from(
        with0x(
          await this._instance.callStatic["reservedDepositWallet"](depositKey)
        )
      )
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#pendingThirdPartyReanchorHolds}
   */
  async pendingThirdPartyReanchorHolds(
    walletPublicKeyHash: Hex
  ): Promise<number> {
    return backoffRetrier<number>(this._totalRetryAttempts)(async () => {
      return BigNumber.from(
        await this._instance.callStatic["pendingThirdPartyReanchorHolds"](
          walletPublicKeyHash.toPrefixedString()
        )
      ).toNumber()
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#isReservedDeposit}
   */
  async isReservedDeposit(depositKey: BigNumber): Promise<boolean> {
    return backoffRetrier<boolean>(this._totalRetryAttempts)(async () => {
      return await this._instance.callStatic["isReservedDeposit"](depositKey)
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#deposit}
   */
  async deposit(depositKey: BigNumber): Promise<{
    depositor: ChainIdentifier
    amount: BigNumber
    revealedAt: number
    vault?: ChainIdentifier
    treasuryFee: BigNumber
    sweptAt: number
  }> {
    const record: DepositRecord = await backoffRetrier<DepositRecord>(
      this._totalRetryAttempts
    )(async () => {
      return await this._instance.callStatic["deposits"](depositKey)
    })

    return {
      depositor: EthereumAddress.from(record[0]),
      amount: BigNumber.from(record[1]),
      revealedAt: BigNumber.from(record[2]).toNumber(),
      vault:
        record[3] === AddressZero ? undefined : EthereumAddress.from(record[3]),
      treasuryFee: BigNumber.from(record[4]),
      sweptAt: BigNumber.from(record[5]).toNumber(),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#wallet}
   */
  async wallet(walletPublicKeyHash: Hex): Promise<{
    ecdsaWalletID: Hex
    state: WalletState
  }> {
    const record: WalletRecord = await backoffRetrier<WalletRecord>(
      this._totalRetryAttempts
    )(async () => {
      return await this._instance.callStatic["wallets"](
        walletPublicKeyHash.toPrefixedString()
      )
    })

    return {
      ecdsaWalletID: Hex.from(with0x(record[0])),
      state: WalletState.parse(record[7]),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#isVaultTrusted}
   */
  async isVaultTrusted(vault: ChainIdentifier): Promise<boolean> {
    return backoffRetrier<boolean>(this._totalRetryAttempts)(async () => {
      return await this._instance.callStatic["isVaultTrusted"](
        `0x${vault.identifierHex}`
      )
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#depositParameters}
   */
  async depositParameters(): Promise<{
    dustThreshold: BigNumber
    treasuryFeeDivisor: BigNumber
    txMaxFee: BigNumber
    revealAheadPeriodSeconds: number
  }> {
    const record: DepositParametersRecord =
      await backoffRetrier<DepositParametersRecord>(this._totalRetryAttempts)(
        async () => {
          return await this._instance.callStatic["depositParameters"]()
        }
      )

    return {
      dustThreshold: BigNumber.from(record[0]),
      treasuryFeeDivisor: BigNumber.from(record[1]),
      txMaxFee: BigNumber.from(record[2]),
      revealAheadPeriodSeconds: BigNumber.from(record[3]).toNumber(),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#getNewWalletRegisteredEvents}
   */
  async getNewWalletRegisteredEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<NewWalletRegisteredEvent[]> {
    const events: EthersEvent[] = await this.getEvents(
      "NewWalletRegistered",
      options,
      ...filterArgs
    )

    return events.map<NewWalletRegisteredEvent>((event) => {
      const args = event.args as unknown as Record<string, unknown>

      return {
        blockNumber: BigNumber.from(event.blockNumber).toNumber(),
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        ecdsaWalletID: Hex.from(with0x(args.ecdsaWalletID)),
        walletPublicKeyHash: Hex.from(with0x(args.walletPubKeyHash)),
      }
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Reservations#getReservedDepositReleasedToPoolEvents}
   */
  async getReservedDepositReleasedToPoolEvents(
    options?: GetChainEvents.Options
  ): Promise<
    Array<
      {
        depositKey: BigNumber
        depositor: ChainIdentifier
        vault?: ChainIdentifier
      } & ChainEvent
    >
  > {
    const events: EthersEvent[] = await this.getEvents(
      "ReservedDepositReleasedToPool",
      options
    )

    return events.map((event) => {
      const args = event.args as unknown as Record<string, unknown>
      const { depositKey, depositor, vault } = args

      return {
        blockNumber: BigNumber.from(event.blockNumber).toNumber(),
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        depositKey: BigNumber.from(depositKey as BigNumberish),
        depositor: EthereumAddress.from(String(depositor)),
        vault:
          vault === AddressZero
            ? undefined
            : EthereumAddress.from(String(vault)),
      }
    })
  }
}
