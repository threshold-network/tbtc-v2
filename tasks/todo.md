# Review Fixes

1. [x] Harden Base/Arbitrum artifact copy flow and CI dry-run wiring
verify: hardhat configs fail fast on missing V2 artifact and Arbitrum dry-run builds `solidity` first

2. [x] Regenerate and commit Base/Arbitrum exported deployment artifacts for V2 ABI
verify: exported artifacts include `TokensTransferredWithPayload`

3. [x] Add upgrade-prep integration coverage for Base/Arbitrum upgrade scripts
verify: tests exercise `prepareUpgrade` against checked-in manifests/deployments

4. [x] Resolve fresh deployment inconsistency for Base L1 depositor
verify: deploy script scope is explicit and consistent with V2 rollout

5. [x] Update RFC-11 for the event-driven relayer flow
verify: docs describe direct Token Bridge transfer plus off-chain relay completion

6. [x] Reduce brittleness in V2 storage-layout tests
verify: tests keep upgrade-safety coverage with lower maintenance cost
