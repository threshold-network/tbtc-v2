/* eslint-disable no-underscore-dangle */
import { ethers } from "hardhat"
import { expect } from "chai"

import {
  computeFrostResultDigest,
  hardhatNetworkId,
  signFrostDkgResult,
  Operators,
} from "../integration/utils/frost-wallet-registry"

// B-1.5 first slice: digest parity test.
//
// The off-chain B-1.5 integration helper
// (`test/integration/utils/frost-wallet-registry.ts`)
// re-computes the RFC v4 FROST result digest in TypeScript so
// it can sign valid results without touching the chain.
// On-chain, `FrostDkgValidator.resultDigest(...)` is the
// canonical implementation. If the two ever drift, every
// integration test that uses the helper would silently produce
// signatures that fail validation on submit — surfacing as a
// confusing "invalid signature" rather than the actual cause.
//
// This test pins the two implementations as byte-identical
// across a representative spread of inputs (varying member
// arrays, misbehaved sets, seeds, addresses). It does NOT
// exercise the full DKG flow — that requires the 100-operator
// sortition pool fixture which is the next B-1.5 slice. The
// digest check is the load-bearing primitive that the rest of
// the flow depends on; if this passes, the signing primitive
// is sound.

describe("FrostDkgValidator digest parity (B-1.5 helper invariant)", () => {
  let validator: any
  let bridge: string
  let registry: string

  before(async () => {
    // Deploy a tiny sortition pool placeholder so the validator
    // constructor has a valid address — `resultDigest` is a
    // pure view and never reads from the pool, so any non-zero
    // address suffices for this test.
    const SortitionPoolFactory = await ethers.getContractFactory(
      "@keep-network/sortition-pools/contracts/SortitionPool.sol:SortitionPool"
    )
    // The pool factory needs a token + weight-divisor; use T's
    // address from the deployments registry would be cleaner,
    // but for digest-parity tests any non-zero address works.
    const [deployer] = await ethers.getSigners()
    // Deploy a minimal ERC20 stub for the pool's token argument.
    const TokenFactory = await ethers.getContractFactory("TestERC20")
    const token = await TokenFactory.connect(deployer).deploy()
    await token.deployed()
    const pool = await SortitionPoolFactory.connect(deployer).deploy(
      token.address,
      ethers.utils.parseEther("1")
    )
    await pool.deployed()

    const ValidatorFactory = await ethers.getContractFactory(
      "FrostDkgValidator"
    )
    validator = await ValidatorFactory.connect(deployer).deploy(pool.address)
    await validator.deployed()

    // Synthetic addresses for the digest binding. The validator
    // doesn't validate that these are deployed contracts during
    // `resultDigest`, just hashes them as part of the digest.
    bridge = ethers.utils.getAddress(
      "0x1111111111111111111111111111111111111111"
    )
    registry = ethers.utils.getAddress(
      "0x2222222222222222222222222222222222222222"
    )
  })

  const cases = [
    {
      name: "minimal happy case",
      seed: 42n,
      xOnlyOutputKey:
        "0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      members: [1, 2, 3],
      misbehavedMembersIndices: [],
    },
    {
      name: "with misbehaved members",
      seed: 0xc0ffee_c0ffee_c0ffee_c0ffee_c0ffee_c0ffee_c0ffee_c0ffeen,
      xOnlyOutputKey:
        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      members: [10, 20, 30, 40, 50],
      misbehavedMembersIndices: [2, 4],
    },
    {
      name: "full-size group + dense misbehaved set",
      seed: 0xff_ff_ff_ff_ff_ff_ff_ffn,
      xOnlyOutputKey:
        "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
      members: Array.from({ length: 100 }, (_, i) => i + 1),
      misbehavedMembersIndices: Array.from(
        { length: 20 },
        (_, i) => (i + 1) * 5
      ),
    },
  ]

  describe("membersHash parity (Codex P2 regression pin)", () => {
    // Validate that the helper's `membersHash` matches what
    // `FrostDkgValidator.validateMembersHash` recomputes. The
    // earlier version of `signFrostDkgResult` hashed the full
    // pre-filter `members` array unconditionally, which would
    // silently produce invalid results whenever the test
    // supplied a non-empty `misbehavedMembersIndices`. Pin the
    // post-fix behaviour against the on-chain validator.
    it("validateMembersHash accepts the helper's hash (no misbehaved)", async () => {
      const [signer] = await ethers.getSigners()
      // The signing-key per member doesn't matter for the
      // membersHash check; reuse a single signer for all five
      // slots to keep the test cheap.
      const fakeOperators = new Operators(
        ...[1, 2, 3, 4, 5].map((id) => ({
          id,
          signer: signer as any,
          stakingProvider: signer.address,
        }))
      )
      const result = await signFrostDkgResult(
        { ethers } as any,
        fakeOperators,
        bridge,
        registry,
        7n,
        `0x${"ab".repeat(32)}`,
        1,
        []
      )
      expect(await validator.validateMembersHash(result)).to.equal(true)
    })

    it("validateMembersHash accepts the helper's hash (with misbehaved)", async () => {
      const [signer] = await ethers.getSigners()
      const fakeOperators = new Operators(
        ...[10, 20, 30, 40, 50, 60, 70, 80].map((id) => ({
          id,
          signer: signer as any,
          stakingProvider: signer.address,
        }))
      )
      // Misbehaved indices are 1-based per FrostDkg convention;
      // exclude members 2, 5, 7 — must be sorted ascending +
      // unique per the contract's documentation.
      const result = await signFrostDkgResult(
        { ethers } as any,
        fakeOperators,
        bridge,
        registry,
        99n,
        `0x${"cd".repeat(32)}`,
        1,
        [2, 5, 7]
      )
      expect(await validator.validateMembersHash(result)).to.equal(
        true,
        "helper's membersHash must hash the FILTERED group (Codex P2)"
      )
    })
  })

  describe("field validation", () => {
    for (const misbehavedMembersIndices of [[0], [101]]) {
      it(`rejects a single out-of-range misbehaved member index ${misbehavedMembersIndices[0]} gracefully`, async () => {
        const result = {
          submitterMemberIndex: 1,
          xOnlyOutputKey:
            "0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
          misbehavedMembersIndices,
          signatures: "0x",
          signingMembersIndices: [],
          members: [],
          membersHash: ethers.constants.HashZero,
        }

        const [isValid, errorMsg] = await validator.validateFields(result)
        expect(isValid).to.equal(false)
        expect(errorMsg).to.equal("Corrupted misbehaved members indices")
      })
    }
  })

  cases.forEach((c) => {
    it(`matches on-chain resultDigest: ${c.name}`, async () => {
      // Off-chain: TS helper.
      const offchain = computeFrostResultDigest(
        // pass hre by reference; the helper only uses `ethers`
        { ethers } as any,
        {
          chainId: hardhatNetworkId,
          bridge,
          registry,
          seed: c.seed,
          xOnlyOutputKey: c.xOnlyOutputKey,
          members: c.members,
          misbehavedMembersIndices: c.misbehavedMembersIndices,
        }
      )

      // On-chain: pass a minimal Result struct to resultDigest.
      // signatures/signingMembersIndices/membersHash/
      // submitterMemberIndex are not part of the digest so any
      // values pass through unchanged; set them to defaults.
      const result = {
        submitterMemberIndex: 1,
        xOnlyOutputKey: c.xOnlyOutputKey,
        misbehavedMembersIndices: c.misbehavedMembersIndices,
        signatures: "0x",
        signingMembersIndices: [],
        members: c.members,
        membersHash: ethers.utils.keccak256(
          ethers.utils.defaultAbiCoder.encode(["uint32[]"], [c.members])
        ),
      }

      const onchain = await validator.resultDigest(
        result,
        c.seed,
        bridge,
        registry
      )

      expect(onchain).to.equal(offchain, `digest mismatch on case "${c.name}"`)
    })
  })
})
