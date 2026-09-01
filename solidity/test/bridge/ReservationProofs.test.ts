import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { smock, FakeContract } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, BigNumberish } from "ethers"
import {
  IRelay,
  TestReservationProofs,
  MockReservationVault,
  Bank,
} from "../../typechain"
import { SingleP2SHDeposit } from "../data/deposit-sweep"

describe("ReservationProofs", () => {
  let relay: FakeContract<IRelay>
  let testReservationProofs: TestReservationProofs
  let mockReservationVault: MockReservationVault
  let bank: Bank
  let deployer: SignerWithAddress
  let depositor: SignerWithAddress
  let redeemer: SignerWithAddress

  // Test constants
  const walletPubKeyHash = `0x${"11".repeat(20)}`
  const otherWalletPubKeyHash = `0x${"22".repeat(20)}`
  const sampleFundingTxHash = `0x${"aa".repeat(32)}`
  const sampleFundingOutputIndex = 0
  const sampleReservationKey = ethers.utils.solidityKeccak256(
    ["bytes32", "uint32"],
    [sampleFundingTxHash, sampleFundingOutputIndex]
  )
  const sampleAnchorTxHash = `0x${"bb".repeat(32)}`

  const termSeconds = 90 * 86400 // 90 days
  const dissolutionDelay = 30 * 86400 // 30 days
  const txMaxFee = 10000 // 10000 satoshis

  // Helpers to convert numbers to Little-Endian hex strings
  function uint32ToLittleEndianHex(val: number): string {
    const buf = Buffer.alloc(4)
    buf.writeUInt32LE(val, 0)
    return buf.toString("hex")
  }

  function uint64ToLittleEndianHex(val: BigNumberish): string {
    const bn = BigNumber.from(val)
    const hex = bn.toHexString().substring(2).padStart(16, "0")
    return Buffer.from(hex, "hex").reverse().toString("hex")
  }

  // Assemble Bitcoin 1-input vector
  function assembleInputVector(txHash: string, txOutputIndex: number): string {
    const cleanTxHash = txHash.startsWith("0x") ? txHash.substring(2) : txHash
    const indexLE = uint32ToLittleEndianHex(txOutputIndex)
    // 0x01 (1 input) + 32B txid + 4B index + 0x00 (0-length scriptSig) + 0xffffffff (sequence)
    return `0x01${cleanTxHash}${indexLE}00ffffffff`
  }

  // Assemble Bitcoin 1-output vector for P2PKH
  function assembleP2PKHOutputVector(
    valueSatoshis: BigNumberish,
    pkh: string
  ): string {
    const cleanPkh = pkh.startsWith("0x") ? pkh.substring(2) : pkh
    const valueLE = uint64ToLittleEndianHex(valueSatoshis)
    // 0x01 (1 output) + 8B value LE + 0x19 (25B script length) + 0x76a914 + 20B PKH + 0x88ac
    return `0x01${valueLE}1976a914${cleanPkh}88ac`
  }

  // Assemble Bitcoin 1-output vector for P2WPKH
  function assembleP2WPKHOutputVector(
    valueSatoshis: BigNumberish,
    pkh: string
  ): string {
    const cleanPkh = pkh.startsWith("0x") ? pkh.substring(2) : pkh
    const valueLE = uint64ToLittleEndianHex(valueSatoshis)
    // 0x01 (1 output) + 8B value LE + 0x16 (22B script length) + 0x0014 + 20B PKH
    return `0x01${valueLE}160014${cleanPkh}`
  }

  function buildReservationAction(overrides: Record<string, any> = {}) {
    return {
      targetWalletPubKeyHash: walletPubKeyHash,
      requestedAt: 1000,
      timeoutAt: 5000,
      txMaxFee: 10000,
      actionType: 1, // Acceptance
      state: 1, // Pending
      feePaid: false,
      redeemer: ethers.constants.AddressZero,
      amount: 100000000,
      actionDataHash: ethers.constants.HashZero,
      sourceAnchorUtxoHash: ethers.constants.HashZero,
      usedRetryCredit: false,
      watchtowerDefaultDelay: 0,
      watchtowerLevelOneDelay: 0,
      watchtowerLevelTwoDelay: 0,
      isPartial: false,
      retryCreditSourceNonce: 0,
      termSeconds,
      dissolutionDelay,
      ...overrides,
    }
  }

  function buildReservationRequest(overrides: Record<string, any> = {}) {
    return {
      owner: depositor.address,
      mintedAmount: 100000000 - 5000,
      acceptedAt: 1000,
      walletPubKeyHash,
      anchorAmount: 100000000 - 5000,
      expiresAt: 1000 + termSeconds,
      anchorTxHash: sampleAnchorTxHash,
      anchorTxOutputIndex: 0,
      state: 1, // Active
      requestNonce: 1,
      retryCredit: false,
      dissolutionEligibleAt: 1000 + termSeconds + dissolutionDelay,
      cumulativeReanchorFee: 0,
      ...overrides,
    }
  }

  beforeEach(async () => {
    const signers = await ethers.getSigners()
    ;[deployer, depositor, redeemer] = signers

    const BankFactory = await ethers.getContractFactory("Bank")
    bank = (await BankFactory.connect(deployer).deploy()) as Bank

    const ReservationProofsFactory = await ethers.getContractFactory(
      "ReservationProofs"
    )
    const reservationProofsLibrary = await ReservationProofsFactory.connect(
      deployer
    ).deploy()
    const TestReservationProofsFactory = await ethers.getContractFactory(
      "TestReservationProofs",
      {
        libraries: {
          ReservationProofs: reservationProofsLibrary.address,
        },
      }
    )
    testReservationProofs = (await TestReservationProofsFactory.connect(
      deployer
    ).deploy(bank.address)) as TestReservationProofs

    relay = await smock.fake<IRelay>("IRelay")
    await testReservationProofs.setRelay(relay.address)

    await bank.connect(deployer).updateBridge(testReservationProofs.address)

    const MockReservationVaultFactory = await ethers.getContractFactory(
      "MockReservationVault"
    )
    mockReservationVault = (await MockReservationVaultFactory.connect(
      deployer
    ).deploy(bank.address)) as MockReservationVault

    await testReservationProofs.setReservationVault(
      mockReservationVault.address
    )
    await testReservationProofs.setVaultTrusted(
      mockReservationVault.address,
      true
    )
    await testReservationProofs.setReservationParameters(
      termSeconds,
      dissolutionDelay,
      txMaxFee
    )
    // WalletState.Live = 1
    await testReservationProofs.setWalletState(walletPubKeyHash, 1)
  })

  describe("1. Dispatcher range and proof type routing (submitReservationProof)", () => {
    const dummyTxInfo = {
      version: "0x01000000",
      inputVector: "0x",
      outputVector: "0x",
      locktime: "0x00000000",
    }
    const dummyProof = {
      merkleProof: "0x",
      txIndexInBlock: 0,
      bitcoinHeaders: "0x",
      coinbasePreimage: ethers.constants.HashZero,
      coinbaseProof: "0x",
    }
    const dummyUtxo = {
      txHash: ethers.constants.HashZero,
      txOutputIndex: 0,
      txOutputValue: 0,
    }

    it("should revert if proof type is out of range (> ProofType.max)", async () => {
      // ProofType enum has 4 members: Acceptance=0, Redemption=1, Reanchor=2, Dissolution=3.
      // proofType=4 or 5 is >= max + 1
      await expect(
        testReservationProofs.submitReservationProof(
          5,
          dummyTxInfo,
          dummyProof,
          dummyUtxo,
          sampleReservationKey,
          1
        )
      ).to.be.revertedWith("Unsupported reservation proof type")

      await expect(
        testReservationProofs.submitReservationProof(
          4,
          dummyTxInfo,
          dummyProof,
          dummyUtxo,
          sampleReservationKey,
          1
        )
      ).to.be.revertedWith("Unsupported reservation proof type")
    })

    it("should revert if proof type is not Acceptance (Redemption, Reanchor, Dissolution)", async () => {
      // ProofType.Redemption = 1
      await expect(
        testReservationProofs.submitReservationProof(
          1,
          dummyTxInfo,
          dummyProof,
          dummyUtxo,
          sampleReservationKey,
          1
        )
      ).to.be.revertedWith("Unsupported reservation proof type")

      // ProofType.Reanchor = 2
      await expect(
        testReservationProofs.submitReservationProof(
          2,
          dummyTxInfo,
          dummyProof,
          dummyUtxo,
          sampleReservationKey,
          1
        )
      ).to.be.revertedWith("Unsupported reservation proof type")

      // ProofType.Dissolution = 3
      await expect(
        testReservationProofs.submitReservationProof(
          3,
          dummyTxInfo,
          dummyProof,
          dummyUtxo,
          sampleReservationKey,
          1
        )
      ).to.be.revertedWith("Unsupported reservation proof type")
    })
  })

  describe("2. Action type mismatch", () => {
    it("should revert if loaded action type does not match expected ActionType.Acceptance", async () => {
      const requestNonce = 1
      // Setup action with ActionType.Redemption (2) instead of Acceptance (1)
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        requestNonce,
        buildReservationAction({
          actionType: 2, // Redemption
          state: 1, // Pending
          redeemer: redeemer.address,
        })
      )

      // Expect ActionType.Acceptance = 1
      await expect(
        testReservationProofs.loadSettleableAction(
          sampleReservationKey,
          requestNonce,
          1 // Acceptance
        )
      ).to.be.revertedWith("Action type mismatch")
    })

    it("should revert if loaded action type is None (0)", async () => {
      const requestNonce = 1
      // Action default state is ActionType.None (0)
      await expect(
        testReservationProofs.loadSettleableAction(
          sampleReservationKey,
          requestNonce,
          1 // Acceptance
        )
      ).to.be.revertedWith("Action type mismatch")
    })
  })

  describe("3. Action not settleable", () => {
    const requestNonce = 1

    it("should revert if action state is Unknown (0)", async () => {
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        requestNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 0, // Unknown
        })
      )

      await expect(
        testReservationProofs.loadSettleableAction(
          sampleReservationKey,
          requestNonce,
          1
        )
      ).to.be.revertedWith("Action is not settleable")
    })

    it("should revert if action state is Settled (2)", async () => {
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        requestNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 2, // Settled
        })
      )

      await expect(
        testReservationProofs.loadSettleableAction(
          sampleReservationKey,
          requestNonce,
          1
        )
      ).to.be.revertedWith("Action is not settleable")
    })

    it("should revert if action state is Vetoed (4)", async () => {
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        requestNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 4, // Vetoed
        })
      )

      await expect(
        testReservationProofs.loadSettleableAction(
          sampleReservationKey,
          requestNonce,
          1
        )
      ).to.be.revertedWith("Action is not settleable")
    })

    it("should revert if action state is Superseded (5)", async () => {
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        requestNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 5, // Superseded
        })
      )

      await expect(
        testReservationProofs.loadSettleableAction(
          sampleReservationKey,
          requestNonce,
          1
        )
      ).to.be.revertedWith("Action is not settleable")
    })

    it("should accept action if state is Pending (1) and return late = false", async () => {
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        requestNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 1, // Pending
        })
      )

      const [action, late] = await testReservationProofs.loadSettleableAction(
        sampleReservationKey,
        requestNonce,
        1
      )
      expect(action.state).to.equal(1) // Pending
      expect(late).to.be.false
    })

    it("should accept action if state is TimedOut (3) and return late = true", async () => {
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        requestNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 3, // TimedOut
        })
      )

      const [action, late] = await testReservationProofs.loadSettleableAction(
        sampleReservationKey,
        requestNonce,
        1
      )
      expect(action.state).to.equal(3) // TimedOut
      expect(late).to.be.true
    })
  })
  describe("4. Pending-reserved and existence guards", () => {
    const requestNonce = 1
    const depositAmount = 100000000
    const minerFee = 5000
    const anchorAmount = depositAmount - minerFee
    const inputVector = assembleInputVector(
      sampleFundingTxHash,
      sampleFundingOutputIndex
    )
    const outputVector = assembleP2PKHOutputVector(
      anchorAmount,
      walletPubKeyHash
    )

    beforeEach(async () => {
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        requestNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 1, // Pending
          amount: depositAmount,
        })
      )
    })

    it("should revert if reservation already exists (state != Unknown)", async () => {
      await testReservationProofs.initializeProducerStub(
        sampleReservationKey,
        walletPubKeyHash,
        200000,
        depositor.address,
        depositAmount,
        mockReservationVault.address
      )

      // Set reservation state to Active (1)
      await testReservationProofs.setReservation(
        sampleReservationKey,
        buildReservationRequest({
          owner: depositor.address,
          mintedAmount: depositAmount,
          acceptedAt: 1000,
          walletPubKeyHash,
          anchorAmount,
          expiresAt: 1000 + termSeconds,
          anchorTxHash: sampleAnchorTxHash,
          anchorTxOutputIndex: 0,
          state: 1, // Active
          requestNonce,
          retryCredit: false,
          dissolutionEligibleAt: 1000 + termSeconds + dissolutionDelay,
          cumulativeReanchorFee: 0,
        })
      )

      await expect(
        testReservationProofs.executeAcceptancePipeline(
          inputVector,
          outputVector,
          sampleReservationKey,
          requestNonce,
          sampleAnchorTxHash
        )
      ).to.be.revertedWith("Reservation already exists")
    })

    it("should revert if pending-reserved deposit is missing (not revealed as reserved)", async () => {
      // No producer stub initialized: isReserved = false
      await expect(
        testReservationProofs.executeAcceptancePipeline(
          inputVector,
          outputVector,
          sampleReservationKey,
          requestNonce,
          sampleAnchorTxHash
        )
      ).to.be.revertedWith("Deposit was not revealed as reserved")
    })
  })

  describe("5. End-to-end happy path", () => {
    const requestNonce = 1
    const depositAmount = 100000000 // 1 BTC
    const minerFee = 5000 // 5000 sats
    const anchorAmount = depositAmount - minerFee // 99995000 sats
    const refundDeadline = 200000

    const inputVector = assembleInputVector(
      sampleFundingTxHash,
      sampleFundingOutputIndex
    )
    const outputVector = assembleP2PKHOutputVector(
      anchorAmount,
      walletPubKeyHash
    )

    beforeEach(async () => {
      // Seed reveal-time producer stub
      await testReservationProofs.initializeProducerStub(
        sampleReservationKey,
        walletPubKeyHash,
        refundDeadline,
        depositor.address,
        depositAmount,
        mockReservationVault.address
      )

      // Action record created at request time
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        requestNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 1, // Pending
          amount: depositAmount,
        })
      )

      // Book initial request capacity
      await testReservationProofs.setReservationTotalAmount(depositAmount)
      await testReservationProofs.setWalletReservationsAmount(
        walletPubKeyHash,
        depositAmount
      )
      await testReservationProofs.setWalletReservationsCount(
        walletPubKeyHash,
        1
      )
      await testReservationProofs.setActiveReservationsCount(1)
    })

    it("should successfully execute end-to-end acceptance settlement", async () => {
      const tx = await testReservationProofs.executeAcceptancePipeline(
        inputVector,
        outputVector,
        sampleReservationKey,
        requestNonce,
        sampleAnchorTxHash
      )
      const receipt = await tx.wait()

      // 1. Action state becomes Settled (2)
      const action = await testReservationProofs.getReservationAction(
        sampleReservationKey,
        requestNonce
      )
      expect(action.state).to.equal(2) // Settled

      // 2. Reservation state becomes Active (1)
      const reservation = await testReservationProofs.getReservation(
        sampleReservationKey
      )
      expect(reservation.state).to.equal(1) // Active
      expect(reservation.owner).to.equal(depositor.address)
      expect(reservation.mintedAmount).to.equal(anchorAmount)
      expect(reservation.anchorAmount).to.equal(anchorAmount)
      expect(reservation.walletPubKeyHash).to.equal(walletPubKeyHash)
      expect(reservation.anchorTxHash).to.equal(sampleAnchorTxHash)
      expect(reservation.anchorTxOutputIndex).to.equal(0)

      const currentBlock = await ethers.provider.getBlock(receipt.blockNumber)
      const expectedExpiresAt = currentBlock.timestamp + termSeconds
      const expectedDissolutionAt = expectedExpiresAt + dissolutionDelay
      expect(reservation.expiresAt).to.equal(expectedExpiresAt)
      expect(reservation.dissolutionEligibleAt).to.equal(expectedDissolutionAt)

      // 3. Anchor UTXO indexing
      const anchorUtxoKey = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [sampleAnchorTxHash, 0]
      )
      expect(
        await testReservationProofs.getReservationByAnchorUtxo(anchorUtxoKey)
      ).to.equal(sampleReservationKey)

      // 4. Wallet reservation enumeration
      const walletKeys = await testReservationProofs.getWalletReservationKeys(
        walletPubKeyHash
      )
      expect(walletKeys.length).to.equal(1)
      expect(walletKeys[0]).to.equal(sampleReservationKey)
      // 5. Deposit marked as swept
      const deposit = await testReservationProofs.getDeposit(
        sampleReservationKey
      )
      expect(deposit.sweptAt).to.equal(currentBlock.timestamp)

      // 6. Pending-reserved deposit consumed and counter decremented
      const pendingReserved =
        await testReservationProofs.getPendingReservedDeposit(
          sampleReservationKey
        )
      expect(pendingReserved.walletPubKeyHash).to.equal(
        "0x0000000000000000000000000000000000000000"
      )
      expect(await testReservationProofs.getPendingReservedDeposits()).to.equal(
        0
      )

      // 7. Bank balance of vault increased and vault notified
      expect(await bank.balanceOf(mockReservationVault.address)).to.equal(
        anchorAmount
      )
      expect(await mockReservationVault.totalReceived()).to.equal(anchorAmount)
      expect(await mockReservationVault.getLastDepositors()).to.deep.equal([
        depositor.address,
      ])
      const lastAmounts = await mockReservationVault.getLastAmounts()
      expect(lastAmounts.length).to.equal(1)
      expect(lastAmounts[0]).to.equal(anchorAmount)

      // 8. Capacity difference (miner fee) released
      expect(await testReservationProofs.getReservationTotalAmount()).to.equal(
        anchorAmount
      )
      expect(
        await testReservationProofs.getWalletReservationsAmount(
          walletPubKeyHash
        )
      ).to.equal(anchorAmount)
      expect(
        await testReservationProofs.getWalletReservationsCount(walletPubKeyHash)
      ).to.equal(1)
      expect(await testReservationProofs.getActiveReservationsCount()).to.equal(
        1
      )

      // 9. ReservationAccepted event emitted
      await expect(tx)
        .to.emit(testReservationProofs, "ReservationAccepted")
        .withArgs(
          sampleReservationKey,
          requestNonce,
          walletPubKeyHash,
          depositor.address,
          sampleAnchorTxHash,
          anchorAmount,
          expectedExpiresAt
        )
    })

    it("should accept P2WPKH anchor output vector format", async () => {
      const p2wpkhOutputVector = assembleP2WPKHOutputVector(
        anchorAmount,
        walletPubKeyHash
      )

      const tx = await testReservationProofs.executeAcceptancePipeline(
        inputVector,
        p2wpkhOutputVector,
        sampleReservationKey,
        requestNonce,
        sampleAnchorTxHash
      )
      await tx.wait()

      const reservation = await testReservationProofs.getReservation(
        sampleReservationKey
      )
      expect(reservation.state).to.equal(1) // Active
      expect(reservation.anchorAmount).to.equal(anchorAmount)
    })
  })

  describe("6. Anchor output validation failures", () => {
    const requestNonce = 1
    const depositAmount = 100000000
    const validAnchorAmount = depositAmount - 5000

    beforeEach(async () => {
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        requestNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 1, // Pending
          amount: depositAmount,
        })
      )
    })

    it("should revert if output vector does not have exactly 1 output (0 outputs)", async () => {
      // 0 outputs: VarInt 0
      const emptyOutputVector = "0x00"
      await expect(
        testReservationProofs.parseSingleOutput(emptyOutputVector)
      ).to.be.revertedWith("Reservation transaction must have a single output")
    })

    it("should revert if output vector has >1 outputs", async () => {
      // 2 outputs
      const singleOutput = assembleP2PKHOutputVector(
        validAnchorAmount,
        walletPubKeyHash
      ).substring(4) // remove 0x01
      const multiOutputVector = `0x02${singleOutput}${singleOutput}`
      await expect(
        testReservationProofs.parseSingleOutput(multiOutputVector)
      ).to.be.revertedWith("Reservation transaction must have a single output")
    })

    it("should revert if anchor output pays a different wallet public key hash", async () => {
      const wrongWalletOutputVector = assembleP2PKHOutputVector(
        validAnchorAmount,
        otherWalletPubKeyHash
      )

      await expect(
        testReservationProofs.validateAnchorOutput(
          wrongWalletOutputVector,
          sampleReservationKey,
          requestNonce
        )
      ).to.be.revertedWith("Anchor output must pay the authorized wallet")
    })

    it("should revert if miner fee exceeds snapshotted txMaxFee", async () => {
      // action.amount = 100000000, txMaxFee = 10000. Fee = 15000 (exceeds max fee).
      const highFeeAnchorAmount = depositAmount - 15000
      const highFeeOutputVector = assembleP2PKHOutputVector(
        highFeeAnchorAmount,
        walletPubKeyHash
      )

      await expect(
        testReservationProofs.validateAnchorOutput(
          highFeeOutputVector,
          sampleReservationKey,
          requestNonce
        )
      ).to.be.revertedWith("Transaction fee is too high")
    })
  })

  describe("7. Double-consume and input vector validation", () => {
    const depositAmount = 100000000
    const validAnchorAmount = depositAmount - 5000

    beforeEach(async () => {
      await testReservationProofs.initializeProducerStub(
        sampleReservationKey,
        walletPubKeyHash,
        200000,
        depositor.address,
        depositAmount,
        mockReservationVault.address
      )
    })

    it("should revert if input vector has not exactly 1 input (0 inputs)", async () => {
      const invalidInputVector = `0x00${sampleFundingTxHash.substring(
        2
      )}0000000000ffffffff`
      await expect(
        testReservationProofs.consumeAcceptedDeposit(
          invalidInputVector,
          sampleReservationKey
        )
      ).to.be.revertedWith("Outbound transaction must have a single input")
    })

    it("should revert if input does not spend the reserved deposit (wrong txHash)", async () => {
      const wrongTxHash = `0x${"ff".repeat(32)}`
      const wrongInputVector = assembleInputVector(wrongTxHash, 0)

      await expect(
        testReservationProofs.consumeAcceptedDeposit(
          wrongInputVector,
          sampleReservationKey
        )
      ).to.be.revertedWith("Transaction input must spend the reserved deposit")
    })

    it("should revert if input does not spend the reserved deposit (wrong output index)", async () => {
      const wrongIndexInputVector = assembleInputVector(
        sampleFundingTxHash,
        1 // index 1 instead of 0
      )

      await expect(
        testReservationProofs.consumeAcceptedDeposit(
          wrongIndexInputVector,
          sampleReservationKey
        )
      ).to.be.revertedWith("Transaction input must spend the reserved deposit")
    })

    it("should revert on double-consume (deposit already swept)", async () => {
      const inputVector = assembleInputVector(
        sampleFundingTxHash,
        sampleFundingOutputIndex
      )

      // First consume succeeds
      await testReservationProofs.consumeAcceptedDeposit(
        inputVector,
        sampleReservationKey
      )

      const deposit = await testReservationProofs.getDeposit(
        sampleReservationKey
      )
      expect(deposit.sweptAt).to.be.gt(0)

      // Second consume reverts
      await expect(
        testReservationProofs.consumeAcceptedDeposit(
          inputVector,
          sampleReservationKey
        )
      ).to.be.revertedWith("Deposit already swept")
    })
  })

  describe("8. Late-settle and pending newer generation unwinding", () => {
    const olderNonce = 1
    const newerNonce = 2
    const depositAmount = 100000000
    const minerFee = 5000
    const anchorAmount = depositAmount - minerFee
    const refundDeadline = 200000

    beforeEach(async () => {
      await testReservationProofs.initializeProducerStub(
        sampleReservationKey,
        walletPubKeyHash,
        refundDeadline,
        depositor.address,
        depositAmount,
        mockReservationVault.address
      )
    })

    it("should settle a timed-out older generation without newer generation (late settlement)", async () => {
      // Older generation timed out
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        olderNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 3, // TimedOut
          amount: depositAmount,
        })
      )

      // At timeout, capacity was released (counts were 0)
      await testReservationProofs.setReservationTotalAmount(0)
      await testReservationProofs.setWalletReservationsAmount(
        walletPubKeyHash,
        0
      )
      await testReservationProofs.setWalletReservationsCount(
        walletPubKeyHash,
        0
      )

      // Settle older generation late
      const tx = await testReservationProofs.settleAcceptance(
        sampleReservationKey,
        olderNonce,
        true, // late = true
        sampleAnchorTxHash,
        anchorAmount
      )

      // Action becomes Settled
      const action = await testReservationProofs.getReservationAction(
        sampleReservationKey,
        olderNonce
      )
      expect(action.state).to.equal(2) // Settled

      // Capacity re-taken for actual anchor value
      expect(await testReservationProofs.getReservationTotalAmount()).to.equal(
        anchorAmount
      )
      expect(
        await testReservationProofs.getWalletReservationsAmount(
          walletPubKeyHash
        )
      ).to.equal(anchorAmount)
      expect(
        await testReservationProofs.getWalletReservationsCount(walletPubKeyHash)
      ).to.equal(1)
      expect(await testReservationProofs.getActiveReservationsCount()).to.equal(
        1
      )

      // ReservationLateSettled event emitted
      await expect(tx)
        .to.emit(testReservationProofs, "ReservationLateSettled")
        .withArgs(sampleReservationKey, olderNonce, 1) // Acceptance = 1

      // Reservation becomes Active
      const reservation = await testReservationProofs.getReservation(
        sampleReservationKey
      )
      expect(reservation.state).to.equal(1) // Active
      expect(reservation.anchorAmount).to.equal(anchorAmount)
    })

    it("should unwind pending newer acceptance generation when settling older generation late", async () => {
      // Older generation (nonce 1) is TimedOut
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        olderNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 3, // TimedOut
          amount: depositAmount,
        })
      )

      // Newer generation (nonce 2) is Pending
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        newerNonce,
        buildReservationAction({
          requestedAt: 6000,
          timeoutAt: 10000,
          actionType: 1, // Acceptance
          state: 1, // Pending
          amount: depositAmount,
        })
      )

      // Position's current requestNonce points to newerNonce (2)
      await testReservationProofs.setReservation(
        sampleReservationKey,
        buildReservationRequest({
          owner: ethers.constants.AddressZero,
          mintedAmount: 0,
          acceptedAt: 0,
          walletPubKeyHash: "0x0000000000000000000000000000000000000000",
          anchorAmount: 0,
          expiresAt: 0,
          anchorTxHash: ethers.constants.HashZero,
          anchorTxOutputIndex: 0,
          state: 0, // Unknown
          requestNonce: newerNonce,
          retryCredit: false,
          dissolutionEligibleAt: 0,
          cumulativeReanchorFee: 0,
        })
      )

      // Initial booked capacity for the pending newer generation
      await testReservationProofs.setReservationTotalAmount(depositAmount)
      await testReservationProofs.setWalletReservationsAmount(
        walletPubKeyHash,
        depositAmount
      )
      await testReservationProofs.setWalletReservationsCount(
        walletPubKeyHash,
        1
      )
      await testReservationProofs.setActiveReservationsCount(1)

      // Settle older generation late
      const tx = await testReservationProofs.settleAcceptance(
        sampleReservationKey,
        olderNonce,
        true, // late
        sampleAnchorTxHash,
        anchorAmount
      )

      // Newer action is marked Superseded (5)
      const newerAction = await testReservationProofs.getReservationAction(
        sampleReservationKey,
        newerNonce
      )
      expect(newerAction.state).to.equal(5) // Superseded

      // ReservationActionSuperseded event emitted for newerNonce
      await expect(tx)
        .to.emit(testReservationProofs, "ReservationActionSuperseded")
        .withArgs(sampleReservationKey, newerNonce)

      // Older action is Settled (2)
      const olderAction = await testReservationProofs.getReservationAction(
        sampleReservationKey,
        olderNonce
      )
      expect(olderAction.state).to.equal(2) // Settled

      // ReservationLateSettled event emitted
      await expect(tx)
        .to.emit(testReservationProofs, "ReservationLateSettled")
        .withArgs(sampleReservationKey, olderNonce, 1)

      // Capacity: newer generation unwound (-depositAmount, -1 count),
      // and older generation settled (+anchorAmount, +1 count).
      // Net: reservationTotalAmount = anchorAmount, walletReservationsAmount = anchorAmount, walletReservationsCount = 1, activeReservationsCount = 1
      expect(await testReservationProofs.getReservationTotalAmount()).to.equal(
        anchorAmount
      )
      expect(
        await testReservationProofs.getWalletReservationsAmount(
          walletPubKeyHash
        )
      ).to.equal(anchorAmount)
      expect(
        await testReservationProofs.getWalletReservationsCount(walletPubKeyHash)
      ).to.equal(1)
      expect(await testReservationProofs.getActiveReservationsCount()).to.equal(
        1
      )

      // Reservation position becomes Active on older anchor
      const reservation = await testReservationProofs.getReservation(
        sampleReservationKey
      )
      expect(reservation.state).to.equal(1) // Active
      expect(reservation.anchorAmount).to.equal(anchorAmount)
    })

    it("should revert if unwindPendingAction is called on non-pending action", async () => {
      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        olderNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 2, // Settled (not Pending)
          amount: depositAmount,
        })
      )

      await testReservationProofs.setReservation(
        sampleReservationKey,
        buildReservationRequest({
          owner: ethers.constants.AddressZero,
          mintedAmount: 0,
          acceptedAt: 0,
          walletPubKeyHash: "0x0000000000000000000000000000000000000000",
          anchorAmount: 0,
          expiresAt: 0,
          anchorTxHash: ethers.constants.HashZero,
          anchorTxOutputIndex: 0,
          state: 0,
          requestNonce: olderNonce,
          retryCredit: false,
          dissolutionEligibleAt: 0,
          cumulativeReanchorFee: 0,
        })
      )

      await expect(
        testReservationProofs.unwindPendingAction(sampleReservationKey, false)
      ).to.be.revertedWith("No pending action to unwind")
    })

    it("should unwind pending redemption and refund escrow balance", async () => {
      const redemptionNonce = 1
      const escrowAmount = 50000000

      // Fund test contract in bank so it can transfer balance
      await bank.connect(deployer).updateBridge(deployer.address)
      await bank
        .connect(deployer)
        .increaseBalance(testReservationProofs.address, escrowAmount)
      await bank.connect(deployer).updateBridge(testReservationProofs.address)

      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        redemptionNonce,
        buildReservationAction({
          targetWalletPubKeyHash: "0x0000000000000000000000000000000000000000",
          actionType: 2, // Redemption
          state: 1, // Pending
          feePaid: true,
          redeemer: redeemer.address,
          amount: escrowAmount,
          usedRetryCredit: true,
        })
      )

      await testReservationProofs.setReservation(
        sampleReservationKey,
        buildReservationRequest({
          owner: depositor.address,
          mintedAmount: depositAmount,
          acceptedAt: 1000,
          walletPubKeyHash,
          anchorAmount: depositAmount,
          expiresAt: 1000 + termSeconds,
          anchorTxHash: sampleAnchorTxHash,
          anchorTxOutputIndex: 0,
          state: 2, // ActionPending
          requestNonce: redemptionNonce,
          retryCredit: false,
          dissolutionEligibleAt: 1000 + termSeconds + dissolutionDelay,
          cumulativeReanchorFee: 0,
        })
      )

      // Unwind redemption with restoreRetryCredit = true
      const tx = await testReservationProofs.unwindPendingAction(
        sampleReservationKey,
        true
      )

      // Balance refunded to redeemer
      expect(await bank.balanceOf(redeemer.address)).to.equal(escrowAmount)

      // Retry credit restored
      const reservation = await testReservationProofs.getReservation(
        sampleReservationKey
      )
      expect(reservation.retryCredit).to.be.true

      // Events emitted
      await expect(tx)
        .to.emit(testReservationProofs, "ReservationRetryCreditMinted")
        .withArgs(sampleReservationKey)
      await expect(tx)
        .to.emit(testReservationProofs, "ReservationActionSuperseded")
        .withArgs(sampleReservationKey, redemptionNonce)
    })

    it("should unwind pending reanchor action", async () => {
      const reanchorNonce = 1
      const reanchorTargetWallet = `0x${"33".repeat(20)}`

      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        reanchorNonce,
        buildReservationAction({
          targetWalletPubKeyHash: reanchorTargetWallet,
          actionType: 3, // Reanchor
          state: 1, // Pending
          amount: depositAmount,
        })
      )

      await testReservationProofs.setReservation(
        sampleReservationKey,
        buildReservationRequest({
          owner: depositor.address,
          mintedAmount: depositAmount,
          acceptedAt: 1000,
          walletPubKeyHash,
          anchorAmount: depositAmount,
          expiresAt: 1000 + termSeconds,
          anchorTxHash: sampleAnchorTxHash,
          anchorTxOutputIndex: 0,
          state: 2, // ActionPending
          requestNonce: reanchorNonce,
          retryCredit: false,
          dissolutionEligibleAt: 1000 + termSeconds + dissolutionDelay,
          cumulativeReanchorFee: 0,
        })
      )

      await testReservationProofs.setWalletReservationsCount(
        reanchorTargetWallet,
        1
      )
      await testReservationProofs.setWalletReservationsAmount(
        reanchorTargetWallet,
        depositAmount
      )

      await testReservationProofs.unwindPendingAction(
        sampleReservationKey,
        false
      )

      expect(
        await testReservationProofs.getWalletReservationsCount(
          reanchorTargetWallet
        )
      ).to.equal(0)
      expect(
        await testReservationProofs.getWalletReservationsAmount(
          reanchorTargetWallet
        )
      ).to.equal(0)
    })

    it("should unwind pending dissolution action", async () => {
      const dissolutionNonce = 1

      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        dissolutionNonce,
        buildReservationAction({
          targetWalletPubKeyHash: walletPubKeyHash,
          actionType: 4, // Dissolution
          state: 1, // Pending
          amount: depositAmount,
        })
      )

      await testReservationProofs.setReservation(
        sampleReservationKey,
        buildReservationRequest({
          owner: depositor.address,
          mintedAmount: depositAmount,
          acceptedAt: 1000,
          walletPubKeyHash,
          anchorAmount: depositAmount,
          expiresAt: 1000 + termSeconds,
          anchorTxHash: sampleAnchorTxHash,
          anchorTxOutputIndex: 0,
          state: 2, // ActionPending
          requestNonce: dissolutionNonce,
          retryCredit: false,
          dissolutionEligibleAt: 1000 + termSeconds + dissolutionDelay,
          cumulativeReanchorFee: 0,
        })
      )

      await testReservationProofs.setWalletPendingDissolution(
        walletPubKeyHash,
        sampleReservationKey
      )

      await testReservationProofs.unwindPendingAction(
        sampleReservationKey,
        false
      )

      expect(
        await testReservationProofs.getWalletPendingDissolution(
          walletPubKeyHash
        )
      ).to.equal(0)
    })
  })

  describe("9. Strand flow on late settlement against closed/closing wallet", () => {
    const requestNonce = 1
    const depositAmount = 100000000
    const minerFee = 5000
    const anchorAmount = depositAmount - minerFee

    beforeEach(async () => {
      await testReservationProofs.initializeProducerStub(
        sampleReservationKey,
        walletPubKeyHash,
        200000,
        depositor.address,
        depositAmount,
        mockReservationVault.address
      )

      await testReservationProofs.setReservationAction(
        sampleReservationKey,
        requestNonce,
        buildReservationAction({
          actionType: 1, // Acceptance
          state: 3, // TimedOut
          amount: depositAmount,
        })
      )
    })

    it("should strand if wallet is Closing/Closed even when late = false (on-time proof)", async () => {
      // WalletState.Closed = 4
      await testReservationProofs.setWalletState(walletPubKeyHash, 4)

      // Setup active reservation
      await testReservationProofs.setReservation(
        sampleReservationKey,
        buildReservationRequest({
          owner: depositor.address,
          mintedAmount: anchorAmount,
          acceptedAt: 1000,
          walletPubKeyHash,
          anchorAmount,
          expiresAt: 1000 + termSeconds,
          anchorTxHash: sampleAnchorTxHash,
          anchorTxOutputIndex: 0,
          state: 1, // Active
          requestNonce,
          retryCredit: false,
          dissolutionEligibleAt: 1000 + termSeconds + dissolutionDelay,
          cumulativeReanchorFee: 0,
        })
      )

      await testReservationProofs.setWalletReservationsCount(
        walletPubKeyHash,
        1
      )
      await testReservationProofs.setWalletReservationsAmount(
        walletPubKeyHash,
        anchorAmount
      )
      await testReservationProofs.setReservationTotalAmount(anchorAmount)
      await testReservationProofs.setActiveReservationsCount(1)
      await testReservationProofs.addWalletReservationKey(
        walletPubKeyHash,
        sampleReservationKey
      )

      // Call strand hook with late = false: an honest on-time proof must
      // still strand against a wallet that left Live while the proof was
      // pending, exactly like the late path does.
      await testReservationProofs.strandLateSettlementIfTargetWalletClosed(
        sampleReservationKey,
        false
      )

      // Reservation becomes Stranded, not left Active
      const reservation = await testReservationProofs.getReservation(
        sampleReservationKey
      )
      expect(reservation.state).to.equal(4) // Stranded
      expect(await testReservationProofs.getActiveReservationsCount()).to.equal(
        0
      )
    })

    it("should not strand on late settlement if wallet is Live (1)", async () => {
      // WalletState.Live = 1
      await testReservationProofs.setWalletState(walletPubKeyHash, 1)

      await testReservationProofs.setReservation(
        sampleReservationKey,
        buildReservationRequest({
          owner: depositor.address,
          mintedAmount: anchorAmount,
          acceptedAt: 1000,
          walletPubKeyHash,
          anchorAmount,
          expiresAt: 1000 + termSeconds,
          anchorTxHash: sampleAnchorTxHash,
          anchorTxOutputIndex: 0,
          state: 1, // Active
          requestNonce,
          retryCredit: false,
          dissolutionEligibleAt: 1000 + termSeconds + dissolutionDelay,
          cumulativeReanchorFee: 0,
        })
      )

      await testReservationProofs.strandLateSettlementIfTargetWalletClosed(
        sampleReservationKey,
        false
      )

      const reservation = await testReservationProofs.getReservation(
        sampleReservationKey
      )
      expect(reservation.state).to.equal(1) // Active
    })

    it("should not strand on late settlement if wallet is MovingFunds (2)", async () => {
      // WalletState.MovingFunds = 2
      await testReservationProofs.setWalletState(walletPubKeyHash, 2)

      await testReservationProofs.setReservation(
        sampleReservationKey,
        buildReservationRequest({
          owner: depositor.address,
          mintedAmount: anchorAmount,
          acceptedAt: 1000,
          walletPubKeyHash,
          anchorAmount,
          expiresAt: 1000 + termSeconds,
          anchorTxHash: sampleAnchorTxHash,
          anchorTxOutputIndex: 0,
          state: 1, // Active
          requestNonce,
          retryCredit: false,
          dissolutionEligibleAt: 1000 + termSeconds + dissolutionDelay,
          cumulativeReanchorFee: 0,
        })
      )

      await testReservationProofs.strandLateSettlementIfTargetWalletClosed(
        sampleReservationKey,
        false
      )

      const reservation = await testReservationProofs.getReservation(
        sampleReservationKey
      )
      expect(reservation.state).to.equal(1) // Active
    })

    it("should strand on late settlement if wallet is Closing (3)", async () => {
      // WalletState.Closing = 3
      await testReservationProofs.setWalletState(walletPubKeyHash, 3)

      // Setup counts and wallet keys as settleAcceptance would have set them
      await testReservationProofs.setReservation(
        sampleReservationKey,
        buildReservationRequest({
          owner: depositor.address,
          mintedAmount: anchorAmount,
          acceptedAt: 1000,
          walletPubKeyHash,
          anchorAmount,
          expiresAt: 1000 + termSeconds,
          anchorTxHash: sampleAnchorTxHash,
          anchorTxOutputIndex: 0,
          state: 1, // Active
          requestNonce,
          retryCredit: false,
          dissolutionEligibleAt: 1000 + termSeconds + dissolutionDelay,
          cumulativeReanchorFee: 0,
        })
      )

      await testReservationProofs.setWalletReservationsCount(
        walletPubKeyHash,
        1
      )
      await testReservationProofs.setWalletReservationsAmount(
        walletPubKeyHash,
        anchorAmount
      )
      await testReservationProofs.setReservationTotalAmount(anchorAmount)
      await testReservationProofs.setActiveReservationsCount(1)
      await testReservationProofs.addWalletReservationKey(
        walletPubKeyHash,
        sampleReservationKey
      )

      const tx =
        await testReservationProofs.strandLateSettlementIfTargetWalletClosed(
          sampleReservationKey,
          false // evidenceAlreadyEmitted = false
        )

      // State becomes Stranded (4)
      const reservation = await testReservationProofs.getReservation(
        sampleReservationKey
      )
      expect(reservation.state).to.equal(4) // Stranded

      // Counts decremented
      expect(
        await testReservationProofs.getWalletReservationsCount(walletPubKeyHash)
      ).to.equal(0)
      expect(
        await testReservationProofs.getWalletReservationsAmount(
          walletPubKeyHash
        )
      ).to.equal(0)
      expect(await testReservationProofs.getReservationTotalAmount()).to.equal(
        0
      )
      expect(await testReservationProofs.getActiveReservationsCount()).to.equal(
        0
      )

      // Wallet reservation key removed
      const walletKeys = await testReservationProofs.getWalletReservationKeys(
        walletPubKeyHash
      )
      expect(walletKeys).to.deep.equal([])

      // ReservationStranded event emitted
      await expect(tx)
        .to.emit(testReservationProofs, "ReservationStranded")
        .withArgs(
          sampleReservationKey,
          walletPubKeyHash,
          depositor.address,
          anchorAmount
        )
    })

    it("should strand on late settlement if wallet is Closed (4)", async () => {
      // WalletState.Closed = 4
      await testReservationProofs.setWalletState(walletPubKeyHash, 4)

      await testReservationProofs.setReservation(
        sampleReservationKey,
        buildReservationRequest({
          owner: depositor.address,
          mintedAmount: anchorAmount,
          acceptedAt: 1000,
          walletPubKeyHash,
          anchorAmount,
          expiresAt: 1000 + termSeconds,
          anchorTxHash: sampleAnchorTxHash,
          anchorTxOutputIndex: 0,
          state: 1, // Active
          requestNonce,
          retryCredit: false,
          dissolutionEligibleAt: 1000 + termSeconds + dissolutionDelay,
          cumulativeReanchorFee: 0,
        })
      )

      await testReservationProofs.setWalletReservationsCount(
        walletPubKeyHash,
        1
      )
      await testReservationProofs.setWalletReservationsAmount(
        walletPubKeyHash,
        anchorAmount
      )
      await testReservationProofs.setReservationTotalAmount(anchorAmount)
      await testReservationProofs.setActiveReservationsCount(1)
      await testReservationProofs.addWalletReservationKey(
        walletPubKeyHash,
        sampleReservationKey
      )

      const tx =
        await testReservationProofs.strandLateSettlementIfTargetWalletClosed(
          sampleReservationKey,
          false
        )

      const reservation = await testReservationProofs.getReservation(
        sampleReservationKey
      )
      expect(reservation.state).to.equal(4) // Stranded
      expect(
        await testReservationProofs.getWalletReservationsCount(walletPubKeyHash)
      ).to.equal(0)

      await expect(tx)
        .to.emit(testReservationProofs, "ReservationStranded")
        .withArgs(
          sampleReservationKey,
          walletPubKeyHash,
          depositor.address,
          anchorAmount
        )
    })

    it("should strand during full late settleAcceptance against Closed wallet", async () => {
      // WalletState.Closed = 4
      await testReservationProofs.setWalletState(walletPubKeyHash, 4)
      await testReservationProofs.setActiveReservationsCount(1)

      const tx = await testReservationProofs.settleAcceptance(
        sampleReservationKey,
        requestNonce,
        true, // late = true
        sampleAnchorTxHash,
        anchorAmount
      )

      // Reservation ends in Stranded state
      const reservation = await testReservationProofs.getReservation(
        sampleReservationKey
      )
      expect(reservation.state).to.equal(4) // Stranded

      // Both ReservationAccepted and ReservationStranded emitted
      await expect(tx).to.emit(testReservationProofs, "ReservationAccepted")
      await expect(tx).to.emit(testReservationProofs, "ReservationStranded")
    })

    it("should handle Terminated wallet with evidenceAlreadyEmitted = true without duplicate event", async () => {
      // WalletState.Terminated = 5
      await testReservationProofs.setWalletState(walletPubKeyHash, 5)

      await testReservationProofs.setReservation(
        sampleReservationKey,
        buildReservationRequest({
          owner: depositor.address,
          mintedAmount: anchorAmount,
          acceptedAt: 1000,
          walletPubKeyHash,
          anchorAmount,
          expiresAt: 1000 + termSeconds,
          anchorTxHash: sampleAnchorTxHash,
          anchorTxOutputIndex: 0,
          state: 1, // Active
          requestNonce,
          retryCredit: false,
          dissolutionEligibleAt: 1000 + termSeconds + dissolutionDelay,
          cumulativeReanchorFee: 0,
        })
      )

      await testReservationProofs.setWalletReservationsCount(
        walletPubKeyHash,
        1
      )
      await testReservationProofs.setWalletReservationsAmount(
        walletPubKeyHash,
        anchorAmount
      )
      await testReservationProofs.setReservationTotalAmount(anchorAmount)
      await testReservationProofs.setActiveReservationsCount(1)
      await testReservationProofs.addWalletReservationKey(
        walletPubKeyHash,
        sampleReservationKey
      )

      // When evidenceAlreadyEmitted is true, strandLateSettlementIfTargetWalletClosed strands but does not emit duplicate event
      const tx =
        await testReservationProofs.strandLateSettlementIfTargetWalletClosed(
          sampleReservationKey,
          true // evidenceAlreadyEmitted = true
        )

      const reservation = await testReservationProofs.getReservation(
        sampleReservationKey
      )
      expect(reservation.state).to.equal(4) // Stranded

      // Should NOT emit duplicate ReservationStranded event
      await expect(tx).to.not.emit(testReservationProofs, "ReservationStranded")
    })
  })
  describe("10. End-to-end SPV validation through the real production entry point (Fix 8)", () => {
    const data = SingleP2SHDeposit
    const { fundingTx, reveal } = data.deposits[0]
    const anchorReservationKey = ethers.utils.solidityKeccak256(
      ["bytes32", "uint32"],
      [fundingTx.hash, reveal.fundingOutputIndex]
    )
    const anchorAmount = 18500 // value of the SingleP2SHDeposit sweepTx's single output

    beforeEach(async () => {
      await testReservationProofs.setWalletState(reveal.walletPubKeyHash, 1) // Live
      await testReservationProofs.initializeProducerStub(
        anchorReservationKey,
        reveal.walletPubKeyHash,
        2000000000, // refundDeadline: unused by the settlement path under test
        depositor.address,
        anchorAmount,
        mockReservationVault.address
      )
      await testReservationProofs.setReservationAction(
        anchorReservationKey,
        1,
        buildReservationAction({
          targetWalletPubKeyHash: reveal.walletPubKeyHash,
          amount: anchorAmount,
          txMaxFee: 0,
        })
      )
      relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
      relay.getPrevEpochDifficulty.returns(data.chainDifficulty)
    })

    it("should settle through submitReservationProof with a real, valid SPV proof", async () => {
      const tx = await testReservationProofs.submitReservationProof(
        0, // ProofType.Acceptance
        data.sweepTx,
        data.sweepProof,
        data.mainUtxo,
        anchorReservationKey,
        1
      )

      await expect(tx).to.emit(testReservationProofs, "ReservationAccepted")
      const reservation = await testReservationProofs.getReservation(
        anchorReservationKey
      )
      expect(reservation.state).to.equal(1) // Active
      expect(reservation.anchorAmount).to.equal(anchorAmount)
      expect(await mockReservationVault.totalReceived()).to.equal(anchorAmount)
    })

    it("should revert with no state mutation when the SPV merkle proof is tampered with", async () => {
      const tamperedProof = {
        ...data.sweepProof,
        merkleProof: "0x00",
      }

      await expect(
        testReservationProofs.submitReservationProof(
          0,
          data.sweepTx,
          tamperedProof,
          data.mainUtxo,
          anchorReservationKey,
          1
        )
      ).to.be.reverted

      const reservation = await testReservationProofs.getReservation(
        anchorReservationKey
      )
      expect(reservation.state).to.equal(0) // still Unknown, no mutation
      expect(await mockReservationVault.totalReceived()).to.equal(0)
    })
  })

  describe("11. Vault-routing regression test (Fix 9)", () => {
    it("should credit the deposit's immutable vault, not a reservationVault repointed mid-flight", async () => {
      const MockReservationVaultFactory = await ethers.getContractFactory(
        "MockReservationVault"
      )
      const vaultA = (await MockReservationVaultFactory.connect(
        deployer
      ).deploy(bank.address)) as MockReservationVault
      const vaultB = (await MockReservationVaultFactory.connect(
        deployer
      ).deploy(bank.address)) as MockReservationVault
      await testReservationProofs.setVaultTrusted(vaultA.address, true)
      await testReservationProofs.setVaultTrusted(vaultB.address, true)

      const routingFundingTxHash = `0x${"cc".repeat(32)}`
      const routingFundingOutputIndex = 0
      const routingReservationKey = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [routingFundingTxHash, routingFundingOutputIndex]
      )
      const depositAmount = 100000000
      const minerFee = 5000
      const anchorAmount = depositAmount - minerFee
      const routingInputVector = assembleInputVector(
        routingFundingTxHash,
        routingFundingOutputIndex
      )
      const routingOutputVector = assembleP2PKHOutputVector(
        anchorAmount,
        walletPubKeyHash
      )

      await testReservationProofs.initializeProducerStub(
        routingReservationKey,
        walletPubKeyHash,
        2000000000,
        depositor.address,
        depositAmount,
        vaultA.address // the deposit's immutable, reveal-time vault
      )
      await testReservationProofs.setReservationAction(
        routingReservationKey,
        1,
        buildReservationAction({
          targetWalletPubKeyHash: walletPubKeyHash,
          amount: depositAmount,
          txMaxFee: minerFee,
        })
      )
      // Governance re-points the live reservation vault after the request but
      // before settlement.
      await testReservationProofs.setReservationVault(vaultB.address)
      await testReservationProofs.setReservationTotalAmount(depositAmount)
      await testReservationProofs.setWalletReservationsAmount(
        walletPubKeyHash,
        depositAmount
      )
      await testReservationProofs.setWalletReservationsCount(
        walletPubKeyHash,
        1
      )
      await testReservationProofs.setActiveReservationsCount(1)

      await testReservationProofs.executeAcceptancePipeline(
        routingInputVector,
        routingOutputVector,
        routingReservationKey,
        1,
        sampleAnchorTxHash
      )

      expect(await vaultA.totalReceived()).to.equal(anchorAmount)
      expect(await vaultB.totalReceived()).to.equal(0)
    })
  })

  describe("12. Idempotency guard for consumeAcceptedDeposit (Fix 10)", () => {
    it("should not double-decrement pendingReservedDeposits when the pending marker is already cleared", async () => {
      const idempotencyFundingTxHash = `0x${"dd".repeat(32)}`
      const idempotencyFundingOutputIndex = 0
      const reservationKey = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [idempotencyFundingTxHash, idempotencyFundingOutputIndex]
      )
      const inputVector = assembleInputVector(
        idempotencyFundingTxHash,
        idempotencyFundingOutputIndex
      )

      await testReservationProofs.setDeposit(reservationKey, {
        depositor: depositor.address,
        amount: 100000000,
        revealedAt: 1000,
        vault: mockReservationVault.address,
        treasuryFee: 0,
        sweptAt: 0,
        extraData: ethers.constants.HashZero,
      })
      // Pre-clear the pending marker's walletPubKeyHash to zero while
      // sweptAt stays 0 -- the stale-notification-already-released-it
      // scenario the idempotency guard exists for.
      await testReservationProofs.setPendingReservedDeposit(reservationKey, {
        isReserved: true,
        walletPubKeyHash: `0x${"00".repeat(20)}`,
        refundDeadline: 1000,
        refundDeadlineValidated: true,
      })
      await testReservationProofs.setPendingReservedDeposits(1)

      await testReservationProofs.consumeAcceptedDeposit(
        inputVector,
        reservationKey
      )

      // The already-cleared marker must not cause a second decrement.
      expect(await testReservationProofs.getPendingReservedDeposits()).to.equal(
        1
      )
      const deposit = await testReservationProofs.getDeposit(reservationKey)
      expect(deposit.sweptAt).to.not.equal(0) // sweep is still recorded
    })
  })
})
