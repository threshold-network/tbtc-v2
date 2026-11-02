import { SystemEventType } from "./system-event"

import type {
  Bridge,
  WalletRegistry,
  NewWalletRegisteredEvent as WalletRegisteredChainEvent,
  DkgResultSubmittedEvent as DkgResultSubmittedChainEvent,
  DkgResultApprovedEvent as DkgResultApprovedChainEvent,
  DkgResultChallengedEvent as DkgResultChallengedChainEvent,
} from "@keep-network/tbtc-v2.ts/core"
import type { SystemEvent, Monitor as SystemEventMonitor } from "./system-event"

const WalletRegistered = (
  chainEvent: WalletRegisteredChainEvent
): SystemEvent => ({
  title: "Wallet registered",
  type: SystemEventType.Informational,
  data: {
    ecdsaWalletID: chainEvent.ecdsaWalletID.toPrefixedString(),
    walletPublicKeyHash: chainEvent.walletPublicKeyHash.toString(),
    ethRegisterTxHash: chainEvent.transactionHash.toPrefixedString(),
  },
  block: chainEvent.blockNumber,
})

const DkgResultSubmitted = (
  chainEvent: DkgResultSubmittedChainEvent
): SystemEvent => ({
  title: "DKG result submitted",
  type: SystemEventType.Informational,
  data: {
    resultHash: chainEvent.resultHash.toPrefixedString(),
    seed: chainEvent.seed.toPrefixedString(),
    submitterMemberIndex: chainEvent.result.submitterMemberIndex.toString(),
    groupPubKey: chainEvent.result.groupPubKey.toPrefixedString(),
    misbehavedMembersIndices:
      chainEvent.result.misbehavedMembersIndices.toString() || "none",
    signingMembersIndices: chainEvent.result.signingMembersIndices
      .map((smi) => smi.toString())
      .toString(),
    members: chainEvent.result.members.toString(),
    membersHash: chainEvent.result.membersHash.toPrefixedString(),
    ethSubmitTxHash: chainEvent.transactionHash.toPrefixedString(),
  },
  block: chainEvent.blockNumber,
})

const DkgResultApproved = (
  chainEvent: DkgResultApprovedChainEvent
): SystemEvent => ({
  title: "DKG result approved",
  type: SystemEventType.Informational,
  data: {
    resultHash: chainEvent.resultHash.toPrefixedString(),
    approver: `0x${chainEvent.approver.identifierHex}`,
    ethApproveTxHash: chainEvent.transactionHash.toPrefixedString(),
  },
  block: chainEvent.blockNumber,
})

const DkgResultChallenged = (
  chainEvent: DkgResultChallengedChainEvent
): SystemEvent => ({
  title: "DKG result challenged",
  type: SystemEventType.Critical,
  data: {
    resultHash: chainEvent.resultHash.toPrefixedString(),
    challenger: `0x${chainEvent.challenger.identifierHex}`,
    reason: chainEvent.reason,
    ethChallengeTxHash: chainEvent.transactionHash.toPrefixedString(),
  },
  block: chainEvent.blockNumber,
})

export class WalletMonitor implements SystemEventMonitor {
  private bridge: Bridge

  constructor(bridge: Bridge) {
    this.bridge = bridge
  }

  async check(fromBlock: number, toBlock: number): Promise<SystemEvent[]> {
    // eslint-disable-next-line no-console
    console.log("running wallet monitor check")

    const walletRegistry = await this.bridge.walletRegistry()

    const systemEvents: SystemEvent[] = []
    systemEvents.push(...(await this.checkNewWallets(fromBlock, toBlock)))
    systemEvents.push(
      ...(await this.checkDkgSubmissions(walletRegistry, fromBlock, toBlock))
    )
    systemEvents.push(
      ...(await this.checkDkgApprovals(walletRegistry, fromBlock, toBlock))
    )
    systemEvents.push(
      ...(await this.checkDkgChallenges(walletRegistry, fromBlock, toBlock))
    )

    // eslint-disable-next-line no-console
    console.log("completed wallet monitor check")

    return systemEvents
  }

  private async checkNewWallets(
    fromBlock: number,
    toBlock: number
  ): Promise<SystemEvent[]> {
    return (
      await this.bridge.getNewWalletRegisteredEvents({
        fromBlock,
        toBlock,
      })
    ).map(WalletRegistered)
  }

  private async checkDkgSubmissions(
    walletRegistry: WalletRegistry,
    fromBlock: number,
    toBlock: number
  ): Promise<SystemEvent[]> {
    return (
      await walletRegistry.getDkgResultSubmittedEvents({
        fromBlock,
        toBlock,
      })
    ).map(DkgResultSubmitted)
  }

  private async checkDkgApprovals(
    walletRegistry: WalletRegistry,
    fromBlock: number,
    toBlock: number
  ): Promise<SystemEvent[]> {
    return (
      await walletRegistry.getDkgResultApprovedEvents({
        fromBlock,
        toBlock,
      })
    ).map(DkgResultApproved)
  }

  private async checkDkgChallenges(
    walletRegistry: WalletRegistry,
    fromBlock: number,
    toBlock: number
  ): Promise<SystemEvent[]> {
    return (
      await walletRegistry.getDkgResultChallengedEvents({
        fromBlock,
        toBlock,
      })
    ).map(DkgResultChallenged)
  }
}
