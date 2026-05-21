import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { randomBytes } from "crypto"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, ContractTransaction } from "ethers"
import {
  IWormhole,
  IWormholeTokenBridge,
  MockL1BTCRedeemerWormhole,
  MockBank,
  MockTBTCBridge,
  L2TBTC,
  ReimbursementPool,
  WormholeBridgeStub,
  MockTBTCVault,
  TestL1BTCRedeemerWormhole,
  TestERC20,
} from "../../../typechain"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

// Helper functions for TBTC/satoshi conversions
const SATOSHI_MULTIPLIER = ethers.BigNumber.from(10).pow(10)
const toSatoshis = (tbtcAmount: BigNumber) => tbtcAmount.div(SATOSHI_MULTIPLIER)
const toTBTC = (satoshiAmount: BigNumber) =>
  satoshiAmount.mul(SATOSHI_MULTIPLIER)

describe("L1BTCRedeemerWormhole (using Mock)", () => {
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let relayer: SignerWithAddress
  let anotherRelayer: SignerWithAddress

  let l1BtcRedeemer: MockL1BTCRedeemerWormhole
  let tbtcToken: L2TBTC
  let wormholeTokenBridge: FakeContract<IWormholeTokenBridge>
  let bridge: MockTBTCBridge
  let reimbursementPool: FakeContract<ReimbursementPool>
  let bank: MockBank
  let tbtcVault: MockTBTCVault

  let thirdParty: SignerWithAddress
  let treasury: SignerWithAddress

  const exampleAmount = ethers.utils.parseUnits("2", 18) // 2 TBTC with 18 decimals
  const exampleAmountInSatoshis = toSatoshis(exampleAmount) // Convert to satoshis
  const exampleRedeemerOutputScript =
    "0x1976a9140102030405060708090a0b0c0d0e0f101112131488ac"
  const exampleWalletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const exampleMainUtxo = {
    txHash:
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    txOutputIndex: 0,
    txOutputValue: exampleAmountInSatoshis.add(500000).add(10000).toNumber(), // value > amount + estimated fees
  }

  // Additional example output scripts for testing
  const exampleP2WPKHOutputScript =
    "0x1600140102030405060708090a0b0c0d0e0f1011121314"
  const exampleP2SHOutputScript =
    "0x17a9140102030405060708090a0b0c0d0e0f101112131487"
  const exampleP2WSHOutputScript =
    "0x2200200102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

  const contractsFixture = async () => {
    const _signers = await ethers.getSigners()
    const _deployer = _signers[0]
    const _user = _signers[1]
    const _thirdParty = _signers[2]
    const _treasury = _signers[3]
    const _anotherRelayer = _signers[5]
    const _namedSigners = await helpers.signers.getNamedSigners()
    const _governance = _namedSigners.governance || _signers[4]

    // Deploy mock contracts
    const MockBankFactory = await ethers.getContractFactory("MockBank")
    const _bank = (await MockBankFactory.deploy()) as MockBank
    await _bank.deployed()

    // Deploy mock TBTC vault
    const MockTBTCVaultFactory = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    const _tbtcVault = (await MockTBTCVaultFactory.deploy()) as MockTBTCVault
    await _tbtcVault.deployed()

    //
    // Deploy test token as the Wormhole Bridge L2 tBTC representation.
    //
    const TestERC20 = await ethers.getContractFactory("TestERC20")
    const _wormholeTbtc = await TestERC20.deploy()
    await _wormholeTbtc.deployed()

    //
    // Deploy stub of the Wormhole Bridge contract.
    // Stub contract is used instead of a smock because of the token transfer
    // that needs to happen in completeTransferWithPayload function.
    //
    const WormholeBridgeStubFactory = await ethers.getContractFactory(
      "WormholeBridgeStub"
    )
    const _wormholeBridgeStub = await WormholeBridgeStubFactory.deploy(
      _wormholeTbtc.address
    )
    await _wormholeBridgeStub.deployed()
    const MockTBTCBridgeFactory = await ethers.getContractFactory(
      "MockTBTCBridge"
    )
    const _bridge = (await MockTBTCBridgeFactory.deploy()) as MockTBTCBridge
    await _bridge.deployed()

    const tbtcDeployment = await helpers.upgrades.deployProxy(
      `L2TBTC_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L2TBTC",
        initializerArgs: ["L2 TBTC", "L2TBTC"],
        factoryOpts: { signer: _deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    const _tbtcToken = tbtcDeployment[0] as L2TBTC

    // The deployer of L2TBTC is its owner. The owner needs to add itself as a minter.
    await _tbtcToken.connect(_deployer).addMinter(_deployer.address)
    await _tbtcToken.deployed()

    // Set the tbtcToken on the MockTBTCVault
    await _tbtcVault.setTbtcToken(_tbtcToken.address)

    const _wormholeTokenBridge = await smock.fake<IWormholeTokenBridge>(
      "IWormholeTokenBridge"
    )
    const _reimbursementPool = await smock.fake<ReimbursementPool>(
      "ReimbursementPool"
    )

    // Deploy MockL1BTCRedeemerWormhole
    const l1BtcRedeemerWormholeDeployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `MockL1BTCRedeemerWormhole_${randomBytes(8).toString("hex")}`,
      {
        contractName: "MockL1BTCRedeemerWormhole",
        initializerArgs: [
          _bridge.address,
          _wormholeTokenBridge.address,
          _tbtcToken.address,
          _bank.address,
          _tbtcVault.address,
        ],
        factoryOpts: { signer: _deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    const _l1BtcRedeemer =
      l1BtcRedeemerWormholeDeployment[0] as MockL1BTCRedeemerWormhole

    const currentOwner = await _l1BtcRedeemer.owner()
    console.log(
      `L2BTCRedeemerWormhole owner after deploy: ${currentOwner}, deployer: ${_deployer.address}`
    )

    // Transfer ownership from the deployer (initial owner) to governance
    await _l1BtcRedeemer
      .connect(_deployer)
      .transferOwnership(_governance.address)
    await _bank.setBalance(
      _l1BtcRedeemer.address,
      exampleAmountInSatoshis.mul(5)
    ) // Ensure bank has ample balance

    return {
      deployer: _deployer,
      governance: _governance,
      relayer: _user,
      anotherRelayer: _anotherRelayer,
      thirdParty: _thirdParty,
      treasury: _treasury,
      l1BtcRedeemer: _l1BtcRedeemer,
      wormholeTokenBridge: _wormholeTokenBridge,
      bridge: _bridge,
      reimbursementPool: _reimbursementPool,
      bank: _bank,
      tbtcVault: _tbtcVault,
      tbtcToken: _tbtcToken,
    }
  }

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      relayer,
      anotherRelayer,
      thirdParty,
      treasury,
      l1BtcRedeemer,
      wormholeTokenBridge,
      bridge,
      reimbursementPool,
      bank,
      tbtcToken,
      tbtcVault,
    } = await waffle.loadFixture(contractsFixture))
  })

  describe("initialization", () => {
    it("should set the Bridge address", async () => {
      expect(await l1BtcRedeemer.thresholdBridge()).to.equal(bridge.address)
    })

    it("should set the Wormhole Token Bridge address", async () => {
      expect(await l1BtcRedeemer.wormholeTokenBridge()).to.equal(
        wormholeTokenBridge.address
      )
    })

    it("should set the tBTC token address", async () => {
      expect(await l1BtcRedeemer.tbtcToken()).to.equal(tbtcToken.address)
    })

    it("should set the bank address", async () => {
      expect(await l1BtcRedeemer.bank()).to.equal(bank.address)
    })

    it("should set the owner to governance", async () => {
      expect(await l1BtcRedeemer.owner()).to.equal(governance.address)
    })

    it("should set the default request redemption gas offset", async () => {
      expect(await l1BtcRedeemer.requestRedemptionGasOffset()).to.equal(60000)
    })

    it("should initialize with no reimbursement pool", async () => {
      expect(await l1BtcRedeemer.reimbursementPool()).to.equal(
        ethers.constants.AddressZero
      )
    })
  })

  describe("updateGasOffsetParameters", () => {
    const newGasOffset = 70000

    context("when called by a non-owner", () => {
      it("should revert", async () => {
        await expect(
          l1BtcRedeemer.connect(relayer).updateGasOffsetParameters(newGasOffset)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await l1BtcRedeemer
          .connect(governance)
          .updateGasOffsetParameters(newGasOffset)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the gas offset", async () => {
        expect(await l1BtcRedeemer.requestRedemptionGasOffset()).to.equal(
          newGasOffset
        )
      })

      it("should emit GasOffsetParametersUpdated event", async () => {
        await expect(tx)
          .to.emit(l1BtcRedeemer, "GasOffsetParametersUpdated")
          .withArgs(newGasOffset)
      })
    })

    context("when setting gas offset to zero", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await l1BtcRedeemer
          .connect(governance)
          .updateGasOffsetParameters(0)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should allow setting gas offset to zero", async () => {
        expect(await l1BtcRedeemer.requestRedemptionGasOffset()).to.equal(0)
      })
    })

    context("when setting gas offset to a very high value", () => {
      const veryHighGasOffset = 100000

      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await l1BtcRedeemer
          .connect(governance)
          .updateGasOffsetParameters(veryHighGasOffset)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should allow setting high gas offset", async () => {
        expect(await l1BtcRedeemer.requestRedemptionGasOffset()).to.equal(
          veryHighGasOffset
        )
      })
    })
  })

  describe("updateReimbursementAuthorization", () => {
    context("when called by a non-owner", () => {
      it("should revert", async () => {
        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .updateReimbursementAuthorization(relayer.address, true)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementAuthorization(relayer.address, true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the authorization", async () => {
        expect(await l1BtcRedeemer.reimbursementAuthorizations(relayer.address))
          .to.be.true
      })

      it("should emit ReimbursementAuthorizationUpdated event", async () => {
        await expect(tx)
          .to.emit(l1BtcRedeemer, "ReimbursementAuthorizationUpdated")
          .withArgs(relayer.address, true)
      })
    })

    context("when revoking authorization", () => {
      let authorizeTx: ContractTransaction
      let revokeTx: ContractTransaction

      before(async () => {
        await createSnapshot()
        authorizeTx = await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementAuthorization(relayer.address, true)
        revokeTx = await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementAuthorization(relayer.address, false)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revoke the authorization", async () => {
        expect(await l1BtcRedeemer.reimbursementAuthorizations(relayer.address))
          .to.be.false
      })

      it("should emit ReimbursementAuthorizationUpdated event for revocation", async () => {
        await expect(revokeTx)
          .to.emit(l1BtcRedeemer, "ReimbursementAuthorizationUpdated")
          .withArgs(relayer.address, false)
      })
    })

    context("when authorizing multiple relayers", () => {
      before(async () => {
        await createSnapshot()
        await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementAuthorization(relayer.address, true)
        await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementAuthorization(anotherRelayer.address, true)
        await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementAuthorization(thirdParty.address, false)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should track multiple authorizations correctly", async () => {
        expect(await l1BtcRedeemer.reimbursementAuthorizations(relayer.address))
          .to.be.true
        expect(
          await l1BtcRedeemer.reimbursementAuthorizations(
            anotherRelayer.address
          )
        ).to.be.true
        expect(
          await l1BtcRedeemer.reimbursementAuthorizations(thirdParty.address)
        ).to.be.false
      })
    })
  })

  describe("updateReimbursementPool", () => {
    context("when called by a non-owner", () => {
      it("should revert", async () => {
        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .updateReimbursementPool(reimbursementPool.address)
        ).to.be.revertedWith("Caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementPool(reimbursementPool.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the reimbursement pool", async () => {
        expect(await l1BtcRedeemer.reimbursementPool()).to.equal(
          reimbursementPool.address
        )
      })

      it("should emit ReimbursementPoolUpdated event", async () => {
        await expect(tx)
          .to.emit(l1BtcRedeemer, "ReimbursementPoolUpdated")
          .withArgs(reimbursementPool.address)
      })
    })

    context("when removing reimbursement pool", () => {
      before(async () => {
        await createSnapshot()
        await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementPool(reimbursementPool.address)
        await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementPool(ethers.constants.AddressZero)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should allow removing the reimbursement pool", async () => {
        expect(await l1BtcRedeemer.reimbursementPool()).to.equal(
          ethers.constants.AddressZero
        )
      })
    })
  })

  describe("updateAllowedSender", () => {
    const exampleSender = ethers.utils.hexZeroPad("0x1234", 32)
    const anotherSender = ethers.utils.hexZeroPad("0x5678", 32)

    context("when called by a non-owner", () => {
      it("should revert", async () => {
        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .updateAllowedSender(exampleSender, true)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSender(exampleSender, true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the allowed sender", async () => {
        expect(await l1BtcRedeemer.allowedSenders(exampleSender)).to.be.true
      })

      it("should emit AllowedSenderUpdated event", async () => {
        await expect(tx)
          .to.emit(l1BtcRedeemer, "AllowedSenderUpdated")
          .withArgs(exampleSender, true)
      })
    })

    context("when revoking allowed sender", () => {
      let allowTx: ContractTransaction
      let revokeTx: ContractTransaction

      before(async () => {
        await createSnapshot()
        allowTx = await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSender(exampleSender, true)
        revokeTx = await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSender(exampleSender, false)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revoke the allowed sender", async () => {
        expect(await l1BtcRedeemer.allowedSenders(exampleSender)).to.be.false
      })

      it("should emit AllowedSenderUpdated event for revocation", async () => {
        await expect(revokeTx)
          .to.emit(l1BtcRedeemer, "AllowedSenderUpdated")
          .withArgs(exampleSender, false)
      })
    })

    context("when allowing multiple senders", () => {
      before(async () => {
        await createSnapshot()
        await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSender(exampleSender, true)
        await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSender(anotherSender, true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should track multiple allowed senders correctly", async () => {
        expect(await l1BtcRedeemer.allowedSenders(exampleSender)).to.be.true
        expect(await l1BtcRedeemer.allowedSenders(anotherSender)).to.be.true
      })
    })
  })

  describe("requestRedemption", () => {
    const encodedVm = "0x1234567890"
    const calculatedRedemptionKey = ethers.utils.solidityKeccak256(
      ["bytes32", "bytes20"],
      [
        ethers.utils.solidityKeccak256(
          ["bytes"],
          [exampleRedeemerOutputScript]
        ),
        exampleWalletPubKeyHash,
      ]
    )

    // Default sender address for tests (in Wormhole format)
    const defaultSender = ethers.utils.hexZeroPad("0xABCD", 32)
    const unauthorizedSender = ethers.utils.hexZeroPad("0xDEAD", 32)

    // Helper function to create a mock TransferWithPayload struct
    function createMockTransferWithPayload(
      payload: string,
      fromAddress: string = defaultSender
    ) {
      const transfer = {
        payloadID: 1,
        amount: 2,
        tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
        tokenChain: 4,
        to: ethers.utils.hexZeroPad("0x5000", 32),
        toChain: 6,
        fromAddress,
        payload,
      }
      return ethers.utils.defaultAbiCoder.encode(
        [
          "tuple(uint8 payloadID, uint256 amount, bytes32 tokenAddress, uint16 tokenChain, bytes32 to, uint16 toChain, bytes32 fromAddress, bytes payload)",
        ],
        [transfer]
      )
    }

    beforeEach(async () => {
      await createSnapshot()
      wormholeTokenBridge.completeTransferWithPayload.reset()
      wormholeTokenBridge.parseTransferWithPayload.reset()
      reimbursementPool.refund.reset()

      // Set up default mock behavior
      const encodedTransfer = createMockTransferWithPayload(
        exampleRedeemerOutputScript
      )
      wormholeTokenBridge.completeTransferWithPayload.returns(encodedTransfer)
      wormholeTokenBridge.parseTransferWithPayload
        .whenCalledWith(encodedTransfer)
        .returns({
          payloadID: 1,
          amount: 2,
          tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
          tokenChain: 4,
          to: ethers.utils.hexZeroPad("0x5000", 32),
          toChain: 6,
          fromAddress: defaultSender,
          payload: exampleRedeemerOutputScript,
        })

      // Allow the default sender
      await l1BtcRedeemer
        .connect(governance)
        .updateAllowedSender(defaultSender, true)

      await tbtcToken.mint(l1BtcRedeemer.address, exampleAmount)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    context("when sender is not authorized", () => {
      beforeEach(async () => {
        // Set up mock to return unauthorized sender
        const encodedTransfer = createMockTransferWithPayload(
          exampleRedeemerOutputScript,
          unauthorizedSender
        )
        wormholeTokenBridge.completeTransferWithPayload.returns(encodedTransfer)
        wormholeTokenBridge.parseTransferWithPayload
          .whenCalledWith(encodedTransfer)
          .returns({
            payloadID: 1,
            amount: 2,
            tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
            tokenChain: 4,
            to: ethers.utils.hexZeroPad("0x5000", 32),
            toChain: 6,
            fromAddress: unauthorizedSender,
            payload: exampleRedeemerOutputScript,
          })
      })

      it("should revert with unauthorized error", async () => {
        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )
        ).to.be.revertedWith("SourceAddressNotAuthorized")
      })
    })

    context("when sender authorization is updated", () => {
      const newSender = ethers.utils.hexZeroPad("0x9999", 32)

      beforeEach(async () => {
        // Set up mock to return new sender
        const encodedTransfer = createMockTransferWithPayload(
          exampleRedeemerOutputScript,
          newSender
        )
        wormholeTokenBridge.completeTransferWithPayload.returns(encodedTransfer)
        wormholeTokenBridge.parseTransferWithPayload
          .whenCalledWith(encodedTransfer)
          .returns({
            payloadID: 1,
            amount: 2,
            tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
            tokenChain: 4,
            to: ethers.utils.hexZeroPad("0x5000", 32),
            toChain: 6,
            fromAddress: newSender,
            payload: exampleRedeemerOutputScript,
          })
      })

      it("should reject before authorization", async () => {
        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )
        ).to.be.revertedWith("SourceAddressNotAuthorized")
      })

      it("should accept after authorization", async () => {
        // Authorize the new sender
        await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSender(newSender, true)

        // Should now succeed
        const tx = await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm
          )

        await expect(tx)
          .to.emit(l1BtcRedeemer, "RedemptionRequested")
          .withArgs(
            calculatedRedemptionKey,
            exampleWalletPubKeyHash,
            [
              exampleMainUtxo.txHash,
              exampleMainUtxo.txOutputIndex,
              exampleMainUtxo.txOutputValue,
            ],
            exampleRedeemerOutputScript,
            exampleAmount
          )
      })

      it("should reject after revocation", async () => {
        // First authorize
        await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSender(newSender, true)

        // Then revoke
        await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSender(newSender, false)

        // Should now fail
        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )
        ).to.be.revertedWith("SourceAddressNotAuthorized")
      })
    })

    context("when redemption is successful", () => {
      let tx: ContractTransaction

      beforeEach(async () => {
        tx = await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm
          )
      })

      it("should complete the transfer with Wormhole bridge", async () => {
        expect(
          wormholeTokenBridge.completeTransferWithPayload
        ).to.have.been.calledOnceWith(encodedVm)
      })

      it("should call requestRedemption on the Bridge and emit RedemptionRequestedMock", async () => {
        await expect(tx)
          .to.emit(bridge, "RedemptionRequestedMock")
          .withArgs(
            exampleWalletPubKeyHash,
            exampleAmountInSatoshis,
            exampleRedeemerOutputScript,
            calculatedRedemptionKey
          )
      })

      it("should emit RedemptionRequested event from L1BTCRedeemerWormhole", async () => {
        await expect(tx)
          .to.emit(l1BtcRedeemer, "RedemptionRequested")
          .withArgs(
            calculatedRedemptionKey,
            exampleWalletPubKeyHash,
            [
              exampleMainUtxo.txHash,
              exampleMainUtxo.txOutputIndex,
              exampleMainUtxo.txOutputValue,
            ],
            exampleRedeemerOutputScript,
            exampleAmount
          )
      })

      it("should transfer tBTC tokens to the vault", async () => {
        // After redemption, tokens should be transferred from the redeemer to the vault
        expect(await tbtcToken.balanceOf(l1BtcRedeemer.address)).to.equal(0)
        expect(await tbtcToken.balanceOf(tbtcVault.address)).to.equal(
          exampleAmount
        )
      })
    })

    context("when using different output script types", () => {
      context("when using P2WPKH output script", () => {
        let tx: ContractTransaction

        beforeEach(async () => {
          const encodedTransfer = createMockTransferWithPayload(
            exampleP2WPKHOutputScript
          )
          wormholeTokenBridge.completeTransferWithPayload.returns(
            encodedTransfer
          )
          wormholeTokenBridge.parseTransferWithPayload
            .whenCalledWith(encodedTransfer)
            .returns({
              payloadID: 1,
              amount: 2,
              tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
              tokenChain: 4,
              to: ethers.utils.hexZeroPad("0x5000", 32),
              toChain: 6,
              fromAddress: defaultSender,
              payload: exampleP2WPKHOutputScript,
            })
          tx = await l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )
        })

        it("should process P2WPKH redemption successfully", async () => {
          await expect(tx)
            .to.emit(l1BtcRedeemer, "RedemptionRequested")
            .withArgs(
              ethers.utils.solidityKeccak256(
                ["bytes32", "bytes20"],
                [
                  ethers.utils.solidityKeccak256(
                    ["bytes"],
                    [exampleP2WPKHOutputScript]
                  ),
                  exampleWalletPubKeyHash,
                ]
              ),
              exampleWalletPubKeyHash,
              [
                exampleMainUtxo.txHash,
                exampleMainUtxo.txOutputIndex,
                exampleMainUtxo.txOutputValue,
              ],
              exampleP2WPKHOutputScript,
              exampleAmount
            )
        })
      })

      context("when using P2SH output script", () => {
        let tx: ContractTransaction

        beforeEach(async () => {
          const encodedTransfer = createMockTransferWithPayload(
            exampleP2SHOutputScript
          )
          wormholeTokenBridge.completeTransferWithPayload.returns(
            encodedTransfer
          )
          wormholeTokenBridge.parseTransferWithPayload
            .whenCalledWith(encodedTransfer)
            .returns({
              payloadID: 1,
              amount: 2,
              tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
              tokenChain: 4,
              to: ethers.utils.hexZeroPad("0x5000", 32),
              toChain: 6,
              fromAddress: defaultSender,
              payload: exampleP2SHOutputScript,
            })
          tx = await l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )
        })

        it("should process P2SH redemption successfully", async () => {
          await expect(tx)
            .to.emit(l1BtcRedeemer, "RedemptionRequested")
            .withArgs(
              ethers.utils.solidityKeccak256(
                ["bytes32", "bytes20"],
                [
                  ethers.utils.solidityKeccak256(
                    ["bytes"],
                    [exampleP2SHOutputScript]
                  ),
                  exampleWalletPubKeyHash,
                ]
              ),
              exampleWalletPubKeyHash,
              [
                exampleMainUtxo.txHash,
                exampleMainUtxo.txOutputIndex,
                exampleMainUtxo.txOutputValue,
              ],
              exampleP2SHOutputScript,
              exampleAmount
            )
        })
      })

      context("when using P2WSH output script", () => {
        let tx: ContractTransaction

        beforeEach(async () => {
          const encodedTransfer = createMockTransferWithPayload(
            exampleP2WSHOutputScript
          )
          wormholeTokenBridge.completeTransferWithPayload.returns(
            encodedTransfer
          )
          wormholeTokenBridge.parseTransferWithPayload
            .whenCalledWith(encodedTransfer)
            .returns({
              payloadID: 1,
              amount: 2,
              tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
              tokenChain: 4,
              to: ethers.utils.hexZeroPad("0x5000", 32),
              toChain: 6,
              fromAddress: defaultSender,
              payload: exampleP2WSHOutputScript,
            })
          tx = await l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )
        })

        it("should process P2WSH redemption successfully", async () => {
          await expect(tx)
            .to.emit(l1BtcRedeemer, "RedemptionRequested")
            .withArgs(
              ethers.utils.solidityKeccak256(
                ["bytes32", "bytes20"],
                [
                  ethers.utils.solidityKeccak256(
                    ["bytes"],
                    [exampleP2WSHOutputScript]
                  ),
                  exampleWalletPubKeyHash,
                ]
              ),
              exampleWalletPubKeyHash,
              [
                exampleMainUtxo.txHash,
                exampleMainUtxo.txOutputIndex,
                exampleMainUtxo.txOutputValue,
              ],
              exampleP2WSHOutputScript,
              exampleAmount
            )
        })
      })
    })

    context("when using different amounts", () => {
      context("when using a smaller amount", () => {
        const smallAmount = ethers.utils.parseUnits("0.5", 18)

        beforeEach(async () => {
          // Don't subtract exampleAmount since it would be negative
          // The mock will simulate receiving smallAmount from Wormhole
          await l1BtcRedeemer.setMockRedemptionAmountTBTC(smallAmount)
          // Ensure the contract still has enough tokens
          await tbtcToken.mint(l1BtcRedeemer.address, smallAmount)
        })

        it("should process small amount redemption", async () => {
          const tx = await l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )

          await expect(tx)
            .to.emit(l1BtcRedeemer, "RedemptionRequested")
            .withArgs(
              calculatedRedemptionKey,
              exampleWalletPubKeyHash,
              [
                exampleMainUtxo.txHash,
                exampleMainUtxo.txOutputIndex,
                exampleMainUtxo.txOutputValue,
              ],
              exampleRedeemerOutputScript,
              smallAmount
            )
        })
      })

      context("when using a large amount", () => {
        const largeAmount = ethers.utils.parseUnits("100", 18)

        beforeEach(async () => {
          await tbtcToken.mint(l1BtcRedeemer.address, largeAmount) // Mint the large amount
          await l1BtcRedeemer.setMockRedemptionAmountTBTC(largeAmount)
        })

        it("should process large amount redemption", async () => {
          const tx = await l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )

          await expect(tx)
            .to.emit(l1BtcRedeemer, "RedemptionRequested")
            .withArgs(
              calculatedRedemptionKey,
              exampleWalletPubKeyHash,
              [
                exampleMainUtxo.txHash,
                exampleMainUtxo.txOutputIndex,
                exampleMainUtxo.txOutputValue,
              ],
              exampleRedeemerOutputScript,
              largeAmount
            )
        })
      })
    })

    context("when authorized for reimbursement", () => {
      beforeEach(async () => {
        await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementAuthorization(relayer.address, true)
        await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementPool(reimbursementPool.address)
      })

      it("should reimburse gas", async () => {
        await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm
          )
        expect(reimbursementPool.refund).to.have.been.calledOnce
      })

      it("should calculate reimbursement with gas offset", async () => {
        const gasOffset = await l1BtcRedeemer.requestRedemptionGasOffset()

        await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm
          )

        const refundCall = reimbursementPool.refund.getCall(0)
        expect(refundCall.args[0]).to.be.gt(gasOffset)
        expect(refundCall.args[1]).to.equal(relayer.address)
      })
    })

    context("when not authorized for reimbursement", () => {
      beforeEach(async () => {
        await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementAuthorization(relayer.address, false)
        await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementPool(reimbursementPool.address)
      })

      it("should not reimburse gas", async () => {
        await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm
          )
        expect(reimbursementPool.refund).to.not.have.been.called
      })
    })

    context("when reimbursement pool is not set", () => {
      beforeEach(async () => {
        await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementAuthorization(relayer.address, true)
        // Reimbursement pool is not set (default to zero address)
      })

      it("should not reimburse gas", async () => {
        await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm
          )
        expect(reimbursementPool.refund).to.not.have.been.called
      })
    })

    context("when gas offset is updated mid-transaction", () => {
      beforeEach(async () => {
        await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementAuthorization(relayer.address, true)
        await l1BtcRedeemer
          .connect(governance)
          .updateReimbursementPool(reimbursementPool.address)
        await l1BtcRedeemer
          .connect(governance)
          .updateGasOffsetParameters(100000)
      })

      it("should use the updated gas offset", async () => {
        await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm
          )

        const refundCall = reimbursementPool.refund.getCall(0)
        expect(refundCall.args[0]).to.be.gt(100000)
      })
    })

    context("when Wormhole bridge transfer fails", () => {
      beforeEach(async () => {
        wormholeTokenBridge.completeTransferWithPayload.reverts(
          "Wormhole transfer failed"
        )
      })

      it("should revert", async () => {
        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )
        ).to.be.reverted
      })
    })

    context("when Bridge redemption fails (e.g., already requested)", () => {
      beforeEach(async () => {
        await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm
          )
        await tbtcToken.mint(l1BtcRedeemer.address, exampleAmount)
      })

      it("should revert", async () => {
        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )
        ).to.be.revertedWith("Redemption already requested")
      })
    })

    context("when multiple redemptions in sequence", () => {
      const encodedVm2 = "0x2345678901"
      const encodedVm3 = "0x3456789012"
      const differentOutputScript =
        "0x1976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac"

      beforeEach(async () => {
        // Set up first transfer
        const encodedTransfer1 = createMockTransferWithPayload(
          exampleRedeemerOutputScript
        )
        wormholeTokenBridge.completeTransferWithPayload
          .whenCalledWith(encodedVm)
          .returns(encodedTransfer1)
        wormholeTokenBridge.parseTransferWithPayload
          .whenCalledWith(encodedTransfer1)
          .returns({
            payloadID: 1,
            amount: 2,
            tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
            tokenChain: 4,
            to: ethers.utils.hexZeroPad("0x5000", 32),
            toChain: 6,
            fromAddress: defaultSender,
            payload: exampleRedeemerOutputScript,
          })

        // Set up second transfer
        const encodedTransfer2 = createMockTransferWithPayload(
          differentOutputScript
        )
        wormholeTokenBridge.completeTransferWithPayload
          .whenCalledWith(encodedVm2)
          .returns(encodedTransfer2)
        wormholeTokenBridge.parseTransferWithPayload
          .whenCalledWith(encodedTransfer2)
          .returns({
            payloadID: 1,
            amount: 2,
            tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
            tokenChain: 4,
            to: ethers.utils.hexZeroPad("0x5000", 32),
            toChain: 6,
            fromAddress: defaultSender,
            payload: differentOutputScript,
          })

        // Set up third transfer
        const encodedTransfer3 = createMockTransferWithPayload(
          exampleP2WPKHOutputScript
        )
        wormholeTokenBridge.completeTransferWithPayload
          .whenCalledWith(encodedVm3)
          .returns(encodedTransfer3)
        wormholeTokenBridge.parseTransferWithPayload
          .whenCalledWith(encodedTransfer3)
          .returns({
            payloadID: 1,
            amount: 2,
            tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
            tokenChain: 4,
            to: ethers.utils.hexZeroPad("0x5000", 32),
            toChain: 6,
            fromAddress: defaultSender,
            payload: exampleP2WPKHOutputScript,
          })

        await tbtcToken.mint(l1BtcRedeemer.address, exampleAmount.mul(2)) // Need more tokens
      })

      it("should handle multiple redemptions", async () => {
        const tx1 = await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm
          )

        const tx2 = await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm2
          )

        const tx3 = await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm3
          )

        expect(wormholeTokenBridge.completeTransferWithPayload).to.have.been
          .calledThrice
      })
    })

    context("when balance changes during redemption", () => {
      beforeEach(async () => {
        const originalAmount = await tbtcToken.balanceOf(l1BtcRedeemer.address)
        expect(originalAmount).to.equal(exampleAmount)
      })

      it("should handle balance correctly", async () => {
        const balanceBefore = await tbtcToken.balanceOf(l1BtcRedeemer.address)
        const vaultBalanceBefore = await tbtcToken.balanceOf(tbtcVault.address)

        await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm
          )

        const balanceAfter = await tbtcToken.balanceOf(l1BtcRedeemer.address)
        const vaultBalanceAfter = await tbtcToken.balanceOf(tbtcVault.address)

        // The tokens should be transferred from redeemer to vault during unmint
        expect(balanceAfter).to.equal(0)
        expect(vaultBalanceAfter).to.equal(
          vaultBalanceBefore.add(balanceBefore)
        )
      })
    })

    context("edge cases", () => {
      context("when VM is empty", () => {
        it("should handle empty VM", async () => {
          const emptyVm = "0x"
          const encodedTransfer = createMockTransferWithPayload(
            exampleRedeemerOutputScript
          )
          wormholeTokenBridge.completeTransferWithPayload
            .whenCalledWith(emptyVm)
            .returns(encodedTransfer)
          wormholeTokenBridge.parseTransferWithPayload
            .whenCalledWith(encodedTransfer)
            .returns({
              payloadID: 1,
              amount: 2,
              tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
              tokenChain: 4,
              to: ethers.utils.hexZeroPad("0x5000", 32),
              toChain: 6,
              fromAddress: defaultSender,
              payload: exampleRedeemerOutputScript,
            })

          const tx = await l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              emptyVm
            )

          await expect(tx).to.emit(l1BtcRedeemer, "RedemptionRequested")
        })
      })

      context("when mainUtxo has minimum values", () => {
        it("should handle minimum UTXO values", async () => {
          const minimalUtxo = {
            txHash:
              "0x0000000000000000000000000000000000000000000000000000000000000001",
            txOutputIndex: 0,
            txOutputValue: 1,
          }

          const tx = await l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(exampleWalletPubKeyHash, minimalUtxo, encodedVm)

          await expect(tx)
            .to.emit(l1BtcRedeemer, "RedemptionRequested")
            .withArgs(
              calculatedRedemptionKey,
              exampleWalletPubKeyHash,
              [
                minimalUtxo.txHash,
                minimalUtxo.txOutputIndex,
                minimalUtxo.txOutputValue,
              ],
              exampleRedeemerOutputScript,
              exampleAmount
            )
        })
      })

      context("when mainUtxo has maximum values", () => {
        it("should handle maximum UTXO values", async () => {
          const maximalUtxo = {
            txHash:
              "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            txOutputIndex: 4294967295, // uint32 max
            txOutputValue: 21000000 * 100000000, // 21M BTC in satoshis
          }

          const tx = await l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(exampleWalletPubKeyHash, maximalUtxo, encodedVm)

          await expect(tx)
            .to.emit(l1BtcRedeemer, "RedemptionRequested")
            .withArgs(
              calculatedRedemptionKey,
              exampleWalletPubKeyHash,
              [
                maximalUtxo.txHash,
                maximalUtxo.txOutputIndex,
                maximalUtxo.txOutputValue,
              ],
              exampleRedeemerOutputScript,
              exampleAmount
            )
        })
      })
    })
  })

  describe("setMockRedemptionAmountTBTC", () => {
    // Default sender address for tests (in Wormhole format)
    const defaultSender = ethers.utils.hexZeroPad("0xABCD", 32)

    // Helper function to create a mock TransferWithPayload struct
    function createMockTransferWithPayload(
      payload: string,
      fromAddress: string = defaultSender
    ) {
      const transfer = {
        payloadID: 1,
        amount: 2,
        tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
        tokenChain: 4,
        to: ethers.utils.hexZeroPad("0x5000", 32),
        toChain: 6,
        fromAddress,
        payload,
      }
      return ethers.utils.defaultAbiCoder.encode(
        [
          "tuple(uint8 payloadID, uint256 amount, bytes32 tokenAddress, uint16 tokenChain, bytes32 to, uint16 toChain, bytes32 fromAddress, bytes payload)",
        ],
        [transfer]
      )
    }

    context("when setting a new mock amount", () => {
      const newAmount = ethers.utils.parseUnits("5", 18)

      before(async () => {
        await createSnapshot()
        await l1BtcRedeemer.setMockRedemptionAmountTBTC(newAmount)
        // Allow the default sender
        await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSender(defaultSender, true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the mock redemption amount", async () => {
        expect(await l1BtcRedeemer.mockRedemptionAmountTBTC()).to.equal(
          newAmount
        )
      })

      it("should use the new amount in redemptions", async () => {
        const encodedTransfer = createMockTransferWithPayload(
          exampleRedeemerOutputScript
        )
        wormholeTokenBridge.completeTransferWithPayload.returns(encodedTransfer)
        wormholeTokenBridge.parseTransferWithPayload
          .whenCalledWith(encodedTransfer)
          .returns({
            payloadID: 1,
            amount: 2,
            tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
            tokenChain: 4,
            to: ethers.utils.hexZeroPad("0x5000", 32),
            toChain: 6,
            fromAddress: defaultSender,
            payload: exampleRedeemerOutputScript,
          })
        await tbtcToken.mint(l1BtcRedeemer.address, newAmount)

        const tx = await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            "0x1234567890"
          )

        await expect(tx)
          .to.emit(l1BtcRedeemer, "RedemptionRequested")
          .withArgs(
            ethers.utils.solidityKeccak256(
              ["bytes32", "bytes20"],
              [
                ethers.utils.solidityKeccak256(
                  ["bytes"],
                  [exampleRedeemerOutputScript]
                ),
                exampleWalletPubKeyHash,
              ]
            ),
            exampleWalletPubKeyHash,
            [
              exampleMainUtxo.txHash,
              exampleMainUtxo.txOutputIndex,
              exampleMainUtxo.txOutputValue,
            ],
            exampleRedeemerOutputScript,
            newAmount
          )
      })
    })

    context("when setting amount to zero", () => {
      before(async () => {
        await createSnapshot()
        await l1BtcRedeemer.setMockRedemptionAmountTBTC(0)
        // Allow the default sender
        await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSender(defaultSender, true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should fallback to default amount in redemptions", async () => {
        const encodedTransfer = createMockTransferWithPayload(
          exampleRedeemerOutputScript
        )
        wormholeTokenBridge.completeTransferWithPayload.returns(encodedTransfer)
        wormholeTokenBridge.parseTransferWithPayload
          .whenCalledWith(encodedTransfer)
          .returns({
            payloadID: 1,
            amount: 2,
            tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
            tokenChain: 4,
            to: ethers.utils.hexZeroPad("0x5000", 32),
            toChain: 6,
            fromAddress: defaultSender,
            payload: exampleRedeemerOutputScript,
          })
        await tbtcToken.mint(l1BtcRedeemer.address, exampleAmount)

        const tx = await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            "0x1234567890"
          )

        // Should use the fallback amount (2 * 10^18)
        await expect(tx)
          .to.emit(l1BtcRedeemer, "RedemptionRequested")
          .withArgs(
            ethers.utils.solidityKeccak256(
              ["bytes32", "bytes20"],
              [
                ethers.utils.solidityKeccak256(
                  ["bytes"],
                  [exampleRedeemerOutputScript]
                ),
                exampleWalletPubKeyHash,
              ]
            ),
            exampleWalletPubKeyHash,
            [
              exampleMainUtxo.txHash,
              exampleMainUtxo.txOutputIndex,
              exampleMainUtxo.txOutputValue,
            ],
            exampleRedeemerOutputScript,
            exampleAmount // Fallback to 2 * 10^18
          )
      })
    })
  })

  describe("gas estimation scenarios", () => {
    // Default sender address for tests (in Wormhole format)
    const defaultSender = ethers.utils.hexZeroPad("0xABCD", 32)

    // Helper function to create a mock TransferWithPayload struct
    function createMockTransferWithPayload(
      payload: string,
      fromAddress: string = defaultSender
    ) {
      const transfer = {
        payloadID: 1,
        amount: 2,
        tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
        tokenChain: 4,
        to: ethers.utils.hexZeroPad("0x5000", 32),
        toChain: 6,
        fromAddress,
        payload,
      }
      return ethers.utils.defaultAbiCoder.encode(
        [
          "tuple(uint8 payloadID, uint256 amount, bytes32 tokenAddress, uint16 tokenChain, bytes32 to, uint16 toChain, bytes32 fromAddress, bytes payload)",
        ],
        [transfer]
      )
    }

    beforeEach(async () => {
      await createSnapshot()
      const encodedTransfer = createMockTransferWithPayload(
        exampleRedeemerOutputScript
      )
      wormholeTokenBridge.completeTransferWithPayload.returns(encodedTransfer)
      wormholeTokenBridge.parseTransferWithPayload
        .whenCalledWith(encodedTransfer)
        .returns({
          payloadID: 1,
          amount: 2,
          tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
          tokenChain: 4,
          to: ethers.utils.hexZeroPad("0x5000", 32),
          toChain: 6,
          fromAddress: defaultSender,
          payload: exampleRedeemerOutputScript,
        })

      // Allow the default sender
      await l1BtcRedeemer
        .connect(governance)
        .updateAllowedSender(defaultSender, true)

      await tbtcToken.mint(l1BtcRedeemer.address, exampleAmount)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should estimate gas for redemption without reimbursement", async () => {
      const estimatedGas = await l1BtcRedeemer
        .connect(relayer)
        .estimateGas.requestRedemption(
          exampleWalletPubKeyHash,
          exampleMainUtxo,
          "0x1234567890"
        )

      expect(estimatedGas).to.be.gt(0)
      expect(estimatedGas).to.be.lt(500000) // Reasonable upper bound
    })

    it("should estimate gas for redemption with reimbursement", async () => {
      await l1BtcRedeemer
        .connect(governance)
        .updateReimbursementAuthorization(relayer.address, true)
      await l1BtcRedeemer
        .connect(governance)
        .updateReimbursementPool(reimbursementPool.address)

      const estimatedGas = await l1BtcRedeemer
        .connect(relayer)
        .estimateGas.requestRedemption(
          exampleWalletPubKeyHash,
          exampleMainUtxo,
          "0x1234567890"
        )

      expect(estimatedGas).to.be.gt(0)
      expect(estimatedGas).to.be.lt(500000) // Reasonable upper bound
    })
  })

  describe("refundTimedOutRedemptionToL2 request identity", () => {
    const sourceChainId = 8453
    const redemptionKey = BigNumber.from(1234)
    const recordedRequestedAt = 1000
    const timedOutRequestedAt = 1001

    let productionRedeemer: TestL1BTCRedeemerWormhole
    let productionBridge: MockTBTCBridge

    beforeEach(async () => {
      await createSnapshot()

      const MockBankFactory = await ethers.getContractFactory("MockBank")
      const productionBank = (await MockBankFactory.deploy()) as MockBank
      await productionBank.deployed()

      const MockTBTCVaultFactory = await ethers.getContractFactory(
        "contracts/test/MockTBTCVault.sol:MockTBTCVault"
      )
      const productionVault =
        (await MockTBTCVaultFactory.deploy()) as MockTBTCVault
      await productionVault.deployed()

      const TestERC20Factory = await ethers.getContractFactory("TestERC20")
      const wormholeTbtc = (await TestERC20Factory.deploy()) as TestERC20
      await wormholeTbtc.deployed()
      await productionVault.setTbtcToken(wormholeTbtc.address)

      const MockTBTCBridgeFactory = await ethers.getContractFactory(
        "MockTBTCBridge"
      )
      productionBridge =
        (await MockTBTCBridgeFactory.deploy()) as MockTBTCBridge
      await productionBridge.deployed()

      const TestL1BTCRedeemerWormholeFactory = await ethers.getContractFactory(
        "TestL1BTCRedeemerWormhole"
      )
      const implementation = await TestL1BTCRedeemerWormholeFactory.deploy()
      await implementation.deployed()
      const initializerData =
        TestL1BTCRedeemerWormholeFactory.interface.encodeFunctionData(
          "initialize",
          [
            productionBridge.address,
            thirdParty.address,
            wormholeTbtc.address,
            productionBank.address,
            productionVault.address,
          ]
        )
      const ERC1967ProxyFactory = await ethers.getContractFactory(
        "ERC1967Proxy"
      )
      const proxy = await ERC1967ProxyFactory.deploy(
        implementation.address,
        initializerData
      )
      await proxy.deployed()
      productionRedeemer = TestL1BTCRedeemerWormholeFactory.attach(
        proxy.address
      ) as TestL1BTCRedeemerWormhole

      await productionRedeemer.seedTimedOutRedemptionRefund(
        redemptionKey,
        thirdParty.address,
        sourceChainId,
        exampleAmountInSatoshis,
        recordedRequestedAt
      )
      await productionBridge.setTimedOutRedemption(
        redemptionKey,
        productionRedeemer.address,
        exampleAmountInSatoshis,
        timedOutRequestedAt
      )
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should reject a timeout refund from a different redemption request", async () => {
      const refundRecord = await productionRedeemer.timedOutRedemptionRefunds(
        redemptionKey
      )

      expect(refundRecord.requestedAt).to.equal(recordedRequestedAt)

      await expect(
        productionRedeemer.refundTimedOutRedemptionToL2(redemptionKey)
      ).to.be.revertedWith("Wrong timeout refund request")
    })

    it("should allow replacing a stale route that is not the timed-out request", async () => {
      await productionRedeemer.requireNoPendingTimedOutRedemptionRefund(
        redemptionKey
      )
    })

    it("should reject replacing an unresolved timeout refund route", async () => {
      await productionBridge.setTimedOutRedemption(
        redemptionKey,
        productionRedeemer.address,
        exampleAmountInSatoshis,
        recordedRequestedAt
      )

      await expect(
        productionRedeemer.requireNoPendingTimedOutRedemptionRefund(
          redemptionKey
        )
      ).to.be.revertedWith("Timeout refund pending")
    })
  })

  describe("requestRedemptionWithRebate authorization", () => {
    const sourceChainId = 8453
    const encodedVm = "0x1234567890"
    const defaultSender = ethers.utils.hexZeroPad("0xABCD", 32)
    const redemptionId = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("redemption-id")
    )

    let productionRedeemer: TestL1BTCRedeemerWormhole
    let productionBridge: MockTBTCBridge
    let productionTokenBridge: FakeContract<IWormholeTokenBridge>

    function encodeTransfer(payload: string) {
      const transfer = {
        payloadID: 1,
        amount: 2,
        tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
        tokenChain: 4,
        to: ethers.utils.hexZeroPad("0x5000", 32),
        toChain: 6,
        fromAddress: defaultSender,
        payload,
      }
      return ethers.utils.defaultAbiCoder.encode(
        [
          "tuple(uint8 payloadID, uint256 amount, bytes32 tokenAddress, uint16 tokenChain, bytes32 to, uint16 toChain, bytes32 fromAddress, bytes payload)",
        ],
        [transfer]
      )
    }

    function encodeV2Payload(rebateAuthorization: string) {
      return ethers.utils.defaultAbiCoder.encode(
        [
          "tuple(bytes redeemerOutputScript, address l2User, address rebateBeneficiary, uint64 maxRebateSat, bytes rebateAuthorization, bytes32 redemptionId)",
        ],
        [
          [
            exampleRedeemerOutputScript,
            thirdParty.address,
            thirdParty.address,
            exampleAmountInSatoshis,
            rebateAuthorization,
            redemptionId,
          ],
        ]
      )
    }

    function getRedemptionKey() {
      return ethers.utils.solidityKeccak256(
        ["bytes32", "bytes20"],
        [
          ethers.utils.solidityKeccak256(
            ["bytes"],
            [exampleRedeemerOutputScript]
          ),
          exampleWalletPubKeyHash,
        ]
      )
    }

    function mockCompletedTransfer(payload: string) {
      const encodedTransfer = encodeTransfer(payload)

      productionTokenBridge.completeTransferWithPayload.returns(encodedTransfer)
      productionTokenBridge.parseTransferWithPayload
        .whenCalledWith(encodedTransfer)
        .returns({
          payloadID: 1,
          amount: 2,
          tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
          tokenChain: 4,
          to: ethers.utils.hexZeroPad("0x5000", 32),
          toChain: 6,
          fromAddress: defaultSender,
          payload,
        })
    }

    async function seedPendingTimeoutRefund(redemptionKey: string) {
      const requestedAt = 1000
      await productionRedeemer.seedTimedOutRedemptionRefund(
        redemptionKey,
        thirdParty.address,
        sourceChainId,
        exampleAmountInSatoshis,
        requestedAt
      )
      await productionBridge.setTimedOutRedemption(
        redemptionKey,
        productionRedeemer.address,
        exampleAmountInSatoshis,
        requestedAt
      )
    }

    before(async () => {
      await createSnapshot()

      const MockBankFactory = await ethers.getContractFactory("MockBank")
      const productionBank = (await MockBankFactory.deploy()) as MockBank
      await productionBank.deployed()

      const MockTBTCVaultFactory = await ethers.getContractFactory(
        "contracts/test/MockTBTCVault.sol:MockTBTCVault"
      )
      const productionVault =
        (await MockTBTCVaultFactory.deploy()) as MockTBTCVault
      await productionVault.deployed()

      const TestERC20Factory = await ethers.getContractFactory("TestERC20")
      const wormholeTbtc = (await TestERC20Factory.deploy()) as TestERC20
      await wormholeTbtc.deployed()
      await productionVault.setTbtcToken(wormholeTbtc.address)

      const MockTBTCBridgeFactory = await ethers.getContractFactory(
        "MockTBTCBridge"
      )
      productionBridge =
        (await MockTBTCBridgeFactory.deploy()) as MockTBTCBridge
      await productionBridge.deployed()

      productionTokenBridge = await smock.fake<IWormholeTokenBridge>(
        "IWormholeTokenBridge"
      )

      const TestL1BTCRedeemerWormholeFactory = await ethers.getContractFactory(
        "TestL1BTCRedeemerWormhole"
      )
      const implementation = await TestL1BTCRedeemerWormholeFactory.deploy()
      await implementation.deployed()
      const initializerData =
        TestL1BTCRedeemerWormholeFactory.interface.encodeFunctionData(
          "initialize",
          [
            productionBridge.address,
            productionTokenBridge.address,
            wormholeTbtc.address,
            productionBank.address,
            productionVault.address,
          ]
        )
      const ERC1967ProxyFactory = await ethers.getContractFactory(
        "ERC1967Proxy"
      )
      const proxy = await ERC1967ProxyFactory.deploy(
        implementation.address,
        initializerData
      )
      await proxy.deployed()
      productionRedeemer = TestL1BTCRedeemerWormholeFactory.attach(
        proxy.address
      ) as TestL1BTCRedeemerWormhole

      await productionRedeemer.updateAllowedSenderWithSourceChain(
        defaultSender,
        true,
        sourceChainId
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should reject unsigned gateway-originated redemption rebate payloads", async () => {
      const payload = encodeV2Payload("0x")
      mockCompletedTransfer(payload)

      await expect(
        productionRedeemer.requestRedemptionWithRebate(
          exampleWalletPubKeyHash,
          exampleMainUtxo,
          encodedVm
        )
      ).to.be.revertedWith("Signed auth required")
    })

    it("should reject same-key rebate redemptions while a timeout refund is pending", async () => {
      const redemptionKey = getRedemptionKey()
      await seedPendingTimeoutRefund(redemptionKey)

      const payload = encodeV2Payload("0x1234")
      mockCompletedTransfer(payload)

      await expect(
        productionRedeemer.requestRedemptionWithRebate(
          exampleWalletPubKeyHash,
          exampleMainUtxo,
          encodedVm
        )
      ).to.be.revertedWith("Timeout refund pending")
    })

    it("should reject same-key legacy redemptions while a timeout refund is pending", async () => {
      const redemptionKey = getRedemptionKey()
      await seedPendingTimeoutRefund(redemptionKey)
      mockCompletedTransfer(exampleRedeemerOutputScript)

      await expect(
        productionRedeemer.requestRedemption(
          exampleWalletPubKeyHash,
          exampleMainUtxo,
          encodedVm
        )
      ).to.be.revertedWith("Timeout refund pending")
    })
  })

  // Regression tests for the audit fix that adds VAA emitter-chain
  // authentication. Without these checks, any contract deployed at the
  // same address on a foreign chain with a registered Wormhole Token
  // Bridge could pass the `allowedSenders` check.
  describe("setWormhole", () => {
    const binding = ethers.utils.hexZeroPad("0xbbbb", 32)

    context("when called by a non-owner", () => {
      it("should revert", async () => {
        await expect(
          l1BtcRedeemer.connect(relayer).setWormhole(thirdParty.address, [], [])
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should reject the zero address", async () => {
        await expect(
          l1BtcRedeemer
            .connect(governance)
            .setWormhole(ethers.constants.AddressZero, [], [])
        ).to.be.revertedWith("ZeroAddress")
      })

      it("should reject mismatched array lengths", async () => {
        const wormhole = await smock.fake<IWormhole>("IWormhole")
        await expect(
          l1BtcRedeemer
            .connect(governance)
            .setWormhole(wormhole.address, [binding], [])
        ).to.be.revertedWith("InvalidArrayLength")
      })

      it("should accept an empty binding list", async () => {
        const wormhole = await smock.fake<IWormhole>("IWormhole")
        await expect(
          l1BtcRedeemer
            .connect(governance)
            .setWormhole(wormhole.address, [], [])
        )
          .to.emit(l1BtcRedeemer, "WormholeCoreSet")
          .withArgs(wormhole.address)
        expect(await l1BtcRedeemer.wormhole()).to.equal(wormhole.address)
      })

      it("should revert on a second set", async () => {
        const wormhole = await smock.fake<IWormhole>("IWormhole")
        await expect(
          l1BtcRedeemer
            .connect(governance)
            .setWormhole(wormhole.address, [], [])
        ).to.be.revertedWith("WormholeAlreadySet")
      })
    })

    context("when bindings are provided atomically", () => {
      let wormhole: FakeContract<IWormhole>
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        wormhole = await smock.fake<IWormhole>("IWormhole")
        const senderA = ethers.utils.hexZeroPad("0xc0de", 32)
        const senderB = ethers.utils.hexZeroPad("0xd0de", 32)
        tx = await l1BtcRedeemer
          .connect(governance)
          .setWormhole(wormhole.address, [senderA, senderB], [30, 23])
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should populate allowedSenderWormholeChainIds for each binding", async () => {
        expect(
          await l1BtcRedeemer.allowedSenderWormholeChainIds(
            ethers.utils.hexZeroPad("0xc0de", 32)
          )
        ).to.equal(30)
        expect(
          await l1BtcRedeemer.allowedSenderWormholeChainIds(
            ethers.utils.hexZeroPad("0xd0de", 32)
          )
        ).to.equal(23)
      })

      it("should emit AllowedSenderWormholeChainUpdated for each binding", async () => {
        await expect(tx)
          .to.emit(l1BtcRedeemer, "AllowedSenderWormholeChainUpdated")
          .withArgs(ethers.utils.hexZeroPad("0xc0de", 32), 30)
        await expect(tx)
          .to.emit(l1BtcRedeemer, "AllowedSenderWormholeChainUpdated")
          .withArgs(ethers.utils.hexZeroPad("0xd0de", 32), 23)
      })
    })
  })

  describe("updateAllowedSender revocation clears wormhole chain ID", () => {
    const sender = ethers.utils.hexZeroPad("0xcccc", 32)

    before(async () => {
      await createSnapshot()
      await l1BtcRedeemer.connect(governance).updateAllowedSender(sender, true)
      await l1BtcRedeemer
        .connect(governance)
        .updateAllowedSenderWormholeChain(sender, 30)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should clear the wormhole chain ID on revocation", async () => {
      expect(
        await l1BtcRedeemer.allowedSenderWormholeChainIds(sender)
      ).to.equal(30)

      await expect(
        l1BtcRedeemer.connect(governance).updateAllowedSender(sender, false)
      )
        .to.emit(l1BtcRedeemer, "AllowedSenderWormholeChainUpdated")
        .withArgs(sender, 0)

      expect(
        await l1BtcRedeemer.allowedSenderWormholeChainIds(sender)
      ).to.equal(0)
    })
  })

  describe("updateAllowedSenderWithSourceChain revocation clears wormhole chain ID", () => {
    const sender = ethers.utils.hexZeroPad("0xdddd", 32)

    before(async () => {
      await createSnapshot()
      await l1BtcRedeemer
        .connect(governance)
        .updateAllowedSenderWithSourceChain(sender, true, 8453)
      await l1BtcRedeemer
        .connect(governance)
        .updateAllowedSenderWormholeChain(sender, 30)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should clear the wormhole chain ID on revocation", async () => {
      await expect(
        l1BtcRedeemer
          .connect(governance)
          .updateAllowedSenderWithSourceChain(sender, false, 0)
      )
        .to.emit(l1BtcRedeemer, "AllowedSenderWormholeChainUpdated")
        .withArgs(sender, 0)

      expect(
        await l1BtcRedeemer.allowedSenderWormholeChainIds(sender)
      ).to.equal(0)
    })
  })

  // Regression: re-enabling a revoked sender must NOT resurrect the old
  // wormhole chain ID binding. Otherwise an admin who revokes and
  // re-registers at a different chain would silently reuse the stale
  // mapping from before the revocation.
  describe("updateAllowedSender revocation round-trip", () => {
    const sender = ethers.utils.hexZeroPad("0xeeee", 32)

    before(async () => {
      await createSnapshot()
      await l1BtcRedeemer.connect(governance).updateAllowedSender(sender, true)
      await l1BtcRedeemer
        .connect(governance)
        .updateAllowedSenderWormholeChain(sender, 30)
      await l1BtcRedeemer.connect(governance).updateAllowedSender(sender, false)
      await l1BtcRedeemer.connect(governance).updateAllowedSender(sender, true)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should leave the wormhole chain ID cleared after disable/re-enable", async () => {
      expect(
        await l1BtcRedeemer.allowedSenderWormholeChainIds(sender)
      ).to.equal(0)
    })
  })

  describe("updateAllowedSender revocation clears source chain ID", () => {
    const sender = ethers.utils.hexZeroPad("0xbeef", 32)

    before(async () => {
      await createSnapshot()
      await l1BtcRedeemer
        .connect(governance)
        .updateAllowedSenderWithSourceChain(sender, true, 8453)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should clear the EVM source chain ID on revocation", async () => {
      expect(await l1BtcRedeemer.allowedSenderSourceChainIds(sender)).to.equal(
        8453
      )

      await l1BtcRedeemer.connect(governance).updateAllowedSender(sender, false)

      expect(await l1BtcRedeemer.allowedSenderSourceChainIds(sender)).to.equal(
        0
      )
    })

    it("should leave the source chain ID cleared after legacy re-enable", async () => {
      await l1BtcRedeemer.connect(governance).updateAllowedSender(sender, false)
      await l1BtcRedeemer.connect(governance).updateAllowedSender(sender, true)

      expect(await l1BtcRedeemer.allowedSenderSourceChainIds(sender)).to.equal(
        0
      )
    })
  })

  describe("updateAllowedSenderWormholeChain", () => {
    const sender = ethers.utils.hexZeroPad("0xaaaa", 32)

    context("when called by a non-owner", () => {
      it("should revert", async () => {
        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .updateAllowedSenderWormholeChain(sender, 2)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the mapping and emit the event", async () => {
        await expect(
          l1BtcRedeemer
            .connect(governance)
            .updateAllowedSenderWormholeChain(sender, 30)
        )
          .to.emit(l1BtcRedeemer, "AllowedSenderWormholeChainUpdated")
          .withArgs(sender, 30)
        expect(
          await l1BtcRedeemer.allowedSenderWormholeChainIds(sender)
        ).to.equal(30)
      })

      it("should overwrite an existing entry", async () => {
        await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSenderWormholeChain(sender, 23)
        expect(
          await l1BtcRedeemer.allowedSenderWormholeChainIds(sender)
        ).to.equal(23)
      })
    })
  })

  describe("requestRedemption emitter-chain guard", () => {
    const encodedVm = "0x1234567890"
    const defaultSender = ethers.utils.hexZeroPad("0xABCD", 32)
    const expectedWormholeChainId = 30

    let wormhole: FakeContract<IWormhole>

    // Mirrors the helper used in the main requestRedemption describe block.
    function encodeTransfer(payload: string, fromAddress = defaultSender) {
      const transfer = {
        payloadID: 1,
        amount: 2,
        tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
        tokenChain: 4,
        to: ethers.utils.hexZeroPad("0x5000", 32),
        toChain: 6,
        fromAddress,
        payload,
      }
      return ethers.utils.defaultAbiCoder.encode(
        [
          "tuple(uint8 payloadID, uint256 amount, bytes32 tokenAddress, uint16 tokenChain, bytes32 to, uint16 toChain, bytes32 fromAddress, bytes payload)",
        ],
        [transfer]
      )
    }

    beforeEach(async () => {
      await createSnapshot()

      wormhole = await smock.fake<IWormhole>("IWormhole")

      wormholeTokenBridge.completeTransferWithPayload.reset()
      wormholeTokenBridge.parseTransferWithPayload.reset()

      const encodedTransfer = encodeTransfer(exampleRedeemerOutputScript)
      wormholeTokenBridge.completeTransferWithPayload.returns(encodedTransfer)
      wormholeTokenBridge.parseTransferWithPayload
        .whenCalledWith(encodedTransfer)
        .returns({
          payloadID: 1,
          amount: 2,
          tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
          tokenChain: 4,
          to: ethers.utils.hexZeroPad("0x5000", 32),
          toChain: 6,
          fromAddress: defaultSender,
          payload: exampleRedeemerOutputScript,
        })

      await l1BtcRedeemer
        .connect(governance)
        .updateAllowedSender(defaultSender, true)
      await tbtcToken.mint(l1BtcRedeemer.address, exampleAmount)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    context("when the Wormhole Core reference is not set", () => {
      it("should not call parseVM (backwards-compatible path)", async () => {
        await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm
          )
        // The fake had no calls wired up; asserting it was never invoked
        // ensures we preserved the migration path for existing deployments.
        expect(wormhole.parseVM).to.not.have.been.called
      })
    })

    context("when the Wormhole Core reference is set", () => {
      beforeEach(async () => {
        await l1BtcRedeemer
          .connect(governance)
          .setWormhole(wormhole.address, [], [])
      })

      it("should revert when the sender has no wormhole chain configured", async () => {
        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )
        ).to.be.revertedWith("SourceChainNotAuthorized")
      })

      it("should revert when the VAA emitter chain does not match", async () => {
        await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSenderWormholeChain(
            defaultSender,
            expectedWormholeChainId
          )

        wormhole.parseVM.whenCalledWith(encodedVm).returns({
          version: 1,
          timestamp: 0,
          nonce: 0,
          // Attacker-controlled chain id that does not match the one we
          // bound `defaultSender` to above.
          emitterChainId: 7,
          emitterAddress: ethers.utils.hexZeroPad("0x0", 32),
          sequence: 0,
          consistencyLevel: 0,
          payload: "0x",
          guardianSetIndex: 0,
          signatures: [],
          hash: ethers.utils.hexZeroPad("0x0", 32),
        })

        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )
        ).to.be.revertedWith("WormholeChainMismatch")
      })

      it("should accept immediately after setWormhole with atomic binding", async () => {
        // End-to-end regression for the atomic-binding signature: a
        // single setWormhole call must be enough to activate the guard
        // AND configure the sender -> chain mapping. The fixture's
        // setWormhole is called with empty arrays above, but this test
        // overrides by reverting the snapshot inside the context and
        // running the atomic form.
        //
        // Re-deploy a fresh pair of fakes so the `setWormhole` one-shot
        // guard isn't tripped by the outer beforeEach.
        await restoreSnapshot()
        await createSnapshot()

        wormhole = await smock.fake<IWormhole>("IWormhole")
        wormholeTokenBridge.completeTransferWithPayload.reset()
        wormholeTokenBridge.parseTransferWithPayload.reset()

        const encodedTransfer = encodeTransfer(exampleRedeemerOutputScript)
        wormholeTokenBridge.completeTransferWithPayload.returns(encodedTransfer)
        wormholeTokenBridge.parseTransferWithPayload
          .whenCalledWith(encodedTransfer)
          .returns({
            payloadID: 1,
            amount: 2,
            tokenAddress: ethers.utils.hexZeroPad("0x3000", 32),
            tokenChain: 4,
            to: ethers.utils.hexZeroPad("0x5000", 32),
            toChain: 6,
            fromAddress: defaultSender,
            payload: exampleRedeemerOutputScript,
          })

        await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSender(defaultSender, true)
        await tbtcToken.mint(l1BtcRedeemer.address, exampleAmount)

        // Atomic: core + binding in the same call.
        await l1BtcRedeemer
          .connect(governance)
          .setWormhole(
            wormhole.address,
            [defaultSender],
            [expectedWormholeChainId]
          )

        wormhole.parseVM.whenCalledWith(encodedVm).returns({
          version: 1,
          timestamp: 0,
          nonce: 0,
          emitterChainId: expectedWormholeChainId,
          emitterAddress: ethers.utils.hexZeroPad("0x0", 32),
          sequence: 0,
          consistencyLevel: 0,
          payload: "0x",
          guardianSetIndex: 0,
          signatures: [],
          hash: ethers.utils.hexZeroPad("0x0", 32),
        })

        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )
        ).to.emit(l1BtcRedeemer, "RedemptionRequested")
      })

      it("should accept when the VAA emitter chain matches", async () => {
        await l1BtcRedeemer
          .connect(governance)
          .updateAllowedSenderWormholeChain(
            defaultSender,
            expectedWormholeChainId
          )

        wormhole.parseVM.whenCalledWith(encodedVm).returns({
          version: 1,
          timestamp: 0,
          nonce: 0,
          emitterChainId: expectedWormholeChainId,
          emitterAddress: ethers.utils.hexZeroPad("0x0", 32),
          sequence: 0,
          consistencyLevel: 0,
          payload: "0x",
          guardianSetIndex: 0,
          signatures: [],
          hash: ethers.utils.hexZeroPad("0x0", 32),
        })

        await expect(
          l1BtcRedeemer
            .connect(relayer)
            .requestRedemption(
              exampleWalletPubKeyHash,
              exampleMainUtxo,
              encodedVm
            )
        ).to.emit(l1BtcRedeemer, "RedemptionRequested")
      })
    })
  })
})
