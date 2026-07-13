import { expect } from "chai"
import hre, { ethers } from "hardhat"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type { Contract } from "ethers"

// Legacy-retirement and optimistic-debt custom errors are declared and thrown by
// the linked `VaultManagement` library, so they are decoded from the raw revert
// data through a standalone interface rather than the harness ABI.
const errorsInterface = new ethers.utils.Interface([
  "error UnsupportedLegacyVault(address vault)",
  "error LegacyVaultCodeHashMismatch(address vault, bytes32 actualCodeHash)",
  "error LegacyVaultOptimisticMintingDebtAttestationMissing(address vault)",
  "error LegacyVaultOptimisticMintingNotPaused(address vault)",
  "error LegacyVaultMigrationCoordinatorInvalid(address vault, address coordinator)",
  "error LegacyVaultEvidenceInvalid()",
  "error LegacyVaultAttestationCannotBeRevoked(address vault)",
  "error LegacyVaultAlreadyRetired(address vault)",
  "error LegacyVaultImplementsOptimisticMintingDebtInterface(address vault)",
  "error LegacyVaultNotTrusted(address vault)",
  "error VaultHasOutstandingOptimisticMintingDebt(address vault)",
  "error PreviousMigrationDebtVaultHasOptimisticDebt(address vault)",
])

function collectRevertData(error: unknown): string[] {
  const data: string[] = []
  const stack: unknown[] = [error]
  while (stack.length > 0) {
    const candidate = stack.shift()
    if (candidate && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>
      if (typeof record.data === "string") data.push(record.data)
      if (record.data && typeof record.data === "object")
        stack.push(record.data)
      if (record.error && typeof record.error === "object")
        stack.push(record.error)
    }
  }
  return data
}

async function expectCustomError(
  txPromise: Promise<unknown>,
  errorName: string
): Promise<void> {
  try {
    await txPromise
    expect.fail(`expected revert with custom error ${errorName}`)
  } catch (error) {
    const match = collectRevertData(error).find((data) => {
      try {
        errorsInterface.decodeErrorResult(errorName, data)
        return true
      } catch {
        return false
      }
    })
    expect(match, `revert data for ${errorName}`).to.not.equal(undefined)
  }
}

const NONZERO_HASH =
  "0x1111111111111111111111111111111111111111111111111111111111111111"
const EVIDENCE_HASH =
  "0x2222222222222222222222222222222222222222222222222222222222222222"

describe("Bridge - Legacy vault optimistic-minting retirement", () => {
  let deployer: SignerWithAddress
  let council: SignerWithAddress
  let other: SignerWithAddress

  let harness: Contract
  let controller: Contract
  let legacy: Contract
  let coordinator: Contract
  let tbtc: Contract
  let bank: Contract

  let legacyCodeHash: string
  let snapshotBlock: number

  async function deploy(name: string, args: unknown[] = []): Promise<Contract> {
    const factory = await ethers.getContractFactory(name)
    const contract = await factory.deploy(...args)
    await contract.deployed()
    return contract
  }

  async function deployHarness(): Promise<Contract> {
    const vaultManagement = await deploy("VaultManagement")
    const factory = await ethers.getContractFactory(
      "BridgeVaultStatusHarness",
      {
        libraries: { VaultManagement: vaultManagement.address },
      }
    )
    const h = await factory.deploy()
    await h.deployed()
    return h
  }

  // Deploys the harness plus a fully locked known-legacy vault and coordinator
  // bound to the harness, and trusts the legacy vault. Leaves the attestation
  // unset so both the attested and unattested paths can be exercised.
  async function setup(): Promise<void> {
    harness = await deployHarness()
    tbtc = await deploy("MockOwnableToken")
    bank = await deploy("MockRetirementBank")
    legacy = await deploy("MockLegacyTBTCVault", [tbtc.address, bank.address])
    controller = await deploy("MockCoordinatorController", [council.address])
    coordinator = await deploy("LegacyTBTCVaultMigrationCoordinator", [
      controller.address,
      legacy.address,
      harness.address,
    ])

    // Lock: pause, then hand the legacy vault to the coordinator.
    await legacy.setOptimisticMintingPaused(true)
    await legacy.transferOwnership(coordinator.address)

    legacyCodeHash = ethers.utils.keccak256(
      await ethers.provider.getCode(legacy.address)
    )
    await harness.setKnownLegacyVault(legacy.address, legacyCodeHash)
    await harness.setHarnessGovernance(controller.address)
    await harness.setVaultStatus(legacy.address, true)

    snapshotBlock = (await ethers.provider.getBlockNumber()) - 1
  }

  async function attest(): Promise<void> {
    await harness.setLegacyVaultOptimisticMintingDebtAttestation(
      legacy.address,
      coordinator.address,
      snapshotBlock,
      NONZERO_HASH,
      EVIDENCE_HASH
    )
  }

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[deployer, council, other] = await ethers.getSigners()
    await setup()
  })

  describe("attestation setter", () => {
    it("records the attestation for the exact known legacy vault", async () => {
      await expect(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy.address,
          coordinator.address,
          snapshotBlock,
          NONZERO_HASH,
          EVIDENCE_HASH
        )
      )
        .to.emit(harness, "LegacyVaultOptimisticMintingDebtAttestationUpdated")
        .withArgs(
          legacy.address,
          coordinator.address,
          snapshotBlock,
          NONZERO_HASH,
          EVIDENCE_HASH
        )
      expect(
        await harness.legacyVaultOptimisticMintingDebtCoordinator(
          legacy.address
        )
      ).to.equal(coordinator.address)
    })

    it("reverts for a vault other than the known legacy address", async () => {
      await harness.setKnownLegacyVault(other.address, legacyCodeHash)
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy.address,
          coordinator.address,
          snapshotBlock,
          NONZERO_HASH,
          EVIDENCE_HASH
        ),
        "UnsupportedLegacyVault"
      )
    })

    it("reverts on a code-hash mismatch", async () => {
      await harness.setKnownLegacyVault(legacy.address, NONZERO_HASH)
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy.address,
          coordinator.address,
          snapshotBlock,
          NONZERO_HASH,
          EVIDENCE_HASH
        ),
        "LegacyVaultCodeHashMismatch"
      )
    })

    it("reverts when the vault is not trusted", async () => {
      // Stage the untrusted state: temporarily drop the known-legacy identity so
      // the untrust is fail-open, untrust, then restore the identity.
      await harness.setKnownLegacyVault(other.address, legacyCodeHash)
      await harness.setVaultStatus(legacy.address, false)
      await harness.setKnownLegacyVault(legacy.address, legacyCodeHash)
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy.address,
          coordinator.address,
          snapshotBlock,
          NONZERO_HASH,
          EVIDENCE_HASH
        ),
        "LegacyVaultNotTrusted"
      )
    })

    it("reverts when the vault decodably answers the optimistic-debt selector", async () => {
      // A conforming vault (implements the aggregate selector) may never use the
      // override, even when installed as the known-legacy identity.
      const conforming = await deploy("MockMigrationDebtVault")
      const conformingHash = ethers.utils.keccak256(
        await ethers.provider.getCode(conforming.address)
      )
      await harness.setKnownLegacyVault(conforming.address, conformingHash)
      await harness.setVaultStatus(conforming.address, true)
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          conforming.address,
          coordinator.address,
          snapshotBlock,
          NONZERO_HASH,
          EVIDENCE_HASH
        ),
        "LegacyVaultImplementsOptimisticMintingDebtInterface"
      )
    })

    it("reverts on zero/invalid evidence fields", async () => {
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy.address,
          coordinator.address,
          0,
          NONZERO_HASH,
          EVIDENCE_HASH
        ),
        "LegacyVaultEvidenceInvalid"
      )
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy.address,
          coordinator.address,
          snapshotBlock,
          ethers.constants.HashZero,
          EVIDENCE_HASH
        ),
        "LegacyVaultEvidenceInvalid"
      )
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy.address,
          coordinator.address,
          snapshotBlock,
          NONZERO_HASH,
          ethers.constants.HashZero
        ),
        "LegacyVaultEvidenceInvalid"
      )
    })

    it("reverts when the coordinator has the wrong controller binding", async () => {
      // The harness governance no longer matches the coordinator's controller.
      await harness.setHarnessGovernance(other.address)
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy.address,
          coordinator.address,
          snapshotBlock,
          NONZERO_HASH,
          EVIDENCE_HASH
        ),
        "LegacyVaultMigrationCoordinatorInvalid"
      )
    })

    it("reverts when the coordinator is bound to a different Bridge", async () => {
      // `bank` is a contract distinct from the harness, so the coordinator's
      // Bridge binding does not match `address(this)` during validation.
      const strayCoordinator = await deploy(
        "LegacyTBTCVaultMigrationCoordinator",
        [controller.address, legacy.address, bank.address]
      )
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy.address,
          strayCoordinator.address,
          snapshotBlock,
          NONZERO_HASH,
          EVIDENCE_HASH
        ),
        "LegacyVaultMigrationCoordinatorInvalid"
      )
    })

    it("reverts when the coordinator is not migration-locked (owner mismatch)", async () => {
      // Fresh legacy vault that is paused but still owned by the deployer, and a
      // coordinator bound to it: migrationLocked() is false.
      const legacy2 = await deploy("MockLegacyTBTCVault", [
        tbtc.address,
        bank.address,
      ])
      await legacy2.setOptimisticMintingPaused(true)
      const coordinator2 = await deploy("LegacyTBTCVaultMigrationCoordinator", [
        controller.address,
        legacy2.address,
        harness.address,
      ])
      const hash2 = ethers.utils.keccak256(
        await ethers.provider.getCode(legacy2.address)
      )
      await harness.setKnownLegacyVault(legacy2.address, hash2)
      await harness.setVaultStatus(legacy2.address, true)
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy2.address,
          coordinator2.address,
          snapshotBlock,
          NONZERO_HASH,
          EVIDENCE_HASH
        ),
        "LegacyVaultMigrationCoordinatorInvalid"
      )
    })

    it("reverts when the legacy vault is not paused", async () => {
      // A locked-but-unpaused arrangement: coordinator owns the vault, but the
      // vault is not paused, so the paused check fails.
      const legacy3 = await deploy("MockLegacyTBTCVault", [
        tbtc.address,
        bank.address,
      ])
      const coordinator3 = await deploy("LegacyTBTCVaultMigrationCoordinator", [
        controller.address,
        legacy3.address,
        harness.address,
      ])
      await legacy3.transferOwnership(coordinator3.address)
      const hash3 = ethers.utils.keccak256(
        await ethers.provider.getCode(legacy3.address)
      )
      await harness.setKnownLegacyVault(legacy3.address, hash3)
      await harness.setVaultStatus(legacy3.address, true)
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy3.address,
          coordinator3.address,
          snapshotBlock,
          NONZERO_HASH,
          EVIDENCE_HASH
        ),
        "LegacyVaultOptimisticMintingNotPaused"
      )
    })
  })

  describe("known-legacy untrust guard", () => {
    it("reverts untrusting the unattested known legacy vault", async () => {
      await expectCustomError(
        harness.setVaultStatus(legacy.address, false),
        "LegacyVaultOptimisticMintingDebtAttestationMissing"
      )
      expect(await harness.isVaultTrusted(legacy.address)).to.equal(true)
    })

    it("allows untrusting once the attestation is recorded", async () => {
      await attest()
      await expect(harness.setVaultStatus(legacy.address, false))
        .to.emit(harness, "VaultStatusUpdated")
        .withArgs(legacy.address, false)
      expect(await harness.isVaultTrusted(legacy.address)).to.equal(false)
    })
  })

  describe("known-legacy rotation guard", () => {
    beforeEach(async () => {
      // Stage the known legacy vault as the canonical migration-debt vault so
      // the rotation guard runs against it, and trust a conforming successor.
      await harness.forceSetMigrationDebtVault(legacy.address)
    })

    it("reverts rotating away from the unattested known legacy vault", async () => {
      const conforming = await deploy("MockMigrationDebtVault")
      await harness.setVaultStatus(conforming.address, true)
      await expectCustomError(
        harness.rotateMigrationDebtVault(conforming.address, legacy.address),
        "LegacyVaultOptimisticMintingDebtAttestationMissing"
      )
    })

    it("allows rotation once the attestation is recorded", async () => {
      await attest()
      const conforming = await deploy("MockMigrationDebtVault")
      await harness.setVaultStatus(conforming.address, true)
      await expect(
        harness.rotateMigrationDebtVault(conforming.address, legacy.address)
      )
        .to.emit(harness, "VaultStatusUpdated")
        .withArgs(legacy.address, false)
      expect(await harness.isVaultTrusted(legacy.address)).to.equal(false)
    })
  })

  describe("retirement is irreversible", () => {
    it("reverts re-trusting an attested-and-untrusted legacy vault", async () => {
      await attest()
      await harness.setVaultStatus(legacy.address, false)
      await expectCustomError(
        harness.setVaultStatus(legacy.address, true),
        "LegacyVaultAlreadyRetired"
      )
    })

    it("revocation works only while the legacy vault is trusted", async () => {
      await attest()
      // Revoke while trusted: succeeds and clears the mapping.
      await harness.setLegacyVaultOptimisticMintingDebtAttestation(
        legacy.address,
        ethers.constants.AddressZero,
        0,
        ethers.constants.HashZero,
        ethers.constants.HashZero
      )
      expect(
        await harness.legacyVaultOptimisticMintingDebtCoordinator(
          legacy.address
        )
      ).to.equal(ethers.constants.AddressZero)

      // Re-attest, untrust, then revocation must revert.
      await attest()
      await harness.setVaultStatus(legacy.address, false)
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy.address,
          ethers.constants.AddressZero,
          0,
          ethers.constants.HashZero,
          ethers.constants.HashZero
        ),
        "LegacyVaultAttestationCannotBeRevoked"
      )
    })

    it("revocation rejects nonzero evidence arguments", async () => {
      await attest()
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          legacy.address,
          ethers.constants.AddressZero,
          snapshotBlock,
          ethers.constants.HashZero,
          ethers.constants.HashZero
        ),
        "LegacyVaultEvidenceInvalid"
      )
    })
  })

  describe("backward compatibility", () => {
    it("untrusts a pre-interface non-conforming vault without any attestation (fail-open)", async () => {
      const nonConforming = await deploy("MockTrustedNonConformingVault")
      await harness.setVaultStatus(nonConforming.address, true)
      await expect(harness.setVaultStatus(nonConforming.address, false))
        .to.emit(harness, "VaultStatusUpdated")
        .withArgs(nonConforming.address, false)
      expect(await harness.isVaultTrusted(nonConforming.address)).to.equal(
        false
      )
    })

    it("untrusts a reverting non-legacy vault without any attestation (fail-open)", async () => {
      const reverting = await deploy("MockRevertingMigrationDebtVault")
      await reverting.setReverting(true)
      await harness.setVaultStatus(reverting.address, true)
      await expect(harness.setVaultStatus(reverting.address, false))
        .to.emit(harness, "VaultStatusUpdated")
        .withArgs(reverting.address, false)
    })

    it("still blocks untrusting a conforming vault reporting true, regardless of identity", async () => {
      const conforming = await deploy("MockMigrationDebtVault")
      await conforming.setHasOutstandingOptimisticMintingDebt(true)
      await harness.setVaultStatus(conforming.address, true)
      // Even if this address is treated as the known legacy identity, a decodable
      // `true` is authoritative and blocks the untrust.
      const conformingHash = ethers.utils.keccak256(
        await ethers.provider.getCode(conforming.address)
      )
      await harness.setKnownLegacyVault(conforming.address, conformingHash)
      await expectCustomError(
        harness.setVaultStatus(conforming.address, false),
        "VaultHasOutstandingOptimisticMintingDebt"
      )
    })
  })

  // Proves the NEW VaultManagement fail-closed helpers (`_staticcallAddress`,
  // `_staticcallBool`) validate an EXACT 32-byte return. Before the fix they
  // accepted `returndatasize >= 32`, so a malformed 64-byte `[value, junk]`
  // response was decoded as valid — defeating the fail-closed known-legacy
  // classification and letting the attestation setter accept a malformed
  // coordinator. The pre-existing fail-OPEN migration-debt helper is unchanged.
  describe("fail-closed exact-32-byte staticcalls (VaultManagement)", () => {
    const iface = new ethers.utils.Interface([
      "function hasOutstandingOptimisticMintingDebt() view returns (bool)",
      "function isOptimisticMintingPaused() view returns (bool)",
      "function owner() view returns (address)",
      "function legacyVault() view returns (address)",
      "function bridge() view returns (address)",
      "function controller() view returns (address)",
      "function migrationLocked() view returns (bool)",
    ])
    const OM_DEBT = iface.getSighash("hasOutstandingOptimisticMintingDebt")
    const PAUSED = iface.getSighash("isOptimisticMintingPaused")
    const OWNER = iface.getSighash("owner")
    const LEGACY_VAULT = iface.getSighash("legacyVault")
    const BRIDGE = iface.getSighash("bridge")
    const CONTROLLER = iface.getSighash("controller")
    const MIGRATION_LOCKED = iface.getSighash("migrationLocked")
    const abi = ethers.utils.defaultAbiCoder
    const pad = (a: string) => ethers.utils.hexZeroPad(a, 32)
    const oversized = (word: number) =>
      abi.encode(["uint256", "uint256"], [word, "0xdead"])

    async function codeHash(contract: Contract): Promise<string> {
      return ethers.utils.keccak256(
        await ethers.provider.getCode(contract.address)
      )
    }

    // Installs a raw-returning mock as the known-legacy identity and trusts it.
    async function installKnownLegacyRaw(): Promise<Contract> {
      const raw = await deploy("MockRawReturner")
      await harness.setKnownLegacyVault(raw.address, await codeHash(raw))
      await harness.setVaultStatus(raw.address, true)
      return raw
    }

    describe("known-legacy optimistic-debt probe (_staticcallBool)", () => {
      let raw: Contract
      beforeEach(async () => {
        raw = await installKnownLegacyRaw()
      })

      // Every malformed shape must be UNDECODABLE, so the known legacy falls to
      // the fail-closed branch and reverts without an attestation.
      const malformed: Array<[string, () => Promise<unknown>]> = [
        [
          "64-byte [false, junk]",
          () => raw.setRawResponse(OM_DEBT, oversized(0)),
        ],
        [
          "64-byte [true, junk]",
          () => raw.setRawResponse(OM_DEBT, oversized(1)),
        ],
        ["31 bytes", () => raw.setRawResponse(OM_DEBT, `0x${"00".repeat(31)}`)],
        ["33 bytes", () => raw.setRawResponse(OM_DEBT, `0x${"00".repeat(33)}`)],
        ["empty return", () => raw.setRawResponse(OM_DEBT, "0x")],
        ["reverting", () => raw.setSelectorReverts(OM_DEBT)],
        [
          "non-boolean word",
          () => raw.setRawResponse(OM_DEBT, abi.encode(["uint256"], [2])),
        ],
      ]

      malformed.forEach(([label, configure]) => {
        it(`${label} is fail-closed (untrust reverts without an attestation)`, async () => {
          await configure()
          await expectCustomError(
            harness.setVaultStatus(raw.address, false),
            "LegacyVaultOptimisticMintingDebtAttestationMissing"
          )
          expect(await harness.isVaultTrusted(raw.address)).to.equal(true)
        })
      })

      it("clean 32-byte false still untrusts without attestation (no over-block)", async () => {
        await raw.setRawResponse(OM_DEBT, abi.encode(["bool"], [false]))
        await expect(harness.setVaultStatus(raw.address, false))
          .to.emit(harness, "VaultStatusUpdated")
          .withArgs(raw.address, false)
      })

      it("clean 32-byte true blocks with the optimistic-debt error", async () => {
        await raw.setRawResponse(OM_DEBT, abi.encode(["bool"], [true]))
        await expectCustomError(
          harness.setVaultStatus(raw.address, false),
          "VaultHasOutstandingOptimisticMintingDebt"
        )
      })
    })

    it("non-legacy 64-byte [true, junk] falls open (untrust allowed), preserving pre-interface compatibility", async () => {
      // Not installed as the known legacy identity, so a malformed oversized
      // response must NOT be treated as an authoritative `true`.
      const raw = await deploy("MockRawReturner")
      await raw.setRawResponse(OM_DEBT, oversized(1))
      await harness.setVaultStatus(raw.address, true)
      await expect(harness.setVaultStatus(raw.address, false))
        .to.emit(harness, "VaultStatusUpdated")
        .withArgs(raw.address, false)
    })

    it("attestation setter fails closed when isOptimisticMintingPaused returns 64-byte [true, junk]", async () => {
      const raw = await installKnownLegacyRaw()
      // Undecodable optimistic-debt selector so the conforming check passes.
      await raw.setSelectorReverts(OM_DEBT)
      // Oversized paused read => fail-closed => treated as not paused.
      await raw.setRawResponse(PAUSED, oversized(1))
      await expectCustomError(
        harness.setLegacyVaultOptimisticMintingDebtAttestation(
          raw.address,
          coordinator.address,
          snapshotBlock,
          NONZERO_HASH,
          EVIDENCE_HASH
        ),
        "LegacyVaultOptimisticMintingNotPaused"
      )
    })

    // The attestation setter's coordinator-binding validation reads through both
    // `_staticcallAddress` (owner/legacyVault/bridge/controller) and
    // `_staticcallBool` (migrationLocked). A malformed coordinator must be
    // rejected with LegacyVaultMigrationCoordinatorInvalid.
    describe("attestation setter rejects a malformed coordinator (_coordinatorBound)", () => {
      let rawLegacy: Contract
      let rawCoordinator: Contract

      beforeEach(async () => {
        rawLegacy = await deploy("MockRawReturner")
        rawCoordinator = await deploy("MockRawReturner")
        await harness.setKnownLegacyVault(
          rawLegacy.address,
          await codeHash(rawLegacy)
        )
        await harness.setVaultStatus(rawLegacy.address, true)
        // Legacy passes every check up to coordinator binding: undecodable debt
        // selector, clean paused, owned by the coordinator.
        await rawLegacy.setSelectorReverts(OM_DEBT)
        await rawLegacy.setRawResponse(PAUSED, abi.encode(["bool"], [true]))
        await rawLegacy.setRawResponse(OWNER, pad(rawCoordinator.address))
        // Clean, correct bindings; individual tests corrupt exactly one.
        await rawCoordinator.setRawResponse(
          LEGACY_VAULT,
          pad(rawLegacy.address)
        )
        await rawCoordinator.setRawResponse(BRIDGE, pad(harness.address))
        await rawCoordinator.setRawResponse(CONTROLLER, pad(controller.address))
        await rawCoordinator.setRawResponse(
          MIGRATION_LOCKED,
          abi.encode(["bool"], [true])
        )
      })

      async function expectInvalid(): Promise<void> {
        await expectCustomError(
          harness.setLegacyVaultOptimisticMintingDebtAttestation(
            rawLegacy.address,
            rawCoordinator.address,
            snapshotBlock,
            NONZERO_HASH,
            EVIDENCE_HASH
          ),
          "LegacyVaultMigrationCoordinatorInvalid"
        )
      }

      it("accepts the clean baseline (control)", async () => {
        await expect(
          harness.setLegacyVaultOptimisticMintingDebtAttestation(
            rawLegacy.address,
            rawCoordinator.address,
            snapshotBlock,
            NONZERO_HASH,
            EVIDENCE_HASH
          )
        ).to.emit(harness, "LegacyVaultOptimisticMintingDebtAttestationUpdated")
      })

      it("legacyVault() returns 64-byte [correct address, junk]", async () => {
        await rawCoordinator.setRawResponse(
          LEGACY_VAULT,
          abi.encode(["address", "uint256"], [rawLegacy.address, "0xdead"])
        )
        await expectInvalid()
      })

      it("controller() has dirty high bits (not a clean address)", async () => {
        await rawCoordinator.setRawResponse(
          CONTROLLER,
          `0xff${pad(controller.address).slice(4)}`
        )
        await expectInvalid()
      })

      it("bridge() returns 31 bytes", async () => {
        await rawCoordinator.setRawResponse(BRIDGE, `0x${"00".repeat(31)}`)
        await expectInvalid()
      })

      it("migrationLocked() returns 64-byte [true, junk]", async () => {
        await rawCoordinator.setRawResponse(MIGRATION_LOCKED, oversized(1))
        await expectInvalid()
      })

      it("migrationLocked() returns a non-boolean word", async () => {
        await rawCoordinator.setRawResponse(
          MIGRATION_LOCKED,
          abi.encode(["uint256"], [2])
        )
        await expectInvalid()
      })
    })
  })

  // FIX 4: the vault-management / legacy-retirement custom errors were moved into
  // the VaultManagement library, dropping them from the Bridge ABI even though
  // Bridge still reverts with their selectors. They are now redeclared on Bridge.
  describe("Bridge custom-error ABI", () => {
    const RETIREMENT_ERRORS = [
      "VaultIsCanonicalMigrationDebtVault",
      "VaultHasOutstandingMigrationDebt",
      "VaultHasOutstandingOptimisticMintingDebt",
      "VaultNotTrusted",
      "PreviousMigrationDebtVaultIsZero",
      "PreviousMigrationDebtVaultMismatch",
      "MigrationDebtVaultUnchanged",
      "MigrationDebtVaultInterfaceMissing",
      "MigrationDebtVaultUnreachable",
      "PreviousMigrationDebtVaultHasDebt",
      "PreviousMigrationDebtVaultHasOptimisticDebt",
      "UnsupportedLegacyVault",
      "LegacyVaultCodeHashMismatch",
      "LegacyVaultOptimisticMintingDebtAttestationMissing",
      "LegacyVaultOptimisticMintingNotPaused",
      "LegacyVaultMigrationCoordinatorInvalid",
      "LegacyVaultEvidenceInvalid",
      "LegacyVaultAttestationCannotBeRevoked",
      "LegacyVaultAlreadyRetired",
      "LegacyVaultImplementsOptimisticMintingDebtInterface",
      "LegacyVaultNotTrusted",
    ]

    it("declares every vault-management and legacy-retirement error", async () => {
      const artifact = await hre.artifacts.readArtifact("Bridge")
      const bridgeIface = new ethers.utils.Interface(artifact.abi)
      RETIREMENT_ERRORS.forEach((name) => {
        expect(() => bridgeIface.getError(name), name).to.not.throw()
      })
    })

    it("decodes a library-thrown revert against the Bridge ABI (matching selector)", async () => {
      // The harness untrust reverts inside the VaultManagement library; its raw
      // selector must decode against the Bridge ABI, proving the redeclared
      // error carries the identical selector.
      const artifact = await hre.artifacts.readArtifact("Bridge")
      const bridgeIface = new ethers.utils.Interface(artifact.abi)
      let reverted = false
      try {
        await harness.setVaultStatus(legacy.address, false)
      } catch (error) {
        reverted = true
        const match = collectRevertData(error).find((data) => {
          try {
            bridgeIface.decodeErrorResult(
              "LegacyVaultOptimisticMintingDebtAttestationMissing",
              data
            )
            return true
          } catch {
            return false
          }
        })
        expect(match, "decodable via the Bridge ABI").to.not.equal(undefined)
      }
      expect(reverted).to.equal(true)
    })
  })
})
