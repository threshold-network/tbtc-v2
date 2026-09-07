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
  })
})
