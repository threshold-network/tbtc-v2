# Schnorr/FROST Migration External Repository Tracking

- Date: 2026-02-21
- Contributors: Threshold Labs
- Constraint: Do not mirror work in `threshold-network/tbtc-v2`.

## Repository Branches

| Repository                    | Branch                                  | Status | Draft PR                                                 |
| ----------------------------- | --------------------------------------- | ------ | -------------------------------------------------------- |
| `tlabs-xyz/tbtc`              | `feat/frost-schnorr-migration`          | Open   | https://github.com/tlabs-xyz/tbtc/pull/10                |
| `tlabs-xyz/frost-uniffi-sdk`  | `feat/frost-secp256k1-tr-go-bindings`   | Open   | https://github.com/tlabs-xyz/frost-uniffi-sdk/pull/1     |
| `threshold-network/keep-core` | `feat/frost-schnorr-migration-scaffold` | Open   | https://github.com/threshold-network/keep-core/pull/3866 |

## Implemented Changes

### `tlabs-xyz/tbtc`

- Added P2TR output parsing support in `contracts/tbtc-v2/contracts/bridge/BitcoinTx.sol`.
- Added compatibility alias helper `HASH160(0x02 || xOnlyKey)` in bridge parsing.
- Added canonical wallet ID extraction helper for legacy and Taproot outputs.
- Added P2TR script builder helper for contract-side validation paths.
- Added bridge contract tests for P2TR parsing and wallet ID extraction.
- Added SDK support for P2TR address/script conversions in
  `sdk/tbtc-v2-ts/src/lib/bitcoin/address.ts`.
- Added SDK P2TR fixtures and tests in `sdk/tbtc-v2-ts/test`.
- Added Phase 0 prototype Schnorr verifier library
  `contracts/tbtc-v2/contracts/prototypes/PrototypeCheckBitcoinSchnorrSigs.sol`
  and test wrapper
  `contracts/tbtc-v2/contracts/test/TestCheckBitcoinSchnorrSigs.sol`.
- Added prototype verifier tests and gas gate in
  `contracts/tbtc-v2/test/bridge/CheckBitcoinSchnorrSigs.test.ts`
  (`estimateGas(checkSig) < 50000`).
- Added canonical `bytes32` wallet ID compatibility mapping in Bridge state and
  wallet registration flow:
  `walletPubKeyHashByWalletID`, `NewWalletRegisteredV2`, `walletsByWalletID`,
  `walletID`, `walletPubKeyHashForWalletID`, `activeWalletID`.
- Propagated wallet ID support through SDK bridge interfaces and adapters:
  `sdk/tbtc-v2-ts/src/lib/contracts/bridge.ts`,
  `sdk/tbtc-v2-ts/src/lib/ethereum/bridge.ts`,
  `sdk/tbtc-v2-ts/test/utils/mock-bridge.ts`.
- Updated `contracts/tbtc-v2/hardhat.config.ts` to disable gas reporter by
  default (`REPORT_GAS=true` opt-in) so local test runs are deterministic.
- Added monorepo-aware fallback resolution for
  `@threshold-network/solidity-contracts` artifacts/deploy paths in
  `contracts/tbtc-v2/hardhat.config.ts`.
- Fixed allowlist-era Bridge fixture bootstrap by scoping fixture tags and
  adding test-network fallback deployments for `T`, `RebateStaking`,
  `WalletRegistry`, and `ReimbursementPool` in:
  `contracts/tbtc-v2/test/fixtures/bridge.ts`,
  `contracts/tbtc-v2/deploy/00_resolve_wallet_registry.ts`,
  `contracts/tbtc-v2/deploy/00_resolve_reimbursement_pool.ts`,
  `contracts/tbtc-v2/contracts/test/WalletRegistryStubForBridge.sol`.
- Added BIP340 tagged challenge hashing helper in
  `contracts/tbtc-v2/contracts/prototypes/PrototypeCheckBitcoinSchnorrSigs.sol`
  and
  wrapper exposure in
  `contracts/tbtc-v2/contracts/test/TestCheckBitcoinSchnorrSigs.sol`.
- Added Phase 1 BIP340 challenge reference and gas benchmark tests in
  `contracts/tbtc-v2/test/bridge/CheckBitcoinSchnorrSigs.test.ts`.
- Added fraud path gas benchmark suite in
  `contracts/tbtc-v2/test/bridge/Bridge.FraudGas.test.ts`.
- Added `NewWalletRegisteredV2` indexing coverage in
  `data/v3-indexer/src/indexer/abis/index.ts`,
  `data/v3-indexer/src/config/contracts.ts`,
  `data/v3-indexer/src/indexer/event-handlers/bridge.ts`,
  `data/v3-indexer/src/indexer/event-handlers/new-wallet-registered.test.ts`.
- Added `NewWalletRegisteredV2` subgraph support in
  `data/tbtc-subgraph/abis/Bridge.json`,
  `data/tbtc-subgraph/subgraph.yaml`,
  `data/tbtc-subgraph/src/mappingBridge.ts`.
- Added native active wallet canonical ID storage path for non-legacy wallet
  generations, including backward-compatible fallback derivation for migrated
  legacy state, in:
  `contracts/tbtc-v2/contracts/bridge/BridgeState.sol`,
  `contracts/tbtc-v2/contracts/bridge/Wallets.sol`,
  `contracts/tbtc-v2/contracts/bridge/Bridge.sol`,
  `contracts/tbtc-v2/contracts/test/BridgeStub.sol`,
  `contracts/tbtc-v2/test/bridge/Bridge.Wallets.test.ts`.

### `tlabs-xyz/frost-uniffi-sdk`

- Added secp256k1-tr ciphersuite support and made it the default build path.
- Added `frost-uniffi-sdk/src/ciphersuite.rs` and feature-gated ciphersuite
  wiring across coordinator/participant/serialization/trusted-dealer paths.
- Added unofficial core compatibility (`frost-core-unofficial`) for the
  secp256k1-tr mode while preserving redpallas feature support.
- Updated Go module path to `github.com/zecdev/frost-uniffi-sdk` and regenerated
  `frost_go_ffi` bindings (`frost_uniffi_sdk.go`, `frost_go_ffi.h`,
  `frost_go_ffi.c`) for the new API surface.
- Updated build scripts and README for ciphersuite-specific build flows:
  `Scripts/build_go.sh` (secp256k1-tr) and
  `Scripts/build_randomized_go.sh` (redpallas).
- TODO after internal review completion: open upstream PR from
  `tlabs-xyz/frost-uniffi-sdk` to `zecdev/frost-uniffi-sdk`.
- Status update (2026-02-26): this upstream PR is no longer a completion
  blocker for the migration because keep-core removed the active UniFFI SDK
  dependency path in commit `d4e95c5f3`; keep as optional follow-up only if
  UniFFI runtime compatibility is reintroduced.

### `threshold-network/keep-core`

- Added build-tagged native UniFFI FROST signing engine scaffold in
  `pkg/frost/signing/native_frost_engine_uniffi_frost_native.go`.
- Added registration split for default (`frost_native`) and optional
  UniFFI-backed (`frost_native && frost_uniffi_sdk && cgo`) paths in
  `pkg/frost/signing/native_frost_engine_uniffi_registration_frost_native_default.go`
  and
  `pkg/frost/signing/native_frost_engine_uniffi_registration_frost_native_uniffi.go`.
- Updated native provider bootstrap to auto-register build-tagged engine in
  `pkg/frost/signing/native_ffi_primitive_transitional_frost_native.go`.
- Added unit coverage for bridge delegation and validation in
  `pkg/frost/signing/native_frost_engine_uniffi_frost_native_test.go`.
- Added optional end-to-end UniFFI bridge test in
  `pkg/frost/signing/native_frost_engine_uniffi_registration_frost_native_uniffi_test.go`.
- Added temporary fork-pinned module replacement for internal integration
  validation:
  `replace github.com/zecdev/frost-uniffi-sdk => github.com/tlabs-xyz/frost-uniffi-sdk v0.0.0-20260221162625-51e08b3fb886`.
- Removed active UniFFI SDK dependency/runtime path from the scaffold branch in
  keep-core commit `d4e95c5f3` (2026-02-26):
  - dropped `github.com/zecdev/frost-uniffi-sdk` dependency and replace pin,
  - removed `frost_uniffi_sdk` import-time wiring as an active execution path,
  - switched default `frost_native` non-`frost_tbtc_signer` signer-material
    resolver output to `frost-tbtc-signer-v1`,
  - retained best-effort read compatibility for previously persisted
    `frost-uniffi-v1` material.
- Added canonical wallet ID compatibility threading across keep-core chain
  models and Ethereum adapter mappings:
  `pkg/tbtc/chain.go`,
  `pkg/tbtc/wallet_id.go`,
  `pkg/chain/ethereum/tbtc.go`,
  `pkg/tbtc/chain_test.go`,
  `pkg/tbtc/wallet_id_test.go`.

### Validation Notes (2026-02-20)

- `tlabs-xyz/frost-uniffi-sdk`: `cargo test -p frost-uniffi-sdk`
  passed on `feat/frost-secp256k1-tr-go-bindings` at commit `51e08b3fb886`.
- `tlabs-xyz/frost-uniffi-sdk`: `cargo test -p frost-uniffi-sdk --no-default-features --features redpallas`
  passed on `feat/frost-secp256k1-tr-go-bindings` at commit `51e08b3fb886`.
- `tlabs-xyz/frost-uniffi-sdk`: `sh Scripts/build_go.sh`,
  `PATH="$HOME/.cargo/bin:$PATH" uniffi-bindgen-go --library ./target/debug/libfrost_uniffi_sdk.dylib --out-dir .`,
  and `sh Scripts/test_bindings.sh` passed on
  `feat/frost-secp256k1-tr-go-bindings` at commit `51e08b3fb886`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f765eece5`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial"`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f765eece5`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache CGO_ENABLED=1 CGO_LDFLAGS='-lfrost_uniffi_sdk -L/Users/maclane/Projects/claude-test/frost-uniffi-sdk/target/debug -lm -ldl' LD_LIBRARY_PATH='/Users/maclane/Projects/claude-test/frost-uniffi-sdk/target/debug' go test -tags 'frost_native frost_uniffi_sdk' ./pkg/frost/signing -run TestBuildTaggedUniFFINativeFROSTBridge_EndToEndSigning`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f765eece5`.
- `threshold-network/keep-core`: draft PR `https://github.com/threshold-network/keep-core/pull/3866`
  remains open and now includes commit `f765eece5`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestDeriveLegacyWalletID`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `90caa23f1`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/chain/ethereum -run TestCalculateWalletID`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `90caa23f1`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial"`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `90caa23f1`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `90caa23f1`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache CGO_ENABLED=1 CGO_LDFLAGS='-lfrost_uniffi_sdk -L/Users/maclane/Projects/claude-test/frost-uniffi-sdk/target/debug -lm -ldl' LD_LIBRARY_PATH='/Users/maclane/Projects/claude-test/frost-uniffi-sdk/target/debug' go test -tags 'frost_native frost_uniffi_sdk' ./pkg/frost/signing -run TestBuildTaggedUniFFINativeFROSTBridge_EndToEndSigning`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `90caa23f1`.
- `threshold-network/keep-core`: draft PR `https://github.com/threshold-network/keep-core/pull/3866`
  remains open and now includes commit `90caa23f1`.
- `tlabs-xyz/frost-uniffi-sdk`: draft PR `https://github.com/tlabs-xyz/frost-uniffi-sdk/pull/1`
  opened for internal review; upstream PR intentionally deferred per current process.
- Phase 0 validation evidence was captured during review; raw per-run
  evidence logs are intentionally not committed in this branch.
- `contracts/tbtc-v2`: `npm run test -- test/bridge/CheckBitcoinSchnorrSigs.test.ts`
  passed (4 passing).
- `contracts/tbtc-v2`: `USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true npm run test -- test/bridge/Bridge.Wallets.test.ts`
  passed (91 passing).
- `contracts/tbtc-v2`: `USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true npm run test -- test/bridge/CheckBitcoinSchnorrSigs.test.ts test/bridge/Bridge.Wallets.test.ts`
  passed (95 passing).
- `sdk/tbtc-v2-ts` status is unchanged from 2026-02-19 in this tracker
  (no additional SDK run executed in this update).
- Phase 1 follow-up validation evidence was captured during review; raw
  per-run evidence logs are intentionally not committed in this branch.
- `contracts/tbtc-v2`: `npm run test -- test/bridge/CheckBitcoinSchnorrSigs.test.ts`
  passed (6 passing), `phase1_bip340_tagged_challenge_gas=25000`.
- `contracts/tbtc-v2`: `npm run test -- test/bridge/Bridge.FraudGas.test.ts`
  passed (3 passing), with:
  `phase1_submitFraudChallenge_gas=119793`,
  `phase1_defeatFraudChallenge_gas=68323`,
  `phase1_notifyFraudChallengeDefeatTimeout_gas=82033`.
- `data/v3-indexer`: `npm run test -- src/indexer/event-handlers/new-wallet-registered.test.ts`
  passed (2 tests).
- `data/v3-indexer`: `npm run typecheck` passed.
- `data/tbtc-subgraph`: `npm run build` passed (`Build completed: build/subgraph.yaml`).
- `contracts/tbtc-v2`: `npm run test -- test/bridge/Bridge.Wallets.test.ts --grep activeWalletID`
  passed (2 passing), covering stored canonical ID and legacy fallback behavior.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `fc58fed96`
  (`pkg/frost` and `pkg/tbtc` green; `pkg/tbtc` completed in 146.187s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `2702c7a4b`
  (`pkg/frost` and `pkg/tbtc` green; `pkg/tbtc` completed in 149.788s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/retry ./pkg/tecdsa/retry`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `3fc7c9faa`
  (bug-fix regression tests green).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `3fc7c9faa`
  (`pkg/frost` and `pkg/tbtc` green; `pkg/tbtc` completed in 146.070s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `b57775afb`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `b57775afb`
  (`pkg/frost` and `pkg/tbtc` green; `pkg/tbtc` completed in 146.426s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing ./pkg/tbtc -run TestConfigureFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `952946fed`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `952946fed`
  (`pkg/frost` and `pkg/tbtc` green; `pkg/tbtc` completed in 146.089s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `0df807c68`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestConfigureFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `0df807c68`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `0df807c68`
  (`pkg/frost` and `pkg/tbtc` green; `pkg/tbtc` completed in 145.473s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./cmd -run TestFlags_`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `7817a136c`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `fc4c7502e`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `fc4c7502e`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestConfigureFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `fc4c7502e`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `fc4c7502e`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `fc4c7502e`
  (`pkg/frost` and `pkg/tbtc` green; `pkg/tbtc` completed in 146.015s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestNewNode_ConfiguresFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f85b3d5be`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestNewNode_ConfiguresFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f85b3d5be`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestConfigureFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f85b3d5be`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing ./pkg/tbtc -run TestNativeExecutionBackend_FrostNativeBuildSelectable|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f85b3d5be`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f85b3d5be`
  (`pkg/frost` and `pkg/tbtc` green; `pkg/tbtc` completed in 149.916s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `01ea9f44a`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `01ea9f44a`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `01ea9f44a`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `01ea9f44a`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `01ea9f44a`
  (`pkg/frost` and `pkg/tbtc` green; `pkg/tbtc` completed in 146.784s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `01ea9f44a`
  (`pkg/frost` and `pkg/tbtc` green; `pkg/tbtc` completed in 154.499s).
- Independent interim review for native-execution slice completed with
  recommendation `Conditional GO` and no hard blockers.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `973465680`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `973465680`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f57aa099a`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f57aa099a`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestSigningExecutor_Sign_NativeBackend|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f57aa099a`
  (`pkg/tbtc` completed in 5.238s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -count=1 ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f57aa099a`
  (`pkg/tbtc` completed in 150.272s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `f57aa099a`
  (`pkg/tbtc` completed in 153.958s). One prior run in the same environment
  failed in unrelated long-suite tests (`TestSubmitClaim_AnotherMemberSubmitsClaim`);
  immediate rerun passed.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `7efb2f99d`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `7efb2f99d`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `7efb2f99d`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `7efb2f99d`
  (`pkg/tbtc` completed in 4.967s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./cmd -run TestFlags_`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `7efb2f99d`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -count=1 ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `7efb2f99d`
  (`pkg/tbtc` completed in 146.970s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `7efb2f99d`
  (`pkg/tbtc` completed in 152.443s). A concurrent dual-matrix run in the same
  environment failed in `TestNode_RunCoordinationLayer`; isolated and
  sequential reruns passed.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `e42bf4313`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `e42bf4313`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `e42bf4313`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictUnavailable_BuildAdapter|TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `e42bf4313`
  (`pkg/tbtc` completed in 5.052s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./cmd -run TestFlags_`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `e42bf4313`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -count=1 ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `e42bf4313`
  (`pkg/tbtc` completed in 147.204s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `e42bf4313`
  (`pkg/tbtc` completed in 153.545s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `606e73dfc`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `606e73dfc`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `606e73dfc`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictUnavailable_BuildAdapter|TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `606e73dfc`
  (`pkg/tbtc` completed in 5.183s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./cmd -run TestFlags_`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `606e73dfc`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -count=1 ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `606e73dfc`
  (`pkg/tbtc` completed in 147.031s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `606e73dfc`
  (`pkg/tbtc` completed in 152.617s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `d00763505`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `d00763505`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `d00763505`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `d00763505`
  (`pkg/tbtc` completed in 4.961s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./cmd -run TestFlags_`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `d00763505`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -count=1 ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `d00763505`
  (`pkg/tbtc` completed in 147.687s).
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `d00763505`
  (`pkg/tbtc` completed in 155.956s).
- `threshold-network/keep-core`: `go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `8e23f5ef0`.
- `threshold-network/keep-core`: `go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `8e23f5ef0`.
- `threshold-network/keep-core`: `go test ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `8e23f5ef0`.
- `threshold-network/keep-core`: `go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `8e23f5ef0`
  (`pkg/tbtc` completed in 5.064s).
- `threshold-network/keep-core`: `go test -count=1 ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `8e23f5ef0`
  (`pkg/tbtc` completed in 151.892s).
- `threshold-network/keep-core`: `go test -count=1 -tags frost_native ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `8e23f5ef0`
  (`pkg/tbtc` completed in 158.197s).
- Independent interim review for strict-ffi executor slice completed with
  recommendation `Conditional GO`; blocker `F-1` required restoring mode on
  failed backend selection.
- `threshold-network/keep-core`: `go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `ed642b294`.
- `threshold-network/keep-core`: `go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `ed642b294`.
- `threshold-network/keep-core`: `go test ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `ed642b294`.
- `threshold-network/keep-core`: `go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `ed642b294`
  (`pkg/tbtc` completed in 5.092s).
- `threshold-network/keep-core`: `go test -count=1 ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `ed642b294`
  (`pkg/tbtc` completed in 148.631s).
- `threshold-network/keep-core`: `go test -count=1 -tags frost_native ./pkg/frost/... ./pkg/tbtc/...`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `ed642b294`
  (`pkg/tbtc` completed in 154.666s).
- `threshold-network/keep-core`: `go test -race ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `ed642b294`
  (`pkg/frost/signing` completed in 1.560s).
- `threshold-network/keep-core`: `go test -race ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `ed642b294`
  (`pkg/tbtc` completed in 1.480s).
- `threshold-network/keep-core`: `go test -race -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend`
  failed on `feat/frost-schnorr-migration-scaffold` at commit `ed642b294`
  due to pre-existing data races in runtime paths outside this slice, including
  `pkg/net/retransmission/strategy.go` and `pkg/tbtc/signing_done.go`.
- `threshold-network/keep-core`: `go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `74e894ccc`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign$`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `656f62ff2`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `656f62ff2`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `656f62ff2`.
- `threshold-network/keep-core`: `go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `83bf3af85`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `83bf3af85`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestSignerMarshalling|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign$`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `83bf3af85`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `83bf3af85`.
- `threshold-network/keep-core`: `go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `3083e15ab`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `3083e15ab`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSignerMarshalling|TestSigningExecutor_Sign$`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `3083e15ab`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `3083e15ab`.
- `threshold-network/keep-core`: `go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `31026eb3f`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `31026eb3f`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestSignerMarshalling|TestSignerMarshalling_NativeSignerMaterialRoundtrip|TestMarshalSignerMaterialForPersistence|TestUnmarshalSignerMaterialFromPersistence|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign$`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `31026eb3f`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `31026eb3f`.
- `threshold-network/keep-core`: `go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `a1525a023`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `a1525a023`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestSignerMarshalling|TestSignerMarshalling_NativeSignerMaterialRoundtrip|TestMarshalSignerMaterialForPersistence|TestUnmarshalSignerMaterialFromPersistence|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign$`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `a1525a023`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `a1525a023`.
- `threshold-network/keep-core`: `go test ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `eeaad8fea`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `eeaad8fea`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run TestRegisterSignerMaterialResolver|TestResolveSignerMaterial|TestSignerMarshalling|TestSignerMarshalling_NativeSignerMaterialRoundtrip|TestMarshalSignerMaterialForPersistence|TestUnmarshalSignerMaterialFromPersistence|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign$`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `eeaad8fea`.
- `threshold-network/keep-core`: `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial`
  passed on `feat/frost-schnorr-migration-scaffold` at commit `eeaad8fea`.

### `threshold-network/keep-core`

- Added scaffold `pkg/frost` package with Taproot output key and Schnorr
  signature types.
- Added compatibility alias helper `HASH160(0x02 || xOnlyOutputKey)`.
- Added tests for scaffold type serialization and alias derivation.
- Added draft RFC for scaffold scope in keep-core path
  `docs/rfc/rfc-20-schnorr-frost-migration-scaffold.adoc`.
- Added runtime adapter package `pkg/frost/signing` with
  `Execute(...)(*signing.Result, error)` and transport unmarshaller wiring.
- Added transitional conversion helper `FromTECDSASignature` to map legacy
  `(R,S)` into fixed-width `frost.Signature` with validation.
- Extended `pkg/frost.Signature` with canonical `Marshal`/`Unmarshal`,
  `Equals`, and `SignatureSize` support for runtime/message handling.
- Migrated tBTC runtime signing path to FROST-facing interfaces and result
  types in `pkg/tbtc` (`signing`, `signing_loop`, `signing_done`, `heartbeat`,
  `wallet`, `node`, `marshaling`).
- Preserved current Bitcoin transaction builder compatibility by converting
  runtime `frost.Signature` byte fields to `big.Int` signature containers at
  the wallet transaction boundary.
- Updated `pkg/tbtc` tests/mocks to use `frost.Signature` and conversion
  helpers.
- Ported retry participant-selection logic to `pkg/frost/retry` and switched
  tBTC signing-loop wiring from `pkg/tecdsa/retry` to FROST-owned retry code.
- Added deterministic ROAST-style coordinator selection package
  `pkg/frost/roast` (`SelectCoordinator`) with input-order-independent tests.
- Added attempt metadata model (`pkg/frost/signing.Attempt`) and propagated
  coordinator/included/excluded members context through
  `pkg/frost/signing.Execute` and `pkg/frost/signing.Result`.
- Updated tBTC signing execution path to compute included members, select
  coordinator deterministically per attempt, and pass attempt metadata to the
  FROST signing package.
- Fixed pre-existing triplet retry eligibility bug in both retry packages by
  using the third operator seat count (`operators[k]`) in
  `excludeOperatorTriplets`, and added regression tests in:
  `pkg/frost/retry/retry_test.go`,
  `pkg/tecdsa/retry/retry_test.go`.
- Added pluggable FROST signing execution backend seam in `pkg/frost/signing`:
  `ExecutionBackend`, `Request`, backend registry (`SetExecutionBackend`,
  `ResetExecutionBackend`, `CurrentExecutionBackendName`), and default
  transitional legacy bridge backend.
- Removed redundant excluded-members input channel from
  `pkg/frost/signing.Execute`; excluded members are now sourced solely from
  attempt metadata.
- Added backend delegation tests in
  `pkg/frost/signing/backend_test.go` covering backend switching, request
  cloning isolation, and unmarshaler delegation.
- Added backend-name selector API in `pkg/frost/signing`
  (`SetExecutionBackendByName`) with explicit `native/ffi` unavailable error
  signaling (`ErrNativeExecutionBackendUnavailable`) and stable
  `LegacyExecutionBackendName`.
- Added tBTC runtime config hook to select backend on node startup via
  `Config.FrostSigningBackend` and `configureFrostSigningBackend`, with tests:
  `pkg/tbtc/node_signing_backend_test.go`.
- Added native backend scaffold in `pkg/frost/signing`:
  `NativeExecutionAdapter`, `nativeExecutionBackend`, exported
  `NativeExecutionBackendName`, adapter registration APIs
  (`RegisterNativeExecutionAdapter`, `UnregisterNativeExecutionAdapter`), and
  backend-selection wiring so `native`/`ffi` activates only when an adapter is
  registered.
- Added native-backend selection tests in `pkg/frost/signing/backend_test.go`
  and `pkg/tbtc/node_signing_backend_test.go`.
- Added CLI/config exposure for backend selection via
  `--tbtc.frostSigningBackend` in `cmd/flags.go` with coverage in
  `cmd/flags_test.go`, enabling operators to select `legacy`/`native`/`ffi`
  without code changes.
- Added build-tagged native adapter bootstrap in `pkg/frost/signing`:
  package init wiring (`native_adapter_registration.go`) with
  `!frost_native` no-op registration and `frost_native` transitional adapter
  registration, enabling runtime selection of `native` on tagged builds.
- Replaced the `frost_native` placeholder native adapter with a transitional
  executable adapter that delegates to the legacy tECDSA signing bridge while
  preserving native backend selection semantics.
- Added exported build-flavor registration helper
  `RegisterNativeExecutionAdapterForBuild` and updated build-tag tests in
  `native_adapter_build_frost_native_test.go`.
- Added tagged execution-path signing test
  `pkg/tbtc/signing_native_backend_frost_native_test.go` that validates
  successful signature production under `FrostSigningBackend=native`.
- Added node startup-path backend coverage in
  `pkg/tbtc/node_startup_signing_backend_test.go` to verify `newNode`
  behavior for native backend unavailable vs registered cases.
- Updated `newNode` backend configuration error wrapping to preserve cause
  chains for `errors.Is` checks.
- Added explicit guidance comment in `pkg/frost/signing/backend.go` that
  backend-state-mutating tests must not use `t.Parallel`.
- Added transitional-path comment in
  `pkg/tbtc/signing_native_backend_frost_native_test.go` documenting planned
  switch from ECDSA validation to Schnorr/BIP-340 validation once native
  cryptographic execution is linked.
- Added native cryptography bridge scaffold in `pkg/frost/signing`
  (`nativeExecutionBridge`, `ErrNativeCryptographyUnavailable`,
  `newNativeExecutionBridge`) and wired the `frost_native` build-tag adapter
  to prefer native bridge execution with fallback routing to legacy backend.
- Expanded `frost_native` adapter tests in
  `pkg/frost/signing/native_adapter_build_frost_native_test.go` to cover
  native path selection, unavailable-bridge fallback, unavailable-error
  fallback, non-fallback bridge errors, and unmarshaller routing.
- Split backend semantics between `native` and `ffi` in
  `pkg/frost/signing/backend.go`:
  `native` keeps transitional legacy fallback and `ffi` requires native
  execution (strict no-fallback mode).
- Updated `frost_native` adapter routing in
  `pkg/frost/signing/native_adapter_registration_frost_native.go` so strict
  `ffi` mode returns `ErrNativeCryptographyUnavailable` instead of falling back.
- Added strict-mode unit coverage in
  `pkg/frost/signing/backend_test.go` and
  `pkg/frost/signing/native_adapter_build_frost_native_test.go`.
- Added runtime config/startup coverage for `FrostSigningBackend=\"ffi\"` in
  `pkg/tbtc/node_signing_backend_test.go` and
  `pkg/tbtc/node_startup_signing_backend_test.go`.
- Clarified operator-facing backend semantics in
  `cmd/flags.go` and `pkg/tbtc/tbtc.go`.
- Added strict-mode availability reporter support in
  `pkg/frost/signing/backend.go` so `ffi` can fail fast at backend selection
  when an adapter reports native cryptography unavailable.
- Added `NativeExecutionAvailable()` reporter implementation for the
  build-tagged adapter in
  `pkg/frost/signing/native_adapter_registration_frost_native.go`.
- Added fail-fast strict-mode tests in
  `pkg/frost/signing/backend_test.go`,
  `pkg/frost/signing/native_adapter_build_frost_native_test.go`, and
  `pkg/tbtc/signing_native_backend_frost_native_test.go`.
- Added exported native bridge registration APIs in
  `pkg/frost/signing/native_bridge.go`
  (`RegisterNativeExecutionBridge`, `UnregisterNativeExecutionBridge`) and
  dynamic bridge lookup so runtime registration can occur after adapter
  initialization.
- Updated the build-tagged adapter in
  `pkg/frost/signing/native_adapter_registration_frost_native.go` to resolve
  native bridge availability/execution via provider callback on each use
  (instead of one-time bridge capture).
- Extended `frost_native` adapter tests in
  `pkg/frost/signing/native_adapter_build_frost_native_test.go` to validate
  strict `ffi` selection success after registering an available native bridge.
- Added build-tagged transitional native bridge implementation in
  `pkg/frost/signing/native_bridge_frost_native.go` and registered it from
  `registerNativeExecutionAdapterForBuild` so strict `ffi` mode is available
  by default on `frost_native` builds.
- Updated `frost_native` tBTC backend tests in
  `pkg/tbtc/signing_native_backend_frost_native_test.go` to cover both strict
  `ffi` configured behavior (with build-registered bridge) and explicit
  unavailable behavior when the bridge is intentionally unregistered.
- Added native FFI executor registration APIs in
  `pkg/frost/signing/native_ffi_executor.go`
  (`NativeExecutionFFIExecutor`, `RegisterNativeExecutionFFIExecutor`,
  `UnregisterNativeExecutionFFIExecutor`) and wired executor state into the
  shared backend runtime globals.
- Updated the build-tagged transitional bridge in
  `pkg/frost/signing/native_bridge_frost_native.go` to prioritize registered
  FFI execution, treat non-availability FFI errors as hard failures, and allow
  legacy fallback only when fallback mode is enabled.
- Added dedicated bridge behavior tests in
  `pkg/frost/signing/native_bridge_frost_native_test.go` for FFI execution
  routing, strict no-fallback behavior, fallback routing, and unmarshaler
  delegation.
- Updated strict `ffi` selection tests in
  `pkg/frost/signing/backend_test.go`,
  `pkg/frost/signing/native_adapter_build_frost_native_test.go`, and
  `pkg/tbtc/signing_native_backend_frost_native_test.go` to require explicit
  FFI executor registration where strict availability is expected, with
  additional nil-registration guard coverage.
- Restored previous native execution mode when backend selection fails in
  `pkg/frost/signing/backend.go` so unsuccessful `native`/`ffi` configuration
  attempts do not mutate active-mode behavior.
- Added mode-restoration regression coverage in
  `pkg/frost/signing/backend_test.go`.
- Added direct bridge-level FFI error-path coverage in
  `pkg/frost/signing/native_bridge_frost_native_test.go` for strict/fallback
  unavailable-error handling and non-availability error hard-fail behavior.
- Clarified strict unavailable test setup intent in
  `pkg/tbtc/signing_native_backend_frost_native_test.go` by documenting why
  build-registered bridge/executor are intentionally unregistered.
- Added backend-agnostic signer material support in
  `pkg/frost/signing/request.go` via `SignerMaterial` and legacy key-share
  resolution helper `LegacyPrivateKeyShare()`, while keeping
  `PrivateKeyShare` as a transitional compatibility alias.
- Added `pkg/frost/signing.ExecuteRequest(...)` so callers can pass a complete
  signing request object directly while preserving request-attempt cloning
  safety.
- Updated tBTC signing flow to call `ExecuteRequest` with explicit request
  construction in `pkg/tbtc/signing.go`, threading signer-specific material
  from wallet signer state.
- Extended `pkg/tbtc/signer` state with `signerMaterial` and fallback resolver
  in `pkg/tbtc/wallet.go`, and ensured persisted signer unmarshaling restores
  transitional signer material compatibility in `pkg/tbtc/marshaling.go`.
- Added execution-request coverage in `pkg/frost/signing/signing_test.go` and
  updated shared signer test helper initialization in `pkg/tbtc/node_test.go`
  for new signer material state.
- Added typed native signer material model in
  `pkg/frost/signing/native_signer_material.go` with strict validation and
  request extraction helper (`Request.NativeSignerMaterial`) supporting
  pointer/value forms and raw-byte default mapping to
  `NativeSignerMaterialFormatFrostUniFFIV1`.
- Added reusable native FFI executor adapter in
  `pkg/frost/signing/native_ffi_executor_adapter.go` introducing:
  - `NativeExecutionFFISigningRequest`
  - `NativeExecutionFFISigningPrimitive`
  - `NewNativeExecutionFFIExecutorAdapter`
  - `RegisterNativeExecutionFFISigningPrimitive`
    enabling concrete cryptographic primitive wiring without coupling runtime
    routing to a specific FFI package import.
- Added comprehensive contract tests for native signer material extraction and
  FFI adapter behavior in:
  `pkg/frost/signing/native_signer_material_test.go`,
  `pkg/frost/signing/native_ffi_executor_adapter_test.go`.
- Extended `NativeExecutionFFISigningRequest` with transport/runtime context
  (`Channel`, `MembershipValidator`) so native primitives can execute with full
  parity to `signing.Request`.
- Updated `pkg/tbtc/signing_native_backend_frost_native_test.go` strict-ffi
  setup to register native execution through
  `RegisterNativeExecutionFFISigningPrimitive`, exercising the new adapter
  registration helper at the runtime integration boundary.
- Added backward-compatible signer material persistence in `pkg/tbtc` by
  introducing a versioned native-material envelope over existing
  `Signer.privateKeyShare` bytes, while preserving legacy raw tECDSA encoding:
  - `pkg/tbtc/signer_material_encoding.go`
  - `pkg/tbtc/marshaling.go`
- Added signer-material persistence coverage in
  `pkg/tbtc/signer_material_encoding_test.go` for:
  - legacy raw-share compatibility (no envelope),
  - native envelope encode/decode and roundtrip,
  - corrupted envelope rejection, and
  - unsupported signer material type handling.
- Classified missing/invalid native signer material in
  `pkg/frost/signing/native_ffi_executor_adapter.go` as
  `ErrNativeCryptographyUnavailable` so `native` mode can fall back cleanly to
  legacy execution, while strict `ffi` mode still fails as expected.
- Added regression coverage in:
  - `pkg/frost/signing/native_ffi_executor_adapter_test.go` (error
    classification),
  - `pkg/tbtc/signing_native_backend_frost_native_test.go`
    (`TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial`).
- Added DKG-time signer-material resolver registration in `pkg/tbtc`:
  - `SignerMaterialResolver` interface and runtime register/unregister APIs in
    `pkg/tbtc/signer_material_resolver.go`,
  - default legacy resolver behavior (returns `*tecdsa.PrivateKeyShare`),
  - DKG signer construction wiring in `pkg/tbtc/dkg.go` so signer material is
    resolved at creation and passed into `newSigner(...)`,
  - `newSigner(...)` extension in `pkg/tbtc/wallet.go` to accept explicit
    signer material with nil fallback to legacy share.
- Added build-flavor native FFI primitive registration hook in
  `pkg/frost/signing`:
  - `RegisterNativeExecutionFFISigningPrimitiveForBuild()`,
  - default/tagged build registration stubs in
    `native_ffi_primitive_registration_default.go` and
    `native_ffi_primitive_registration_frost_native.go`,
  - startup wiring from `RegisterNativeExecutionAdapterForBuild()` in
    `pkg/frost/signing/backend.go`.
- Added resolver coverage in `pkg/tbtc/signer_material_resolver_test.go`
  (default behavior, custom resolver registration, and error propagation).
- Upgraded build-scoped registration hooks to provider-based wiring in
  `pkg/frost/signing`:
  - added `NativeExecutionFFISigningPrimitiveProviderForBuild`,
    `RegisterNativeExecutionFFISigningPrimitiveProviderForBuild(...)`, and
    `UnregisterNativeExecutionFFISigningPrimitiveProviderForBuild(...)`,
  - updated `frost_native` build registration to resolve primitive from
    provider and fail on nil provider output,
  - added default and `frost_native` coverage in
    `native_ffi_primitive_registration_test.go` and
    `native_ffi_primitive_registration_frost_native_test.go`.
- Added build-scoped signer-material resolver provider wiring in `pkg/tbtc`:
  - added `SignerMaterialResolverProviderForBuild`,
    `RegisterSignerMaterialResolverProviderForBuild(...)`, and
    `UnregisterSignerMaterialResolverProviderForBuild(...)`,
  - added build-tagged resolver registration paths in
    `signer_material_resolver_build*.go`,
  - invoked `RegisterSignerMaterialResolverForBuild()` at node startup in
    `pkg/tbtc/node.go`,
  - added default and `frost_native` coverage in
    `pkg/tbtc/signer_material_resolver_test.go` and
    `pkg/tbtc/signer_material_resolver_build_frost_native_test.go`.
- Validation (commit `4069ffe16`):
  - `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run "TestRegisterSignerMaterialResolver|TestResolveSignerMaterial|TestSignerMarshalling|TestSignerMarshalling_NativeSignerMaterialRoundtrip|TestMarshalSignerMaterialForPersistence|TestUnmarshalSignerMaterialFromPersistence|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign$"`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial|TestRegisterSignerMaterialResolverForBuild"`
- Wired default transitional build-provider behavior for `frost_native` in
  `pkg/frost/signing`:
  - `registerNativeExecutionFFISigningPrimitiveForBuild()` now uses
    a default provider when no custom provider is registered.
  - Added transitional primitive
    `buildTaggedLegacyCompatibleNativeExecutionFFISigningPrimitive` in
    `native_ffi_primitive_transitional_frost_native.go` that:
    - consumes `NativeSignerMaterial` payload,
    - decodes legacy `tecdsa.PrivateKeyShare`,
    - executes legacy signing engine via FFI path, and
    - preserves strict/fallback semantics via
      `ErrNativeCryptographyUnavailable` classification.
  - Added build-tag-scoped tests for default-build vs `frost_native` provider
    expectations and primitive payload validation:
    `native_ffi_primitive_registration_default_build_test.go`,
    `native_ffi_primitive_registration_frost_native_test.go`,
    `native_ffi_primitive_transitional_frost_native_test.go`.
- Wired default transitional signer-material resolver behavior for
  `frost_native` in `pkg/tbtc`:
  - `registerSignerMaterialResolverForBuild()` now uses a default provider when
    no custom provider is registered.
  - Added `buildTaggedNativeSignerMaterialResolver` in
    `signer_material_resolver_build_frost_native.go` that converts legacy
    key-share state to
    `*signing.NativeSignerMaterial{Format: \"frost-uniffi-v1\", Payload: ...}`.
  - Added build-tag-scoped tests for default-build vs `frost_native` behavior:
    `signer_material_resolver_default_build_test.go`,
    `signer_material_resolver_build_frost_native_test.go`.
- Updated integration expectations for default `frost_native` strict path:
  - `pkg/frost/signing/native_adapter_build_frost_native_test.go` now expects
    strict `ffi` selection success immediately after build registration
    (and explicit unavailable behavior only after unregistering bridge/executor).
  - `pkg/tbtc/signing_native_backend_frost_native_test.go` now:
    - validates strict `ffi` startup without manual primitive registration,
    - adds `TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial`
      proving strict path execution with native signer material.
- Validation (commit `c3e8b02dc`):
  - `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run "TestRegisterSignerMaterialResolver|TestResolveSignerMaterial|TestSignerMarshalling|TestSignerMarshalling_NativeSignerMaterialRoundtrip|TestMarshalSignerMaterialForPersistence|TestUnmarshalSignerMaterialFromPersistence|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign$"`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial|TestRegisterSignerMaterialResolverForBuild"`
- Added legacy-load signer-material migration through active resolver in
  `pkg/tbtc/signer_material_encoding.go`:
  - legacy private-key-share payloads now resolve via `resolveSignerMaterial`
    during unmarshal,
  - `privateKeyShare` is preserved for compatibility while `signerMaterial`
    is resolver-derived (native on `frost_native` after build registration).
- Updated/added `frost_native` tests to reflect automatic migration behavior:
  - `pkg/tbtc/signer_material_encoding_frost_native_test.go` verifies legacy
    payload unmarshal resolves to `NativeSignerMaterial` with decodable payload.
  - `pkg/tbtc/signing_native_backend_frost_native_test.go`:
    - strict `ffi` signing no longer requires manual signer-material mutation,
    - fallback regression test now explicitly forces legacy-only signer material
      to preserve coverage of unavailable-classification fallback path.
- Validation (commit `9aa474c83`):
  - `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run "TestRegisterSignerMaterialResolver|TestResolveSignerMaterial|TestSignerMarshalling|TestSignerMarshalling_NativeSignerMaterialRoundtrip|TestMarshalSignerMaterialForPersistence|TestUnmarshalSignerMaterialFromPersistence|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign$"`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial|TestRegisterSignerMaterialResolverForBuild|TestUnmarshalSignerMaterialFromPersistence_LegacyEncodingResolvesNativeMaterialOnFrostNativeBuild"`
- Added migration persistence regression coverage in
  `pkg/tbtc/signer_material_encoding_frost_native_test.go`:
  - `TestSignerMarshalling_LegacyRoundtripMigratesToNativeEnvelopeOnFrostNativeBuild`
    verifies that legacy signer encoding, once unmarshaled under
    `frost_native` with build resolver registration, is re-marshaled using the
    native signer-material envelope prefix.
- Validation (commit `245c64cf3`):
  - `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run "TestRegisterSignerMaterialResolver|TestResolveSignerMaterial|TestSignerMarshalling|TestSignerMarshalling_NativeSignerMaterialRoundtrip|TestMarshalSignerMaterialForPersistence|TestUnmarshalSignerMaterialFromPersistence|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign$"`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial|TestRegisterSignerMaterialResolverForBuild|TestUnmarshalSignerMaterialFromPersistence_LegacyEncodingResolvesNativeMaterialOnFrostNativeBuild|TestSignerMarshalling_LegacyRoundtripMigratesToNativeEnvelopeOnFrostNativeBuild"`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
- Independent interim review completed for provider-default slice:
  - recommendation: `Conditional GO`
  - must-address items:
    - evidence reproducibility (`-count=1` logs),
    - continuity-gap documentation for `8e23f5ef0..4069ffe16`,
    - downgrade safety for native-envelope signer persistence.
- Implemented downgrade-safety remediation in keep-core commit `80503964e`:
  - `pkg/tbtc/signer_material_encoding.go` now recovers legacy
    `*tecdsa.PrivateKeyShare` from native envelope payload when format is
    `frost-uniffi-v1`, preserving default-build compatibility on reload.
  - Added explicit default-build regression in
    `pkg/tbtc/signer_material_encoding_default_build_test.go` for
    resolver-on-load legacy behavior.
  - Updated shared envelope test in
    `pkg/tbtc/signer_material_encoding_test.go` to assert native-envelope
    private-key-share recovery.
  - Added assumption comment for raw `[]byte` signer material mapping in
    `marshalSignerMaterialForPersistence`.
- Validation (commit `80503964e`):
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 ./pkg/tbtc -run "TestUnmarshalSignerMaterialFromPersistence_NativeEnvelope|TestRegisterSignerMaterialResolver|TestResolveSignerMaterial|TestSignerMarshalling|TestSignerMarshalling_NativeSignerMaterialRoundtrip|TestMarshalSignerMaterialForPersistence|TestUnmarshalSignerMaterialFromPersistence|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign$|TestUnmarshalSignerMaterialFromPersistence_LegacyEncoding_DefaultBuildReturnsLegacySignerMaterial"`
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/tbtc -run "TestUnmarshalSignerMaterialFromPersistence_NativeEnvelope|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial|TestRegisterSignerMaterialResolverForBuild|TestUnmarshalSignerMaterialFromPersistence_LegacyEncodingResolvesNativeMaterialOnFrostNativeBuild|TestSignerMarshalling_LegacyRoundtripMigratesToNativeEnvelopeOnFrostNativeBuild"`
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/frost/signing`
- Implemented runtime race-hardening in keep-core commit `6532456d5`:
  - added mutex protection for `BackoffStrategy.Tick(...)` state in
    `pkg/net/retransmission/strategy.go`,
  - refactored signing-done state access in `pkg/tbtc/signing_done.go` using
    `RWMutex`, lock-protected insertions, snapshot-based reads, and
    clone-based message isolation for aggregation checks.
- Validation (commit `6532456d5`):
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 ./pkg/net/retransmission`
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 ./pkg/tbtc -run "TestSigningDoneCheck|TestSigningExecutor_Sign_NativeBackend"`
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -race ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -race -tags frost_native ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -race ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign_NativeBackend"`
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -race -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial|TestUnmarshalSignerMaterialFromPersistence_NativeEnvelope|TestUnmarshalSignerMaterialFromPersistence_LegacyEncodingResolvesNativeMaterialOnFrostNativeBuild|TestSignerMarshalling_LegacyRoundtripMigratesToNativeEnvelopeOnFrostNativeBuild"`
- Race-hardening review evidence was captured during review; raw per-run
  packets and logs are intentionally not committed in this branch.
- Independent review outcomes:
  - provider-defaults remediation review recommendation: `GO`.
  - runtime race-hardening review recommendation: `GO`.
  - required race-hardening review wording update applied.
- Implemented native FROST round-signing protocol path in keep-core commit
  `8ef50715d`:
  - Added new native signer-material format
    `NativeSignerMaterialFormatFrostUniFFIV2` (`frost-uniffi-v2`) and
    native engine registration APIs in
    `pkg/frost/signing/native_frost_engine_frost_native.go`:
    - `RegisterNativeFROSTSigningEngine(...)`
    - `UnregisterNativeFROSTSigningEngine()`
  - Added native two-round protocol transport + execution in
    `pkg/frost/signing/native_frost_protocol_frost_native.go`:
    - signer-material payload decoding for `frost-uniffi-v2`,
    - round-one commitment and round-two signature-share message types,
    - unmarshaler registration,
    - included-member set derivation from attempt metadata,
    - native message collection/validation with membership checks and
      retransmission-safe dedup by sender,
    - signature aggregation into canonical `frost.Signature`.
  - Updated transitional primitive routing in
    `pkg/frost/signing/native_ffi_primitive_transitional_frost_native.go`:
    - `frost-uniffi-v2` material now routes to native two-round execution,
    - `frost-uniffi-v1` preserves legacy tECDSA bridge execution path,
    - unmarshaler registration now includes both native FROST and legacy
      bridge message types.
  - Added concurrent multi-member native-path protocol coverage in
    `pkg/frost/signing/native_frost_protocol_frost_native_test.go`:
    - native round execution succeeds across 3 members and converges on a
      single signature,
    - missing native engine returns `ErrNativeCryptographyUnavailable`.
- Validation (commit `8ef50715d`):
  - `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/...`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/...`
  - `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign$"`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial"`
  - `GOCACHE=/tmp/keep-core-gocache go test -race ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test -race -tags frost_native ./pkg/frost/signing`
- Added strict-ffi v2 signer-material runtime integration coverage in
  keep-core commit `753bf311a`:
  - updated `pkg/tbtc/signing_native_backend_frost_native_test.go` to assert
    strict `ffi` execution succeeds with explicit
    `frost-uniffi-v2` signer material payloads.
  - added deterministic native FFI primitive test double for the strict path
    and deterministic signature assertions (`frost.Signature` bytes).
  - added helper fixture to rewrite wallet signers in tests with canonical v2
    native signer-material envelopes (`keyPackage` + `publicKeyPackage`).
  - made primitive call counters race-safe with atomic increments for
    concurrent signer goroutines.
- Validation (commit `753bf311a`):
  - `GOCACHE=/tmp/keep-core-gocache go test ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign$"`
  - `GOCACHE=/tmp/keep-core-gocache go test -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial"`
  - `GOCACHE=/tmp/keep-core-gocache go test -race -tags frost_native ./pkg/tbtc -run "TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial"`
- Implemented canonical wallet-ID chain wiring + regenerated Bridge bindings in
  keep-core commit `a49e35d26`:
  - regenerated `pkg/chain/ethereum/tbtc/gen/{abi,cmd,contract}/Bridge.go`
    from updated tBTC Bridge ABI adding:
    `NewWalletRegisteredV2`, `activeWalletID`, `walletID`,
    `walletPubKeyHashForWalletID`, and `walletsByWalletID`,
  - propagated canonical wallet-ID filter support through
    `pkg/tbtc/chain.go` (`NewWalletRegisteredEventFilter.WalletID`) and
    Ethereum adapter event decoding in `pkg/chain/ethereum/tbtc.go`,
  - added canonical wallet-ID wallet-lookup support with compatibility fallback:
    `pkg/chain/ethereum/tbtc.go` + `pkg/tbtc/wallet_id.go`,
  - updated runtime wallet closure/archive flows in `pkg/tbtc/node.go` to
    resolve wallet identity via chain wallet-ID mapping first and retain
    legacy fallback behavior,
  - updated local chain mock + wallet ID unit coverage in
    `pkg/tbtc/chain_test.go` and `pkg/tbtc/wallet_id_test.go`.
- Validation (commit `a49e35d26`):
  - `go test ./pkg/tbtc -run "TestDeriveLegacyWalletID|TestWalletPublicKeyHashFromLegacyWalletID|TestWalletPublicKeyHashFromLegacyWalletID_NonLegacy"`
  - `go test ./pkg/chain/ethereum -run TestCalculateWalletID`
  - `go test -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial"`
  - `go test -tags frost_native ./pkg/frost/signing`
- Follow-up housekeeping in keep-core commit `bbd1b53cd`:
  - restored `pkg/chain/ethereum/tbtc/gen/_address/Bridge` to an empty
    committed placeholder, consistent with repository `_address/*` embed-file
    policy; no runtime behavior changes.
- Validation (commit `bbd1b53cd`):
  - `go test ./pkg/frost/... ./pkg/tbtc/...` passed
    (`pkg/tbtc` completed in 146.842s).
- Canonical wallet-ID review evidence was captured during review; raw per-run
  packets and logs are intentionally not committed in this branch.
- Independent interim review completed with recommendation: `Conditional GO`
  and one must-fix item (`F-1`).
- Applied F-1 remediation in keep-core commit `b4185499c`:
  - lowered expected closure-path canonical-resolution miss log from warning to
    debug and documented legacy ECDSA event-source expectation in
    `pkg/tbtc/node.go`.
- Validation (commit `b4185499c`):
  - `go test -count=1 ./pkg/tbtc -run "TestWalletPublicKeyHashFromLegacyWalletID|TestWalletPublicKeyHashFromLegacyWalletID_NonLegacy"` passed.
  - `go test -count=1 -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign_NativeBackend"` passed.
- Closed deferred F-2/F-3 findings in keep-core commit `5d0b9da9f`:
  - extracted testable helpers in `pkg/chain/ethereum/tbtc.go` without runtime
    behavior changes,
  - added event fallback policy coverage in
    `pkg/chain/ethereum/tbtc_test.go` for:
    `TestPastNewWalletRegisteredEvents_UsesV2EventsWhenAvailable`,
    `TestPastNewWalletRegisteredEvents_FallsBackToLegacyWhenV2Empty`,
    `TestPastNewWalletRegisteredEvents_DoesNotFallbackWithWalletIDFilter`,
  - added wallet-ID resolver multi-path coverage in
    `pkg/chain/ethereum/tbtc_test.go` via
    `TestResolveWalletPublicKeyHashForWalletID`.
- Validation (commit `5d0b9da9f`):
  - `go test -count=1 ./pkg/chain/ethereum -run "TestPastNewWalletRegisteredEvents_UsesV2EventsWhenAvailable|TestPastNewWalletRegisteredEvents_FallsBackToLegacyWhenV2Empty|TestPastNewWalletRegisteredEvents_DoesNotFallbackWithWalletIDFilter"` passed.
  - `go test -count=1 ./pkg/chain/ethereum -run "TestResolveWalletPublicKeyHashForWalletID"` passed.
  - `go test -count=1 ./pkg/chain/ethereum` passed.
- Closed deferred F-5 (`-race` evidence augmentation) for wallet-ID interim
  review with focused uncached race runs:
  - `go test -count=1 -race ./pkg/chain/ethereum` passed.
  - `go test -count=1 -race ./pkg/tbtc -run "TestWalletPublicKeyHashFromLegacyWalletID|TestWalletPublicKeyHashFromLegacyWalletID_NonLegacy|TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign_NativeBackend"` passed.
  - `go test -count=1 -race -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial"` passed.
- Implemented ROAST Phase 2 coordinator-policy validation in keep-core commit
  `5f2383443` (PR `#3872`):
  - centralized attempt/coordinator policy checks in
    `pkg/frost/signing/native_frost_protocol_frost_native.go` via
    `includedMembersFromRequest(...)`,
  - rejects zero attempt number, zero coordinator, included/excluded overlap,
    and coordinator-not-included cases,
  - updated transitional frost-native tests in
    `pkg/frost/signing/native_ffi_primitive_transitional_frost_native_test.go`
    to include new policy rejection coverage and explicit attempt metadata in
    attempt-variation cases.
- Validation (PR `#3872`):
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial|TestRegisterSignerMaterialResolverForBuild"`
- Independent review recommendation for this increment was `Conditional GO`
  and noted the coarse-path fallback policy gap closed below.
- Closed the coarse-path fallback gap in keep-core commit `53bae0c7c`
  (PR `#3873`):
  - added `ErrInvalidSigningAttemptPolicy` sentinel for attempt-policy
    invariant violations in
    `pkg/frost/signing/native_frost_protocol_frost_native.go`,
  - updated coarse `frost-tbtc-signer-v1` path in
    `pkg/frost/signing/native_ffi_primitive_transitional_frost_native.go` to
    return `ErrNativeBridgeOperationFailed` (no legacy fallback) when
    attempt-policy validation fails,
  - added regression test proving invalid attempt policy does not fallback even
    when legacy private key share is present:
    `TestBuildTaggedLegacyCompatibleNativeExecutionFFISigningPrimitive_Sign_TBTCSignerPath_InvalidAttemptPolicy_DoesNotFallback`.
- Validation (PR `#3873`):
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial|TestRegisterSignerMaterialResolverForBuild"`
- Follow-up review recommendation: `GO`.
- Added coarse attempt-policy error-matrix hardening in keep-core commit
  `85f843ca0` (PR `#3874`):
  - preserved `ErrInvalidSigningAttemptPolicy` identity through coarse-path
    wrapping in
    `pkg/frost/signing/native_ffi_primitive_transitional_frost_native.go`,
  - expanded invalid attempt-policy no-fallback test to matrix coverage for:
    zero attempt number, zero coordinator, coordinator-not-included,
    empty included set, and include/exclude overlap in
    `pkg/frost/signing/native_ffi_primitive_transitional_frost_native_test.go`,
  - asserted every matrix case returns both
    `ErrNativeBridgeOperationFailed` and `ErrInvalidSigningAttemptPolicy`,
    with no fallback event emission and no `RunDKG` call.
- Validation (PR `#3874`):
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/frost/signing`
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial|TestRegisterSignerMaterialResolverForBuild"`
- Follow-up review recommendation: `GO`.
- Closed ROAST Phase 3 consumed-attempt replay classification in keep-core
  commit `4d194b978` (PR `#3876`):
  - added `ErrConsumedSigningAttemptReplay` sentinel in
    `pkg/frost/signing/native_frost_protocol_frost_native.go`,
  - updated coarse `frost-tbtc-signer-v1` path in
    `pkg/frost/signing/native_ffi_primitive_transitional_frost_native.go` to
    classify signer errors containing `attempt_id ... already consumed for sign attempt` as `ErrNativeBridgeOperationFailed` + replay sentinel (no legacy
    fallback),
  - added regression test
    `TestBuildTaggedLegacyCompatibleNativeExecutionFFISigningPrimitive_Sign_TBTCSignerPath_ConsumedAttemptReplay_DoesNotFallback`.
- Validation (PR `#3876`):
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/frost/signing -run "ConsumedAttemptReplay|InvalidAttemptPolicy|BuildTaggedLegacyCompatibleNativeExecutionFFISigningPrimitive_Sign_TBTCSignerPath"`
  - `GOCACHE=/tmp/keep-core-gocache go test -count=1 -tags frost_native ./pkg/tbtc -run "TestConfigureFrostSigningBackend|TestNewNode_ConfiguresFrostSigningBackend|TestConfigureFrostSigningBackend_FFIStrictConfigured_BuildAdapter|TestConfigureFrostSigningBackend_FFIStrictUnavailable_NoBridge|TestSigningExecutor_Sign_NativeBackend|TestSigningExecutor_Sign_FFIStrictBackend_WithNativeSignerMaterial|TestSigningExecutor_Sign_NativeBackend_FallsBackWhenOnlyLegacySignerMaterial|TestRegisterSignerMaterialResolverForBuild"`
- Follow-up review recommendation: `GO`.
- Latest keep-core commit on tracked branch:
  `4d194b978` (`feat/frost-schnorr-migration-scaffold`), merged PR:
  https://github.com/threshold-network/keep-core/pull/3876
- Post-audit long-term hardening decision (2026-03-01):
  - selected path: Option 3 + Option 4A before production FROST/ROAST rollout
    (secret-aware in-process boundaries + encrypted-at-rest state envelope),
    with Option 4B (KMS/HSM provider) as follow-on.
  - implementation plan:
    `docs/frost-migration/tbtc-signer-secret-material-hardening-plan.md`
  - review outcome: no blocker recorded against the selected long-term
    hardening path.

## Remaining TODOs (as of 2026-02-27)

- Phase 4 funded nightly live run artifact:
  run `ci-nightly-e2e` with required funded secrets and attach first green run
  evidence in `docs/phase-gates/phase-4-decision.md` and
  `docs/phase-gates/phase-4-packet.md`.
- Phase 4 final approver signoff:
  update status from pending in `docs/phase-gates/phase-4-decision.md` and
  approval block in `docs/phase-gates/phase-4-packet.md`.
- Phase 4 archive/redirect execution (external org owner):
  execute original-repo archive/redirect mapping and record results/links in
  `docs/phase-gates/phase-4-decision.md` and
  `docs/phase-gates/phase-4-packet.md`.
- Upstream SDK follow-up (optional, non-blocking):
  keep-core commit `4d194b978` retains the post-`d4e95c5f3` state where the
  active UniFFI SDK dependency/runtime path remains removed, so upstreaming
  `tlabs-xyz/frost-uniffi-sdk` to `zecdev` is no longer required for migration
  completion; only pursue this if UniFFI compatibility is intentionally
  restored later.
