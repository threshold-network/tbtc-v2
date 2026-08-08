# UTXO Reservation — Frozen Parameter and Economic Spec

Status: **DRAFT pending governance sign-off.** This document freezes the
parameter surface and economic model of the UTXO reservation feature for
audit. Every value below marked _(sign-off)_ is a governance decision the
implementation exposes but does not settle; the mechanics are fixed, the
numbers are proposals. Companion: `docs/rfc/rfc-13.adoc`,
`docs/utxo-reservation-design.md`.

## 1. Parameter surface

### Bridge reservation parameters (`updateReservationParameters`)

| Parameter                         | Meaning                                                    | Launch value            | Bounds / notes                                                                       |
| --------------------------------- | ---------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `reservationVault`                | Liability-side vault; deposits revealed to it are reserved | deployed vault          | Changeable only with zero active reservations **and** zero pending reserved deposits |
| `reservationMinAmount`            | Minimum anchor amount (sat)                                | 10 BTC _(sign-off)_     | Must exceed `reservationTxMaxFee`; the count/size dial for pre-FROST ceremony cost   |
| `reservationTxMaxFee`             | Per-transaction Bitcoin miner-fee cap (sat)                | governance _(sign-off)_ | > 0; a partial redemption's redeemed portion and remainder must each exceed it       |
| `reservationTermSeconds`          | Custody term granted per acceptance/renewal                | 365 days _(sign-off)_   | Hard bounds **90–730 days** (protocol constants)                                     |
| `reservationDissolutionDelay`     | Post-expiry delay before dissolvable (renamed grace)       | 30 days _(sign-off)_    | Snapshotted per granted term; not an owner-action window                             |
| `reservationMaxTotalAmount`       | Global reserved-anchor cap (sat)                           | 500 BTC _(sign-off)_    | The absolute lever; the reserved-fraction target is enforced through it (§3)         |
| `maxReservationsPerWallet`        | Per-wallet reservation count cap                           | ~10 _(sign-off)_        | Bounds re-anchor ceremonies in a rotation window                                     |
| `reservationActionTimeout`        | Timeout for acceptance/re-anchor/dissolution actions       | 48 hours _(sign-off)_   | > 0; redemptions use `redemptionTimeout`                                             |
| `reservationRenewalWindowSeconds` | Renewal window before expiry                               | 30 days _(sign-off)_    | `0 < window < term`, enforced atomically                                             |

### Bridge reservation caps (`updateReservationCaps`)

| Parameter                        | Meaning                              | Launch value              | Notes      |
| -------------------------------- | ------------------------------------ | ------------------------- | ---------- |
| `maxReservationsAmountPerWallet` | Per-wallet total anchor amount (sat) | governance _(sign-off)_   | 0 disables |
| `reservationMaxSingleAmount`     | Single-reservation maximum (sat)     | 0 = disabled _(sign-off)_ | 0 disables |

### ReservationVault fees and reserve

| Parameter              | Meaning                             | Value                   | Notes                                                                                               |
| ---------------------- | ----------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------- |
| `initiationFeeBps`     | Acceptance fee (bps of gross)       | 40                      | 20 bps mint-leg parity + 20 bps first-year custody                                                  |
| `extensionFeeBps`      | Renewal fee (bps of gross)          | 20                      | Per renewed term                                                                                    |
| `redemptionFeeBps`     | Redemption fee (bps of gross)       | 20                      | Pooled parity; not re-charged on wallet-fault retries; a partial charges it on the redeemed portion |
| `MAX_FEE_BASIS_POINTS` | Per-fee hard cap                    | 500 (constant)          |                                                                                                     |
| `feeReserveTarget`     | Retained in-kind fee reserve (TBTC) | governance _(sign-off)_ | Seed before unpausing; excess sweeps to treasury                                                    |

## 2. Economic model (frozen mechanics)

- **Claim ≡ anchor, always.** `mintedAmount` tracks `anchorAmount` at every
  instant. Acceptance mints the gross anchor value; a whole redemption burns
  it, and a partial burns the redeemed portion while re-anchoring the
  remainder to the wallet (claim and anchor drop by the redeemed amount in
  lockstep); re-anchor and dissolution write it down to the new anchor and
  finance the miner fee from the vault reserve. There is no netting and no
  per-position accumulating leakage.
- **Fee schedule 40 / 20 / 20**, all-in initiation 40 bps (endpoints at
  pooled parity, so the purchased premium is exactly the 20 bps/yr custody
  fee). N-year holding pays `40 + 20N` bps vs pooled 40 — strictly premium
  at every horizon. Stable across the FROST transition by design; the
  minimum reservation size, not a fee change, keeps carry ≥ per-position
  lifecycle cost.
- **Renewal is exactly one term.** Proration is moot (a renewal never adds
  a partial term) and a renewal-horizon cap is unnecessary (the window <
  term makes stacking impossible). Maximum owner lookahead = one term +
  window.
- **In-kind fees are financed, never leaked.** The vault burns TBTC equal
  to each re-anchor/dissolution miner fee; a reserve shortfall becomes
  public, repayable `inKindFeeDebtSat` rather than silent over-issuance.

## 3. Reserved-fraction target — governance operating rule (not on-chain)

The design's "reserved backing ≤ 10–20 % of total" ceiling is **not** an
on-chain check: the Bank exposes no trustless aggregate backing figure, and
introducing an oracle to gate a throttle is a worse risk than the throttle
protects against. Instead:

- The absolute `reservationMaxTotalAmount` is the on-chain lever.
- Governance sets it to at most the target fraction of the current total
  BTC backing, observed off-chain, and re-tightens it as backing moves.
- Launch target: **10 %** of backing _(sign-off)_, realized as a 500 BTC
  absolute cap at the assumed launch backing _(sign-off)_.

Flag this as an explicit accepted limitation for the audit.

## 4. Open economics items (out of contract scope)

- **Senior-liquidity option pricing.** A reserved owner holds a demand
  claim against term-locked backing — effectively a senior liquidity
  option over the pool. Whether 20 bps/yr correctly prices it is a
  financial-modeling question for the user/economics owner, not a contract
  parameter. Noted, not invented.
- **`updateFees` governance delay.** Fees are owner-gated but not yet
  behind the protocol governance delay wrapper; and initiation-fee terms
  are not snapshotted per position (renewal/redemption fees are read at
  call time with a user slippage bound, but acceptance has no user-facing
  slippage bound because it is wallet-initiated). Both are tracked
  follow-ups; neither blocks the settlement-class audit.
- **Grace penalty.** None — the post-expiry delay is a settlement-
  coordination window, not an owner grace period, so there is nothing to
  penalize. (The earlier "grace penalty default 0" item is resolved by the
  redesign, not merely defaulted.)

## 4a. Governance operating invariants (from the re-review)

The adversarial re-review surfaced two governance-set relationships that
the contracts do not enforce but that governance must respect:

- **`reservedRedemptionVetoDelay < redemptionTimeout`.** If the watchtower
  veto delay for a reserved redemption exceeded `redemptionTimeout`, a
  redemption generation could time out before its veto window closed,
  letting a would-be-vetoed redemption settle late. Safe under the default
  delays (hours) vs `redemptionTimeout` (days); keep the delay strictly
  below the timeout when tuning either.
- **Reservation-vault re-pointing.** Re-pointing `reservationVault` while
  positions or pending deposits exist is already blocked on-chain; the
  re-review additionally hardened late acceptance settlement to credit the
  deposit's immutable revealed vault, so a governance re-point cannot
  misroute a late credit. Still, avoid re-pointing the vault while any
  reserved deposit could still settle late.

## 5. Sign-off ledger

| Item                                                      | Owner                      | Status    |
| --------------------------------------------------------- | -------------------------- | --------- |
| Term bounds 90–730 d, default 365 d                       | governance                 | ☐         |
| Renewal window 30 d                                       | governance                 | ☐         |
| Dissolution delay 30 d                                    | governance                 | ☐         |
| Min reservation 10 BTC                                    | governance                 | ☐         |
| Global cap 500 BTC / 10 % fraction                        | governance                 | ☐         |
| Per-wallet count ~10, amount cap                          | governance                 | ☐         |
| Action timeout 48 h                                       | governance                 | ☐         |
| Fee schedule 40 / 20 / 20                                 | governance (settled prior) | ☐ confirm |
| `feeReserveTarget` seed                                   | governance                 | ☐         |
| Reserved-fraction as off-chain rule (accepted limitation) | governance                 | ☐         |
| Senior-liquidity option pricing                           | economics                  | ☐         |
