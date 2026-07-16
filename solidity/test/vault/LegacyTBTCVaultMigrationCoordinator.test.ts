import { expect } from "chai"
import { ethers, helpers } from "hardhat"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type { Contract } from "ethers"

const { increaseTime } = helpers.time

const DELAY = 24 * 60 * 60
const BANK_BALANCE = 1_000_000

describe("LegacyTBTCVaultMigrationCoordinator", () => {
  let deployer: SignerWithAddress
  let council: SignerWithAddress
  let other: SignerWithAddress

  let tbtc: Contract
  let bank: Contract
  let legacy: Contract
  let successor: Contract
  let controller: Contract
  let bridge: Contract
  let coordinator: Contract

  async function deploy(name: string, args: unknown[] = []): Promise<Contract> {
    const factory = await ethers.getContractFactory(name)
    const contract = await factory.deploy(...args)
    await contract.deployed()
    return contract
  }

  // Builds a legacy vault + successor + controller + bridge + coordinator, but
  // leaves the "locked" transition (pause + ownership transfer to coordinator)
  // to the caller so individual failure modes can be exercised.
  async function deployStack(): Promise<void> {
    tbtc = await deploy("MockOwnableToken")
    bank = await deploy("MockRetirementBank")
    legacy = await deploy("MockLegacyTBTCVault", [tbtc.address, bank.address])
    // The legacy vault owns the TBTC token and holds a Bank balance.
    await tbtc.transferOwnership(legacy.address)
    await bank.setBalance(legacy.address, BANK_BALANCE)

    successor = await deploy("MockOwnableToken")
    await successor.transferOwnership(council.address)

    controller = await deploy("MockCoordinatorController", [council.address])
    bridge = await deploy("MockRetirementBridge")

    coordinator = await deploy("LegacyTBTCVaultMigrationCoordinator", [
      controller.address,
      legacy.address,
      bridge.address,
    ])
  }

  // Pauses optimistic minting and hands the legacy vault to the coordinator,
  // producing `migrationLocked() == true`.
  async function lock(): Promise<void> {
    await legacy.setOptimisticMintingPaused(true)
    await legacy.transferOwnership(coordinator.address)
  }

  // Advances the legacy delay and stages the Bridge retirement state the
  // coordinator requires before finalization.
  async function stageBridgeRetirement(): Promise<void> {
    await increaseTime(DELAY)
    await bridge.setVaultTrusted(legacy.address, false)
    await bridge.setCoordinator(legacy.address, coordinator.address)
  }

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[deployer, council, other] = await ethers.getSigners()
    await deployStack()
  })

  describe("constructor", () => {
    it("stores the immutable bindings", async () => {
      expect(await coordinator.controller()).to.equal(controller.address)
      expect(await coordinator.legacyVault()).to.equal(legacy.address)
      expect(await coordinator.bridge()).to.equal(bridge.address)
      expect(await coordinator.finalized()).to.equal(false)
    })

    it("reverts when any binding is not a contract", async () => {
      const factory = await ethers.getContractFactory(
        "LegacyTBTCVaultMigrationCoordinator"
      )
      await expect(
        factory.deploy(other.address, legacy.address, bridge.address)
      ).to.be.revertedWith("Controller must be a contract")
      await expect(
        factory.deploy(controller.address, other.address, bridge.address)
      ).to.be.revertedWith("Legacy vault must be a contract")
      await expect(
        factory.deploy(controller.address, legacy.address, other.address)
      ).to.be.revertedWith("Bridge must be a contract")
    })
  })

  describe("migrationLocked", () => {
    it("is false before ownership transfer", async () => {
      await legacy.setOptimisticMintingPaused(true)
      expect(await coordinator.migrationLocked()).to.equal(false)
    })

    it("is false when the legacy vault is not paused", async () => {
      await legacy.transferOwnership(coordinator.address)
      expect(await coordinator.migrationLocked()).to.equal(false)
    })

    it("is true only when owned-by-coordinator and paused", async () => {
      await lock()
      expect(await coordinator.migrationLocked()).to.equal(true)
    })
  })

  describe("happy path", () => {
    it("locks, initiates to a Council-owned successor, and finalizes after 24h", async () => {
      await lock()

      await expect(
        controller.initiateUpgrade(coordinator.address, successor.address)
      )
        .to.emit(coordinator, "LegacyVaultUpgradeInitiated")
        .withArgs(legacy.address, successor.address)

      expect(await coordinator.successorVault()).to.equal(successor.address)
      expect(await legacy.newVault()).to.equal(successor.address)

      await stageBridgeRetirement()

      await expect(controller.finalizeUpgrade(coordinator.address))
        .to.emit(coordinator, "LegacyVaultUpgradeFinalized")
        .withArgs(legacy.address, successor.address)

      expect(await coordinator.finalized()).to.equal(true)
      expect(await tbtc.owner()).to.equal(successor.address)
      expect(await bank.balanceOf(successor.address)).to.equal(BANK_BALANCE)
      expect(await bank.balanceOf(legacy.address)).to.equal(0)
      expect(await legacy.newVault()).to.equal(ethers.constants.AddressZero)
    })
  })

  describe("access control", () => {
    beforeEach(async () => {
      await lock()
    })

    it("only the controller may initiate", async () => {
      await expect(
        coordinator.connect(other).initiateUpgrade(successor.address)
      ).to.be.revertedWith("Caller is not the controller")
    })

    it("only the controller may finalize", async () => {
      await controller.initiateUpgrade(coordinator.address, successor.address)
      await stageBridgeRetirement()
      await expect(
        coordinator.connect(other).finalizeUpgrade()
      ).to.be.revertedWith("Caller is not the controller")
    })

    it("the Council cannot call legacy initiateUpgrade/finalizeUpgrade directly after transfer", async () => {
      await expect(
        legacy.connect(council).initiateUpgrade(successor.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
      await expect(
        legacy.connect(council).finalizeUpgrade()
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })
  })

  describe("initiateUpgrade validation", () => {
    it("reverts when the legacy vault is unpaused", async () => {
      // Owned by coordinator but never paused.
      await legacy.transferOwnership(coordinator.address)
      await expect(
        controller.initiateUpgrade(coordinator.address, successor.address)
      ).to.be.revertedWith("Legacy vault not locked to coordinator")
    })

    it("reverts when the coordinator is not the legacy owner", async () => {
      // Paused but ownership not transferred.
      await legacy.setOptimisticMintingPaused(true)
      await expect(
        controller.initiateUpgrade(coordinator.address, successor.address)
      ).to.be.revertedWith("Legacy vault not locked to coordinator")
    })

    it("reverts when the successor is zero, the legacy vault, or has no code", async () => {
      await lock()
      await expect(
        controller.initiateUpgrade(
          coordinator.address,
          ethers.constants.AddressZero
        )
      ).to.be.revertedWith("Successor vault cannot be zero")
      await expect(
        controller.initiateUpgrade(coordinator.address, legacy.address)
      ).to.be.revertedWith("Successor must differ from the legacy vault")
      await expect(
        controller.initiateUpgrade(coordinator.address, other.address)
      ).to.be.revertedWith("Successor must be a contract")
    })

    it("reverts when the successor is not owned by the controller owner", async () => {
      await lock()
      const strayVault = await deploy("MockOwnableToken")
      await strayVault.transferOwnership(other.address)
      await expect(
        controller.initiateUpgrade(coordinator.address, strayVault.address)
      ).to.be.revertedWith("Successor must be owned by the controller owner")
    })

    it("can re-initiate to a different valid successor, resetting delay and preserving the pause lock", async () => {
      await lock()
      await controller.initiateUpgrade(coordinator.address, successor.address)

      const successor2 = await deploy("MockOwnableToken")
      await successor2.transferOwnership(council.address)

      await controller.initiateUpgrade(coordinator.address, successor2.address)
      expect(await coordinator.successorVault()).to.equal(successor2.address)
      expect(await legacy.newVault()).to.equal(successor2.address)
      // Pause lock preserved throughout.
      expect(await coordinator.migrationLocked()).to.equal(true)
    })
  })

  describe("finalizeUpgrade validation", () => {
    beforeEach(async () => {
      await lock()
      await controller.initiateUpgrade(coordinator.address, successor.address)
    })

    it("reverts before the legacy delay elapses", async () => {
      await bridge.setVaultTrusted(legacy.address, false)
      await bridge.setCoordinator(legacy.address, coordinator.address)
      await expect(
        controller.finalizeUpgrade(coordinator.address)
      ).to.be.revertedWith("Governance delay has not elapsed")
    })

    it("reverts while the legacy vault is still trusted", async () => {
      await increaseTime(DELAY)
      await bridge.setVaultTrusted(legacy.address, true)
      await bridge.setCoordinator(legacy.address, coordinator.address)
      await expect(
        controller.finalizeUpgrade(coordinator.address)
      ).to.be.revertedWith("Legacy vault must be untrusted before finalization")
    })

    it("reverts without the matching Bridge attestation", async () => {
      await increaseTime(DELAY)
      await bridge.setVaultTrusted(legacy.address, false)
      await bridge.setCoordinator(legacy.address, other.address)
      await expect(
        controller.finalizeUpgrade(coordinator.address)
      ).to.be.revertedWith("Bridge attestation must bind this coordinator")
    })

    it("reverts after the successor ownership changes", async () => {
      await increaseTime(DELAY)
      await bridge.setVaultTrusted(legacy.address, false)
      await bridge.setCoordinator(legacy.address, coordinator.address)
      await successor.connect(council).transferOwnership(other.address)
      await expect(
        controller.finalizeUpgrade(coordinator.address)
      ).to.be.revertedWith("Successor must be owned by the controller owner")
    })

    it("latches: cannot finalize twice", async () => {
      await stageBridgeRetirement()
      await controller.finalizeUpgrade(coordinator.address)
      await expect(
        controller.finalizeUpgrade(coordinator.address)
      ).to.be.revertedWith("Migration already finalized")
    })
  })

  describe("no escape-hatch surface", () => {
    it("exposes no unpause, ownership-return, or arbitrary-call selector", () => {
      const names = Object.values(coordinator.interface.functions).map(
        (f) => f.name
      )
      const forbidden = [
        "unpauseOptimisticMinting",
        "pauseOptimisticMinting",
        "transferOwnership",
        "renounceOwnership",
        "execute",
        "call",
        "delegatecall",
        "setController",
      ]
      forbidden.forEach((name) => {
        expect(names, `must not expose ${name}`).to.not.include(name)
      })
      // Only these two mutating functions exist.
      expect(names).to.include("initiateUpgrade")
      expect(names).to.include("finalizeUpgrade")
    })
  })

  // Proves the coordinator's fail-closed staticcall helpers reject malformed
  // legacy `owner()` / `isOptimisticMintingPaused()` responses with EXACT 32-byte
  // validation. Before the fix these helpers accepted `returndatasize >= 32`, so
  // a 64-byte `[value, junk]` response was decoded as valid and `migrationLocked`
  // could return true on malformed data.
  describe("migrationLocked fail-closed on malformed legacy reads", () => {
    const legacyIface = new ethers.utils.Interface([
      "function owner() view returns (address)",
      "function isOptimisticMintingPaused() view returns (bool)",
    ])
    const OWNER = legacyIface.getSighash("owner")
    const PAUSED = legacyIface.getSighash("isOptimisticMintingPaused")
    const abi = ethers.utils.defaultAbiCoder

    let rawLegacy: Contract
    let rawCoordinator: Contract

    beforeEach(async () => {
      rawLegacy = await deploy("MockRawReturner")
      rawCoordinator = await deploy("LegacyTBTCVaultMigrationCoordinator", [
        controller.address,
        rawLegacy.address,
        bridge.address,
      ])
    })

    // Clean, well-formed locked state: owner() == coordinator and paused == true.
    async function setCleanLocked(): Promise<void> {
      await rawLegacy.setRawResponse(
        OWNER,
        ethers.utils.hexZeroPad(rawCoordinator.address, 32)
      )
      await rawLegacy.setRawResponse(PAUSED, abi.encode(["bool"], [true]))
    }

    // 32-byte word carrying the coordinator address in its low 160 bits but with
    // dirty (nonzero) high bits, which the address helper must reject.
    const dirtyOwnerWord = (): string =>
      `0xff${ethers.utils.hexZeroPad(rawCoordinator.address, 32).slice(4)}`

    it("is true on clean 32-byte owner and paused reads (positive control)", async () => {
      await setCleanLocked()
      expect(await rawCoordinator.migrationLocked()).to.equal(true)
    })

    it("is false when owner() returns 64-byte [coordinator, junk]", async () => {
      await setCleanLocked()
      await rawLegacy.setRawResponse(
        OWNER,
        abi.encode(["address", "uint256"], [rawCoordinator.address, "0xdead"])
      )
      expect(await rawCoordinator.migrationLocked()).to.equal(false)
    })

    it("is false when owner() returns 33 bytes (correct first word)", async () => {
      await setCleanLocked()
      await rawLegacy.setRawResponse(
        OWNER,
        ethers.utils.hexConcat([
          ethers.utils.hexZeroPad(rawCoordinator.address, 32),
          "0xff",
        ])
      )
      expect(await rawCoordinator.migrationLocked()).to.equal(false)
    })

    it("is false when owner() returns 31 bytes", async () => {
      await setCleanLocked()
      await rawLegacy.setRawResponse(OWNER, `0x${"00".repeat(31)}`)
      expect(await rawCoordinator.migrationLocked()).to.equal(false)
    })

    it("is false when owner() returns empty data", async () => {
      await setCleanLocked()
      await rawLegacy.setRawResponse(OWNER, "0x")
      expect(await rawCoordinator.migrationLocked()).to.equal(false)
    })

    it("is false when owner() reverts", async () => {
      await setCleanLocked()
      await rawLegacy.setSelectorReverts(OWNER)
      expect(await rawCoordinator.migrationLocked()).to.equal(false)
    })

    it("is false when owner() has dirty high bits (not a clean address)", async () => {
      await setCleanLocked()
      await rawLegacy.setRawResponse(OWNER, dirtyOwnerWord())
      expect(await rawCoordinator.migrationLocked()).to.equal(false)
    })

    it("is false when isOptimisticMintingPaused() returns 64-byte [true, junk]", async () => {
      await setCleanLocked()
      await rawLegacy.setRawResponse(
        PAUSED,
        abi.encode(["uint256", "uint256"], [1, "0xdead"])
      )
      expect(await rawCoordinator.migrationLocked()).to.equal(false)
    })

    it("is false when isOptimisticMintingPaused() returns a non-boolean word", async () => {
      await setCleanLocked()
      await rawLegacy.setRawResponse(PAUSED, abi.encode(["uint256"], [2]))
      expect(await rawCoordinator.migrationLocked()).to.equal(false)
    })

    it("is false when isOptimisticMintingPaused() returns 31 bytes", async () => {
      await setCleanLocked()
      await rawLegacy.setRawResponse(PAUSED, `0x${"00".repeat(31)}`)
      expect(await rawCoordinator.migrationLocked()).to.equal(false)
    })

    it("is false when isOptimisticMintingPaused() reverts", async () => {
      await setCleanLocked()
      await rawLegacy.setSelectorReverts(PAUSED)
      expect(await rawCoordinator.migrationLocked()).to.equal(false)
    })
  })
})
