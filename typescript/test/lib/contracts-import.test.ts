import { expect } from "chai"
import { execFileSync } from "child_process"

describe("Contracts module imports", () => {
  it("should load the contracts barrel without circular initialization failures", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "-e",
          "require('ts-node/register/files'); require('./src/lib/contracts')",
        ],
        {
          cwd: process.cwd(),
          stdio: "pipe",
        }
      )
    ).not.to.throw()
  })
})
