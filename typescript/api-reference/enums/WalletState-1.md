# Enumeration: WalletState

## Table of contents

### Enumeration Members

- [Closed](WalletState-1.md#closed)
- [Closing](WalletState-1.md#closing)
- [Live](WalletState-1.md#live)
- [MovingFunds](WalletState-1.md#movingfunds)
- [Quarantined](WalletState-1.md#quarantined)
- [RecoveryRequired](WalletState-1.md#recoveryrequired)
- [Terminated](WalletState-1.md#terminated)
- [Unknown](WalletState-1.md#unknown)

## Enumeration Members

### Closed

• **Closed** = ``4``

The wallet finalized the closing period successfully and can no longer perform
any action in the Bridge.

#### Defined in

[src/lib/contracts/bridge.ts:525](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L525)

___

### Closing

• **Closing** = ``3``

The wallet moved or redeemed all their funds and is in the
losing period where it is still a subject of fraud challenges
and must defend against them.

#### Defined in

[src/lib/contracts/bridge.ts:520](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L520)

___

### Live

• **Live** = ``1``

The wallet can sweep deposits and accept redemption requests.

#### Defined in

[src/lib/contracts/bridge.ts:507](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L507)

___

### MovingFunds

• **MovingFunds** = ``2``

The wallet was deemed unhealthy and is expected to move their outstanding
funds to another wallet. The wallet can still fulfill their pending redemption
requests although new redemption requests and new deposit reveals are not
accepted.

#### Defined in

[src/lib/contracts/bridge.ts:514](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L514)

___

### Quarantined

• **Quarantined** = ``6``

An unresolved P2TR signature-fraud challenge temporarily blocks every
wallet action. The wallet's exact prior state is restored only after its
final challenge is defeated.

#### Defined in

[src/lib/contracts/bridge.ts:538](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L538)

___

### RecoveryRequired

• **RecoveryRequired** = ``7``

An SPV-authenticated transaction conflicted with a pre-signing reservation.
Automated wallet state transitions stop until an explicit recovery
procedure is executed.

#### Defined in

[src/lib/contracts/bridge.ts:544](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L544)

___

### Terminated

• **Terminated** = ``5``

The wallet committed a fraud that was reported, did not move funds to
another wallet before a timeout, or did not sweep funds moved to if from
another wallet before a timeout. The wallet is blocked and can not perform
any actions in the Bridge.

#### Defined in

[src/lib/contracts/bridge.ts:532](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L532)

___

### Unknown

• **Unknown** = ``0``

The wallet is unknown to the Bridge.

#### Defined in

[src/lib/contracts/bridge.ts:503](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L503)
