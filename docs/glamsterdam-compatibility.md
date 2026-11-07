# Glamsterdam contract compatibility

This draft provides optional hardening for the proposed Glamsterdam gas rules.
The review and supplied Sepolia results have not demonstrated a mainnet contract
upgrade requirement before activation. Mainnet fraud challenges are disabled;
the deferred-payment change concerns deployments where challenges are enabled
or may be enabled later. Retaining these changes as a draft does not schedule
an upgrade. If they are selected for deployment, re-run fork tests against the
final activation rules and complete the migration checks below.

## Fraud challenge payments

The Bridge continues to attempt the existing bounded ETH payment when a fraud
challenge is resolved. A receiver that exceeds that budget or rejects ETH now
gets a credit in `pendingFraudChallengePayouts(beneficiary)`. The beneficiary
calls `claimFraudChallengePayout(recipient)` to withdraw with a gas estimate
appropriate for the recipient. A contract beneficiary can choose a storage-free
recipient without changing the treasury or challenger that earned the credit.
Anyone can also call `retryFraudChallengePayout(beneficiary)` to deliver the
credit to its original beneficiary. That retry cannot redirect ETH, and supports
legacy receiving contracts that cannot call the new claim function themselves.

Only the credited beneficiary can redirect a withdrawal. The credit is cleared
before the external call; failed claims and retries revert and restore it. Multiple failed payments
accumulate. Successful existing payment paths retain their existing behavior.

The new mapping consumes one reserved slot in `BridgeState.Storage` and reduces
the gap from 48 to 47. No pre-existing field moves, and no new base contract is
introduced. An upgrade must deploy/link the new Fraud library and validate the
Bridge storage layout before upgrading the proxy. No reinitializer is needed.
Previously lost payments cannot be reconstructed automatically: this change only
credits payments attempted after the upgrade.

Mainnet fraud challenges are currently disabled, so the receiver-payment issue
does not require a mainnet upgrade for Glamsterdam activation. Before enabling
challenges, assess the receiving contracts and select a payout policy. If this
deferred-payment design is selected, deploy and verify the upgraded Bridge and
Fraud library before enabling challenges. Other deployments selecting this
design need the same migration.

## Gas reimbursement

All explicit `gasStart - gasleft()` calculations in this repository now use
`GasAccounting.gasSpent`. If normal gas rises above the starting reading, the
measurement returns zero rather than reverting an otherwise valid operation.

This does **not** make `gasleft()` a total-cost meter. There are two distinct
limits:

- The calldata floor is applied during final transaction settlement, after
  execution and refunds. When it exceeds the gas otherwise billed, the receipt
  includes a floor top-up that a `gasStart - gasleft()` measurement cannot see.
  This also applies when the transaction gas limit is at or below 2^24.
- Above a transaction gas limit of 2^24, EIP-8037 can additionally pay new-state
  costs from a reservoir that is invisible to `gasleft()`.

Clamping prevents subtraction failures but cannot recover either omitted cost.
Existing fee offsets may cover a benchmarked path; they do not reconstruct an
arbitrary settlement floor, reservoir charge, or variable number of newly
created output records. A gas limit below 2^24 avoids a state-gas reservoir but
does not guarantee full reimbursement.

Until a separate capped/agreed-fee reimbursement design is adopted:

- operators should use fresh gas estimates and compare the actual refund with
  receipt gas used and effective gas price, including below 2^24;
- benchmark all owner/governance-settable offsets and ReimbursementPool static
  overhead on the target fork, covering floor-bound transactions as well as
  transactions with a state-gas reservoir;
- keep dormant cross-chain reimbursement authorizations disabled until this
  economic limitation has an approved resolution;
- do not widen `movingFundsCommitmentGasOffset` in place: its uint16 field is
  packed into the existing Bridge layout and the setter/getter are public ABI.
  A replacement policy must use append-only storage and a reviewed governance
  migration. Its maximum 65,535 cannot cover a hidden 97,920 state-gas charge.

`MaintainerProxy` and `LightRelayMaintainerProxy` are not upgradeable. If these
optional code changes are adopted for either proxy, deploy a replacement,
benchmark/configure offsets, authorize it in the pool, and switch operators
before deauthorizing the old instance. Adopting the changes in upgradeable
depositors/redeemers requires their normal proxy implementation upgrades; keep
their storage and inheritance order unchanged. These are conditional migration
steps, not a demonstrated requirement to replace live contracts before the fork.

## Validation

Run the new deferred-payment tests together with the existing fraud suite:

```sh
cd solidity
yarn test test/bridge/Bridge.FraudPayouts.test.ts test/bridge/Bridge.Frauds.test.ts test/GasAccounting.test.ts
```

The tests cover a rejecting treasury, a receiver beyond the push budget, failed
claim retry, alternate recipients, beneficiary authorization, reentry, the
challenger refund path, and unchanged immediate payments. GasAccounting tests
cover increasing and decreasing readings. Standard Hardhat tests do not emulate
Amsterdam settlement floors or the state-gas reservoir. If this draft is chosen
for deployment, a fork sweep must cover floor-bound transactions below 2^24 and
reservoir transactions above it, with receipt costs compared to refunds.

Also execute the patched deferred-credit and withdrawal bytecode under the
Amsterdam rules, including a receiver that creates storage, a rejected claim,
and retry recovery. Passing the ordinary Hardhat credit-logic tests does not
establish that those paths have enough gas after repricing.

After compilation, verify the complete BridgeState layout against the chosen
pre-upgrade commit with the project's solc-js 0.8.17 build:

```sh
node scripts/check-bridge-storage-layout.cjs <pre-upgrade-ref> <path-to-soljson-0.8.17.js>
```

The checker compares all existing field positions and nested types, the total
struct size, the new mapping's placement in the first gap slot, and the reduced
47-slot gap. It fails rather than accepting a moved or retyped existing field.

## Gas-rule references

- [EIP-7976](https://eips.ethereum.org/EIPS/eip-7976) raises the calldata floor to
  64 gas per byte, including zero bytes.
- [EIP-2780](https://eips.ethereum.org/EIPS/eip-2780) replaces the floor's legacy
  21,000 base with the applicable transaction base primitives.
- [EIP-8037 transaction gas used](https://eips.ethereum.org/EIPS/eip-8037#transaction-gas-used)
  applies the floor after refunds, separately from reservoir accounting.
- The reviewed [Amsterdam execution specification](https://github.com/ethereum/execution-specs/blob/a7dbafac0c0ec82e7b2e20959cc7c00ce958442a/src/ethereum/forks/amsterdam/vm/gas.py#L1163)
  implements that final settlement. These proposal rules must be checked again
  against the activated fork before any deployment decision.
