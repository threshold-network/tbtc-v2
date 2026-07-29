/* eslint-disable no-await-in-loop */

import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  BigNumber,
  BigNumberish,
  BytesLike,
  Signer,
  Contract,
  ContractTransaction,
  Wallet,
} from "ethers"
import type { HardhatRuntimeEnvironment } from "hardhat/types"

// B-1.5 FROST wallet registry integration helpers.
//
// Mirrors the structure of `ecdsa-wallet-registry.ts` but
// adapts the digest format to the RFC v4 FROST result digest
// (see `docs/rfc/frost-migration/wallet-registry-trust-model-rfc.md`):
//
//   keccak256(abi.encode(
//     "tbtc-frost-dkg-result-v1",
//     block.chainid,
//     address(bridge),
//     address(registry),
//     seed,
//     xOnlyOutputKey,
//     keccak256(abi.encode(members)),
//     keccak256(abi.encode(misbehavedMembersIndices))
//   ))
//
// The digest is EIP-191-prefixed before signing. The FROST
// registry's `FrostDkgValidator` computes the same digest
// in `resultDigest(...)` and verifies the signature bundle;
// it takes `address bridge` + `address registry` parameters
// so the digest binds correctly across deployments.

export const hardhatNetworkId = 31337

export type OperatorID = number
export type Operator = {
  id: OperatorID
  signer: SignerWithAddress
  stakingProvider: string
}

export class Operators extends Array<Operator> {
  getIds(): number[] {
    return this.map((o) => o.id)
  }

  getSigners(): SignerWithAddress[] {
    return this.map((o) => o.signer)
  }
}

export type FrostDkgResult = {
  submitterMemberIndex: number
  // 32-byte x-only Taproot output key. Must NOT be all-zero
  // and must NOT be a legacy-shaped alias (high 12 bytes
  // all-zero); both shapes are rejected by
  // `FrostRegistryWallets.validateXOnlyOutputKey`.
  xOnlyOutputKey: string
  misbehavedMembersIndices: number[]
  signatures: string
  signingMembersIndices: number[]
  members: number[]
  membersHash: string
}

const noMisbehaved: number[] = []

/// Computes the RFC v4 FROST result digest. Mirrors
/// `FrostDkgValidator.resultDigest(...)` (the on-chain view
/// used during signature verification).
export function computeFrostResultDigest(
  hre: HardhatRuntimeEnvironment,
  params: {
    chainId: BigNumberish
    bridge: string
    registry: string
    seed: BigNumberish
    xOnlyOutputKey: BytesLike
    members: number[]
    misbehavedMembersIndices: number[]
  }
): string {
  const { ethers } = hre
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "string",
        "uint256",
        "address",
        "address",
        "uint256",
        "bytes32",
        "bytes32",
        "bytes32",
      ],
      [
        "tbtc-frost-dkg-result-v1",
        params.chainId,
        params.bridge,
        params.registry,
        params.seed,
        params.xOnlyOutputKey,
        ethers.utils.keccak256(
          ethers.utils.defaultAbiCoder.encode(["uint32[]"], [params.members])
        ),
        ethers.utils.keccak256(
          ethers.utils.defaultAbiCoder.encode(
            ["uint8[]"],
            [params.misbehavedMembersIndices]
          )
        ),
      ]
    )
  )
}

/// Signs a FROST DKG result and returns the populated struct
/// ready for `submitDkgResult`. Mirrors the ECDSA helper's
/// shape but swaps `groupPubKey` for `xOnlyOutputKey` and uses
/// the v4 digest format.
///
/// `signers` must already be the post-selectGroup operator set
/// (in member-index order — member i is signers[i-1]).
/// `numberOfSignatures` defaults to `signers.length / 2 + 1`
/// (the honest-majority threshold the validator enforces).
export async function signFrostDkgResult(
  hre: HardhatRuntimeEnvironment,
  signers: Operators,
  bridge: string,
  registry: string,
  seed: BigNumberish,
  xOnlyOutputKey: BytesLike,
  submitterIndex: number,
  misbehavedMembersIndices: number[] = noMisbehaved,
  numberOfSignatures?: number
): Promise<FrostDkgResult> {
  const { ethers } = hre

  const targetSigCount =
    numberOfSignatures ?? Math.floor(signers.length / 2) + 1

  const members: number[] = signers.map((s) => s.id)

  const digest = computeFrostResultDigest(hre, {
    chainId: hardhatNetworkId,
    bridge,
    registry,
    seed,
    xOnlyOutputKey,
    members,
    misbehavedMembersIndices,
  })

  const signingMembersIndices: number[] = []
  const signatures: string[] = []
  for (let i = 0; i < signers.length; i++) {
    if (signatures.length === targetSigCount) {
      // eslint-disable-next-line no-continue
      continue
    }
    const memberIndex = i + 1
    signingMembersIndices.push(memberIndex)
    // EIP-191-prefixed signing — matches the validator's
    // `verifySignature` path which prepends the standard
    // `\x19Ethereum Signed Message:\n32` prefix before
    // recovering the operator address.
    const signature = await signers[i].signer.signMessage(
      ethers.utils.arrayify(digest)
    )
    signatures.push(signature)
  }

  // `membersHash` must hash the FILTERED group — i.e., the
  // members that actually contributed to the group signing
  // key after IA/DQ exclusion. `FrostDkgValidator.validateMembersHash`
  // strips members at `misbehavedMembersIndices` (1-based) from
  // `members` and re-hashes; if the helper produced a hash of
  // the full pre-filter list when misbehaved is non-empty, the
  // validator would reject the result as "Invalid members hash"
  // (or — worse if approved unchallenged — store the wrong
  // active-member set). (Codex P2 on PR #446.)
  const groupMembers =
    misbehavedMembersIndices.length > 0
      ? members.filter((_, i) => !misbehavedMembersIndices.includes(i + 1))
      : members
  const membersHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["uint32[]"], [groupMembers])
  )

  return {
    submitterMemberIndex: submitterIndex,
    xOnlyOutputKey: ethers.utils.hexlify(xOnlyOutputKey),
    misbehavedMembersIndices,
    signatures: ethers.utils.hexConcat(signatures),
    signingMembersIndices,
    members,
    membersHash,
  }
}

/// Runs the full FROST DKG flow against a deployed
/// FrostWalletRegistry: selects the group, signs the result,
/// submits, advances past the challenge window, approves.
///
/// Caller must have:
///   - Registered ≥ groupSize operators in the FROST sortition
///     pool (helper TBD in a follow-up slice — current B-1.5
///     covers the signing primitives; the full operator-
///     registration fixture is the next slice).
///   - Already called `requestNewWallet` and produced a
///     relay-entry callback that started the DKG.
export async function performFrostDkg(
  hre: HardhatRuntimeEnvironment,
  frostWalletRegistry: Contract,
  bridge: string,
  seed: BigNumber,
  xOnlyOutputKey: BytesLike,
  signers: Operators,
  options: {
    misbehavedMembersIndices?: number[]
    submitterIndex?: number
  } = {}
): Promise<{
  submitDkgResultTx: ContractTransaction
  approveDkgResultTx: ContractTransaction
  dkgResult: FrostDkgResult
  submitter: SignerWithAddress
}> {
  const { ethers } = hre

  const submitterIndex = options.submitterIndex ?? 1
  const misbehavedMembersIndices =
    options.misbehavedMembersIndices ?? noMisbehaved

  const dkgResult = await signFrostDkgResult(
    hre,
    signers,
    bridge,
    frostWalletRegistry.address,
    seed,
    xOnlyOutputKey,
    submitterIndex,
    misbehavedMembersIndices
  )

  const submitter = signers[submitterIndex - 1].signer

  const submitDkgResultTx = await frostWalletRegistry
    .connect(submitter)
    .submitDkgResult(dkgResult)

  // Mine enough blocks to exceed `resultChallengePeriodLength`.
  // Read the current value from on-chain rather than caching
  // it — governance can update it independently. Use
  // `hardhat_mine` (single RPC call mining N blocks at once)
  // rather than `evm_mine` in a loop, so the helper stays fast
  // when the production challenge period (11_520 blocks) is
  // in effect.
  const dkgParams = await frostWalletRegistry.dkgParameters()
  const challengeBlocks: number =
    dkgParams.resultChallengePeriodLength.toNumber()
  // `+ 2` absorbs the off-by-one between mineBlocksTo's
  // semantics and the contract's `>` (not `>=`) comparison.
  const blocksToMine = challengeBlocks + 2
  await hre.network.provider.send("hardhat_mine", [
    `0x${blocksToMine.toString(16)}`,
  ])

  const approveDkgResultTx = await frostWalletRegistry
    .connect(submitter)
    .approveDkgResult(dkgResult)

  // Reference unused param to suppress linter; `ethers` import
  // is kept for callers that need it via the function signature.
  void ethers
  return { submitDkgResultTx, approveDkgResultTx, dkgResult, submitter }
}

/// FROST DKG protocol constants. `groupSize` is a compile-time
/// constant in `FrostDkg.sol`; mirror it here so tests can
/// allocate the right number of operators without re-querying
/// the chain.
export const FROST_GROUP_SIZE = 100

/// Generates `count` deterministic `ethers.Wallet` instances
/// connected to the hardhat provider and funds each with 1 ETH
/// via `hardhat_setBalance`. Returns wallets in deterministic
/// derivation-index order so tests get the same set on every
/// run (helps reproducibility under `--bail`).
///
/// Hardhat's default 20-signer accounts list isn't enough for
/// the FROST group size (100); this helper bridges the gap
/// without requiring hardhat config changes.
export async function deriveFundedOperatorWallets(
  hre: HardhatRuntimeEnvironment,
  count: number,
  // Default to the standard hardhat test mnemonic so derivation
  // is deterministic AND BIP-39 valid. Derivation paths start
  // at index 100 to avoid colliding with the first 20 hardhat-
  // funded accounts used elsewhere in the suite.
  seedPhrase = "test test test test test test test test test test test junk"
): Promise<Wallet[]> {
  const { ethers } = hre
  const hdNode = ethers.utils.HDNode.fromMnemonic(seedPhrase)
  const wallets: Wallet[] = []
  // 1 ETH per wallet — plenty for the few txs each runs during
  // operator registration + sortition pool join.
  const fundingHex = "0xDE0B6B3A7640000" // 1 ETH in wei, hex
  // Start at derivation index 100 so we don't collide with
  // hardhat's first 20 pre-funded accounts (indices 0-19).
  const baseIndex = 100
  for (let i = 0; i < count; i++) {
    const child = hdNode.derivePath(`m/44'/60'/0'/0/${baseIndex + i}`)
    const wallet = new ethers.Wallet(child.privateKey, ethers.provider)
    await hre.network.provider.send("hardhat_setBalance", [
      wallet.address,
      fundingHex,
    ])
    wallets.push(wallet)
  }
  return wallets
}

/// Registers `wallets.length` operators in the FROST sortition
/// pool. Each wallet acts as BOTH the staking provider AND the
/// operator (no separation in this test fixture). Callers must
/// admit those wallet addresses to the FrostAllowlist before
/// invoking this helper.
///
/// Returns the `Operators` array keyed by sortition pool ID,
/// preserving wallet-index order so tests can map back to the
/// original wallet that signs with each operator key.
export async function registerOperators(
  hre: HardhatRuntimeEnvironment,
  frostWalletRegistry: Contract,
  frostSortitionPool: Contract,
  wallets: Wallet[]
): Promise<Operators> {
  const operators = new Operators()
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i]
    await frostWalletRegistry.connect(wallet).registerOperator(wallet.address)
    await frostWalletRegistry.connect(wallet).joinSortitionPool()
    const id: number = await frostSortitionPool.getOperatorID(wallet.address)
    operators.push({
      id,
      signer: wallet as unknown as SignerWithAddress,
      stakingProvider: wallet.address,
    })
  }
  return operators
}

/// Adds deterministic operator wallets to the FROST allowlist using the
/// registry's current minimum authorization as their sortition weight.
export async function allowlistOperatorWallets(
  frostAllowlist: Contract,
  frostWalletRegistry: Contract,
  wallets: Wallet[]
): Promise<void> {
  const weight: BigNumber = await frostWalletRegistry.minimumAuthorization()
  for (const wallet of wallets) {
    // eslint-disable-next-line no-await-in-loop
    await frostAllowlist.addStakingProvider(wallet.address, weight)
  }
}

/// One-shot "select group from the populated pool" wrapper.
/// Mirrors `selectGroup` from the ECDSA helper but for the
/// FROST registry. Returns the operators in member-index order
/// (operator i corresponds to result.members[i-1] and signs
/// as `dkgResult.signingMembersIndices[k] == i`).
export async function selectFrostGroup(
  hre: HardhatRuntimeEnvironment,
  frostWalletRegistry: Contract,
  frostSortitionPool: Contract,
  registeredOperators: Operators
): Promise<Operators> {
  const { ethers } = hre
  void ethers
  const identifiers: number[] = await frostWalletRegistry.selectGroup()
  const addresses: string[] = await frostSortitionPool.getIDOperators(
    identifiers
  )
  // Map back to the registered Operator entries (each entry
  // holds the original signer so we can sign the digest).
  const byAddress = new Map<string, Operator>(
    registeredOperators.map((o) => [
      (
        o.signer.address ?? (o.signer as unknown as Wallet).address
      ).toLowerCase(),
      o,
    ])
  )
  return new Operators(
    ...identifiers.map((id, i): Operator => {
      const entry = byAddress.get(addresses[i].toLowerCase())
      if (!entry) {
        throw new Error(
          `selectGroup returned operator ${addresses[i]} (id ${id}) that was not pre-registered`
        )
      }
      return { ...entry, id }
    })
  )
}
