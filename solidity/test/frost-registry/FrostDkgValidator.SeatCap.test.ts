import { ethers } from "hardhat"
import { expect } from "chai"

/// FROST DKG validator per-wallet seat cap tests (delegated
/// staking module, spec section E).
///
/// `maxSeatsPerWallet` bounds the multiplicity of any single
/// member ID in a DKG result's `members` array. Member IDs are
/// sortition-pool operator IDs, so the same operator always
/// carries the same ID and no address resolution is needed to
/// count seats. The check lives in `validateFields` (walked by
/// both the submit-side `isDkgResultValid` free call and the
/// challenge path via `validate`), rejecting any result in
/// which one member holds more than `maxSeatsPerWallet` seats.
/// Zero disables the check entirely.
///
/// The suite deploys validators with different caps against a
/// stub sortition pool (`validateFields` never reads the pool)
/// and drives `validateFields` with crafted member arrays.

const SEAT_CAP_ERROR = "Too many seats for a single member"

describe("FrostDkgValidator per-wallet seat cap", () => {
  const GROUP_SIZE = 100
  const GROUP_THRESHOLD = 51
  const SIGNATURE_BYTE_SIZE = 65

  let sortitionPoolAddress: string

  before(async () => {
    // Deploy a minimal SortitionPool stub; the validator's
    // constructor demands an address but `validateFields`
    // doesn't call into it.
    const T = await (await ethers.getContractFactory("TestERC20")).deploy()
    await T.deployed()
    const SortitionPool = await (
      await ethers.getContractFactory(
        "@keep-network/sortition-pools/contracts/SortitionPool.sol:SortitionPool"
      )
    ).deploy(T.address, ethers.utils.parseEther("1"))
    await SortitionPool.deployed()
    sortitionPoolAddress = SortitionPool.address
  })

  async function deployValidator(maxSeatsPerWallet: number) {
    const Validator = await ethers.getContractFactory("FrostDkgValidator")
    const validator = await Validator.deploy(
      sortitionPoolAddress,
      maxSeatsPerWallet
    )
    await validator.deployed()
    return validator
  }

  /// Builds a DKG result whose every non-members field passes
  /// `validateFields`' static checks, so the seat cap verdict is
  /// isolated: `(true, "")` means the members array passed the
  /// cap, `(false, SEAT_CAP_ERROR)` means it was rejected by the
  /// cap (and nothing else).
  function buildResult(members: number[]) {
    return {
      submitterMemberIndex: 1,
      xOnlyOutputKey:
        "0xb1de1afa17e1cbb20d8a4f8e54f8a55fbf5c8d2da9e1c6c4d1f0c7b3a2e5d4c8",
      misbehavedMembersIndices: [] as number[],
      // Signature bytes are only length-checked by
      // `validateFields`; content is irrelevant here.
      signatures: `0x${"11".repeat(SIGNATURE_BYTE_SIZE * GROUP_THRESHOLD)}`,
      signingMembersIndices: Array.from(
        { length: GROUP_THRESHOLD },
        (_, i) => i + 1
      ),
      members,
      membersHash: ethers.utils.hexZeroPad("0x42", 32),
    }
  }

  /// members = [1, 2, ..., GROUP_SIZE] with the requested seat
  /// multiplicities injected: `seats` maps a member ID to how
  /// many total occurrences it should have. Extra occurrences
  /// overwrite unique tail entries so the array length stays
  /// GROUP_SIZE. (Duplicate IDs must be small — below the
  /// remaining unique prefix — so injection never collides with
  /// its own occurrences.)
  function membersWithSeats(seats: Record<number, number>): number[] {
    const members = Array.from({ length: GROUP_SIZE }, (_, i) => i + 1)
    let tail = GROUP_SIZE - 1
    for (const [idStr, count] of Object.entries(seats)) {
      const id = Number(idStr)
      for (let k = 1; k < count; k++) {
        members[tail] = id
        tail -= 1
      }
    }
    return members
  }

  describe("when the cap is 2", () => {
    let validator: any

    before(async () => {
      validator = await deployValidator(2)
    })

    it("exposes the cap via the maxSeatsPerWallet view", async () => {
      expect(await validator.maxSeatsPerWallet()).to.equal(2)
    })

    it("accepts an all-unique members array", async () => {
      const [isValid, errorMsg] = await validator.validateFields(
        buildResult(membersWithSeats({}))
      )
      expect(isValid).to.equal(true)
      expect(errorMsg).to.equal("")
    })

    it("accepts a member holding exactly the cap (2 seats)", async () => {
      const [isValid, errorMsg] = await validator.validateFields(
        buildResult(membersWithSeats({ 7: 2 }))
      )
      expect(isValid).to.equal(true)
      expect(errorMsg).to.equal("")
    })

    it("rejects a member holding cap + 1 seats", async () => {
      const [isValid, errorMsg] = await validator.validateFields(
        buildResult(membersWithSeats({ 7: 3 }))
      )
      expect(isValid).to.equal(false)
      expect(errorMsg).to.equal(SEAT_CAP_ERROR)
    })

    it("counts per member: two distinct members at the cap are fine", async () => {
      const [isValid, errorMsg] = await validator.validateFields(
        buildResult(membersWithSeats({ 7: 2, 13: 2 }))
      )
      expect(isValid).to.equal(true)
      expect(errorMsg).to.equal("")
    })

    it("rejects one over-cap member even among other at-cap members", async () => {
      const [isValid, errorMsg] = await validator.validateFields(
        buildResult(membersWithSeats({ 7: 2, 13: 3 }))
      )
      expect(isValid).to.equal(false)
      expect(errorMsg).to.equal(SEAT_CAP_ERROR)
    })

    it("counts non-adjacent duplicates (first, middle, last)", async () => {
      // ID 7 planted at positions 0, 50, and 99 — multiplicity 3
      // must be detected even though no two occurrences touch.
      const members = Array.from({ length: GROUP_SIZE }, (_, i) => i + 1)
      members[0] = 7
      members[50] = 7
      members[99] = 7
      const [isValid, errorMsg] = await validator.validateFields(
        buildResult(members)
      )
      expect(isValid).to.equal(false)
      expect(errorMsg).to.equal(SEAT_CAP_ERROR)
    })
  })

  describe("when the cap is 12 (production value)", () => {
    let validator: any

    before(async () => {
      validator = await deployValidator(12)
    })

    it("accepts a member holding exactly 12 seats", async () => {
      const [isValid, errorMsg] = await validator.validateFields(
        buildResult(membersWithSeats({ 3: 12 }))
      )
      expect(isValid).to.equal(true)
      expect(errorMsg).to.equal("")
    })

    it("rejects a member holding 13 seats", async () => {
      const [isValid, errorMsg] = await validator.validateFields(
        buildResult(membersWithSeats({ 3: 13 }))
      )
      expect(isValid).to.equal(false)
      expect(errorMsg).to.equal(SEAT_CAP_ERROR)
    })
  })

  describe("when the cap is 0 (disabled)", () => {
    let validator: any

    before(async () => {
      validator = await deployValidator(0)
    })

    it("exposes the disabled cap via the view", async () => {
      expect(await validator.maxSeatsPerWallet()).to.equal(0)
    })

    it("accepts heavy duplication (60 seats for one member)", async () => {
      const [isValid, errorMsg] = await validator.validateFields(
        buildResult(membersWithSeats({ 5: 60 }))
      )
      expect(isValid).to.equal(true)
      expect(errorMsg).to.equal("")
    })
  })
})
