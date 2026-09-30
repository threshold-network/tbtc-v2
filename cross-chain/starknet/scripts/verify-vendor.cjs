#!/usr/bin/env node
// Verifies that vendored contract sources under contracts/vendor/random-beacon
// still match the sha256 hashes recorded in VENDOR.json when they were vendored.
// Zero-dependency Node CommonJS script (node:crypto + node:fs only).

const fs = require("fs")
const path = require("path")
const crypto = require("crypto")

const vendorDir = path.join(
  __dirname,
  "..",
  "contracts",
  "vendor",
  "random-beacon"
)
const vendorJsonPath = path.join(vendorDir, "VENDOR.json")

function sha256(filePath) {
  const contents = fs.readFileSync(filePath)
  return crypto.createHash("sha256").update(contents).digest("hex")
}

function main() {
  const vendor = JSON.parse(fs.readFileSync(vendorJsonPath, "utf8"))
  const expected = vendor.sourceSha256 || {}

  const mismatches = []

  for (const [file, expectedHash] of Object.entries(expected)) {
    const filePath = path.join(vendorDir, file)
    let actualHash
    try {
      actualHash = sha256(filePath)
    } catch (err) {
      mismatches.push(`${file}: unable to read file (${err.message})`)
      continue
    }

    if (actualHash === expectedHash) {
      console.log(`OK ${file}`)
    } else {
      mismatches.push(
        `${file}: expected ${expectedHash}, got ${actualHash}`
      )
    }
  }

  if (mismatches.length > 0) {
    console.error("Vendor hash verification failed:")
    for (const mismatch of mismatches) {
      console.error(`  ${mismatch}`)
    }
    process.exit(1)
  }

  process.exit(0)
}

main()
