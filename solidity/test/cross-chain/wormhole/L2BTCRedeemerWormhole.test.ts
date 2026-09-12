import { ethers, getUnnamedAccounts, helpers } from "hardhat"
import { randomBytes } from "crypto"
import { expect } from "chai"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { BaseContract, ContractTransactionResponse } from "ethers"
import { requireValue } from "../../../helpers/require-value"
import { loadFixture } from "../../helpers/fixture"
import {
  IL2WormholeGateway,
  L2TBTC,
  L2BTCRedeemerWormhole,
  TestERC20,
  TestBTCUtilsHelper,
} from "../../../typechain"
import { createMock, expectCalledOnceWith } from "../../helpers/mock"
import type { Mock } from "../../helpers/mock"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Returns hexString padded on the left with zeros to 32 bytes.
const toWormholeFormat = (address: string): string =>
  ethers.hexlify(ethers.zeroPadValue(address, 32))

// Assert a no-argument custom error revert without depending on hardhat's
// error-decode state (proxies can surface the error as raw selector data).
const expectRevertWithCustomError = async (
  promise: Promise<unknown>,
  contract: BaseContract,
  errorName: string
) => {
  const { selector } = requireValue(
    contract.interface.getError(`${errorName}()`),
    `${errorName}() ABI fragment`
  )
  try {
    await promise
  } catch (error: unknown) {
    const err = error as {
      data?: string | { data?: string }
      message?: string
      error?: { data?: string | { data?: string }; message?: string }
    } | null
    const rawData = err?.error?.data ?? err?.data
    const data = typeof rawData === "string" ? rawData : rawData?.data ?? ""
    const message = (err?.error?.message ?? err?.message ?? "").toString()
    const fullErrorStr = `${data} ${message}`

    if (
      fullErrorStr.toLowerCase().includes(selector.toLowerCase()) ||
      fullErrorStr.includes(errorName)
    ) {
      return
    }
    throw error
  }
  throw new Error(
    `Expected revert with ${errorName}, but the transaction succeeded`
  )
}

describe("L2BTCRedeemerWormhole", () => {
  let deployer: HardhatEthersSigner
  let governance: HardhatEthersSigner
  let user: HardhatEthersSigner

  let l2BtcRedeemer: L2BTCRedeemerWormhole
  let tbtc: L2TBTC
  let gateway: Mock<IL2WormholeGateway>
  let testBTCUtilsHelper: TestBTCUtilsHelper

  const l1ChainId = 2
  const l1BtcRedeemerWormholeAddress =
    "0x0000000000000000000000000000000000000001"

  const exampleAmount = ethers.parseUnits("1", 18)
  // Use a raw 25-byte P2PKH script structure, consistent with how L2BTCRedeemerWormhole uses BTCUtils.extractHashAt
  // prefix with 0x19 (25 bytes length)
  const exampleRedeemerOutputScript =
    "0x1976a9140102030405060708090a0b0c0d0e0f101112131488ac"
  const exampleNonce = 123

  // Example scripts
  const exampleP2WPKHOutputScript =
    "0x1600140102030405060708090a0b0c0d0e0f1011121314" // 22 bytes: OP_0 <20-byte-hash>
  const exampleP2SHOutputScript =
    "0x17a9140102030405060708090a0b0c0d0e0f101112131487" // 23 bytes: OP_HASH160 <20-byte-hash> OP_EQUAL
  const exampleP2WSHOutputScript =
    "0x2200200102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20" // 34 bytes: OP_0 <32-byte-hash>

  const contractsFixture = async () => {
    const _signers = await ethers.getSigners()
    const _deployer = _signers[0]
    const _user = _signers[1]
    const _namedSigners = await helpers.signers.getNamedSigners()
    const _governance = _namedSigners.governance || _signers[2]

    const _gateway = await createMock<IL2WormholeGateway>("IL2WormholeGateway")

    // Deploy TestBTCUtilsHelper
    const TestBTCUtilsHelperFactory = await ethers.getContractFactory(
      "TestBTCUtilsHelper",
      _deployer
    )
    const _testBTCUtilsHelper =
      (await TestBTCUtilsHelperFactory.deploy()) as TestBTCUtilsHelper
    await _testBTCUtilsHelper.waitForDeployment()

    // Deploy L2TBTC using the project's deployProxy helper structure
    const tbtcDeployment = await helpers.upgrades.deployProxy(
      `L2TBTC_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L2TBTC",
        initializerArgs: ["L2 TBTC", "L2TBTC"],
        factoryOpts: { signer: _deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    const _tbtc = tbtcDeployment[0] as unknown as L2TBTC

    // The deployer of L2TBTC is its owner. The owner needs to add itself as a minter.
    await _tbtc.connect(_deployer).addMinter(_deployer.address)

    // Deploy L2BTCRedeemerWormhole using the project's deployProxy helper structure
    const l2RedeemerDeployment = await helpers.upgrades.deployProxy(
      `L2BTCRedeemerWormhole_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L2BTCRedeemerWormhole",
        initializerArgs: [
          _tbtc.target,
          _gateway.address,
          toWormholeFormat(l1BtcRedeemerWormholeAddress),
          l1ChainId,
        ],
        factoryOpts: { signer: _deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    const _l2BtcRedeemer =
      l2RedeemerDeployment[0] as unknown as L2BTCRedeemerWormhole

    // Transfer ownership from the deployer (initial owner) to governance
    await _l2BtcRedeemer
      .connect(_deployer)
      .transferOwnership(_governance.address)

    return {
      deployer: _deployer,
      governance: _governance,
      user: _user,
      l2BtcRedeemer: _l2BtcRedeemer,
      tbtc: _tbtc,
      gateway: _gateway,
      testBTCUtilsHelper: _testBTCUtilsHelper,
      l1BtcRedeemerWormholeAddress,
      l1ChainId,
    }
  }

  before(async () => {
    await createSnapshot()
    ;({
      deployer,
      governance,
      user,
      l2BtcRedeemer,
      tbtc,
      gateway,
      testBTCUtilsHelper,
    } = await loadFixture(contractsFixture))

    // Debug BTCUtils.extractHashAt
    const payload = await testBTCUtilsHelper.getScriptPayload(
      exampleRedeemerOutputScript
    )
  })

  describe("initialization", () => {
    it("should set the tBTC token address", async () => {
      expect(await l2BtcRedeemer.tbtc()).to.equal(tbtc.target)
    })

    it("should set the gateway address", async () => {
      expect(await l2BtcRedeemer.gateway()).to.equal(gateway.address)
    })

    it("should set the L1 BTC Redeemer Wormhole address", async () => {
      expect(await l2BtcRedeemer.l1BtcRedeemerWormholeAddress()).to.equal(
        toWormholeFormat(l1BtcRedeemerWormholeAddress)
      )
    })

    it("should set the L1 BTC Redeemer Wormhole chain", async () => {
      expect(await l2BtcRedeemer.l1BtcRedeemerWormholeChain()).to.equal(
        l1ChainId
      )
    })

    it("should set the default minimum redemption amount", async () => {
      expect(await l2BtcRedeemer.minimumRedemptionAmount()).to.equal(
        BigInt("10000000000000000")
      )
    })

    it("should set the owner to governance", async () => {
      expect(await l2BtcRedeemer.owner()).to.equal(governance.address)
    })

    it("should revert if initialized with invalid recipient chain (0)", async () => {
      const proxyName = `L2BTCRedeemerWormhole_${randomBytes(8).toString(
        "hex"
      )}`
      await expectRevertWithCustomError(
        helpers.upgrades.deployProxy(proxyName, {
          contractName: "L2BTCRedeemerWormhole",
          initializerArgs: [
            tbtc.target,
            gateway.address,
            toWormholeFormat(l1BtcRedeemerWormholeAddress),
            0,
          ],
          factoryOpts: { signer: deployer },
          proxyOpts: { kind: "transparent" },
        }),
        l2BtcRedeemer,
        "InvalidRecipientChain"
      )
    })

    describe("initializeV2", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should revert if called by non-owner", async () => {
        await expect(
          l2BtcRedeemer.connect(user).initializeV2(l1ChainId)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert if chain is zero", async () => {
        await expectRevertWithCustomError(
          l2BtcRedeemer.connect(governance).initializeV2(0),
          l2BtcRedeemer,
          "InvalidRecipientChain"
        )
      })

      it("should update chain if called by owner", async () => {
        const newChain = 10
        await l2BtcRedeemer.connect(governance).initializeV2(newChain)
        expect(await l2BtcRedeemer.l1BtcRedeemerWormholeChain()).to.equal(
          newChain
        )
      })
    })

    context("when user has insufficient tBTC balance", () => {
      beforeEach(async () => {
        await createSnapshot()
        // Explicitly set user balance for this test to avoid state leakage
        const currentBalance = await tbtc.balanceOf(user.address)
        if (currentBalance > 0n) {
          await tbtc.connect(user).burn(currentBalance)
        }
        await tbtc.connect(deployer).mint(user.address, exampleAmount * 2n)
        await tbtc
          .connect(user)
          .approve(l2BtcRedeemer.target, ethers.MaxUint256)
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        const largeAmount = exampleAmount * 10n

        await expect(
          l2BtcRedeemer
            .connect(user)
            .requestRedemption(
              largeAmount,
              l1ChainId,
              exampleRedeemerOutputScript,
              exampleNonce
            )
        ).to.be.revertedWith("ERC20: transfer amount exceeds balance")
      })
    })
  })

  describe("updateMinimumRedemptionAmount", () => {
    const newMinAmount = ethers.parseUnits("0.05", 18)

    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          l2BtcRedeemer
            .connect(user)
            .updateMinimumRedemptionAmount(newMinAmount)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the new minimum amount is zero", () => {
      it("should revert", async () => {
        await expectRevertWithCustomError(
          l2BtcRedeemer
            .connect(governance)
            .updateMinimumRedemptionAmount(BigInt(0)),
          l2BtcRedeemer,
          "MinimumRedemptionAmountZero"
        )
      })
    })

    context("when the caller is the owner and amount is valid", () => {
      let tx: ContractTransactionResponse
      beforeEach(async () => {
        await createSnapshot()
        tx = await l2BtcRedeemer
          .connect(governance)
          .updateMinimumRedemptionAmount(newMinAmount)
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should update the minimumRedemptionAmount", async () => {
        expect(await l2BtcRedeemer.minimumRedemptionAmount()).to.equal(
          newMinAmount
        )
      })

      it("should emit MinimumRedemptionAmountUpdated event", async () => {
        await expect(tx)
          .to.emit(l2BtcRedeemer, "MinimumRedemptionAmountUpdated")
          .withArgs(newMinAmount)
      })
    })
  })

  describe("updateL1BtcRedeemer", () => {
    const newChainId = 5
    const newAddress = "0x0000000000000000000000000000000000000002"

    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          l2BtcRedeemer
            .connect(user)
            .updateL1BtcRedeemer(toWormholeFormat(newAddress), newChainId)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the new address is zero", () => {
      it("should revert", async () => {
        await expectRevertWithCustomError(
          l2BtcRedeemer
            .connect(governance)
            .updateL1BtcRedeemer(ethers.ZeroHash, newChainId),
          l2BtcRedeemer,
          "ZeroAddress"
        )
      })
    })

    context("when the new chain ID is zero", () => {
      it("should revert", async () => {
        await expectRevertWithCustomError(
          l2BtcRedeemer
            .connect(governance)
            .updateL1BtcRedeemer(toWormholeFormat(newAddress), 0),
          l2BtcRedeemer,
          "InvalidRecipientChain"
        )
      })
    })

    context("when the caller is the owner and params are valid", () => {
      let tx: ContractTransactionResponse

      beforeEach(async () => {
        await createSnapshot()
        tx = await l2BtcRedeemer
          .connect(governance)
          .updateL1BtcRedeemer(toWormholeFormat(newAddress), newChainId)
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should update l1BtcRedeemerWormholeChain and l1BtcRedeemerWormholeAddress", async () => {
        expect(await l2BtcRedeemer.l1BtcRedeemerWormholeChain()).to.equal(
          newChainId
        )
        expect(await l2BtcRedeemer.l1BtcRedeemerWormholeAddress()).to.equal(
          toWormholeFormat(newAddress)
        )
      })

      it("should emit L1BtcRedeemerUpdated event", async () => {
        await expect(tx)
          .to.emit(l2BtcRedeemer, "L1BtcRedeemerUpdated")
          .withArgs(toWormholeFormat(newAddress), newChainId)
      })
    })
  })

  describe("requestRedemption", () => {
    beforeEach(async () => {
      await createSnapshot()
      await gateway.sendTbtcWithPayloadToNativeChain.reset()
      await tbtc.connect(user).approve(l2BtcRedeemer.target, ethers.MaxUint256)

      // Reset user's balance to 0 before minting to ensure consistent test state
      const currentUserBalance = await tbtc.balanceOf(user.address)
      if (currentUserBalance > 0n) {
        await tbtc.connect(user).burn(currentUserBalance)
      }
      await tbtc.connect(deployer).mint(user.address, exampleAmount * 2n)

      await l2BtcRedeemer
        .connect(governance)
        .updateMinimumRedemptionAmount(ethers.parseUnits("0.001", 18))
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    context("when redemption is successful", () => {
      let tx: ContractTransactionResponse
      const expectedGatewaySequence = BigInt(789)

      beforeEach(async () => {
        await createSnapshot()
        await gateway.sendTbtcWithPayloadToNativeChain
          .whenCalledWith(
            exampleAmount,
            l1ChainId,
            toWormholeFormat(l1BtcRedeemerWormholeAddress),
            exampleNonce,
            exampleRedeemerOutputScript
          )
          .returns(expectedGatewaySequence)

        tx = await l2BtcRedeemer
          .connect(user)
          .requestRedemption(
            exampleAmount,
            l1ChainId,
            exampleRedeemerOutputScript,
            exampleNonce
          )
      })

      it("should transfer tBTC from user to L2BTCRedeemerWormhole contract", async () => {
        expect(await tbtc.balanceOf(user.address)).to.equal(exampleAmount)
        expect(await tbtc.balanceOf(l2BtcRedeemer.target)).to.equal(
          exampleAmount
        )
      })

      it("should approve L2WormholeGateway to spend tBTC from L2BTCRedeemerWormhole", async () => {
        const allowance = await tbtc.allowance(
          l2BtcRedeemer.target,
          gateway.address
        )
        expect(allowance).to.be.gte(exampleAmount)
      })

      it("should call gateway.sendTbtcWithPayloadToNativeChain with correct parameters", async () => {
        await expectCalledOnceWith(gateway.sendTbtcWithPayloadToNativeChain, [
          exampleAmount,
          l1ChainId,
          toWormholeFormat(l1BtcRedeemerWormholeAddress),
          exampleNonce,
          exampleRedeemerOutputScript,
        ])
      })

      it("should emit RedemptionRequestedOnL2 event", async () => {
        await expect(tx)
          .to.emit(l2BtcRedeemer, "RedemptionRequestedOnL2")
          .withArgs(exampleAmount, exampleRedeemerOutputScript, exampleNonce)
      })

      it("should return the sequence number from the gateway", async () => {
        // Re-program mock for this specific static call test
        await gateway.sendTbtcWithPayloadToNativeChain
          .whenCalledWith(
            exampleAmount,
            l1ChainId,
            toWormholeFormat(l1BtcRedeemerWormholeAddress),
            exampleNonce,
            exampleRedeemerOutputScript
          )
          .returns(expectedGatewaySequence)

        const sequence = await l2BtcRedeemer
          .connect(user)
          .requestRedemption.staticCall(
            exampleAmount,
            l1ChainId,
            exampleRedeemerOutputScript,
            exampleNonce
          )
        expect(sequence).to.equal(expectedGatewaySequence)
      })

      it("should increase the redeemedAmount", async () => {
        expect(await l2BtcRedeemer.redeemedAmount()).to.equal(exampleAmount)
      })
    })
    context("when l1Chain is 0", () => {
      let l2BtcRedeemerImplementation: L2BTCRedeemerWormhole
      beforeEach(async () => {
        // Deploy implementation directly, without initializing.
        // All state variables, including l1BtcRedeemerWormholeChain, are zero.
        const factory = await ethers.getContractFactory("L2BTCRedeemerWormhole")
        l2BtcRedeemerImplementation =
          (await factory.deploy()) as L2BTCRedeemerWormhole
      })

      it("should revert with InvalidRecipientChain", async () => {
        await expectRevertWithCustomError(
          l2BtcRedeemerImplementation
            .connect(user)
            .requestRedemption(
              exampleAmount,
              l1ChainId,
              exampleRedeemerOutputScript,
              exampleNonce
            ),
          l2BtcRedeemerImplementation,
          "InvalidRecipientChain"
        )
      })
    })

    context("when redeemerOutputScript is P2WPKH (successful)", () => {
      let tx: ContractTransactionResponse
      const expectedGatewaySequence = BigInt(790)

      beforeEach(async () => {
        await createSnapshot()
        await gateway.sendTbtcWithPayloadToNativeChain
          .whenCalledWith(
            exampleAmount,
            l1ChainId,
            toWormholeFormat(l1BtcRedeemerWormholeAddress),
            exampleNonce,
            exampleP2WPKHOutputScript
          )
          .returns(expectedGatewaySequence)

        tx = await l2BtcRedeemer
          .connect(user)
          .requestRedemption(
            exampleAmount,
            l1ChainId,
            exampleP2WPKHOutputScript,
            exampleNonce
          )
      })

      it("should transfer tBTC from user to L2BTCRedeemerWormhole contract", async () => {
        expect(await tbtc.balanceOf(user.address)).to.equal(exampleAmount)
        expect(await tbtc.balanceOf(l2BtcRedeemer.target)).to.equal(
          exampleAmount
        )
      })

      it("should call gateway.sendTbtcWithPayloadToNativeChain with P2WPKH script", async () => {
        await expectCalledOnceWith(gateway.sendTbtcWithPayloadToNativeChain, [
          exampleAmount,
          l1ChainId,
          toWormholeFormat(l1BtcRedeemerWormholeAddress),
          exampleNonce,
          exampleP2WPKHOutputScript, // Use P2WPKH script
        ])
      })

      it("should emit RedemptionRequestedOnL2 event with P2WPKH script", async () => {
        await expect(tx)
          .to.emit(l2BtcRedeemer, "RedemptionRequestedOnL2")
          .withArgs(exampleAmount, exampleP2WPKHOutputScript, exampleNonce)
      })
    })

    context("when redeemerOutputScript is P2SH (successful)", () => {
      let tx: ContractTransactionResponse
      const expectedGatewaySequence = BigInt(791)

      beforeEach(async () => {
        await createSnapshot()
        await gateway.sendTbtcWithPayloadToNativeChain
          .whenCalledWith(
            exampleAmount,
            l1ChainId,
            toWormholeFormat(l1BtcRedeemerWormholeAddress),
            exampleNonce,
            exampleP2SHOutputScript
          )
          .returns(expectedGatewaySequence)

        tx = await l2BtcRedeemer
          .connect(user)
          .requestRedemption(
            exampleAmount,
            l1ChainId,
            exampleP2SHOutputScript,
            exampleNonce
          )
      })

      it("should transfer tBTC from user to L2BTCRedeemerWormhole contract", async () => {
        expect(await tbtc.balanceOf(user.address)).to.equal(exampleAmount)
        expect(await tbtc.balanceOf(l2BtcRedeemer.target)).to.equal(
          exampleAmount
        )
      })

      it("should call gateway.sendTbtcWithPayloadToNativeChain with P2SH script", async () => {
        await expectCalledOnceWith(gateway.sendTbtcWithPayloadToNativeChain, [
          exampleAmount,
          l1ChainId,
          toWormholeFormat(l1BtcRedeemerWormholeAddress),
          exampleNonce,
          exampleP2SHOutputScript, // Use P2SH script
        ])
      })

      it("should emit RedemptionRequestedOnL2 event with P2SH script", async () => {
        await expect(tx)
          .to.emit(l2BtcRedeemer, "RedemptionRequestedOnL2")
          .withArgs(exampleAmount, exampleP2SHOutputScript, exampleNonce)
      })
    })

    context(
      "when redeemerOutputScript is P2WSH (should be successful if BTCUtils truncates/handles 32-byte hash)",
      () => {
        let tx: ContractTransactionResponse
        const expectedGatewaySequence = BigInt(792)

        beforeEach(async () => {
          await createSnapshot()
          await gateway.sendTbtcWithPayloadToNativeChain
            .whenCalledWith(
              exampleAmount,
              l1ChainId,
              toWormholeFormat(l1BtcRedeemerWormholeAddress),
              exampleNonce,
              exampleP2WSHOutputScript
            )
            .returns(expectedGatewaySequence)

          tx = await l2BtcRedeemer
            .connect(user)
            .requestRedemption(
              exampleAmount,
              l1ChainId,
              exampleP2WSHOutputScript,
              exampleNonce
            )
        })

        it("should transfer tBTC from user to L2BTCRedeemerWormhole contract", async () => {
          expect(await tbtc.balanceOf(user.address)).to.equal(exampleAmount)
          expect(await tbtc.balanceOf(l2BtcRedeemer.target)).to.equal(
            exampleAmount
          )
        })

        it("should call gateway.sendTbtcWithPayloadToNativeChain with P2WSH script", async () => {
          await expectCalledOnceWith(gateway.sendTbtcWithPayloadToNativeChain, [
            exampleAmount,
            l1ChainId,
            toWormholeFormat(l1BtcRedeemerWormholeAddress),
            exampleNonce,
            exampleP2WSHOutputScript, // Use P2WSH script
          ])
        })

        it("should emit RedemptionRequestedOnL2 event with P2WSH script", async () => {
          await expect(tx)
            .to.emit(l2BtcRedeemer, "RedemptionRequestedOnL2")
            .withArgs(exampleAmount, exampleP2WSHOutputScript, exampleNonce)
        })
      }
    )

    context("when redeemerOutputScript is invalid (non-standard)", () => {
      it("should revert", async () => {
        const invalidScript = "0x00112233"
        await expectRevertWithCustomError(
          l2BtcRedeemer
            .connect(user)
            .requestRedemption(
              exampleAmount,
              l1ChainId,
              invalidScript,
              exampleNonce
            ),
          l2BtcRedeemer,
          "InvalidRedeemerOutputScript"
        )
      })
    })

    context("when recipient chain is not the configured L1 chain", () => {
      it("should revert", async () => {
        await expectRevertWithCustomError(
          l2BtcRedeemer
            .connect(user)
            .requestRedemption(
              exampleAmount,
              l1ChainId + 1,
              exampleRedeemerOutputScript,
              exampleNonce
            ),
          l2BtcRedeemer,
          "InvalidRecipientChain"
        )
      })
    })

    context("when amount is less than minimumRedemptionAmount", () => {
      beforeEach(async () => {
        await l2BtcRedeemer
          .connect(governance)
          .updateMinimumRedemptionAmount(ethers.parseUnits("2", 18))
      })
      it("should revert", async () => {
        await expectRevertWithCustomError(
          l2BtcRedeemer
            .connect(user)
            .requestRedemption(
              exampleAmount,
              l1ChainId,
              exampleRedeemerOutputScript,
              exampleNonce
            ),
          l2BtcRedeemer,
          "AmountTooLowToRedeem"
        )
      })
    })

    context("when normalized amount is zero (dust)", () => {
      it("should revert", async () => {
        const dustAmount = BigInt(100)
        await expectRevertWithCustomError(
          l2BtcRedeemer
            .connect(user)
            .requestRedemption(
              dustAmount,
              l1ChainId,
              exampleRedeemerOutputScript,
              exampleNonce
            ),
          l2BtcRedeemer,
          "AmountTooLowToRedeem"
        )
      })
    })

    context("when user has not approved L2BTCRedeemerWormhole", () => {
      it("should revert", async () => {
        await tbtc.connect(user).approve(l2BtcRedeemer.target, 0)
        await expect(
          l2BtcRedeemer
            .connect(user)
            .requestRedemption(
              exampleAmount,
              l1ChainId,
              exampleRedeemerOutputScript,
              exampleNonce
            )
        ).to.be.revertedWith("ERC20: insufficient allowance")
      })
    })

    context("when gateway.sendTbtcWithPayloadToNativeChain reverts", () => {
      it("should revert", async () => {
        await gateway.sendTbtcWithPayloadToNativeChain
          .whenCalledWith(
            exampleAmount,
            l1ChainId,
            toWormholeFormat(l1BtcRedeemerWormholeAddress),
            exampleNonce,
            exampleRedeemerOutputScript
          )
          .reverts()

        await expect(
          l2BtcRedeemer
            .connect(user)
            .requestRedemption(
              exampleAmount,
              l1ChainId,
              exampleRedeemerOutputScript,
              exampleNonce
            )
        ).to.be.reverted
      })
    })
  })
})
