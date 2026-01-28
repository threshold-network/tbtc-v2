import { expect } from "chai"
import hre, { ethers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  MintBurnGuard,
  MockBridgeMintingAuthorization,
  MockBurnBank,
  MockBurnVault,
} from "../../typechain"
import {
  validateAddress,
  addressesMatch,
  AlignmentCheck,
  verifyAlignmentChecks,
  verifyMintBurnGuardAlignment,
} from "../../scripts/lib/verification"

describe("MintBurnGuard Verification Library", () => {
  describe("validateAddress", () => {
    it("should validate a correct address", () => {
      expect(() =>
        validateAddress(
          "0x1234567890123456789012345678901234567890",
          "TestAddress"
        )
      ).not.to.throw()
    })

    it("should reject zero address", () => {
      expect(() =>
        validateAddress(
          "0x0000000000000000000000000000000000000000",
          "TestAddress"
        )
      ).to.throw("TestAddress cannot be zero address")
    })

    it("should reject invalid address", () => {
      expect(() => validateAddress("invalid-address", "TestAddress")).to.throw(
        "TestAddress is not a valid Ethereum address"
      )
    })
  })

  describe("addressesMatch", () => {
    it("should return true for matching addresses (same case)", () => {
      expect(
        addressesMatch(
          "0x1234567890123456789012345678901234567890",
          "0x1234567890123456789012345678901234567890"
        )
      ).to.be.true
    })

    it("should return true for matching addresses (different case)", () => {
      expect(
        addressesMatch(
          "0x1234567890123456789012345678901234567890",
          "0x1234567890123456789012345678901234567890".toUpperCase()
        )
      ).to.be.true
    })

    it("should return false for different addresses", () => {
      expect(
        addressesMatch(
          "0x1234567890123456789012345678901234567890",
          "0x0987654321098765432109876543210987654321"
        )
      ).to.be.false
    })
  })

  describe("verifyAlignmentChecks", () => {
    it("should return true when all checks pass", () => {
      const checks: AlignmentCheck[] = [
        {
          name: "Check 1",
          expected: "0x1234",
          actual: "0x1234",
          passed: true,
          critical: true,
        },
        {
          name: "Check 2",
          expected: "0x5678",
          actual: "0x5678",
          passed: true,
          critical: true,
        },
      ]
      expect(verifyAlignmentChecks(checks)).to.be.true
    })

    it("should return false when any check fails", () => {
      const checks: AlignmentCheck[] = [
        {
          name: "Check 1",
          expected: "0x1234",
          actual: "0x1234",
          passed: true,
          critical: true,
        },
        {
          name: "Check 2",
          expected: "0x5678",
          actual: "0xabcd",
          passed: false,
          critical: true,
        },
      ]
      expect(verifyAlignmentChecks(checks)).to.be.false
    })

    it("should return false when critical check fails", () => {
      const checks: AlignmentCheck[] = [
        {
          name: "Critical Check",
          expected: "0x1234",
          actual: "0xabcd",
          passed: false,
          critical: true,
        },
      ]
      expect(verifyAlignmentChecks(checks)).to.be.false
    })
  })
})

describe("MintBurnGuard Deployment Verification", () => {
  let owner: SignerWithAddress
  let controller: SignerWithAddress
  let mintBurnGuard: MintBurnGuard
  let mockBridge: MockBridgeMintingAuthorization
  let mockBank: MockBurnBank
  let mockVault: MockBurnVault

  beforeEach(async () => {
    const [ownerSigner, controllerSigner] = await ethers.getSigners()
    owner = ownerSigner
    controller = controllerSigner

    // Deploy mock contracts
    const MockBridgeFactory = await ethers.getContractFactory(
      "MockBridgeMintingAuthorization"
    )
    mockBridge = await MockBridgeFactory.deploy(owner.address)

    const MintBurnGuardFactory = await ethers.getContractFactory(
      "MintBurnGuard"
    )
    mintBurnGuard = await MintBurnGuardFactory.deploy(
      owner.address,
      controller.address,
      0,
      ethers.utils.parseEther("1000")
    )

    const MockBankFactory = await ethers.getContractFactory("MockBurnBank")
    mockBank = await MockBankFactory.deploy()

    const MockVaultFactory = await ethers.getContractFactory("MockBurnVault")
    mockVault = await MockVaultFactory.deploy()

    // Wire up MintBurnGuard
    await mintBurnGuard.connect(owner).setBridge(mockBridge.address)
    await mintBurnGuard.connect(owner).setBank(mockBank.address)
    await mintBurnGuard.connect(owner).setVault(mockVault.address)
  })

  context("When all contracts are properly aligned", () => {
    it("should pass deployment verification", async () => {
      // Authorize MintBurnGuard in Bridge
      await mockBridge
        .connect(owner)
        .setControllerBalanceIncreaser(mintBurnGuard.address)

      // Set environment variables for verification
      const originalBridge = process.env.BRIDGE_ADDRESS
      const originalController = process.env.MINT_BURN_GUARD_CONTROLLER
      const originalBank = process.env.BANK_ADDRESS
      const originalVault = process.env.TBTC_VAULT_ADDRESS

      process.env.BRIDGE_ADDRESS = mockBridge.address
      process.env.MINT_BURN_GUARD_CONTROLLER = controller.address
      process.env.BANK_ADDRESS = mockBank.address
      process.env.TBTC_VAULT_ADDRESS = mockVault.address

      try {
        // Verify alignment - should not throw
        let threwError = false
        try {
          await verifyMintBurnGuardAlignment({
            mintBurnGuardAddress: mintBurnGuard.address,
            hre,
          })
        } catch (e) {
          threwError = true
        }
        expect(threwError).to.be.false
      } finally {
        // Restore environment variables
        if (originalBridge) process.env.BRIDGE_ADDRESS = originalBridge
        else delete process.env.BRIDGE_ADDRESS
        if (originalController)
          process.env.MINT_BURN_GUARD_CONTROLLER = originalController
        else delete process.env.MINT_BURN_GUARD_CONTROLLER
        if (originalBank) process.env.BANK_ADDRESS = originalBank
        else delete process.env.BANK_ADDRESS
        if (originalVault) process.env.TBTC_VAULT_ADDRESS = originalVault
        else delete process.env.TBTC_VAULT_ADDRESS
      }
    })
  })

  context("When Bridge.controllerBalanceIncreaser is misconfigured", () => {
    it("should fail deployment verification with clear error", async () => {
      // DO NOT authorize MintBurnGuard in Bridge (simulates misconfiguration)

      // Set environment variables for verification
      const originalBridge = process.env.BRIDGE_ADDRESS
      const originalController = process.env.MINT_BURN_GUARD_CONTROLLER
      const originalBank = process.env.BANK_ADDRESS
      const originalVault = process.env.TBTC_VAULT_ADDRESS

      process.env.BRIDGE_ADDRESS = mockBridge.address
      process.env.MINT_BURN_GUARD_CONTROLLER = controller.address
      process.env.BANK_ADDRESS = mockBank.address
      process.env.TBTC_VAULT_ADDRESS = mockVault.address

      try {
        // Verify alignment should fail
        let threwError = false
        let errorMessage = ""
        try {
          await verifyMintBurnGuardAlignment({
            mintBurnGuardAddress: mintBurnGuard.address,
            hre,
          })
        } catch (e: unknown) {
          threwError = true
          errorMessage = e instanceof Error ? e.message : String(e)
        }
        expect(threwError).to.be.true
        expect(errorMessage).to.include("Configuration drift detected")
      } finally {
        // Restore environment variables
        if (originalBridge) process.env.BRIDGE_ADDRESS = originalBridge
        else delete process.env.BRIDGE_ADDRESS
        if (originalController)
          process.env.MINT_BURN_GUARD_CONTROLLER = originalController
        else delete process.env.MINT_BURN_GUARD_CONTROLLER
        if (originalBank) process.env.BANK_ADDRESS = originalBank
        else delete process.env.BANK_ADDRESS
        if (originalVault) process.env.TBTC_VAULT_ADDRESS = originalVault
        else delete process.env.TBTC_VAULT_ADDRESS
      }
    })
  })

  context("With SKIP_DEPLOYMENT_VERIFICATION environment variable", () => {
    it("should skip verification when flag is set", async () => {
      const originalSkip = process.env.SKIP_DEPLOYMENT_VERIFICATION
      process.env.SKIP_DEPLOYMENT_VERIFICATION = "true"

      // Set environment variables for verification
      const originalBridge = process.env.BRIDGE_ADDRESS
      const originalController = process.env.MINT_BURN_GUARD_CONTROLLER
      const originalBank = process.env.BANK_ADDRESS
      const originalVault = process.env.TBTC_VAULT_ADDRESS

      process.env.BRIDGE_ADDRESS = mockBridge.address
      process.env.MINT_BURN_GUARD_CONTROLLER = controller.address
      process.env.BANK_ADDRESS = mockBank.address
      process.env.TBTC_VAULT_ADDRESS = mockVault.address

      try {
        // Should not throw even with misconfiguration when skip flag is set
        let threwError = false
        try {
          await verifyMintBurnGuardAlignment({
            mintBurnGuardAddress: mintBurnGuard.address,
            hre,
          })
        } catch (e) {
          threwError = true
        }
        expect(threwError).to.be.false
      } finally {
        // Restore environment variables
        if (originalSkip === undefined) {
          delete process.env.SKIP_DEPLOYMENT_VERIFICATION
        } else {
          process.env.SKIP_DEPLOYMENT_VERIFICATION = originalSkip
        }
        if (originalBridge) process.env.BRIDGE_ADDRESS = originalBridge
        else delete process.env.BRIDGE_ADDRESS
        if (originalController)
          process.env.MINT_BURN_GUARD_CONTROLLER = originalController
        else delete process.env.MINT_BURN_GUARD_CONTROLLER
        if (originalBank) process.env.BANK_ADDRESS = originalBank
        else delete process.env.BANK_ADDRESS
        if (originalVault) process.env.TBTC_VAULT_ADDRESS = originalVault
        else delete process.env.TBTC_VAULT_ADDRESS
      }
    })
  })
})
