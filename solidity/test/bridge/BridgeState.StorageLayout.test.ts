import { expect } from "chai"
import fs from "fs"
import path from "path"

/* eslint-disable @typescript-eslint/no-explicit-any */

// Reads the compiler-derived storage layout of the `Bridge` implementation from
// the Hardhat build-info. `@openzeppelin/hardhat-upgrades` (pulled in by
// `@keep-network/hardhat-helpers`) enables the `storageLayout` output selection.
// Because `Bridge.sol` uses a per-file optimizer override, more than one
// build-info can contain a `Bridge` entry; this scans them for the one whose
// entry carries the storage layout.
async function getBridgeStorageLayout(): Promise<{
  self: { slot: string; type: string }
  members: Array<{ label: string; slot: string; offset: number; type: string }>
}> {
  const buildInfoDir = path.resolve(__dirname, "../../build/build-info")
  const files = (await fs.promises.readdir(buildInfoDir)).filter((f) =>
    f.endsWith(".json")
  )

  let layout: any
  // eslint-disable-next-line no-restricted-syntax
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await fs.promises.readFile(
      path.join(buildInfoDir, file),
      "utf8"
    )
    const buildInfo = JSON.parse(raw) as Record<string, any>
    const candidate =
      buildInfo?.output?.contracts?.["contracts/bridge/Bridge.sol"]?.Bridge
        ?.storageLayout
    if (candidate?.storage && candidate?.types) {
      layout = candidate
      break
    }
  }

  if (!layout) {
    throw new Error("Bridge storageLayout not found. Run `yarn build` first.")
  }

  const self = layout.storage.find((s: any) => s.label === "self")
  if (!self) {
    throw new Error("Bridge `self` storage entry not found")
  }

  return { self, members: layout.types[self.type].members }
}

// Live Sepolia baseline captured before the Stage-3 combined upgrade. Anchors
// the compile-time layout below to the deployed proxy: absolute slot 81 holds
// the live account-control minting controller and is the single reason
// `mintingController` must occupy relative slot 30.
const baseline = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../data/stage3-combined-sepolia-baseline.json"),
    "utf8"
  )
) as {
  bridgeProxy: string
  forkBlock: number
  mintingController: string
  rawSlots: Record<string, string>
}

// Left-pads a 20-byte address to a full 32-byte storage word, lowercased.
const slotWord = (address: string) =>
  `0x${"0".repeat(24)}${address.replace(/^0x/, "").toLowerCase()}`

describe("BridgeState storage layout", () => {
  let self: { slot: string; type: string }
  let members: Array<{
    label: string
    slot: string
    offset: number
    type: string
  }>

  const member = (label: string) => {
    const m = members.find((x) => x.label === label)
    expect(m, `member ${label}`).to.not.equal(undefined)
    return m!
  }

  // Absolute slot of a struct member (self starts at absolute slot 51).
  const absolute = (label: string) =>
    Number(self.slot) + Number(member(label).slot)

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ self, members } = await getBridgeStorageLayout())
  })

  it("anchors `Bridge.self` at absolute slot 51", () => {
    expect(self.slot).to.equal("51")
  })

  // ---- Stage-3 combined layout (spec section 3.1 table) ----

  it("places `mintingController` at relative slot 30 / absolute slot 81", () => {
    // This is the linchpin of the whole combined upgrade: the live Bridge
    // implementation reads the controller from absolute slot 81, so the
    // reconstructed field must land there.
    const m = member("mintingController")
    expect(m.slot).to.equal("30")
    expect(m.offset).to.equal(0)
    expect(m.type).to.equal("t_address")
    expect(absolute("mintingController")).to.equal(81)
  })

  it("places `migrationDebtVault` immediately after, at absolute slot 82", () => {
    const m = member("migrationDebtVault")
    expect(m.slot).to.equal("31")
    expect(m.offset).to.equal(0)
    expect(m.type).to.equal("t_address")
    expect(absolute("migrationDebtVault")).to.equal(82)
  })

  it("places `walletPendingFraudChallenges` mapping at absolute slot 83", () => {
    const m = member("walletPendingFraudChallenges")
    expect(m.slot).to.equal("32")
    expect(absolute("walletPendingFraudChallenges")).to.equal(83)
    expect(m.type).to.equal("t_mapping(t_bytes20,t_uint32)")
  })

  it("places `walletRegistrationOrder` array at absolute slot 84", () => {
    const m = member("walletRegistrationOrder")
    expect(m.slot).to.equal("33")
    expect(absolute("walletRegistrationOrder")).to.equal(84)
    expect(m.type).to.equal("t_array(t_bytes20)dyn_storage")
  })

  it("shrinks the reserved __gap to 44 slots starting at absolute slot 85", () => {
    const gap = member("__gap")
    expect(gap.slot).to.equal("34")
    expect(absolute("__gap")).to.equal(85)
    // 44-element reserved gap: one slot was consumed by the reconstructed
    // `mintingController` so the post-gap fields keep their absolute slots.
    expect(gap.type).to.match(/t_array\(t_uint256\)44_storage/)
  })

  it("keeps `openFraudChallengeEscrow` at absolute slot 129", () => {
    const m = member("openFraudChallengeEscrow")
    expect(absolute("openFraudChallengeEscrow")).to.equal(129)
    expect(m.type).to.equal("t_uint256")
  })

  it("packs the two seeded booleans and covenant address into slot 130", () => {
    const escrowSeeded = member("fraudChallengeEscrowSeeded")
    const orderSeeded = member("walletRegistrationOrderSeeded")
    const covenant = member("covenantSpendAuthorization")

    // All three share relative slot 79 (absolute 130); the covenant address
    // does not consume a fresh slot.
    expect(escrowSeeded.slot).to.equal("79")
    expect(escrowSeeded.offset).to.equal(0)
    expect(orderSeeded.slot).to.equal("79")
    expect(orderSeeded.offset).to.equal(1)
    expect(covenant.slot).to.equal("79")
    expect(covenant.offset).to.equal(2)
    expect(covenant.type).to.equal("t_address")
    expect(absolute("covenantSpendAuthorization")).to.equal(130)
  })

  it("places legacyVaultOptimisticMintingDebtCoordinator at relative slot 80 / absolute slot 131", () => {
    const mapping = member("legacyVaultOptimisticMintingDebtCoordinator")

    expect(mapping.slot).to.equal("80")
    expect(mapping.offset).to.equal(0)
    expect(absolute("legacyVaultOptimisticMintingDebtCoordinator")).to.equal(
      131
    )
    expect(mapping.type).to.equal("t_mapping(t_address,t_address)")
  })

  it("places the trailing mapping immediately after covenantSpendAuthorization with nothing between", () => {
    const covenant = member("covenantSpendAuthorization")
    const mapping = member("legacyVaultOptimisticMintingDebtCoordinator")

    // The mapping root is exactly one slot after the packed covenant slot; no
    // field is inserted between them and the mapping is the trailing field.
    expect(Number(mapping.slot)).to.equal(Number(covenant.slot) + 1)
    const maxSlot = Math.max(...members.map((m) => Number(m.slot)))
    expect(Number(mapping.slot)).to.equal(maxSlot)
  })

  // ---- Cross-check the compile-time layout against the live proxy ----

  it("matches the live Sepolia baseline: slot 81 holds the deployed controller", () => {
    // The reconstructed compile-time slot of `mintingController` must coincide
    // with the deployed proxy's populated slot 81.
    expect(absolute("mintingController")).to.equal(81)
    expect(baseline.rawSlots["81"].toLowerCase()).to.equal(
      slotWord(baseline.mintingController)
    )
  })

  it("matches the live Sepolia baseline: migration-target slots are clean", () => {
    // The reinitializer requires slots 82 (migrationDebtVault), 84
    // (walletRegistrationOrder length), 129 (escrow), 130 (packed flags +
    // covenant) and 131 (legacy mapping) to be zero pre-upgrade. If any were
    // populated on the live proxy, the layout assumptions would be wrong.
    const cleanSlots = ["82", "83", "84", "129", "130", "131"]
    cleanSlots.forEach((slot) => {
      expect(
        baseline.rawSlots[slot],
        `live slot ${slot} must be zero pre-upgrade`
      ).to.equal(`0x${"0".repeat(64)}`)
    })
  })
})
