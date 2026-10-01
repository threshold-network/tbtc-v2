---
name: production-baseline
description: Work out, fresh on every run and with evidence, which git commit of tBTC v2 (and of the keep-core ECDSA and random-beacon contracts it depends on) is actually deployed on Ethereum mainnet. Use before auditing, reviewing, or debugging tBTC v2 contracts or the SDK against production, before reasoning about "what's live" or "what mainnet runs", and before claiming that a change is or is not deployed.
---

# Production baseline

This skill holds no answer. It never says "production is commit X". Work the answer out
from the sources below on every run, because deployments change and nothing here is
updated when they do.

Two shortcuts are wrong:

- **The newest `main` commit is not what is live.** Contract changes are merged long before
  (or without ever) being deployed, and upgrades go through governance delays.
- **The latest git tag or npm release is not what is live.** In this repo, release tags
  (`solidity/vX`, `typescript/vX`) and npm dist-tags (`latest`, `mainnet`) have both fallen
  behind deployed code before. Treat them as labels to compare against, never as evidence.

## Which source wins

When sources disagree, trust them in this order and report the disagreement:

1. **On-chain state** (EIP-1967 implementation slot, code at the address). This is what
   is actually live, but it is often unreachable from a sandbox (see the last section).
2. **Deployment artifacts matched by source hash** (step 3). This ties an address to an
   exact commit. It is the main tool of this skill.
3. **Deployment records** `solidity/deployments/mainnet/*-deployment-<unix-ms>.json`. These
   list what a deploy script deployed, reused, and still needed governance to execute.
4. **The org's internal service registry**, if you can read it. Its `tbtc-v2-mainnet-contracts`
   and `keep-core-mainnet` entries list key addresses and the artifact directories. Use it
   to cross-check addresses. It does not record commits.
5. **Git tags, GitHub releases, and npm dist-tags** in tbtc-v2 and keep-core. Use them only
   as context, for example "the deployed commit is N commits after tag T".

## Procedure

### 1. Get a full clone

Hash matching needs every blob of every branch, so a shallow or blobless clone will not
work:

```bash
git clone https://github.com/threshold-network/tbtc-v2 && cd tbtc-v2
git fetch --tags origin
```

You also need a keccak256 implementation. `ethers` in `solidity/node_modules` works after
`yarn install`; otherwise:

```bash
npm i --no-audit --no-fund --prefix "${TMPDIR:-/tmp}/k" @noble/hashes
export NODE_PATH="${TMPDIR:-/tmp}/k/node_modules"
```

### 2. List the deployed contracts

- Ethereum mainnet: `solidity/deployments/mainnet/*.json`, which are hardhat-deploy
  artifacts with `address`, `implementation` for proxies, `libraries`, `solcInputHash`,
  `metadata`, `bytecode`, and `deployedBytecode`. Next to them are `solcInputs/` and the
  deployment records described above.
- L1 depositors and L2 contracts: `cross-chain/<chain>/deployments/<network>/`.
- The SDK ships its own copies of mainnet addresses in
  `typescript/src/lib/ethereum/artifacts/mainnet/`.

Artifacts are sometimes committed on a branch before they reach `main`. Check every ref:

```bash
git log --all --format='%h %cs %d %s' -- solidity/deployments/mainnet | head -20
```

For each **proxy** artifact (it has an `implementation` field), find the artifact
deployed at that address, then take **linked libraries from the implementation artifact**.
A proxy artifact's own `libraries` field can be stale.

```bash
impl=$(jq -r .implementation solidity/deployments/mainnet/Bridge.json)
grep -il "\"address\": \"$impl\"" solidity/deployments/mainnet/*.json
jq .libraries solidity/deployments/mainnet/ < ImplementationArtifact > .json
```

If no artifact has the implementation's address, report that contract as unpinned.

### 3. Match source hashes to commits

The solc metadata in each artifact records `sources[path].keccak256` for every source file
compiled into that contract. A commit whose files hash to the same values contains exactly
the deployed source.

Run the bundled script for each implementation or library artifact:

```bash
node .agents/skills/production-baseline/scripts/match-sources.cjs \
  solidity/deployments/mainnet/ [--revs "--all"] [--node-modules solidity/node_modules] < Artifact > .json
```

The script reads hashes from `metadata`. When an artifact has no usable metadata, it falls
back to `solcInputs/<solcInputHash>.json`. That file covers the whole compilation unit,
not just one contract, so it is a stricter test and can match fewer commits. The script
then hashes the local (`contracts/...`) sources at every commit on any ref that touched
them, and prints:

- `FULL MATCH` with the matching commits. The deployed source equals the tree at each
  listed commit, and at later commits on the same line until one of those files changes
  again. If several runs match, for example after a revert, choose the one that is an
  ancestor of the commit that added the artifact (`git merge-base --is-ancestor`). Then
  record where it lives: `git branch -r --contains <c>` and `git tag --contains <c>`.
- `NO FULL MATCH` with the closest commits and the files that differ. The deployed code
  was built from a tree that is not in this repo, or a dependency differs.
- `NO_SOURCE_HASHES` for proxies (follow `implementation`), stub artifacts, and
  bytecode-only artifacts.

To check one file by hand:

```bash
jq -r '.metadata | fromjson | .sources["contracts/bridge/Bridge.sol"].keccak256' < Artifact > .json
git show < commit > :solidity/contracts/bridge/Bridge.sol | node -e \
  'const{keccak_256}=require("@noble/hashes/sha3");console.log("0x"+Buffer.from(keccak_256(require("fs").readFileSync(0))).toString("hex"))'
```

The script reports npm dependency sources (`@keep-network/*`, `@openzeppelin/*`, and so on)
as unchecked. To check them, check out the matched commit, run `yarn install` in
`solidity/`, and pass `--node-modules solidity/node_modules`. The resolved
`@keep-network/ecdsa` and `@keep-network/random-beacon` versions in `solidity/yarn.lock`
tell you which keep-core contract sources were compiled in.

For an artifact without source hashes there are two options. You can compile at the
candidate commit and compare `deployedBytecode`, ignoring the trailing CBOR metadata. Or,
if the explorer is reachable, you can compare against the verified source on Etherscan or
Sourcify. If neither works, report the contract as unpinned.

### 4. Confirm on chain (when reachable)

An artifact records what a deploy script deployed. It does not show that governance ever
pointed the proxy at it. Deployment records list the timelock and council actions that
were still pending at deploy time. If an RPC endpoint is reachable, read the EIP-1967
implementation slot of each proxy and compare it with the artifact's `implementation`:

```bash
SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
cast storage --rpc-url "$ETH_RPC_URL" < proxy > $SLOT
# or, without foundry:
curl -s -X POST -H 'content-type: application/json' "$ETH_RPC_URL" --data \
  '{"jsonrpc":"2.0","id":1,"method":"eth_getStorageAt","params":["<proxy>","'$SLOT'","latest"]}'
```

Linked library addresses are embedded in the implementation's runtime code, so
`eth_getCode` on the implementation confirms which library versions it calls.

### 5. keep-core contracts and client

keep-core holds the ECDSA (`WalletRegistry`) and random-beacon contracts that tBTC v2 calls,
and the `keep-client` that operators run. Use the same method there:

```bash
git clone https://github.com/threshold-network/keep-core && cd keep-core
ls solidity/ecdsa/deployments/mainnet solidity/random-beacon/deployments/mainnet # check the paths still exist
node < path-to > /match-sources.cjs solidity/ecdsa/deployments/mainnet/ --prefix solidity/ecdsa/ < Artifact > .json
git ls-remote --tags https://github.com/threshold-network/keep-core 'refs/tags/v*'
```

Client release tags show what is available, not what each operator runs. Say so instead
of assuming the latest tag.

### 6. The SDK

For the TypeScript SDK (`@keep-network/tbtc-v2.ts`), "live" means the version that
consumers pin, not the newest tag. Read it from the consumer's lockfile when you have one.
Otherwise use `npm view @keep-network/tbtc-v2.ts dist-tags` as a hint. Map a version to
source with `git rev-parse 'typescript/v<version>^{commit}'`. Check that the addresses in
that version's `typescript/src/lib/ethereum/artifacts/mainnet/` match the deployments
resolved above.

## What to report

Produce a table plus notes. For each contract give:

| Contract | Address (proxy → implementation) | Resolved commit | Evidence | On-chain confirmed? |
| -------- | -------------------------------- | --------------- | -------- | ------------------- |

- **Evidence**: name the artifact file, whether hashes came from `metadata` or `solcInput`,
  how many local sources matched, and whether npm sources were checked.
- **Placement**: give the nearest tag before the resolved commit, and say whether the
  commit is on `main` or only on another branch.
- **Unpinned**: list every contract you could not pin and the reason, such as no artifact
  for the implementation address, no source hashes, or no full match.
- **Not checked**: state anything you skipped, for example "on-chain confirmation not
  done: RPC unreachable".

## Sandboxed sessions

In Claude cloud sessions the outbound proxy often blocks Ethereum RPC endpoints, Etherscan,
and Sourcify (`CONNECT tunnel failed, response 403`). GitHub, npm, and git usually work.
When the chain is unreachable, use steps 2 and 3 alone. Say plainly in the report that
on-chain confirmation was not done and that the result shows what was deployed, not
necessarily what the proxies point at now.

Last verified: 2026-10-01. Step 3 resolved
`solidity/deployments/mainnet/BridgeTIP109HotfixImplementation.json` to a single
full-match commit. This only shows that the method works. It is not a statement about
what is live today.
