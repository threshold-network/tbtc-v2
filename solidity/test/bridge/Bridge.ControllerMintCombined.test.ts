import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { BigNumber } from "ethers"
import type {
  Bank,
  BankStub,
  Bridge,
  BridgeStub,
  BridgeGovernance,
  CovenantSpendAuthorization,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { AddressZero } = ethers.constants

// The exact live authorization revert reproduced against the deployed Bridge.
const UNAUTHORIZED_CONTROLLER = "Caller is not the authorized controller"

describe("Bridge - Controller mint & Stage-3 reinitializer (combined)", () => {
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let controller: SignerWithAddress
  let recipientA: SignerWithAddress
  let recipientB: SignerWithAddress

  let bank: Bank & BankStub
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance

  // A real registry (nonzero, with code) for the reinitializer path.
  let registry: CovenantSpendAuthorization

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, governance, thirdParty, bank, bridge, bridgeGovernance } =
      await waffle.loadFixture(bridgeFixture))

    const signers = await ethers.getSigners()
    // Distinct signers for the controller and mint recipients.
    ;[controller, recipientA, recipientB] = [signers[5], signers[6], signers[7]]

    const CovenantFactory = await ethers.getContractFactory(
      "CovenantSpendAuthorization"
    )
    registry = (await CovenantFactory.deploy()) as CovenantSpendAuthorization
  })

  // Reads the raw EIP-1967 / Initializable / controller slots.
  const readSlot = async (slot: number) =>
    ethers.provider.getStorageAt(bridge.address, slot)
  const readInitializedVersion = async () =>
    parseInt((await readSlot(50)).slice(-2), 16)
  const setBridgeBalance = async (wei: BigNumber) =>
    ethers.provider.send("hardhat_setBalance", [
      bridge.address,
      ethers.utils.hexValue(wei),
    ])

  describe("controller-mint surface", () => {
    before(async () => {
      await createSnapshot()
      await bridgeGovernance
        .connect(governance)
        .setMintingController(controller.address)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("exposes both controller getters returning the same value", async () => {
      expect(await bridge.mintingController()).to.equal(controller.address)
      expect(await bridge.getMintingController()).to.equal(controller.address)
    })

    it("does not expose controllerBalanceIncreaser()", () => {
      expect(bridge.interface.functions).to.not.have.property(
        "controllerBalanceIncreaser()"
      )
    })

    it("reverts single controller mint from an unauthorized caller", async () => {
      await expect(
        bridge
          .connect(thirdParty)
          .controllerIncreaseBalance(recipientA.address, 42)
      ).to.be.revertedWith(UNAUTHORIZED_CONTROLLER)
    })

    it("reverts batch controller mint from an unauthorized caller", async () => {
      await expect(
        bridge
          .connect(thirdParty)
          .controllerIncreaseBalances([recipientA.address], [42])
      ).to.be.revertedWith(UNAUTHORIZED_CONTROLLER)
    })

    it("credits the exact input amount and emits ControllerBalanceIncreased", async () => {
      await createSnapshot()
      const before = await bank.balanceOf(recipientA.address)
      const amount = BigNumber.from(42) // satoshi-scale; must NOT be rescaled
      const tx = await bridge
        .connect(controller)
        .controllerIncreaseBalance(recipientA.address, amount)

      await expect(tx)
        .to.emit(bridge, "ControllerBalanceIncreased")
        .withArgs(controller.address, recipientA.address, amount)
      // No Bridge-side satoshi->18-decimal conversion: the Bank delta equals the
      // exact input amount.
      expect((await bank.balanceOf(recipientA.address)).sub(before)).to.equal(
        amount
      )
      await restoreSnapshot()
    })

    it("credits each recipient in a batch and emits ControllerBalancesIncreased", async () => {
      await createSnapshot()
      const beforeA = await bank.balanceOf(recipientA.address)
      const beforeB = await bank.balanceOf(recipientB.address)
      const amounts = [BigNumber.from(7), BigNumber.from(11)]
      const tx = await bridge
        .connect(controller)
        .controllerIncreaseBalances(
          [recipientA.address, recipientB.address],
          amounts
        )

      await expect(tx)
        .to.emit(bridge, "ControllerBalancesIncreased")
        .withArgs(
          controller.address,
          [recipientA.address, recipientB.address],
          amounts
        )
      expect((await bank.balanceOf(recipientA.address)).sub(beforeA)).to.equal(
        7
      )
      expect((await bank.balanceOf(recipientB.address)).sub(beforeB)).to.equal(
        11
      )
      await restoreSnapshot()
    })

    it("propagates Bank's exact revert for mismatched batch arrays", async () => {
      await expect(
        bridge
          .connect(controller)
          .controllerIncreaseBalances([recipientA.address], [7, 11])
      ).to.be.revertedWith("Arrays must have the same length")
    })
  })

  describe("setMintingController access control", () => {
    it("reverts when a non-governance caller sets the controller directly", async () => {
      await expect(
        bridge.connect(thirdParty).setMintingController(controller.address)
      ).to.be.revertedWith("Caller is not the governance")
    })

    it("lets governance set the controller and emits MintingControllerSet", async () => {
      await createSnapshot()
      const tx = await bridgeGovernance
        .connect(governance)
        .setMintingController(controller.address)
      await expect(tx)
        .to.emit(bridge, "MintingControllerSet")
        .withArgs(controller.address)
      await restoreSnapshot()
    })

    it("permits setting the controller back to zero", async () => {
      await createSnapshot()
      await bridgeGovernance
        .connect(governance)
        .setMintingController(controller.address)
      const tx = await bridgeGovernance
        .connect(governance)
        .setMintingController(AddressZero)
      await expect(tx)
        .to.emit(bridge, "MintingControllerSet")
        .withArgs(AddressZero)
      expect(await bridge.mintingController()).to.equal(AddressZero)
      await restoreSnapshot()
    })
  })

  describe("initializeV6_Stage3Combined reinitializer", () => {
    // Puts the fixture Bridge into a live-like pre-migration state: controller
    // set at slot 81, escrow flag cleared, all migration targets clean, ETH
    // balance zero (== escrow), no active wallet.
    const stageV5LikeState = async () => {
      await bridgeGovernance
        .connect(governance)
        .setMintingController(controller.address)
      await bridge.setFraudChallengeEscrowSeeded(false)
      await bridge.setWalletRegistrationOrderSeeded(false)
      await bridge.setOpenFraudChallengeEscrow(0)
      await bridge.setActiveWallet(AddressZero)
      await setBridgeBalance(BigNumber.from(0))
    }

    it("succeeds from a live-like v5 state and wires escrow/order/registry", async () => {
      await createSnapshot()
      await stageV5LikeState()

      const slot81Before = await readSlot(81)
      const tx = await bridge
        .connect(thirdParty)
        .initializeV6_Stage3Combined(
          controller.address,
          registry.address,
          0,
          []
        )

      // Covenant registry wired + event attributed to the Bridge.
      await expect(tx)
        .to.emit(bridge, "CovenantSpendAuthorizationUpdated")
        .withArgs(registry.address)
      // Migration state applied: slot 130 now packs both seeded flags (0x0101)
      // and the covenant registry, matching the spec's exact formula
      // (uint256(uint160(registry)) << 16) | 0x0101 for a zero escrow.
      expect(await bridge.getWalletRegistrationOrderSeeded()).to.equal(true)
      const slot130 = BigNumber.from(await readSlot(130))
      const expected130 = BigNumber.from(registry.address).shl(16).or(0x0101)
      expect(slot130).to.equal(expected130)
      // Initializer advanced to version 6.
      expect(await readInitializedVersion()).to.equal(6)
      // Slot 81 (controller) is untouched by the migration.
      expect(await readSlot(81)).to.equal(slot81Before)
      expect(await bridge.mintingController()).to.equal(controller.address)
      // migrationDebtVault stays zero.
      expect(await bridge.migrationDebtVault()).to.equal(AddressZero)

      await restoreSnapshot()
    })

    it("cannot run twice", async () => {
      await createSnapshot()
      await stageV5LikeState()
      await bridge
        .connect(thirdParty)
        .initializeV6_Stage3Combined(
          controller.address,
          registry.address,
          0,
          []
        )
      await expect(
        bridge
          .connect(thirdParty)
          .initializeV6_Stage3Combined(
            controller.address,
            registry.address,
            0,
            []
          )
      ).to.be.revertedWith("Initializable: contract is already initialized")
      await restoreSnapshot()
    })

    it("reverts on a zero expected controller", async () => {
      await createSnapshot()
      await stageV5LikeState()
      await expect(
        bridge
          .connect(thirdParty)
          .initializeV6_Stage3Combined(AddressZero, registry.address, 0, [])
      ).to.be.revertedWith("Expected minting controller is zero")
      await restoreSnapshot()
    })

    it("reverts on a controller/slot-81 mismatch", async () => {
      await createSnapshot()
      await stageV5LikeState()
      await expect(
        bridge
          .connect(thirdParty)
          .initializeV6_Stage3Combined(
            thirdParty.address,
            registry.address,
            0,
            []
          )
      ).to.be.revertedWith("Minting controller slot mismatch")
      await restoreSnapshot()
    })

    it("detects a raw-PR-style slot collision via a nonzero migrationDebtVault", async () => {
      await createSnapshot()
      await stageV5LikeState()
      // Force absolute slot 82 (migrationDebtVault) to a nonzero value, as a
      // layout that re-collided slot 30 would have done to the controller.
      await ethers.provider.send("hardhat_setStorageAt", [
        bridge.address,
        "0x52",
        ethers.utils.hexZeroPad(thirdParty.address, 32),
      ])
      await expect(
        bridge
          .connect(thirdParty)
          .initializeV6_Stage3Combined(
            controller.address,
            registry.address,
            0,
            []
          )
      ).to.be.revertedWith("Migration debt vault slot not clean")
      await restoreSnapshot()
    })

    it("reverts on a zero covenant registry", async () => {
      await createSnapshot()
      await stageV5LikeState()
      await expect(
        bridge
          .connect(thirdParty)
          .initializeV6_Stage3Combined(controller.address, AddressZero, 0, [])
      ).to.be.revertedWith("Covenant registry is zero")
      await restoreSnapshot()
    })

    it("reverts on a codeless covenant registry", async () => {
      await createSnapshot()
      await stageV5LikeState()
      await expect(
        bridge.connect(thirdParty).initializeV6_Stage3Combined(
          controller.address,
          thirdParty.address, // EOA: no code
          0,
          []
        )
      ).to.be.revertedWith("Covenant registry has no code")
      await restoreSnapshot()
    })

    it("reverts when the ETH balance does not equal the supplied escrow", async () => {
      await createSnapshot()
      await stageV5LikeState()
      await setBridgeBalance(ethers.utils.parseEther("1"))
      await expect(
        bridge
          .connect(thirdParty)
          .initializeV6_Stage3Combined(
            controller.address,
            registry.address,
            0,
            []
          )
      ).to.be.revertedWith("Bridge balance != open escrow")
      await restoreSnapshot()
    })

    it("reverts when an active wallet exists but the wallet list is empty", async () => {
      await createSnapshot()
      await stageV5LikeState()
      await bridge.setActiveWallet("0x1111111111111111111111111111111111111111")
      await expect(
        bridge
          .connect(thirdParty)
          .initializeV6_Stage3Combined(
            controller.address,
            registry.address,
            0,
            []
          )
      ).to.be.revertedWith("Active wallet without wallet list")
      await restoreSnapshot()
    })

    it("reverts when the wallet list tail is not the active wallet", async () => {
      await createSnapshot()
      await stageV5LikeState()
      await bridge.setActiveWallet("0x1111111111111111111111111111111111111111")
      await expect(
        bridge
          .connect(thirdParty)
          .initializeV6_Stage3Combined(
            controller.address,
            registry.address,
            0,
            ["0x2222222222222222222222222222222222222222"]
          )
      ).to.be.revertedWith("Wallet list tail != active wallet")
      await restoreSnapshot()
    })

    it("reverts when the fraud-challenge escrow was already seeded", async () => {
      await createSnapshot()
      await stageV5LikeState()
      await bridge.setFraudChallengeEscrowSeeded(true)
      await expect(
        bridge
          .connect(thirdParty)
          .initializeV6_Stage3Combined(
            controller.address,
            registry.address,
            0,
            []
          )
      ).to.be.revertedWith("Fraud escrow already seeded")
      await restoreSnapshot()
    })

    it("reverts when the wallet registration order was already seeded", async () => {
      await createSnapshot()
      await stageV5LikeState()
      await bridge.setWalletRegistrationOrderSeeded(true)
      await expect(
        bridge
          .connect(thirdParty)
          .initializeV6_Stage3Combined(
            controller.address,
            registry.address,
            0,
            []
          )
      ).to.be.revertedWith("Wallet order already seeded")
      await restoreSnapshot()
    })

    it("blocks direct reinitialization of the implementation (disabled initializers)", async () => {
      const implAddress = ethers.utils.getAddress(
        `0x${(
          await ethers.provider.getStorageAt(
            bridge.address,
            "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
          )
        ).slice(-40)}`
      )
      const impl = (await ethers.getContractAt("Bridge", implAddress)) as Bridge
      await expect(
        impl
          .connect(thirdParty)
          .initializeV6_Stage3Combined(
            controller.address,
            registry.address,
            0,
            []
          )
      ).to.be.revertedWith("Initializable: contract is already initialized")
    })
  })
})
