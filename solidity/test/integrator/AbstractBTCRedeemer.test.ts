import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber, ContractTransaction } from "ethers"
import type {
  MockTBTCBridge,
  MockTBTCToken,
  TestBTCRedeemer,
  MockBank,
  MockTBTCVault,
} from "../../typechain"

import { to1ePrecision } from "../helpers/contract-test-helpers"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Fixture for redemption data
const loadFixture = (walletPubKeyHash: string) => ({
  walletPubKeyHash, // Example PKH
  mainUtxo: {
    txHash: `0x${"1".repeat(64)}`,
    txOutputIndex: 0,
    txOutputValue: BigNumber.from(5000000000), // Changed from value (50 BTC in satoshis)
  },
  redemptionOutputScript: `0x76a914${"2".repeat(40)}88ac`, // P2PKH script
  amountToRedeemSat: BigNumber.from(100000000), // 1 BTC in satoshis
  expectedRedemptionKey: "", // Will be calculated later
  extraData: `0x${"3".repeat(64)}`,
})

describe("AbstractBTCRedeemer", () => {
  let bridge: MockTBTCBridge
  let tbtcToken: MockTBTCToken
  let bank: MockBank
  let tbtcVault: MockTBTCVault
  let redeemer: TestBTCRedeemer
  let fixture: ReturnType<typeof loadFixture>
  let deployer: any

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[deployer] = await ethers.getSigners()

    const MockBridgeFactory = await ethers.getContractFactory("MockTBTCBridge")
    bridge = await MockBridgeFactory.deploy()

    const MockTBTCTokenFactory = await ethers.getContractFactory(
      "MockTBTCToken"
    )
    tbtcToken = await MockTBTCTokenFactory.deploy()

    const MockBankFactory = await ethers.getContractFactory(
      "contracts/test/MockBank.sol:MockBank" // Specify the path to MockBank.sol
    )
    bank = (await MockBankFactory.deploy()) as MockBank

    const MockTBTCVaultFactory = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    tbtcVault = (await MockTBTCVaultFactory.deploy()) as MockTBTCVault
    await tbtcVault.setTbtcToken(tbtcToken.address)

    const TestBTCRedeemerFactory = await ethers.getContractFactory(
      "TestBTCRedeemer"
    )
    redeemer = await TestBTCRedeemerFactory.deploy()
    await redeemer.initialize(
      bridge.address,
      tbtcToken.address,
      bank.address,
      tbtcVault.address
    )

    // Calculate expectedRedemptionKey for the fixture
    const testWalletPkh = `0x${"a".repeat(40)}`
    fixture = loadFixture(testWalletPkh)

    const scriptHash = ethers.utils.keccak256(fixture.redemptionOutputScript)
    fixture.expectedRedemptionKey = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ["bytes32", "bytes20"],
        [scriptHash, fixture.walletPubKeyHash]
      )
    )

    // Assert that contract initializer works as expected.
    await expect(
      redeemer.initialize(
        bridge.address,
        tbtcToken.address,
        bank.address,
        tbtcVault.address
      )
    ).to.be.reverted
  })

  describe("initialize", () => {
    let testRedeemer: TestBTCRedeemer
    const TestBTCRedeemerFactory = ethers.getContractFactory("TestBTCRedeemer")

    beforeEach(async () => {
      await createSnapshot()
      // Deploy a new instance for each initialization test
      testRedeemer = await (await TestBTCRedeemerFactory).deploy()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should initialize with valid parameters", async () => {
      await expect(
        testRedeemer.initialize(
          bridge.address,
          tbtcToken.address,
          bank.address,
          tbtcVault.address
        )
      ).to.not.be.reverted
      expect(await testRedeemer.thresholdBridge()).to.equal(bridge.address)
      expect(await testRedeemer.tbtcToken()).to.equal(tbtcToken.address)
      expect(await testRedeemer.bank()).to.equal(bank.address)
    })

    it("should revert if _thresholdBridge is zero address", async () => {
      await expect(
        testRedeemer.initialize(
          ethers.constants.AddressZero,
          tbtcToken.address,
          bank.address,
          tbtcVault.address
        )
      ).to.be.revertedWith("ZeroAddress")
    })

    it("should revert if _tbtcToken is zero address", async () => {
      await expect(
        testRedeemer.initialize(
          bridge.address,
          ethers.constants.AddressZero,
          bank.address,
          tbtcVault.address
        )
      ).to.be.revertedWith("ZeroAddress")
    })

    it("should revert if _bank is zero address", async () => {
      await expect(
        testRedeemer.initialize(
          bridge.address,
          tbtcToken.address,
          ethers.constants.AddressZero,
          tbtcVault.address
        )
      ).to.be.revertedWith("ZeroAddress")
    })

    it("should revert if _tbtcVault is zero address", async () => {
      await expect(
        testRedeemer.initialize(
          bridge.address,
          tbtcToken.address,
          bank.address,
          ethers.constants.AddressZero
        )
      ).to.be.revertedWith("ZeroAddress")
    })

    it("should revert on re-initialization", async () => {
      await testRedeemer.initialize(
        bridge.address,
        tbtcToken.address,
        bank.address,
        tbtcVault.address
      )
      await expect(
        testRedeemer.initialize(
          bridge.address,
          tbtcToken.address,
          bank.address,
          tbtcVault.address
        )
      ).to.be.revertedWith("AlreadyInitialized")
    })
  })

  describe("_getRedemptionKey", () => {
    it("should calculate the correct redemption key", async () => {
      const walletPkh = `0x${"a".repeat(40)}`
      const outputScript = `0x76a914${"b".repeat(40)}88ac`

      // Calculate expected key using ethers.js for verification
      const scriptHash = ethers.utils.keccak256(outputScript)
      const expectedKey = ethers.utils.keccak256(
        ethers.utils.solidityPack(
          ["bytes32", "bytes20"],
          [scriptHash, walletPkh]
        )
      )

      const calculatedKey = await redeemer.getRedemptionKeyPublic(
        walletPkh,
        outputScript
      )
      expect(calculatedKey).to.equal(expectedKey)
    })
  })

  describe("_requestRedemption", () => {
    context("when redemption is rejected by the Bridge", () => {
      before(async () => {
        await createSnapshot()
        // Pre-request the redemption to cause a revert on the second attempt
        await bank.setBalance(redeemer.address, fixture.amountToRedeemSat)
        // Mint tBTC tokens to the redeemer for unminting
        await tbtcToken.mint(
          redeemer.address,
          fixture.amountToRedeemSat.mul(BigNumber.from(10).pow(10))
        )
        await redeemer.requestRedemptionPublic(
          fixture.walletPubKeyHash,
          fixture.mainUtxo,
          fixture.redemptionOutputScript,
          fixture.amountToRedeemSat
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        // Set balance again for the new attempt
        await bank.setBalance(redeemer.address, fixture.amountToRedeemSat)
        // Mint tBTC tokens to the redeemer for unminting
        await tbtcToken.mint(
          redeemer.address,
          fixture.amountToRedeemSat.mul(BigNumber.from(10).pow(10))
        )
        await expect(
          redeemer.requestRedemptionPublic(
            fixture.walletPubKeyHash,
            fixture.mainUtxo,
            fixture.redemptionOutputScript,
            fixture.amountToRedeemSat
          )
        ).to.be.revertedWith("Redemption already requested") // This is the error from MockBridge
      })
    })

    context("when redemption is accepted by the Bridge", () => {
      let tx: ContractTransaction
      // Calculation: (1 BTC in sat - 0.5% treasury fee sat) - txMaxFee sat = (100,000,000 - 500,000) - 10,000 = 99,490,000 sat
      // This amount is then multiplied by SATOSHI_MULTIPLIER (10**10) in the contract.
      const expectedSatEquivalent = BigNumber.from(99490000)
      const expectedTbtcAmount = expectedSatEquivalent.mul(
        BigNumber.from(10).pow(10)
      )

      before(async () => {
        await createSnapshot()
        // Grant allowance and set balance for the redeemer contract
        await bank.setBalance(redeemer.address, fixture.amountToRedeemSat)
        // Mint tBTC tokens to the redeemer for unminting
        await tbtcToken.mint(
          redeemer.address,
          fixture.amountToRedeemSat.mul(BigNumber.from(10).pow(10))
        )

        tx = await redeemer.requestRedemptionPublic(
          fixture.walletPubKeyHash,
          fixture.mainUtxo,
          fixture.redemptionOutputScript,
          fixture.amountToRedeemSat
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should request redemption from the Bridge", async () => {
        // Check for the event emitted by MockBridge
        await expect(tx)
          .to.emit(bridge, "RedemptionRequestedMock") // Event from MockBridge
          .withArgs(
            fixture.walletPubKeyHash,
            fixture.amountToRedeemSat,
            fixture.redemptionOutputScript,
            fixture.expectedRedemptionKey
          )
      })

      it("should return proper values", async () => {
        await expect(tx)
          .to.emit(redeemer, "RequestRedemptionReturned")
          .withArgs(fixture.expectedRedemptionKey, expectedTbtcAmount)
      })

      it("should increase bank allowance for the bridge", async () => {
        // The allowance is made from redeemer to bridge by _requestRedemption
        const allowance = await bank.getAllowance(
          redeemer.address,
          bridge.address
        )
        expect(allowance).to.equal(fixture.amountToRedeemSat)
      })
    })
  })

  describe("_calculateTbtcAmount", () => {
    // Mock Bridge uses 0.5% treasury fee (divisor 200) and 10000 sat tx max fee by default.
    const SATOSHI_MULTIPLIER_BN = BigNumber.from(10).pow(10)

    context("when all fees are non-zero", () => {
      it("should return the correct amount", async () => {
        const amountSat = BigNumber.from(100000000) // 1 BTC
        const treasuryFeeSat = amountSat.div(200) // 0.005 BTC (500,000 sat)
        const txMaxFeeSat = BigNumber.from(10000) // from MockBridge default

        // Expected: ((1 BTC - 0.005 BTC) - 0.0001 BTC) * 10^10 = (99,500,000 - 10,000) * 10^10 = 99,490,000 * 10^10
        const expectedTbtcAmount = BigNumber.from(99490000).mul(
          SATOSHI_MULTIPLIER_BN
        )

        expect(
          await redeemer.calculateTbtcAmountPublic(amountSat, treasuryFeeSat)
        ).to.equal(expectedTbtcAmount)
      })
    })

    context("when treasury fee is zero", () => {
      it("should return the correct amount", async () => {
        const amountSat = BigNumber.from(100000000) // 1 BTC
        const treasuryFeeSat = BigNumber.from(0)
        const txMaxFeeSat = BigNumber.from(10000)

        // Expected: (1 BTC - 0 BTC - 0.0001 BTC) * 10^10 = (100,000,000 - 10,000) * 10^10 = 99,990,000 * 10^10
        const expectedTbtcAmount = BigNumber.from(99990000).mul(
          SATOSHI_MULTIPLIER_BN
        )

        expect(
          await redeemer.calculateTbtcAmountPublic(amountSat, treasuryFeeSat)
        ).to.equal(expectedTbtcAmount)
      })
    })

    context("when transaction max fee is zero", () => {
      before(async () => {
        await createSnapshot()
        const mockBridge = (await ethers.getContractAt(
          "MockTBTCBridge",
          bridge.address
        )) as MockTBTCBridge
        await mockBridge.setRedemptionTxMaxFeeInternal(0)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return the correct amount", async () => {
        const amountSat = BigNumber.from(100000000) // 1 BTC
        const treasuryFeeSat = amountSat.div(200) // 0.005 BTC

        // Expected: (1 BTC - 0.005 BTC - 0 BTC) * 10^10 = (100,000,000 - 500,000) * 10^10 = 99,500,000 * 10^10
        const expectedTbtcAmount = BigNumber.from(99500000).mul(
          SATOSHI_MULTIPLIER_BN
        )

        expect(
          await redeemer.calculateTbtcAmountPublic(amountSat, treasuryFeeSat)
        ).to.equal(expectedTbtcAmount)
      })
    })

    context("when all fees are zero", () => {
      before(async () => {
        await createSnapshot()
        const mockBridge = (await ethers.getContractAt(
          "MockTBTCBridge",
          bridge.address
        )) as MockTBTCBridge
        await mockBridge.setRedemptionTxMaxFeeInternal(0)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return the correct amount", async () => {
        const amountSat = BigNumber.from(100000000) // 1 BTC
        const treasuryFeeSat = BigNumber.from(0)

        // Expected: (1 BTC - 0 BTC - 0 BTC) * 10^10 = 100,000,000 * 10^10
        const expectedTbtcAmount = BigNumber.from(100000000).mul(
          SATOSHI_MULTIPLIER_BN
        )

        expect(
          await redeemer.calculateTbtcAmountPublic(amountSat, treasuryFeeSat)
        ).to.equal(expectedTbtcAmount)
      })
    })

    context("when redemption amount is too low (leads to underflow)", () => {
      it("should revert if (amount - treasuryFee) < txMaxFee", async () => {
        const amountSat = BigNumber.from(10000) // Less than default txMaxFee (10000) after treasury fee
        const treasuryFeeSat = amountSat.div(200) // 50 sat
        // amountSat - treasuryFeeSat = 9950. Default txMaxFee is 10000.
        // (9950 * 1e10) - (10000 * 1e10) should underflow.

        await expect(
          redeemer.calculateTbtcAmountPublic(amountSat, treasuryFeeSat)
        ).to.be.reverted // Arithmetic underflow
      })

      it("should revert if amount barely covers treasuryFee but not txMaxFee", async () => {
        const txMaxFeeSat = BigNumber.from(10000) // default from MockBridge
        const amountSat = txMaxFeeSat.sub(1).add(1) // e.g. amount = txMaxFee = 10000
        const treasuryFeeSat = BigNumber.from(1) // Make amount after treasury fee less than txMaxFee
        // Here (amountSat - treasuryFeeSat) = 10000 - 1 = 9999
        // (9999 * 1e10) - (10000 * 1e10) should underflow

        await expect(
          redeemer.calculateTbtcAmountPublic(amountSat, treasuryFeeSat)
        ).to.be.reverted // Arithmetic underflow
      })

      it("should return 0 if (amount - treasuryFee) == txMaxFee", async () => {
        const SATOSHI_MULTIPLIER_BN = BigNumber.from(10).pow(10)
        // We need redemptionAmountSat - redemptionTreasuryFeeSat = redemptionTxMaxFee
        // Let redemptionTxMaxFee be 10000 (default from MockBridge)
        // Let redemptionTreasuryFeeSat be 0 for simplicity in this setup.
        const amountSat = BigNumber.from(10000)
        const treasuryFeeSat = BigNumber.from(0)

        // Expected: (10000 - 0 - 10000) * 10^10 = 0
        const expectedTbtcAmount = BigNumber.from(0)

        expect(
          await redeemer.calculateTbtcAmountPublic(amountSat, treasuryFeeSat)
        ).to.equal(expectedTbtcAmount)
      })
    })
  })

  describe("rescueTbtc", () => {
    const amountToRescue = to1ePrecision(1, 18) // 1 TBTC
    let randomAccount: any

    before(async () => {
      // eslint-disable-next-line @typescript-eslint/no-extra-semi
      ;[, randomAccount] = await ethers.getSigners() // Use a different account than the deployer/owner

      // Mint some tBTC to the redeemer contract for rescue testing
      await tbtcToken.mint(redeemer.address, amountToRescue.mul(2)) // Mint 2 TBTC
    })

    context("when caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          redeemer
            .connect(randomAccount)
            .rescueTbtc(randomAccount.address, amountToRescue)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when recipient is the zero address", () => {
      it("should revert", async () => {
        await expect(
          redeemer.rescueTbtc(ethers.constants.AddressZero, amountToRescue)
        ).to.be.revertedWith("ZeroAddress")
      })
    })

    context("when contract has insufficient tBTC balance", () => {
      it("should revert", async () => {
        const excessiveAmount = amountToRescue.mul(3) // Try to rescue more than available
        await expect(
          redeemer.rescueTbtc(randomAccount.address, excessiveAmount)
        ).to.be.revertedWith("InsufficientBalance")
      })
    })

    context("when rescue is successful", () => {
      let tx: ContractTransaction
      let initialContractBalance: BigNumber
      let initialRecipientBalance: BigNumber

      before(async () => {
        await createSnapshot()
        initialContractBalance = await tbtcToken.balanceOf(redeemer.address)
        initialRecipientBalance = await tbtcToken.balanceOf(deployer.address)
        tx = await redeemer.rescueTbtc(deployer.address, amountToRescue)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer tBTC from contract to recipient", async () => {
        const finalContractBalance = await tbtcToken.balanceOf(redeemer.address)
        const finalRecipientBalance = await tbtcToken.balanceOf(
          deployer.address
        )

        expect(finalContractBalance).to.equal(
          initialContractBalance.sub(amountToRescue)
        )
        expect(finalRecipientBalance).to.equal(
          initialRecipientBalance.add(amountToRescue)
        )
      })

      it("should emit Transfer event from tbtcToken", async () => {
        await expect(tx)
          .to.emit(tbtcToken, "Transfer")
          .withArgs(redeemer.address, deployer.address, amountToRescue)
      })
    })

    context("when rescuing zero tokens", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should succeed and transfer zero tokens", async () => {
        const zeroAmount = BigNumber.from(0)
        const initialOwnerBalance = await tbtcToken.balanceOf(deployer.address)
        const initialContractBalance = await tbtcToken.balanceOf(
          redeemer.address
        )

        const tx = await redeemer.rescueTbtc(deployer.address, zeroAmount)

        await expect(tx)
          .to.emit(tbtcToken, "Transfer")
          .withArgs(redeemer.address, deployer.address, zeroAmount)

        expect(await tbtcToken.balanceOf(deployer.address)).to.equal(
          initialOwnerBalance
        )
        expect(await tbtcToken.balanceOf(redeemer.address)).to.equal(
          initialContractBalance
        )
      })
    })

    context("when rescuing exact available balance", () => {
      let exactAmount: BigNumber
      beforeEach(async () => {
        // Ensure a known state for this specific context
        await createSnapshot()
        exactAmount = await tbtcToken.balanceOf(redeemer.address)
        // Ensure there's some balance to rescue
        if (exactAmount.isZero()) {
          await tbtcToken.mint(redeemer.address, to1ePrecision(1, 18))
          exactAmount = await tbtcToken.balanceOf(redeemer.address)
        }
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should succeed and leave contract with zero balance", async () => {
        const initialOwnerBalance = await tbtcToken.balanceOf(deployer.address)

        const tx = await redeemer.rescueTbtc(deployer.address, exactAmount)

        await expect(tx)
          .to.emit(tbtcToken, "Transfer")
          .withArgs(redeemer.address, deployer.address, exactAmount)

        expect(await tbtcToken.balanceOf(deployer.address)).to.equal(
          initialOwnerBalance.add(exactAmount)
        )
        expect(await tbtcToken.balanceOf(redeemer.address)).to.equal(0)
      })
    })
  })
})
