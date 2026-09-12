import fs from "fs"
import path from "path"
import { createHash } from "crypto"
import { expect } from "chai"
import { config } from "hardhat"
import triage from "../../slither.db.json"

describe("Slither triage provenance", () => {
  triage.forEach((finding) => {
    it(`${finding.check} still matches the reviewed source`, () => {
      Object.entries(finding.review.sources).forEach(([file, expected]) => {
        const actual = createHash("sha256")
          .update(fs.readFileSync(path.join(config.paths.root, file)))
          .digest("hex")
        expect(
          actual,
          `Re-review Slither triage after changing ${file}`
        ).to.equal(expected)
      })
    })
    it(`${finding.check} references only reviewed source files`, () => {
      const referencedPaths = (
        finding.description.match(/contracts\/[^\s#)]+\.sol/g) || []
      ).filter((value, index, all) => all.indexOf(value) === index)
      const sourcesKeys = Object.keys(finding.review.sources)
      expect(
        sourcesKeys,
        `Missing source files for ${finding.check}: ${referencedPaths
          .filter((p) => !sourcesKeys.includes(p))
          .join(", ")}`
      ).to.include.members(referencedPaths)
    })
  })
})
