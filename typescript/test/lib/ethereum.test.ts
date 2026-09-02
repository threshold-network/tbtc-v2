import {
  BitcoinTxHash,
  BitcoinHashUtils,
  EthereumAddress,
  EthereumBridge,
  EthereumTBTCToken,
  ethereumAddressFromSigner,
  Hex,
  chainIdFromSigner,
  Chains,
  BitcoinRawTxVectors,
  DepositReceipt,
  ChainIdentifier,
  EthereumL1BitcoinDepositor,
  EthereumExtraDataEncoder,
} from "../../src"
import { expect } from "chai"
import { encodeAbiParameters, zeroAddress, type Abi, type Address } from "viem"
import { expectContractWrite, MockEvm } from "../utils/mock-evm"

// ABI imports.
import { abi as BridgeABI } from "@keep-network/tbtc-v2/artifacts/Bridge.json"
import { abi as TBTCTokenABI } from "@keep-network/tbtc-v2/artifacts/TBTC.json"
import { abi as WalletRegistryABI } from "@keep-network/ecdsa/artifacts/WalletRegistry.json"
import { abi as BaseL1BitcoinDepositorABI } from "../../src/lib/ethereum/artifacts/sepolia/BaseL1BitcoinDepositor.json"
import { abi as ArbitrumL1BitcoinDepositorABI } from "../../src/lib/ethereum/artifacts/sepolia/ArbitrumL1BitcoinDepositor.json"

const bridgeAbi = BridgeABI as Abi
const tbtcTokenAbi = TBTCTokenABI as Abi
const walletRegistryAbi = WalletRegistryABI as Abi
const baseL1BitcoinDepositorAbi = BaseL1BitcoinDepositorABI as Abi
const arbitrumL1BitcoinDepositorAbi = ArbitrumL1BitcoinDepositorABI as Abi

describe("Ethereum", () => {
  describe("EthereumBridge", () => {
    const bridgeAddress: Address = "0x475a30f1baa1a004059b6ee19c40aada5f2e0d1b"
    const walletRegistryAddress: Address =
      "0x2125d9c8bbbdf1fdf82cd5972f74d4d10cccf776"

    let mock: MockEvm
    let bridgeHandle: EthereumBridge

    beforeEach(async () => {
      mock = new MockEvm()

      mock.stubRead(
        bridgeAddress,
        bridgeAbi,
        "contractReferences",
        [],
        [zeroAddress, zeroAddress, walletRegistryAddress, zeroAddress]
      )

      bridgeHandle = new EthereumBridge({
        address: bridgeAddress,
        signerOrProvider: mock.asSigner(),
      })
    })

    describe("pendingRedemptions", () => {
      beforeEach(async () => {
        // Set the mock to return a specific redemption data when called
        // with the redemption key (built as keccak256(keccak256(redeemerOutputScript) | walletPublicKeyHash))
        // that matches the wallet PKH and redeemer output script used during
        // the test call.
        mock.stubRead(
          bridgeAddress,
          bridgeAbi,
          "pendingRedemptions",
          [
            BigInt(
              "0x4f5c364239f365622168b8fcb3f4556a8bbad22f5b5ae598757c4fe83b3a78d7"
            ),
          ],
          {
            redeemer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            requestedAmount: 10000n,
            treasuryFee: 100n,
            txMaxFee: 50n,
            requestedAt: 1650623240,
          }
        )
      })

      it("should return the pending redemption", async () => {
        expect(
          await bridgeHandle.pendingRedemptions(
            Hex.from(
              "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
            ),
            Hex.from("a9143ec459d0f3c29286ae5df5fcc421e2786024277e87")
          )
        ).to.be.eql({
          redeemer: EthereumAddress.from(
            "f39fd6e51aad88f6f4ce6ab8827279cfffb92266"
          ),
          redeemerOutputScript: Hex.from(
            "a9143ec459d0f3c29286ae5df5fcc421e2786024277e87"
          ),
          requestedAmount: 10000n,
          treasuryFee: 100n,
          txMaxFee: 50n,
          requestedAt: 1650623240,
        })
      })
    })

    describe("timedOutRedemptions", () => {
      beforeEach(async () => {
        // Set the mock to return a specific redemption data when called
        // with the redemption key (built as keccak256(keccak256(redeemerOutputScript) | walletPublicKeyHash))
        // that matches the wallet PKH and redeemer output script used during
        // the test call.
        mock.stubRead(
          bridgeAddress,
          bridgeAbi,
          "timedOutRedemptions",
          [
            BigInt(
              "0x4f5c364239f365622168b8fcb3f4556a8bbad22f5b5ae598757c4fe83b3a78d7"
            ),
          ],
          {
            redeemer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            requestedAmount: 10000n,
            treasuryFee: 100n,
            txMaxFee: 50n,
            requestedAt: 1650623240,
          }
        )
      })

      it("should return the timed-out redemption", async () => {
        expect(
          await bridgeHandle.timedOutRedemptions(
            Hex.from(
              "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
            ),
            Hex.from("a9143ec459d0f3c29286ae5df5fcc421e2786024277e87")
          )
        ).to.be.eql({
          redeemer: EthereumAddress.from(
            "f39fd6e51aad88f6f4ce6ab8827279cfffb92266"
          ),
          redeemerOutputScript: Hex.from(
            "a9143ec459d0f3c29286ae5df5fcc421e2786024277e87"
          ),
          requestedAmount: 10000n,
          treasuryFee: 100n,
          txMaxFee: 50n,
          requestedAt: 1650623240,
        })
      })
    })

    describe("revealDeposit", () => {
      const expectedFundingTx = {
        version: "0x00000000",
        inputVector: "0x11111111",
        outputVector: "0x22222222",
        locktime: "0x33333333",
      }
      const expectedReveal = {
        fundingOutputIndex: 2,
        blindingFactor: "0xf9f0c90d00039523",
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
        refundLocktime: "0x60bcea61",
        vault: "0x82883a4c7a8dd73ef165deb402d432613615ced4",
      }

      context("when deposit does not have optional extra data", () => {
        beforeEach(async () => {
          mock.stubRead(
            bridgeAddress,
            bridgeAbi,
            "revealDeposit",
            [expectedFundingTx, expectedReveal],
            undefined
          )

          await bridgeHandle.revealDeposit(
            // Just short byte strings for clarity.
            {
              version: Hex.from("00000000"),
              inputs: Hex.from("11111111"),
              outputs: Hex.from("22222222"),
              locktime: Hex.from("33333333"),
            },
            2,
            {
              depositor: EthereumAddress.from(
                "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
              ),
              walletPublicKeyHash: Hex.from(
                "8db50eb52063ea9d98b3eac91489a90f738986f6"
              ),
              refundPublicKeyHash: Hex.from(
                "28e081f285138ccbe389c1eb8985716230129f89"
              ),
              blindingFactor: Hex.from("f9f0c90d00039523"),
              refundLocktime: Hex.from("60bcea61"),
            },
            EthereumAddress.from("82883a4c7a8dd73ef165deb402d432613615ced4")
          )
        })

        it("should reveal the deposit", async () => {
          expectContractWrite(mock, bridgeAddress, bridgeAbi, "revealDeposit", [
            expectedFundingTx,
            expectedReveal,
          ])
        })
      })

      context("when deposit has optional extra data", () => {
        const expectedExtraData =
          "0xaebfb5afc9ee6432374ed39b58b8cf87797f9468eca40569b67ac8d59415c9c0"

        beforeEach(async () => {
          mock.stubRead(
            bridgeAddress,
            bridgeAbi,
            "revealDepositWithExtraData",
            [expectedFundingTx, expectedReveal, expectedExtraData],
            undefined
          )

          await bridgeHandle.revealDeposit(
            // Just short byte strings for clarity.
            {
              version: Hex.from("00000000"),
              inputs: Hex.from("11111111"),
              outputs: Hex.from("22222222"),
              locktime: Hex.from("33333333"),
            },
            2,
            {
              depositor: EthereumAddress.from(
                "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
              ),
              walletPublicKeyHash: Hex.from(
                "8db50eb52063ea9d98b3eac91489a90f738986f6"
              ),
              refundPublicKeyHash: Hex.from(
                "28e081f285138ccbe389c1eb8985716230129f89"
              ),
              blindingFactor: Hex.from("f9f0c90d00039523"),
              refundLocktime: Hex.from("60bcea61"),
              extraData: Hex.from(
                "aebfb5afc9ee6432374ed39b58b8cf87797f9468eca40569b67ac8d59415c9c0"
              ),
            },
            EthereumAddress.from("82883a4c7a8dd73ef165deb402d432613615ced4")
          )
        })

        it("should reveal the deposit", async () => {
          expectContractWrite(
            mock,
            bridgeAddress,
            bridgeAbi,
            "revealDepositWithExtraData",
            [expectedFundingTx, expectedReveal, expectedExtraData]
          )
        })
      })
    })

    describe("submitDepositSweepProof", () => {
      const expectedSweepTx = {
        version: "0x00000000",
        inputVector: "0x11111111",
        outputVector: "0x22222222",
        locktime: "0x33333333",
      }
      const expectedSweepProof = {
        merkleProof: "0x44444444",
        txIndexInBlock: 5,
        bitcoinHeaders: "0x66666666",
        coinbasePreimage: BitcoinHashUtils.computeSha256(
          Hex.from("77777777")
        ).toPrefixedString(),
        coinbaseProof: "0x88888888",
      }
      const expectedMainUtxo = {
        txHash:
          "0x6896f9abcac13ce6bd2b80d125bedf997ff6330e999f2f605ea15ea542f2eaf8",
        txOutputIndex: 8,
        txOutputValue: 9999n,
      }
      const expectedVault = "0x82883a4c7a8dd73ef165deb402d432613615ced4"

      beforeEach(async () => {
        mock.stubRead(
          bridgeAddress,
          bridgeAbi,
          "submitDepositSweepProof",
          [
            expectedSweepTx,
            expectedSweepProof,
            expectedMainUtxo,
            expectedVault,
          ],
          undefined
        )

        await bridgeHandle.submitDepositSweepProof(
          {
            version: Hex.from("00000000"),
            inputs: Hex.from("11111111"),
            outputs: Hex.from("22222222"),
            locktime: Hex.from("33333333"),
          },
          {
            merkleProof: Hex.from("44444444"),
            txIndexInBlock: 5,
            bitcoinHeaders: Hex.from("66666666"),
            coinbasePreimage: BitcoinHashUtils.computeSha256(
              Hex.from("77777777")
            ),
            coinbaseProof: Hex.from("88888888"),
          },
          {
            transactionHash: BitcoinTxHash.from(
              "f8eaf242a55ea15e602f9f990e33f67f99dfbe25d1802bbde63cc1caabf99668"
            ),
            outputIndex: 8,
            value: 9999n,
          },
          EthereumAddress.from("82883a4c7a8dd73ef165deb402d432613615ced4")
        )
      })

      it("should submit the deposit sweep proof", () => {
        expectContractWrite(
          mock,
          bridgeAddress,
          bridgeAbi,
          "submitDepositSweepProof",
          [expectedSweepTx, expectedSweepProof, expectedMainUtxo, expectedVault]
        )
      })
    })

    describe("txProofDifficultyFactor", () => {
      beforeEach(async () => {
        mock.stubRead(
          bridgeAddress,
          bridgeAbi,
          "txProofDifficultyFactor",
          [],
          6n
        )
      })

      it("should return the tx proof difficulty factor", async () => {
        expect(await bridgeHandle.txProofDifficultyFactor()).to.be.equal(6)
      })
    })

    describe("requestRedemption", () => {
      const expectedWalletPublicKeyHash =
        "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
      const expectedMainUtxo = {
        txHash:
          "0x6896f9abcac13ce6bd2b80d125bedf997ff6330e999f2f605ea15ea542f2eaf8",
        txOutputIndex: 8,
        txOutputValue: 9999n,
      }
      const expectedRedeemerOutputScript =
        "0x17a9143ec459d0f3c29286ae5df5fcc421e2786024277e87"

      beforeEach(async () => {
        mock.stubRead(
          bridgeAddress,
          bridgeAbi,
          "requestRedemption",
          [
            expectedWalletPublicKeyHash,
            expectedMainUtxo,
            expectedRedeemerOutputScript,
            10000n,
          ],
          undefined
        )

        await bridgeHandle.requestRedemption(
          Hex.from(
            "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
          ),
          {
            transactionHash: BitcoinTxHash.from(
              "f8eaf242a55ea15e602f9f990e33f67f99dfbe25d1802bbde63cc1caabf99668"
            ),
            outputIndex: 8,
            value: 9999n,
          },
          Hex.from("a9143ec459d0f3c29286ae5df5fcc421e2786024277e87"),
          10000n
        )
      })

      it("should request the redemption", async () => {
        expectContractWrite(
          mock,
          bridgeAddress,
          bridgeAbi,
          "requestRedemption",
          [
            expectedWalletPublicKeyHash,
            expectedMainUtxo,
            expectedRedeemerOutputScript,
            10000n,
          ]
        )
      })
    })

    describe("submitRedemptionProof", () => {
      const expectedRedemptionTx = {
        version: "0x00000000",
        inputVector: "0x11111111",
        outputVector: "0x22222222",
        locktime: "0x33333333",
      }
      const expectedRedemptionProof = {
        merkleProof: "0x44444444",
        txIndexInBlock: 5,
        bitcoinHeaders: "0x66666666",
        coinbasePreimage: BitcoinHashUtils.computeSha256(
          Hex.from("77777777")
        ).toPrefixedString(),
        coinbaseProof: "0x88888888",
      }
      const expectedMainUtxo = {
        txHash:
          "0x6896f9abcac13ce6bd2b80d125bedf997ff6330e999f2f605ea15ea542f2eaf8",
        txOutputIndex: 8,
        txOutputValue: 9999n,
      }
      const expectedWalletPublicKeyHash =
        "0x8db50eb52063ea9d98b3eac91489a90f738986f6"

      beforeEach(async () => {
        mock.stubRead(
          bridgeAddress,
          bridgeAbi,
          "submitRedemptionProof",
          [
            expectedRedemptionTx,
            expectedRedemptionProof,
            expectedMainUtxo,
            expectedWalletPublicKeyHash,
          ],
          undefined
        )

        await bridgeHandle.submitRedemptionProof(
          {
            version: Hex.from("00000000"),
            inputs: Hex.from("11111111"),
            outputs: Hex.from("22222222"),
            locktime: Hex.from("33333333"),
          },
          {
            merkleProof: Hex.from("44444444"),
            txIndexInBlock: 5,
            bitcoinHeaders: Hex.from("66666666"),
            coinbasePreimage: BitcoinHashUtils.computeSha256(
              Hex.from("77777777")
            ),
            coinbaseProof: Hex.from("88888888"),
          },
          {
            transactionHash: BitcoinTxHash.from(
              "f8eaf242a55ea15e602f9f990e33f67f99dfbe25d1802bbde63cc1caabf99668"
            ),
            outputIndex: 8,
            value: 9999n,
          },
          Hex.from(
            "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
          )
        )
      })

      it("should submit the redemption proof", () => {
        expectContractWrite(
          mock,
          bridgeAddress,
          bridgeAbi,
          "submitRedemptionProof",
          [
            expectedRedemptionTx,
            expectedRedemptionProof,
            expectedMainUtxo,
            expectedWalletPublicKeyHash,
          ]
        )
      })
    })

    describe("deposits", () => {
      context("when the revealed deposit has a vault set", () => {
        beforeEach(async () => {
          // Set the mock to return a specific revealed deposit when called
          // with the deposit key (built as keccak256(depositTxHash | depositOutputIndex)
          // that matches the deposit transaction hash and output index used during
          // the test call.
          mock.stubRead(
            bridgeAddress,
            bridgeAbi,
            "deposits",
            [
              BigInt(
                "0x01151be714c10edde62a310bf0604c01134450416a0bf8a7bfd43cef90644f0f"
              ),
            ],
            {
              depositor: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
              amount: 10000n,
              vault: "0x014e1BFbe0f85F129749a8ae0fcB20175433741B",
              revealedAt: 1654774330,
              sweptAt: 1655033516,
              treasuryFee: 200n,
              extraData:
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            }
          )
        })

        it("should return the revealed deposit", async () => {
          expect(
            await bridgeHandle.deposits(
              BitcoinTxHash.from(
                "c1082c460527079a84e39ec6481666db72e5a22e473a78db03b996d26fd1dc83"
              ),
              0
            )
          ).to.be.eql({
            depositor: EthereumAddress.from(
              "f39fd6e51aad88f6f4ce6ab8827279cfffb92266"
            ),
            amount: 10000n,
            vault: EthereumAddress.from(
              "014e1bfbe0f85f129749a8ae0fcb20175433741b"
            ),
            revealedAt: 1654774330,
            sweptAt: 1655033516,
            treasuryFee: 200n,
          })
        })
      })

      context("when the revealed deposit has no vault set", () => {
        beforeEach(async () => {
          // Set the mock to return a specific revealed deposit when called
          // with the deposit key (built as keccak256(depositTxHash | depositOutputIndex)
          // that matches the deposit transaction hash and output index used during
          // the test call.
          mock.stubRead(
            bridgeAddress,
            bridgeAbi,
            "deposits",
            [
              BigInt(
                "0x01151be714c10edde62a310bf0604c01134450416a0bf8a7bfd43cef90644f0f"
              ),
            ],
            {
              depositor: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
              amount: 10000n,
              vault: zeroAddress,
              revealedAt: 1654774330,
              sweptAt: 1655033516,
              treasuryFee: 200n,
              extraData:
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            }
          )
        })

        it("should return the revealed deposit", async () => {
          expect(
            await bridgeHandle.deposits(
              BitcoinTxHash.from(
                "c1082c460527079a84e39ec6481666db72e5a22e473a78db03b996d26fd1dc83"
              ),
              0
            )
          ).to.be.eql({
            depositor: EthereumAddress.from(
              "f39fd6e51aad88f6f4ce6ab8827279cfffb92266"
            ),
            amount: 10000n,
            vault: undefined,
            revealedAt: 1654774330,
            sweptAt: 1655033516,
            treasuryFee: 200n,
          })
        })
      })
    })

    describe("activeWalletPublicKey", () => {
      context("when there is an active wallet", () => {
        beforeEach(async () => {
          mock.stubRead(
            bridgeAddress,
            bridgeAbi,
            "activeWalletPubKeyHash",
            [],
            "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
          )

          mock.stubRead(
            bridgeAddress,
            bridgeAbi,
            "wallets",
            ["0x8db50eb52063ea9d98b3eac91489a90f738986f6"],
            {
              ecdsaWalletID:
                "0x9ff37567d973e4d884bc42d2d1a6cb1ff22676ab64f82c62b58e2b0ffd3fff71",
              mainUtxoHash:
                "0x0000000000000000000000000000000000000000000000000000000000000000",
              pendingRedemptionsValue: 0n,
              createdAt: 1654846075,
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: 1,
              movingFundsTargetWalletsCommitmentHash:
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            }
          )

          mock.stubRead(
            walletRegistryAddress,
            walletRegistryAbi,
            "getWalletPublicKey",
            [
              "0x9ff37567d973e4d884bc42d2d1a6cb1ff22676ab64f82c62b58e2b0ffd3fff71",
            ],
            "0x989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9d218b65e7d91c752f7b22eaceb771a9af3a6f3d3f010a5d471a1aeef7d7713af"
          )
        })

        it("should return the active wallet's public key", async () => {
          expect(
            (await bridgeHandle.activeWalletPublicKey())?.toString()
          ).to.be.equal(
            "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
          )
        })
      })

      context("when there is no active wallet", () => {
        beforeEach(async () => {
          mock.stubRead(
            bridgeAddress,
            bridgeAbi,
            "activeWalletPubKeyHash",
            [],
            "0x0000000000000000000000000000000000000000"
          )
        })

        it("should return undefined", async () => {
          expect(await bridgeHandle.activeWalletPublicKey()).to.be.undefined
        })
      })
    })
    describe("buildUtxoHash", () => {
      it("should build the correct UTXO hash", () => {
        const utxo = {
          transactionHash: BitcoinTxHash.from(
            "c1082c460527079a84e39ec6481666db72e5a22e473a78db03b996d26fd1dc83"
          ),
          outputIndex: 0,
          value: 10000n,
        }

        expect(bridgeHandle.buildUtxoHash(utxo).toPrefixedString()).to.be.equal(
          "0xa2db1627c2c3b268f52368e1c9ecd0cba47af6c9939b3a5a5b191db641346f7c"
        )
      })
    })
  })

  describe("EthereumTBTCToken", () => {
    const tokenAddress: Address = "0x2f9d861a1e8f4cd5c80cd93b303c02bba90e83d0"

    let mock: MockEvm
    let tokenHandle: EthereumTBTCToken

    beforeEach(async () => {
      mock = new MockEvm()

      tokenHandle = new EthereumTBTCToken({
        address: tokenAddress,
        signerOrProvider: mock.asSigner(),
      })
    })

    describe("requestRedemption", () => {
      const data = {
        vault: EthereumAddress.from(
          "0x24BE35e7C04E2e0a628614Ce0Ed58805e1C894F7"
        ),
        walletPublicKey: Hex.from(
          "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
        ),
        mainUtxo: {
          transactionHash: BitcoinTxHash.from(
            "f8eaf242a55ea15e602f9f990e33f67f99dfbe25d1802bbde63cc1caabf99668"
          ),
          outputIndex: 8,
          value: 9999n,
        },
        amount: 10000n,
        redeemerOutputScript: {
          unprefixed: Hex.from(
            "0020cdbf909e935c855d3e8d1b61aeb9c5e3c03ae8021b286839b1a72f2e48fdba70"
          ),
          prefixed: Hex.from(
            "220020cdbf909e935c855d3e8d1b61aeb9c5e3c03ae8021b286839b1a72f2e48fdba70"
          ),
        },
      }

      // The redeemer is resolved from the account of the connected signer -
      // the fixed MockEvm test account.
      const expectedExtraData = (redeemer: EthereumAddress): `0x${string}` =>
        encodeAbiParameters(
          [
            { type: "address" },
            { type: "bytes20" },
            { type: "bytes32" },
            { type: "uint32" },
            { type: "uint64" },
            { type: "bytes" },
          ],
          [
            `0x${redeemer.identifierHex}` as `0x${string}`,
            BitcoinHashUtils.computeHash160(
              data.walletPublicKey
            ).toPrefixedString() as `0x${string}`,
            data.mainUtxo.transactionHash
              .reverse()
              .toPrefixedString() as `0x${string}`,
            data.mainUtxo.outputIndex,
            data.mainUtxo.value,
            data.redeemerOutputScript.prefixed.toPrefixedString() as `0x${string}`,
          ]
        )

      beforeEach(async () => {
        const redeemer = EthereumAddress.from(mock.account)

        mock.stubRead(
          tokenAddress,
          tbtcTokenAbi,
          "owner",
          [],
          `0x${data.vault.identifierHex}`
        )
        mock.stubRead(
          tokenAddress,
          tbtcTokenAbi,
          "approveAndCall",
          [
            `0x${data.vault.identifierHex}`,
            data.amount,
            expectedExtraData(redeemer),
          ],
          true
        )

        await tokenHandle.requestRedemption(
          data.walletPublicKey,
          data.mainUtxo,
          data.redeemerOutputScript.unprefixed,
          data.amount
        )
      })

      it("should request the redemption", async () => {
        const redeemer = EthereumAddress.from(mock.account)

        expectContractWrite(
          mock,
          tokenAddress,
          tbtcTokenAbi,
          "approveAndCall",
          [
            `0x${data.vault.identifierHex}`,
            data.amount,
            expectedExtraData(redeemer),
          ]
        )
      })
    })
  })

  describe("EthereumL1BitcoinDepositor - BASE", () => {
    const depositorAddress: Address =
      "0x8bdb63ef8281c5c2eae1979ee7cd2c00d4451ecc"

    let mock: MockEvm
    let depositorHandle: EthereumL1BitcoinDepositor

    beforeEach(async () => {
      mock = new MockEvm()

      depositorHandle = new EthereumL1BitcoinDepositor(
        {
          address: depositorAddress,
          signerOrProvider: mock.asSigner(),
        },
        Chains.Ethereum.Sepolia,
        // Use Base for testing but this can be any supported L2 chain.
        "Base"
      )
    })

    describe("initializeDeposit", () => {
      // Just short byte strings for clarity.
      const depositTx: BitcoinRawTxVectors = {
        version: Hex.from("00000000"),
        inputs: Hex.from("11111111"),
        outputs: Hex.from("22222222"),
        locktime: Hex.from("33333333"),
      }
      const depositOutputIndex: number = 2
      const deposit: DepositReceipt = {
        depositor: EthereumAddress.from(
          "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
        ),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "28e081f285138ccbe389c1eb8985716230129f89"
        ),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: Hex.from("60bcea61"),
        extraData: Hex.from(
          "00000000000000000000000091fe5b7027c0cA767270bB1A474bA1338BA2A4d2"
        ),
      }
      const vault: ChainIdentifier = EthereumAddress.from(
        "82883a4c7a8dd73ef165deb402d432613615ced4"
      )

      const expectedFundingTx = {
        version: "0x00000000",
        inputVector: "0x11111111",
        outputVector: "0x22222222",
        locktime: "0x33333333",
      }
      const expectedReveal = {
        fundingOutputIndex: 2,
        blindingFactor: "0xf9f0c90d00039523",
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
        refundLocktime: "0x60bcea61",
        vault: "0x82883a4c7a8dd73ef165deb402d432613615ced4",
      }
      // The full 32-byte extra data (the L2 deposit owner left-padded with
      // 12 zero bytes) as sent on chain.
      const expectedExtraData =
        "0x00000000000000000000000091fe5b7027c0ca767270bb1a474ba1338ba2a4d2"

      context(
        "when L2 deposit owner is properly encoded in the extra data",
        () => {
          beforeEach(async () => {
            mock.stubRead(
              depositorAddress,
              baseL1BitcoinDepositorAbi,
              "initializeDeposit",
              [expectedFundingTx, expectedReveal, expectedExtraData],
              undefined
            )

            await depositorHandle.initializeDeposit(
              depositTx,
              depositOutputIndex,
              deposit,
              vault
            )
          })

          it("should initialize the deposit", async () => {
            expectContractWrite(
              mock,
              depositorAddress,
              baseL1BitcoinDepositorAbi,
              "initializeDeposit",
              [expectedFundingTx, expectedReveal, expectedExtraData]
            )
          })
        }
      )

      context(
        "when L2 deposit owner is not properly encoded in the extra data",
        () => {
          it("should throw", async () => {
            let error: unknown
            try {
              await depositorHandle.initializeDeposit(
                depositTx,
                depositOutputIndex,
                {
                  ...deposit,
                  extraData: undefined, // Set empty extra data.
                },
                vault
              )
            } catch (e) {
              error = e
            }

            expect((error as Error).message).to.equal("Extra data is required")
          })
        }
      )
    })
  })

  describe("EthereumL1BitcoinDepositor - ARBITRUM", () => {
    const depositorAddress: Address =
      "0x494954f2db6cdbd2098c0af2b1e8d5e0c9c30da5"

    let mock: MockEvm
    let depositorHandle: EthereumL1BitcoinDepositor

    beforeEach(async () => {
      mock = new MockEvm()

      depositorHandle = new EthereumL1BitcoinDepositor(
        {
          address: depositorAddress,
          signerOrProvider: mock.asSigner(),
        },
        Chains.Ethereum.Sepolia,
        // Use Arbitrum for testing but this can be any supported L2 chain.
        "Arbitrum"
      )
    })

    describe("initializeDeposit", () => {
      // Just short byte strings for clarity.
      const depositTx: BitcoinRawTxVectors = {
        version: Hex.from("00000000"),
        inputs: Hex.from("11111111"),
        outputs: Hex.from("22222222"),
        locktime: Hex.from("33333333"),
      }
      const depositOutputIndex: number = 2
      const deposit: DepositReceipt = {
        depositor: EthereumAddress.from(
          "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
        ),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "28e081f285138ccbe389c1eb8985716230129f89"
        ),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: Hex.from("60bcea61"),
        extraData: Hex.from(
          "00000000000000000000000091fe5b7027c0cA767270bB1A474bA1338BA2A4d2"
        ),
      }
      const vault: ChainIdentifier = EthereumAddress.from(
        "82883a4c7a8dd73ef165deb402d432613615ced4"
      )

      const expectedFundingTx = {
        version: "0x00000000",
        inputVector: "0x11111111",
        outputVector: "0x22222222",
        locktime: "0x33333333",
      }
      const expectedReveal = {
        fundingOutputIndex: 2,
        blindingFactor: "0xf9f0c90d00039523",
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
        refundLocktime: "0x60bcea61",
        vault: "0x82883a4c7a8dd73ef165deb402d432613615ced4",
      }
      // The full 32-byte extra data (the L2 deposit owner left-padded with
      // 12 zero bytes) as sent on chain.
      const expectedExtraData =
        "0x00000000000000000000000091fe5b7027c0ca767270bb1a474ba1338ba2a4d2"

      context(
        "when L2 deposit owner is properly encoded in the extra data",
        () => {
          beforeEach(async () => {
            mock.stubRead(
              depositorAddress,
              arbitrumL1BitcoinDepositorAbi,
              "initializeDeposit",
              [expectedFundingTx, expectedReveal, expectedExtraData],
              undefined
            )

            await depositorHandle.initializeDeposit(
              depositTx,
              depositOutputIndex,
              deposit,
              vault
            )
          })

          it("should initialize the deposit", async () => {
            expectContractWrite(
              mock,
              depositorAddress,
              arbitrumL1BitcoinDepositorAbi,
              "initializeDeposit",
              [expectedFundingTx, expectedReveal, expectedExtraData]
            )
          })
        }
      )

      context(
        "when L2 deposit owner is not properly encoded in the extra data",
        () => {
          it("should throw", async () => {
            let error: unknown
            try {
              await depositorHandle.initializeDeposit(
                depositTx,
                depositOutputIndex,
                {
                  ...deposit,
                  extraData: undefined, // Set empty extra data.
                },
                vault
              )
            } catch (e) {
              error = e
            }

            expect((error as Error).message).to.equal("Extra data is required")
          })
        }
      )
    })
  })

  describe("EthereumExtraDataEncoder", () => {
    let encoder: EthereumExtraDataEncoder

    beforeEach(async () => {
      encoder = new EthereumExtraDataEncoder()
    })

    describe("encodeDepositOwner", () => {
      context("when the deposit owner is a proper Ethereum address", () => {
        it("should encode the deposit owner", () => {
          const depositOwner = EthereumAddress.from(
            "91fe5b7027c0cA767270bB1A474bA1338BA2A4d2"
          )

          expect(encoder.encodeDepositOwner(depositOwner)).to.be.eql(
            Hex.from(
              "00000000000000000000000091fe5b7027c0cA767270bB1A474bA1338BA2A4d2"
            )
          )
        })
      })

      context("when the deposit owner is not a proper Ethereum address", () => {
        it("should throw", () => {
          // Build a crap address.
          const depositOwner = {
            identifierHex: "1234",
            equals: () => false,
          }

          expect(() => encoder.encodeDepositOwner(depositOwner)).to.throw(
            "Invalid Ethereum address"
          )
        })
      })
    })

    describe("decodeDepositOwner", () => {
      context("when the extra data holds a proper Ethereum address", () => {
        it("should decode the deposit owner", () => {
          const extraData = Hex.from(
            "00000000000000000000000091fe5b7027c0cA767270bB1A474bA1338BA2A4d2"
          )

          const actualAddress = encoder.decodeDepositOwner(extraData)
          const expectedAddress = EthereumAddress.from(
            "91fe5b7027c0cA767270bB1A474bA1338BA2A4d2"
          )
          expect(expectedAddress.equals(actualAddress)).to.be.true
        })
      })

      context(
        "when the extra data doesn't hold a proper Ethereum address",
        () => {
          it("should throw", () => {
            // Build crap extra data.
            const extraData = Hex.from("0000000000000000000000001234")

            expect(() => encoder.decodeDepositOwner(extraData)).to.throw(
              "Invalid Ethereum address"
            )
          })
        }
      )
    })
  })

  describe("ethereumAddressFromSigner", () => {
    context("when the signer can sign transactions", () => {
      it("should return the signer's address", async () => {
        const mock = new MockEvm()

        expect(await ethereumAddressFromSigner(mock.asSigner())).to.be.eql(
          EthereumAddress.from(mock.account)
        )
      })
    })

    context("when the signer is a read-only provider", () => {
      it("should return undefined", async () => {
        const mock = new MockEvm()
        mock.accounts = []

        expect(await ethereumAddressFromSigner(mock.asSigner())).to.be.undefined
      })
    })
  })

  describe("chainIdFromSigner", () => {
    context("when the signer can sign transactions", () => {
      it("should return the signer's network", async () => {
        const mock = new MockEvm()
        mock.chainId = 1337

        expect(await chainIdFromSigner(mock.asSigner())).to.be.eql("1337")
      })
    })

    context("when the signer is a read-only provider", () => {
      it("should return the signer's network", async () => {
        const mock = new MockEvm()
        mock.accounts = []

        expect(await chainIdFromSigner(mock.asSigner())).to.be.eql("1")
      })
    })
  })
})
