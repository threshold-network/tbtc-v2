/* eslint-disable no-underscore-dangle */
import { ethers } from "hardhat"
import { expect } from "chai"

/// FROST WalletRegistry guard tests (B-1.5 first slice).
///
/// These tests focus on the two correctness cases Codex's
/// re-review on PR #441 specifically called out as deferred:
///
///   1. Legacy-shaped x-only key (high 12 bytes zero) — must
///      revert at submission time so the result never enters
///      the challenge window and the DKG state machine cannot
///      get wedged.
///
///   2. Duplicate registered-guard — a second submission for an
///      already-registered key must fail-fast at the top of
///      `submitDkgResult`, not after challenge-window expiry.
///
/// The tests exercise the FrostRegistryWallets library's
/// validation function directly via a thin harness. Custom
/// errors (instead of require strings) are used so the
/// 4-byte selector-based revert decoding works reliably across
/// every JSON-RPC node configuration + hardhat-waffle matcher
/// version. (Codex P1 round-3 on PR #441: require-string
/// matching surfaced empty revert reasons in some environments;
/// custom errors sidestep the issue.)

// Helper: assert a transaction reverts with a specific no-arg
// custom error by manually decoding the 4-byte selector. The
// project's test toolchain (hardhat-waffle 2.x + smock) does
// not register chai's `revertedWithCustomError` matcher.
async function expectCustomError(
  promise: Promise<unknown>,
  errorName: string
): Promise<void> {
  const expectedSelector = ethers.utils.id(`${errorName}()`).slice(0, 10)
  try {
    await promise
  } catch (err) {
    const errAny = err as {
      data?: string
      message?: string
      error?: { data?: string }
    }
    const revertData = errAny.data || errAny.error?.data || ""
    const errMsg = errAny.message || String(err)

    if (
      (revertData && revertData.toLowerCase().startsWith(expectedSelector)) ||
      errMsg.toLowerCase().includes(expectedSelector) ||
      errMsg.includes(errorName)
    ) {
      return
    }
    throw new Error(
      `expected revert with custom error ${errorName} ` +
        `(selector ${expectedSelector}), got: ${errMsg}`
    )
  }
  throw new Error(
    `expected revert with custom error ${errorName} but tx succeeded`
  )
}

describe("FrostWalletRegistry guards (B-1.5 first slice)", () => {
  let validateHarness: any

  before(async () => {
    // Deploy a tiny test harness that exposes
    // `FrostRegistryWallets.validateXOnlyOutputKey` so we can
    // assert each branch of the require chain directly.
    const Harness = await ethers.getContractFactory(
      "FrostRegistryWalletsHarness"
    )
    validateHarness = await Harness.deploy()
    await validateHarness.deployed()
  })

  describe("validateXOnlyOutputKey", () => {
    it("reverts on the all-zero key", async () => {
      await expectCustomError(
        validateHarness.validateXOnlyOutputKey(
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        ),
        "XOnlyOutputKeyIsZero"
      )
    })

    it("reverts on a legacy-shaped key (high 12 bytes zero)", async () => {
      // Codex P1 round-2 on #441: this exact key shape would
      // have wedged the DKG state machine pre-fix — the
      // validator accepted it but the Bridge callback later
      // reverted on FrostWalletIdNotNative.
      const legacyShapedKey =
        "0x000000000000000000000000aabbccddeeff112233445566778899aabbccddee"
      await expectCustomError(
        validateHarness.validateXOnlyOutputKey(legacyShapedKey),
        "XOnlyOutputKeyIsLegacyAlias"
      )
    })

    it("accepts a well-formed native x-only key", async () => {
      // High 12 bytes are non-zero (a real FROST DKG output's
      // expected shape — uniform 32-byte x-only key).
      const nativeKey =
        "0xb1de1afa17e1cbb20d8a4f8e54f8a55fbf5c8d2da9e1c6c4d1f0c7b3a2e5d4c8"
      await expect(validateHarness.validateXOnlyOutputKey(nativeKey)).to.not.be
        .reverted
    })

    it("reverts on a second call with the same key (already-registered guard)", async () => {
      const key =
        "0xa1b2c3d4e5f6112233445566778899aabbccddeeff00112233445566778899aa"
      // First register succeeds.
      await validateHarness.recordAddedWallet(key)
      // Second validate-and-add must reject via the registered
      // guard (the library's own internal check on
      // `self.registry[walletID].xOnlyOutputKey != bytes32(0)`).
      await expectCustomError(
        validateHarness.validateXOnlyOutputKey(key),
        "XOnlyOutputKeyAlreadyRegistered"
      )
    })
  })
})
