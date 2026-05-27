/* eslint-disable no-underscore-dangle */
import { ethers } from "hardhat"
import { expect } from "chai"

/// FROST DKG validator RFC v4 digest-binding tests (B-1.5 second slice).
///
/// RFC #437 v4.1 §"DKG result message format" specifies the
/// per-result digest as:
///
///   keccak256(abi.encode(
///     "tbtc-frost-dkg-result-v1",
///     block.chainid,
///     address(bridge),
///     address(registry),
///     seed,
///     xOnlyOutputKey,
///     keccak256(abi.encode(members)),
///     keccak256(abi.encode(misbehavedMembersIndices))
///   ))
///
/// Each field is required to make the digest unique under a
/// specific replay vector:
///   - chainid    blocks cross-chain replay
///   - bridge     blocks wrong-Bridge replay
///   - registry   blocks wrong-registry replay
///   - seed       blocks wrong-request replay
///   - xOnlyKey   blocks wrong-key replay
///   - members    blocks wrong-group replay
///   - misbehaved blocks reward-ban-list edits
///
/// This suite verifies via the validator's `resultDigest(...)`
/// view that flipping any single field yields a distinct digest,
/// proving each replay vector is closed. Tests run against a
/// minimal hardhat deploy of `FrostDkgValidator` + a stub
/// sortition pool (the digest function does not read the
/// sortition pool; the pool address is only used by
/// `validateSignatures`'s downstream ECDSA recovery path).

describe("FrostDkgValidator RFC v4 digest binding", () => {
  let validator: any

  // A fixed reference DkgResult; each test case mutates exactly
  // one field of this and asserts the digest changes.
  const baseResult = {
    submitterMemberIndex: 1,
    xOnlyOutputKey:
      "0xb1de1afa17e1cbb20d8a4f8e54f8a55fbf5c8d2da9e1c6c4d1f0c7b3a2e5d4c8",
    misbehavedMembersIndices: [3, 7],
    signatures: "0x", // unused by resultDigest
    signingMembersIndices: [1, 2, 3], // unused by resultDigest
    members: Array.from({ length: 5 }, (_, i) => i + 1) as number[],
    membersHash: ethers.utils.hexZeroPad("0x42", 32),
  }
  const baseSeed = 0x12345678n
  const baseBridge = "0x1111111111111111111111111111111111111111"
  const baseRegistry = "0x2222222222222222222222222222222222222222"

  before(async () => {
    // Deploy a minimal SortitionPool stub; the validator's
    // constructor demands an address but `resultDigest` doesn't
    // call into it.
    const T = await (await ethers.getContractFactory("TestERC20")).deploy()
    await T.deployed()
    const SortitionPool = await (
      await ethers.getContractFactory(
        "@keep-network/sortition-pools/contracts/SortitionPool.sol:SortitionPool"
      )
    ).deploy(T.address, ethers.utils.parseEther("1"))
    await SortitionPool.deployed()

    const Validator = await ethers.getContractFactory("FrostDkgValidator")
    validator = await Validator.deploy(SortitionPool.address)
    await validator.deployed()
  })

  async function digest(
    overrides: Partial<typeof baseResult> = {},
    seed: bigint = baseSeed,
    bridge: string = baseBridge,
    registry: string = baseRegistry
  ): Promise<string> {
    const r = { ...baseResult, ...overrides }
    return validator.resultDigest(r, seed, bridge, registry)
  }

  it("reference digest is deterministic across calls", async () => {
    const d1 = await digest()
    const d2 = await digest()
    expect(d1).to.equal(d2)
  })

  it("changing xOnlyOutputKey changes the digest (wrong-key replay closed)", async () => {
    const ref = await digest()
    const flipped = await digest({
      xOnlyOutputKey:
        "0xdeadbeefcafe5512345678901234567890abcdef1234567890abcdef12345678",
    })
    expect(flipped).to.not.equal(ref)
  })

  it("changing seed changes the digest (wrong-request replay closed)", async () => {
    const ref = await digest()
    const flipped = await digest({}, baseSeed + 1n)
    expect(flipped).to.not.equal(ref)
  })

  it("changing bridge changes the digest (wrong-Bridge replay closed)", async () => {
    const ref = await digest()
    const flipped = await digest(
      {},
      baseSeed,
      "0x3333333333333333333333333333333333333333"
    )
    expect(flipped).to.not.equal(ref)
  })

  it("changing registry changes the digest (wrong-registry replay closed)", async () => {
    const ref = await digest()
    const flipped = await digest(
      {},
      baseSeed,
      baseBridge,
      "0x4444444444444444444444444444444444444444"
    )
    expect(flipped).to.not.equal(ref)
  })

  it("changing members changes the digest (wrong-group replay closed)", async () => {
    const ref = await digest()
    const flipped = await digest({ members: [9, 8, 7, 6, 5] })
    expect(flipped).to.not.equal(ref)
  })

  it("changing misbehavedMembersIndices changes the digest (RFC v4 P1: reward-ban-list edits cannot bypass sig verification)", async () => {
    // This is the v3-bug RFC v4 fixed: the misbehaved list MUST
    // be in the digest so an editing attacker can't keep
    // signatures valid while flipping the ban list.
    const ref = await digest()
    const flipped = await digest({ misbehavedMembersIndices: [3, 7, 9] })
    expect(flipped).to.not.equal(ref)
  })

  it("digest format string is the v4 RFC tag (no version drift)", async () => {
    // Compute the expected digest off-chain and compare. If the
    // contract's format string ever changes silently, this
    // assertion catches it.
    const expected = ethers.utils.keccak256(
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
          // hardhat default chainid; the resultDigest reads
          // block.chainid so we need to query it.
          (await ethers.provider.getNetwork()).chainId,
          baseBridge,
          baseRegistry,
          baseSeed,
          baseResult.xOnlyOutputKey,
          ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
              ["uint32[]"],
              [baseResult.members]
            )
          ),
          ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
              ["uint8[]"],
              [baseResult.misbehavedMembersIndices]
            )
          ),
        ]
      )
    )
    expect(await digest()).to.equal(expected)
  })
})
