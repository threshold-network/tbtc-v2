import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber, ContractTransaction } from "ethers"
import type {
  MockBridge,
  MockTBTCVault,
  TestBTCDepositor,
} from "../../typechain"
import { to1ePrecision } from "../helpers/contract-test-helpers"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const loadFixture = (vault: string) => ({
  fundingTx: {
    version: "0x01000000",
    inputVector:
      "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20d" +
      "c2b952f0100000000ffffffff",
    outputVector:
      "0x021027000000000000220020bfaeddba12b0de6feeb649af76376876bc1" +
      "feb6c2248fbfef9293ba3ac51bb4a10d73b00000000001600147ac2d9378a" +
      "1c47e589dfb8095ca95ed2140d2726",
    locktime: "0x00000000",
  },
  reveal: {
    fundingOutputIndex: 0,
    blindingFactor: "0xf9f0c90d00039523",
    walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
    refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
    refundLocktime: "0x60bcea61",
    vault,
  },
  extraData:
    "0xa9b38ea6435c8941d6eda6a46b68e3e2117196995bd154ab55196396b03d9bda",
  expectedDepositKey:
    "0xebff13c2304229ab4a97bfbfabeac82c9c0704e4aae2acf022252ac8dc1101d1",
})

describe("AbstractBTCDepositor", () => {
  let bridge: MockBridge
  let tbtcVault: MockTBTCVault
  let depositor: TestBTCDepositor

  let fixture

  before(async () => {
    const MockBridge = await ethers.getContractFactory("MockBridge")
    bridge = await MockBridge.deploy()

    const MockTBTCVault = await ethers.getContractFactory(
      "contracts/test/TestBTCDepositor.sol:MockTBTCVault"
    )
    tbtcVault = (await MockTBTCVault.deploy()) as MockTBTCVault

    fixture = loadFixture(tbtcVault.address)

    const testBtcDepositor = await ethers.getContractFactory("TestBTCDepositor")
    depositor = await testBtcDepositor.deploy()
    await depositor.initialize(bridge.address, tbtcVault.address)

    // Assert that contract initializer works as expected.
    await expect(
      depositor.initialize(bridge.address, tbtcVault.address)
    ).to.be.revertedWith("AbstractBTCDepositor already initialized")
  })

  describe("_initializeDeposit", () => {
    context("when revealed vault does not match", () => {
      it("should revert", async () => {
        // Load the fixture with a different vault address.
        const { fundingTx, reveal, extraData } = loadFixture(
          ethers.constants.AddressZero
        )

        await expect(
          depositor.initializeDepositPublic(fundingTx, reveal, extraData)
        ).to.be.revertedWith("Vault address mismatch")
      })
    })

    context("when revealed vault matches", () => {
      context("when deposit is rejected by the Bridge", () => {
        before(async () => {
          await createSnapshot()

          // Pre-reveal the deposit to cause a revert on the second attempt
          // made by the AbstractBTCDepositor.
          await bridge.revealDepositWithExtraData(
            fixture.fundingTx,
            fixture.reveal,
            fixture.extraData
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            depositor.initializeDepositPublic(
              fixture.fundingTx,
              fixture.reveal,
              fixture.extraData
            )
          ).to.be.revertedWith("Deposit already revealed")
        })
      })

      context("when deposit is accepted by the Bridge", () => {
        const expectedInitialDepositAmount = to1ePrecision(10000, 10)

        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await depositor.initializeDepositPublic(
            fixture.fundingTx,
            fixture.reveal,
            fixture.extraData
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should reveal the deposit to the Bridge", async () => {
          await expect(tx)
            .to.emit(bridge, "DepositRevealed")
            .withArgs(fixture.expectedDepositKey)
        })

        it("should return proper values", async () => {
          await expect(tx)
            .to.emit(depositor, "InitializeDepositReturned")
            .withArgs(fixture.expectedDepositKey, expectedInitialDepositAmount)
        })
      })
    })
  })

  describe("_finalizeDeposit", () => {
    context("when deposit is not initialized", () => {
      it("should revert", async () => {
        await expect(
          depositor.finalizeDepositPublic(fixture.expectedDepositKey)
        ).to.be.revertedWith("Deposit not initialized")
      })
    })

    context("when deposit is already finalized", () => {
      before(async () => {
        await createSnapshot()

        await depositor.initializeDepositPublic(
          fixture.fundingTx,
          fixture.reveal,
          fixture.extraData
        )

        await bridge.sweepDeposit(fixture.expectedDepositKey)

        await depositor.finalizeDepositPublic(fixture.expectedDepositKey)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not revert", async () => {
        await expect(
          depositor.finalizeDepositPublic(fixture.expectedDepositKey)
        ).to.be.not.reverted
      })
    })

    context("when deposit is initialized but not finalized yet", () => {
      before(async () => {
        await createSnapshot()

        await depositor.initializeDepositPublic(
          fixture.fundingTx,
          fixture.reveal,
          fixture.extraData
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when deposit is not finalized by the Bridge", () => {
        it("should revert", async () => {
          await expect(
            depositor.finalizeDepositPublic(fixture.expectedDepositKey)
          ).to.be.revertedWith("Deposit not finalized by the bridge")
        })
      })

      context("when deposit is finalized by the Bridge", () => {
        // The expected tbtcAmount is calculated as follows:
        //
        // - Deposit amount = 10000 satoshi (hardcoded in funding transaction fixture)
        // - Treasury fee = 2% (default value used in MockBridge)
        // - Optimistic minting fee = 1% (default value used in MockTBTCVault)
        // - Transaction max fee = 1000 satoshi (default value used in MockBridge)
        //
        // ((10000 sat - 200 sat) * 0.99) - 2000 sat = 8702 sat = 8702 * 1e10 TBTC
        const expectedInitialDepositAmount = to1ePrecision(10000, 10)
        const expectedTbtcAmount = to1ePrecision(8702, 10).toString()

        context("when the deposit is swept", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await bridge.sweepDeposit(fixture.expectedDepositKey)

            tx = await depositor.finalizeDepositPublic(
              fixture.expectedDepositKey
            )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should return proper values", async () => {
            await expect(tx)
              .to.emit(depositor, "FinalizeDepositReturned")
              .withArgs(
                expectedInitialDepositAmount,
                expectedTbtcAmount,
                fixture.extraData
              )
          })
        })

        context("when the deposit is optimistically minted", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await tbtcVault.createOptimisticMintingRequest(
              fixture.expectedDepositKey
            )

            await tbtcVault.finalizeOptimisticMintingRequest(
              fixture.expectedDepositKey
            )

            tx = await depositor.finalizeDepositPublic(
              fixture.expectedDepositKey
            )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should return proper values", async () => {
            await expect(tx)
              .to.emit(depositor, "FinalizeDepositReturned")
              .withArgs(
                expectedInitialDepositAmount,
                expectedTbtcAmount,
                fixture.extraData
              )
          })
        })
      })
    })
  })

  describe("_calculateTbtcAmount", () => {
    before(async () => {
      await createSnapshot()

      // Set the transaction max fee to 0.1 BTC.
      await bridge.setDepositTxMaxFee(10000000)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when all fees are non-zero", () => {
      it("should return the correct amount", async () => {
        const depositAmount = to1ePrecision(10, 8) // 10 BTC
        const treasuryFee = to1ePrecision(1, 8) // 1 BTC

        // The expected tbtcAmount is calculated as follows:
        //
        // - Deposit amount = 10 BTC
        // - Treasury fee = 1 BTC
        // - Optimistic minting fee = 1%  (default value used in MockTBTCVault)
        // - Transaction max fee = 0.1 BTC (set in MockBridge)
        //
        // ((10 BTC - 1 BTC) * 0.99) - 0.1 BTC = 8.81 BTC = 8.81 * 1e8 sat = 8.81 * 1e18 TBTC
        const expectedTbtcAmount = to1ePrecision(881, 16)

        expect(
          await depositor.calculateTbtcAmountPublic(depositAmount, treasuryFee)
        ).to.equal(expectedTbtcAmount)
      })
    })

    context("when all fees are zero", () => {
      before(async () => {
        await createSnapshot()

        // Set the transaction max fee to 0.
        await bridge.setDepositTxMaxFee(0)
        // Set the optimistic minting fee to 0%.
        await tbtcVault.setOptimisticMintingFeeDivisor(0)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return the correct amount", async () => {
        const depositAmount = to1ePrecision(10, 8) // 10 BTC
        const treasuryFee = BigNumber.from(0)

        // The expected tbtcAmount is calculated as follows:
        //
        // - Deposit amount = 10 BTC
        // - Treasury fee = 0 BTC
        // - Optimistic minting fee = 0%  (set in MockTBTCVault)
        // - Transaction max fee = 0 BTC (set in MockBridge)
        //
        // ((10 BTC - 0 BTC) * 1) - 0 BTC = 10 BTC = 10 * 1e18 TBTC
        const expectedTbtcAmount = to1ePrecision(10, 18)

        expect(
          await depositor.calculateTbtcAmountPublic(depositAmount, treasuryFee)
        ).to.equal(expectedTbtcAmount)
      })
    })

    context("when one of the fees is zero", () => {
      context("when treasury fee is zero", () => {
        it("should return the correct amount", async () => {
          const depositAmount = to1ePrecision(10, 8) // 10 BTC
          const treasuryFee = BigNumber.from(0)

          // The expected tbtcAmount is calculated as follows:
          //
          // - Deposit amount = 10 BTC
          // - Treasury fee = 0 BTC
          // - Optimistic minting fee = 1%  (default value used in MockTBTCVault)
          // - Transaction max fee = 0.1 BTC (set in MockBridge)
          //
          // ((10 BTC - 0 BTC) * 0.99) - 0.1 BTC = 9.8 BTC = 9.8 * 1e8 sat = 9.8 * 1e18 TBTC
          const expectedTbtcAmount = to1ePrecision(98, 17)

          expect(
            await depositor.calculateTbtcAmountPublic(
              depositAmount,
              treasuryFee
            )
          ).to.equal(expectedTbtcAmount)
        })
      })

      context("when optimistic minting fee is zero", () => {
        before(async () => {
          await createSnapshot()

          // Set the optimistic minting fee to 0%.
          await tbtcVault.setOptimisticMintingFeeDivisor(0)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should return the correct amount", async () => {
          const depositAmount = to1ePrecision(10, 8) // 10 BTC
          const treasuryFee = to1ePrecision(1, 8) // 1 BTC

          // The expected tbtcAmount is calculated as follows:
          //
          // - Deposit amount = 10 BTC
          // - Treasury fee = 1 BTC
          // - Optimistic minting fee = 0%  (set in MockTBTCVault)
          // - Transaction max fee = 0.1 BTC (set in MockBridge)
          //
          // ((10 BTC - 1 BTC) * 1) - 0.1 BTC = 8.9 BTC = 8.9 * 1e8 sat = 8.9 * 1e18 TBTC
          const expectedTbtcAmount = to1ePrecision(89, 17)

          expect(
            await depositor.calculateTbtcAmountPublic(
              depositAmount,
              treasuryFee
            )
          ).to.equal(expectedTbtcAmount)
        })
      })

      context("when transaction max fee is zero", () => {
        before(async () => {
          await createSnapshot()

          // Set the transaction max fee to 0.
          await bridge.setDepositTxMaxFee(0)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should return the correct amount", async () => {
          const depositAmount = to1ePrecision(10, 8) // 10 BTC
          const treasuryFee = to1ePrecision(1, 8) // 1 BTC

          // The expected tbtcAmount is calculated as follows:
          //
          // - Deposit amount = 10 BTC
          // - Treasury fee = 1 BTC
          // - Optimistic minting fee = 1%  (default value used in MockTBTCVault)
          // - Transaction max fee = 0 BTC (set in MockBridge)
          //
          // ((10 BTC - 1 BTC) * 0.99) - 0 BTC = 8.91 BTC = 8.91 * 1e8 sat = 8.91 * 1e18 TBTC
          const expectedTbtcAmount = to1ePrecision(891, 16)

          expect(
            await depositor.calculateTbtcAmountPublic(
              depositAmount,
              treasuryFee
            )
          ).to.equal(expectedTbtcAmount)
        })
      })
    })
  })

  describe("_minDepositAmount", () => {
    before(async () => {
      await createSnapshot()

      // Set deposit dust threshold to 0.1 BTC.
      await bridge.setDepositDustThreshold(1000000)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("returns value in TBTC token precision", async () => {
      // 1000000 sat * 1e10 TBTC
      expect(await depositor.minDepositAmountPublic()).to.be.equal(
        to1ePrecision(1000000, 10)
      )
    })
  })
})
