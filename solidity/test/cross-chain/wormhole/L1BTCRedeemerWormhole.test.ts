import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { randomBytes } from "crypto"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, ContractTransaction } from "ethers"
import {
  IWormholeTokenBridge,
  MockL1BTCRedeemerWormhole,
  MockBank,
  MockTBTCBridge,
  L2TBTC,
  ReimbursementPool,
  WormholeBridgeStub,
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

    beforeEach(async () => {
      await createSnapshot()
      wormholeTokenBridge.completeTransferWithPayload.reset()
      reimbursementPool.refund.reset()
      wormholeTokenBridge.completeTransferWithPayload.returns(
        exampleRedeemerOutputScript
      )
      await tbtcToken.mint(l1BtcRedeemer.address, exampleAmount)
    })

    afterEach(async () => {
      await restoreSnapshot()
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

      it("should transfer tBTC tokens to the contract", async () => {
        expect(await tbtcToken.balanceOf(l1BtcRedeemer.address)).to.equal(
          exampleAmount
        )
      })
    })

    context("when using different output script types", () => {
      context("when using P2WPKH output script", () => {
        let tx: ContractTransaction

        beforeEach(async () => {
          wormholeTokenBridge.completeTransferWithPayload.returns(
            exampleP2WPKHOutputScript
          )
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
          wormholeTokenBridge.completeTransferWithPayload.returns(
            exampleP2SHOutputScript
          )
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
          wormholeTokenBridge.completeTransferWithPayload.returns(
            exampleP2WSHOutputScript
          )
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
        wormholeTokenBridge.completeTransferWithPayload
          .whenCalledWith(encodedVm)
          .returns(exampleRedeemerOutputScript)
        wormholeTokenBridge.completeTransferWithPayload
          .whenCalledWith(encodedVm2)
          .returns(differentOutputScript)
        wormholeTokenBridge.completeTransferWithPayload
          .whenCalledWith(encodedVm3)
          .returns(exampleP2WPKHOutputScript)

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

        await l1BtcRedeemer
          .connect(relayer)
          .requestRedemption(
            exampleWalletPubKeyHash,
            exampleMainUtxo,
            encodedVm
          )

        const balanceAfter = await tbtcToken.balanceOf(l1BtcRedeemer.address)
        // The mock doesn't actually transfer tokens from Wormhole
        // The balance should remain the same after redemption in the mock
        expect(balanceAfter).to.equal(balanceBefore)
      })
    })

    context("edge cases", () => {
      context("when VM is empty", () => {
        it("should handle empty VM", async () => {
          const emptyVm = "0x"
          wormholeTokenBridge.completeTransferWithPayload
            .whenCalledWith(emptyVm)
            .returns(exampleRedeemerOutputScript)

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
    context("when setting a new mock amount", () => {
      const newAmount = ethers.utils.parseUnits("5", 18)

      before(async () => {
        await createSnapshot()
        await l1BtcRedeemer.setMockRedemptionAmountTBTC(newAmount)
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
        wormholeTokenBridge.completeTransferWithPayload.returns(
          exampleRedeemerOutputScript
        )
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
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should fallback to default amount in redemptions", async () => {
        wormholeTokenBridge.completeTransferWithPayload.returns(
          exampleRedeemerOutputScript
        )
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
    beforeEach(async () => {
      await createSnapshot()
      wormholeTokenBridge.completeTransferWithPayload.returns(
        exampleRedeemerOutputScript
      )
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
})
