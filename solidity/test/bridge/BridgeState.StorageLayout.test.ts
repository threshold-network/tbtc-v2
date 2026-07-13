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

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ self, members } = await getBridgeStorageLayout())
  })

  it("anchors `Bridge.self` at absolute slot 51", () => {
    expect(self.slot).to.equal("51")
  })

  it("leaves the reserved __gap at relative slot 33 / absolute slot 84", () => {
    const gap = member("__gap")
    expect(gap.slot).to.equal("33")
    expect(Number(self.slot) + Number(gap.slot)).to.equal(84)
    // 45-element reserved gap, unchanged by this upgrade.
    expect(gap.type).to.match(/t_array\(t_uint256\)45_storage/)
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
    expect(Number(self.slot) + Number(covenant.slot)).to.equal(130)
  })

  it("places legacyVaultOptimisticMintingDebtCoordinator at relative slot 80 / absolute slot 131", () => {
    const mapping = member("legacyVaultOptimisticMintingDebtCoordinator")

    expect(mapping.slot).to.equal("80")
    expect(mapping.offset).to.equal(0)
    expect(Number(self.slot) + Number(mapping.slot)).to.equal(131)
    expect(mapping.type).to.equal("t_mapping(t_address,t_address)")
  })

  it("places the new mapping immediately after covenantSpendAuthorization with nothing between", () => {
    const covenant = member("covenantSpendAuthorization")
    const mapping = member("legacyVaultOptimisticMintingDebtCoordinator")

    // The mapping root is exactly one slot after the packed covenant slot; no
    // field is inserted between them and the mapping is the trailing field.
    expect(Number(mapping.slot)).to.equal(Number(covenant.slot) + 1)
    const maxSlot = Math.max(...members.map((m) => Number(m.slot)))
    expect(Number(mapping.slot)).to.equal(maxSlot)
  })
})
