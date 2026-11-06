# Glamsterdam contract compatibility

This draft targets the EIP-8037/EIP-8038 pricing and accounting changes. Re-run
fork tests against the final activation rules before scheduling an upgrade.

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

Mainnet fraud challenges are currently disabled. Keep them disabled until the
upgraded Bridge and Fraud library have been deployed and verified. Other
deployments that enable challenges need the same migration.

## Gas reimbursement

All explicit `gasStart - gasleft()` calculations in this repository now use
`GasAccounting.gasSpent`. If normal gas rises above the starting reading, the
measurement returns zero rather than reverting an otherwise valid operation.

This does **not** make gasleft a total-cost meter. Above a transaction gas limit
of 2^24, EIP-8037 can pay new-state costs from a reservoir that is invisible to
gasleft. Clamping prevents subtraction failures but cannot recover that omitted
cost. The existing fee offsets are not an exact solution for arbitrary reservoir
transactions or variable numbers of newly-created output records.

Until a separate capped/agreed-fee reimbursement design is adopted:

- operators should estimate and submit ordinary reimbursements below 2^24 where
  possible, and explicitly account for their own shortfall if using a reservoir;
- benchmark all owner/governance-settable offsets and ReimbursementPool static
  overhead on the target fork;
- keep dormant cross-chain reimbursement authorizations disabled until this
  economic limitation has an approved resolution;
- do not widen `movingFundsCommitmentGasOffset` in place: its uint16 field is
  packed into the existing Bridge layout and the setter/getter are public ABI.
  A replacement policy must use append-only storage and a reviewed governance
  migration. Its maximum 65,535 cannot cover a hidden 97,920 state-gas charge.

`MaintainerProxy` and `LightRelayMaintainerProxy` are not upgradeable. Deploy
replacement proxies, benchmark/configure offsets, authorize them in the pool,
and switch operators before deauthorizing the old instances. Upgradeable
depositors/redeemers require their normal proxy implementation upgrades; keep
their storage and inheritance order unchanged.

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
the Amsterdam reservoir; a fork sweep above/below 2^24 remains required before
deployment.

After compilation, verify the complete BridgeState layout against the chosen
pre-upgrade commit with the project's solc-js 0.8.17 build:

```sh
node scripts/check-bridge-storage-layout.cjs <pre-upgrade-ref> <path-to-soljson-0.8.17.js>
```

The checker compares all existing field positions and nested types, the total
struct size, the new mapping's placement in the first gap slot, and the reduced
47-slot gap. It fails rather than accepting a moved or retyped existing field.
