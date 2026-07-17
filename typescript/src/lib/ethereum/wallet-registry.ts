import {
  GetChainEvents,
  WalletRegistry,
  DkgResultApprovedEvent,
  DkgResultChallengedEvent,
  DkgResultSubmittedEvent,
  ChainIdentifier,
  Chains,
} from "../contracts"
import { Hex } from "../utils"
import {
  asDeployment,
  EthereumContractConfig,
  EvmContractDeployment,
  EvmContractHandle,
} from "./adapter"
import { EthereumAddress } from "./address"

import MainnetWalletRegistryDeployment from "./artifacts/mainnet/WalletRegistry.json"
import SepoliaWalletRegistryDeployment from "./artifacts/sepolia/WalletRegistry.json"
import LocalWalletRegistryDeployment from "@keep-network/ecdsa/artifacts/WalletRegistry.json"

/**
 * Structural type of the on-chain `DkgResult` struct as decoded by viem from
 * the `DkgResultSubmitted` event. Numeric fields are typed `number | bigint`
 * because viem decodes uints depending on their ABI width - normalize at the
 * parsing site.
 */
type DkgResultStruct = {
  submitterMemberIndex: number | bigint
  groupPubKey: string
  misbehavedMembersIndices: readonly (number | bigint)[]
  signatures: string
  signingMembersIndices: readonly (number | bigint)[]
  members: readonly (number | bigint)[]
  membersHash: string
}

/**
 * Converts a numeric value to a minimal-length, even-padded, 0x-prefixed hex
 * string - the exact format the ethers `BigNumber.toHexString()` produced
 * (e.g. `0x01` for 1), which downstream `Hex` handling relies on.
 * @param value The value to convert.
 * @returns The 0x-prefixed hex string.
 */
function toEvenLengthHex(value: bigint): string {
  let hex = value.toString(16)
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`
  }
  return `0x${hex}`
}

/**
 * Implementation of the Ethereum WalletRegistry handle.
 * @see {WalletRegistry} for reference.
 */
export class EthereumWalletRegistry
  extends EvmContractHandle
  implements WalletRegistry
{
  constructor(
    config: EthereumContractConfig,
    chainId: Chains.Ethereum = Chains.Ethereum.Local
  ) {
    let deployment: EvmContractDeployment

    switch (chainId) {
      case Chains.Ethereum.Local:
        deployment = asDeployment(LocalWalletRegistryDeployment)
        break
      case Chains.Ethereum.Sepolia:
        deployment = asDeployment(SepoliaWalletRegistryDeployment)
        break
      case Chains.Ethereum.Mainnet:
        deployment = asDeployment(MainnetWalletRegistryDeployment)
        break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {WalletRegistry#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return this.getAddress()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {WalletRegistry#getWalletPublicKey}
   */
  async getWalletPublicKey(
    walletID: Hex,
    skipRetryWhenNotRegistered = false
  ): Promise<Hex> {
    const publicKey = await this._read<string>(
      "getWalletPublicKey",
      [walletID.toPrefixedString()],
      skipRetryWhenNotRegistered
        ? {
            nonRetryableErrors: [
              "Wallet with the given ID has not been registered",
            ],
          }
        : undefined
    )
    return Hex.from(publicKey.substring(2))
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {WalletRegistry#getDkgResultSubmittedEvents}
   */
  async getDkgResultSubmittedEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<DkgResultSubmittedEvent[]> {
    const events = await this._getEvents(
      "DkgResultSubmitted",
      options,
      ...filterArgs
    )

    return events.map<DkgResultSubmittedEvent>((event) => {
      const result = event.args.result as DkgResultStruct

      return {
        blockNumber: event.blockNumber,
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        resultHash: Hex.from(event.args.resultHash as string),
        seed: Hex.from(
          toEvenLengthHex(BigInt(event.args.seed as number | bigint))
        ),
        result: {
          submitterMemberIndex: BigInt(result.submitterMemberIndex),
          groupPubKey: Hex.from(result.groupPubKey),
          misbehavedMembersIndices: result.misbehavedMembersIndices.map((mmi) =>
            Number(mmi)
          ),
          signatures: Hex.from(result.signatures),
          signingMembersIndices: result.signingMembersIndices.map((smi) =>
            BigInt(smi)
          ),
          members: result.members.map((m) => Number(m)),
          membersHash: Hex.from(result.membersHash),
        },
      }
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {WalletRegistry#getDkgResultApprovedEvents}
   */
  async getDkgResultApprovedEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<DkgResultApprovedEvent[]> {
    const events = await this._getEvents(
      "DkgResultApproved",
      options,
      ...filterArgs
    )

    return events.map<DkgResultApprovedEvent>((event) => {
      return {
        blockNumber: event.blockNumber,
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        resultHash: Hex.from(event.args.resultHash as string),
        approver: EthereumAddress.from(event.args.approver as string),
      }
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {WalletRegistry#getDkgResultChallengedEvents}
   */
  async getDkgResultChallengedEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<DkgResultChallengedEvent[]> {
    const events = await this._getEvents(
      "DkgResultChallenged",
      options,
      ...filterArgs
    )

    return events.map<DkgResultChallengedEvent>((event) => {
      return {
        blockNumber: event.blockNumber,
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        resultHash: Hex.from(event.args.resultHash as string),
        challenger: EthereumAddress.from(event.args.challenger as string),
        reason: event.args.reason as string,
      }
    })
  }
}
