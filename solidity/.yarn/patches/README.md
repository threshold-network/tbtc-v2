# OpenZeppelin upgrades-core 1.46.0

The patch works around [OpenZeppelin issue #1227](https://github.com/OpenZeppelin/openzeppelin-upgrades/issues/1227).
When matching library link references, `getUnlinkedBytecode` tries references
from unrelated contracts. References from `BridgeGovernance` overlap the metadata
of `BTCDepositorWormhole`, causing metadata trimming to cut a library placeholder
and reject otherwise valid bytecode.

Candidate matching only needs the full bytecode hash. The patch uses
`hashBytecode` directly, preserving the existing comparison and rejection of
malformed bytecode without computing unused metadata-stripped hashes. It updates
both the distributed JavaScript and TypeScript source. Upgrade safety validation
still runs after matching.

`test/helpers/upgrades-core.test.ts` covers the metadata overlap, successful
library matching, and malformed bytecode rejection. Remove this patch when an
upstream release passes these tests and the Wormhole deployment fixture.

This repo also carries two `postinstall` shell scripts under `scripts/` that
patch other dependencies in place (`apply-solidity-contracts-export-deploy-patch.sh`,
`patch-hardhat-undici-connect-timeout.sh`). For any future npm-published
dependency patch, prefer this Yarn `patch:` protocol: it is lockfile-checksummed
and verifies that the patch applies. Of the two legacy scripts, the deploy-script
copier overwrites files without checking their original contents, while the
Hardhat timeout patch exits successfully if its expected pattern is absent.

A third legacy postinstall script, `patch-upgrades-core-unlinked-bytecode.sh`,
was removed because this Yarn patch fully supersedes it.
