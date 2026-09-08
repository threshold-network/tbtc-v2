# Ethers v6 deployment compatibility

PR [#1067](https://github.com/threshold-network/tbtc-v2/pull/1067) uses a
compatibility check with two explicit exceptions to the original whole-file
byte-parity requirement. The raw comparison remains a separate result.
It fails; it must never be reported as passing after stripping fields.

The baseline is dev at `5b65585459f461b52f685588a80d6c1057da5bad` (ethers 5.5.4,
hardhat-deploy 0.11.15). The candidate uses ethers 6.17.0 and hardhat-deploy 1.0.4.
The [reviewed policy](../scripts/pr1067-parity-policy.json) pins both lockfiles,
package/config hashes, three compiler overrides, 25 affected local deployment
records, and the exact before/after hashes of 19 compiled deployment scripts.
Updating that policy requires reviewing the new differences.

## The two exceptions

1. **Additional compiler output.** OpenZeppelin upgrades 1.28.0 requests
   `storageLayout` for the main compiler list; 2.5.1 also requests it for
   overrides. WalletRegistry, BridgeGovernance and L1BTCDepositorNttWithExecutor
   gain that field. BridgeGovernance's deployment record gains the same layout
   and a new `solcInputHash`; its compiler-input filename changes accordingly.
   Each layout must match captured compiler output. Every other compiler
   input/output field must match, including ABI, bytecode and metadata.
   The input changes only by appending `storageLayout` to
   `settings.outputSelection["*"]["*"]`; hardhat-deploy's Murmur128 hash must
   match the filename and reference.
2. **One ownership-transfer gas limit.** The local ProxyAdmin
   `transferOwnership(esdm)` at block 42, index 0, deployer nonce 41 has a
   different gas limit. Both lockfiles resolve Hardhat **2.29.0**. Its resolver
   caps default transaction gas at 2^24 (EIP-7825), retaining the configured
   30,000,000 block gas limit. The ethers v5 ABI-gas path produces
   `16,777,216 - 1,000,000 + 22,680 = 15,799,896`. The candidate explicitly
   uses `gas: "auto"` and estimates 28,603, also the actual gas consumed.
   These expectations are derived from effective configuration, calldata
   and the receipt; arbitrary gas changes are rejected.

The second exception changes that transaction's signature/hash, transaction
root and encoded block size, then descendant block hashes and receipt/log
references. The checker reconstructs every signed transaction, recovers its
sender, recomputes transaction and receipt trie roots for the 95 mined blocks,
hashes all 96 block headers, checks block sizes and validates every receipt/log reference against its own
chain. Only the identified transaction and affected block fields may change.
State roots, receipt roots, actual gas, fees, calldata, values, order and all
other fields must match.

All five proxies retain the shared admin owned by ESDM. Captures include
implementation/admin slots, 22 owner getters, governance and wallet-owner
getters, and runtime code at all 53 created addresses. These values must match;
deployment records must agree with the captured relationships. Existing-network
records and `export.json` remain byte-identical. JSON files with an exception
must retain their formatting and all other content.

This proves compatibility for the captured local deployment. Equal state roots
bind code, storage, balances and nonces for those executions. They do not prove
behavior under other gas limits, future calls or live explorer acceptance.
Solidity sources and committed live upgrade manifests are unchanged by this PR.

## Reproduce

Use Node **24.11.1** and Yarn **4.12.0**, with the pinned lockfiles. The
[capture config](../scripts/pr1067-parity.config.ts) works in both worktrees.
It fixes the initial clock and advances timestamps one second per transaction.
It requires non-forked, in-process Hardhat with test stubs, rejects optional
upgrade flags and ambient configuration, and refuses an existing destination.

The local-networks plugin always merges `~/.hardhat/networks.json`; an empty
project file does not disable that behavior. Use a clean environment without
that file or a checkout `.env`. Do not change your home configuration for this
check. Effective Hardhat settings and an account-settings hash are recorded
without exporting account secrets.

From a checkout of the candidate revision:

```sh
parity_root="$(mktemp -d -t pr1067-parity)"
parity_candidate="$(git rev-parse HEAD)"
git worktree add --detach "$parity_root/dev" 5b65585459f461b52f685588a80d6c1057da5bad
git worktree add --detach "$parity_root/candidate" "$parity_candidate"
cp "$parity_root/candidate/solidity/scripts/pr1067-parity.config.ts" \
  "$parity_root/dev/solidity/scripts/pr1067-parity.config.ts"

for parity_side in dev candidate; do
  (
    cd "$parity_root/$parity_side/solidity"
    yarn install --immutable \
      && yarn build \
      && yarn prepack \
      && USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true \
        PR1067_CAPTURE="$parity_root/$parity_side-snapshot" \
        yarn hardhat deploy --config scripts/pr1067-parity.config.ts \
        --network hardhat --no-compile --reset --write true --export export.json
  ) || exit
done
cd "$parity_root/candidate/solidity"
```

The raw comparison has expected exit status **1** for this migration:

```sh
yarn ts-node scripts/compare-pr1067-parity.ts \
  "$parity_root/dev-snapshot" "$parity_root/candidate-snapshot" --raw
```

The compatibility check must exit **0** and also prints the raw failure:

```sh
yarn ts-node scripts/compare-pr1067-parity.ts \
  "$parity_root/dev-snapshot" "$parity_root/candidate-snapshot"

PARITY_BASELINE="$parity_root/dev-snapshot" \
  PARITY_CANDIDATE="$parity_root/candidate-snapshot" \
  yarn hardhat test --network hardhat --no-compile \
  scripts/compare-pr1067-parity.test.ts
```

The mutation tests use real snapshots and leave them intact. Changes to ABI,
bytecode, layouts, compiler options, owner/admin fields, calldata, a second
gas limit, block/receipt hashes, runtime code, extra fields/files, package
contents and a further change to an allowed script must all be rejected.
The checker does not learn exceptions from candidate differences. Other
transaction types, block shapes, baselines and tool versions require review.

## Deployment-script coverage

The exact 19 changed script paths and hashes are in the policy. Eleven execute
locally: **06, 14–18, 26, 35, 40, 82 and 90**. Eight are skipped:
**29, 44, 80, 81, 83, 84, 85 and 86**. Script 82 explicitly runs on Hardhat
despite being deprecated.

Local parity does not validate skipped or live-only paths. Future live
operations need their own applicable fork/dry-run validation; deprecated
scripts remain unsuitable for live governance. The consumer search found no
GitHub-indexed external deployment-script consumer, but executing the
published v6 scripts requires compatible ethers v6 tooling.

Future proxy/admin choices are tracked in
[#1130](https://github.com/threshold-network/tbtc-v2/issues/1130);
[#1075](https://github.com/threshold-network/tbtc-v2/issues/1075) tracks the
OpenZeppelin transition and
[#1128](https://github.com/threshold-network/tbtc-v2/issues/1128) tracks the
deployment rewrite. These issues do not enlarge this check's exceptions.
