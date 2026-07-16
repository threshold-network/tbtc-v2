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
import {
  deployMockContract,
  MockContract,
} from "@ethereum-waffle/mock-contract"
import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import {
  BigNumber,
  Wallet,
  constants,
  getDefaultProvider,
  providers,
  utils,
} from "ethers"
import { MockProvider } from "@ethereum-waffle/provider"
import { waffleChai } from "@ethereum-waffle/chai"
import { assertContractCalledWith } from "../utils/helpers"

// ABI imports.
import { abi as BridgeABI } from "@keep-network/tbtc-v2/artifacts/Bridge.json"
import { abi as TBTCTokenABI } from "@keep-network/tbtc-v2/artifacts/TBTC.json"
import { abi as WalletRegistryABI } from "@keep-network/ecdsa/artifacts/WalletRegistry.json"
import { abi as BaseL1BitcoinDepositorABI } from "../../src/lib/ethereum/artifacts/sepolia/BaseL1BitcoinDepositor.json"
import { abi as ArbitrumL1BitcoinDepositorABI } from "../../src/lib/ethereum/artifacts/sepolia/ArbitrumL1BitcoinDepositor.json"

chai.use(waffleChai)
chai.use(chaiAsPromised)

const BridgeABIWithTaprootDepositReveal = [
  ...BridgeABI,
  ...JSON.parse(
    new utils.Interface([
      "function revealTaprootDeposit((bytes4 version, bytes inputVector, bytes outputVector, bytes4 locktime) fundingTx, (uint32 fundingOutputIndex, bytes8 blindingFactor, bytes20 walletPubKeyHash, bytes32 walletXOnlyPublicKey, bytes20 refundPubKeyHash, bytes32 refundXOnlyPublicKey, bytes4 refundLocktime, address vault) reveal)",
      "function revealTaprootDepositWithExtraData((bytes4 version, bytes inputVector, bytes outputVector, bytes4 locktime) fundingTx, (uint32 fundingOutputIndex, bytes8 blindingFactor, bytes20 walletPubKeyHash, bytes32 walletXOnlyPublicKey, bytes20 refundPubKeyHash, bytes32 refundXOnlyPublicKey, bytes4 refundLocktime, address vault) reveal, bytes32 extraData)",
      "function activeWalletID() view returns (bytes32)",
      "function taprootDepositOutputKeyCommitment(uint256 depositKey) view returns (bytes32)",
      "function walletID(bytes20 walletPubKeyHash) view returns (bytes32)",
      "function walletPubKeyHashForWalletID(bytes32 walletID) view returns (bytes20)",
    ]).format(utils.FormatTypes.json) as string
  ),
]

describe("Ethereum", () => {
  describe("EthereumBridge", () => {
    let walletRegistry: MockContract
    let bridgeContract: MockContract
    let bridgeHandle: EthereumBridge
    let signer: Wallet

    beforeEach(async () => {
      ;[signer] = new MockProvider().getWallets()

      walletRegistry = await deployMockContract(
        signer,
        `${JSON.stringify(WalletRegistryABI)}`
      )

      bridgeContract = await deployMockContract(
        signer,
        `${JSON.stringify(BridgeABIWithTaprootDepositReveal)}`
      )

      await bridgeContract.mock.contractReferences.returns(
        constants.AddressZero,
        constants.AddressZero,
        walletRegistry.address,
        constants.AddressZero
      )

      bridgeHandle = new EthereumBridge({
        address: bridgeContract.address,
        signerOrProvider: signer,
      })
    })

    describe("canonical wallet ID accessors", () => {
      const walletPublicKeyHash = Hex.from(
        "2a621226d6f9916a929c0ab8cc7d3252c1485708"
      )
      const walletID = Hex.from(
        "93fd799256287638b1589bc4c8db1b11fcf873796aabeac9edf4cf238f38e596"
      )

      it("should resolve active wallet ID from a post-upgrade Bridge despite stale local ABI", async () => {
        await bridgeContract.mock.activeWalletID.returns(
          walletID.toPrefixedString()
        )

        expect((await bridgeHandle.activeWalletID())?.toString()).to.equal(
          walletID.toString()
        )
      })

      it("should not synthesize an active wallet ID when the selector is unavailable", async () => {
        await bridgeContract.mock.activeWalletPubKeyHash.returns(
          walletPublicKeyHash.toPrefixedString()
        )
        await bridgeContract.mock.activeWalletID.reverts()

        await expect(bridgeHandle.activeWalletID()).to.be.rejectedWith(
          "Bridge does not expose a canonical active wallet ID"
        )
      })

      it("should resolve canonical wallet ID from wallet public key hash despite stale local ABI", async () => {
        await bridgeContract.mock.walletID
          .withArgs(walletPublicKeyHash.toPrefixedString())
          .returns(walletID.toPrefixedString())

        expect(
          (await bridgeHandle.walletID(walletPublicKeyHash)).toString()
        ).to.equal(walletID.toString())
      })

      it("should resolve wallet public key hash from canonical wallet ID despite stale local ABI", async () => {
        await bridgeContract.mock.walletPubKeyHashForWalletID
          .withArgs(walletID.toPrefixedString())
          .returns(walletPublicKeyHash.toPrefixedString())

        expect(
          (
            await bridgeHandle.walletPublicKeyHashForWalletID(walletID)
          ).toString()
        ).to.equal(walletPublicKeyHash.toString())
      })
    })

    describe("activeWalletIdentity", () => {
      const frostWalletID = Hex.from(
        "2336f65004d8f122f1fe947ebd009a8b4add3a0d937356d568e30f7fcc2e4008"
      )
      const frostWalletPublicKeyHash = Hex.from(
        "c92a772f11bc97d8938a16a9db435401f4e6a7bc"
      )
      let sourceProvider: providers.JsonRpcProvider
      let originalSend: providers.JsonRpcProvider["send"]

      // Local provider test double only. A wrapper around one provider is not
      // an independent production trust domain; README documents the operator
      // requirement that cannot be reproduced by this in-process unit test.
      const distinctProviderTestDouble = (
        provider: providers.Provider = sourceProvider
      ): providers.Provider =>
        new Proxy(provider, {
          get(target, property) {
            const value = Reflect.get(target, property, target)
            return typeof value === "function" ? value.bind(target) : value
          },
        })

      const identityHandle = (
        canonicalProvider: providers.Provider = distinctProviderTestDouble(),
        sourceTrustDomainID = "source.example",
        canonicalTrustDomainID = "canonical.example"
      ) =>
        new EthereumBridge({
          address: bridgeContract.address,
          signerOrProvider: signer,
          activeWalletIdentityQuorum: {
            sourceTrustDomainID,
            canonicalProvider: {
              trustDomainID: canonicalTrustDomainID,
              provider: canonicalProvider,
            },
          },
        })

      beforeEach(() => {
        sourceProvider = signer.provider as providers.JsonRpcProvider
        originalSend = sourceProvider.send.bind(sourceProvider)
        sourceProvider.send = async (method, params) => {
          if (method === "eth_getBlockByNumber" && params[0] === "finalized") {
            return originalSend(method, ["latest", params[1]])
          }

          return originalSend(method, params)
        }
      })

      afterEach(() => {
        sourceProvider.send = originalSend
      })

      it("should fail closed without an independent provider", async () => {
        await expect(bridgeHandle.activeWalletIdentity()).to.be.rejectedWith(
          "Deposit wallet identity requires an independent Ethereum provider"
        )
      })

      it("should reject providers declaring the same trust domain", () => {
        expect(() =>
          identityHandle(sourceProvider, " Shared.Example ", "shared.example")
        ).to.throw(
          "Active wallet identity providers must use different trust domains"
        )
      })

      it("should reject the same provider instance across trust domains", () => {
        expect(() => identityHandle(sourceProvider)).to.throw(
          "Active wallet identity providers must use different provider instances"
        )
      })

      it("should return a canonically bound FROST identity", async () => {
        await bridgeContract.mock.activeWalletPubKeyHash.returns(
          frostWalletPublicKeyHash.toPrefixedString()
        )
        await bridgeContract.mock.activeWalletID.returns(
          frostWalletID.toPrefixedString()
        )
        await bridgeContract.mock.walletID
          .withArgs(frostWalletPublicKeyHash.toPrefixedString())
          .returns(frostWalletID.toPrefixedString())
        await bridgeContract.mock.walletPubKeyHashForWalletID
          .withArgs(frostWalletID.toPrefixedString())
          .returns(frostWalletPublicKeyHash.toPrefixedString())

        expect(await identityHandle().activeWalletIdentity()).to.deep.equal({
          walletPublicKeyHash: frostWalletPublicKeyHash,
          walletID: frostWalletID,
        })
      })

      it("should preserve an upgraded-Bridge legacy ECDSA identity", async () => {
        const walletPublicKeyHash = Hex.from(
          "2a621226d6f9916a929c0ab8cc7d3252c1485708"
        )
        const walletID = Hex.from(
          utils.hexZeroPad(walletPublicKeyHash.toPrefixedString(), 32)
        )
        await bridgeContract.mock.activeWalletPubKeyHash.returns(
          walletPublicKeyHash.toPrefixedString()
        )
        await bridgeContract.mock.activeWalletID.returns(
          walletID.toPrefixedString()
        )
        await bridgeContract.mock.walletID
          .withArgs(walletPublicKeyHash.toPrefixedString())
          .returns(walletID.toPrefixedString())
        await bridgeContract.mock.walletPubKeyHashForWalletID
          .withArgs(walletID.toPrefixedString())
          .returns(walletPublicKeyHash.toPrefixedString())

        expect(await identityHandle().activeWalletIdentity()).to.deep.equal({
          walletPublicKeyHash,
          walletID,
        })
      })

      it("should reject a provider response that is not canonically mapped", async () => {
        await bridgeContract.mock.activeWalletPubKeyHash.returns(
          frostWalletPublicKeyHash.toPrefixedString()
        )
        await bridgeContract.mock.activeWalletID.returns(
          frostWalletID.toPrefixedString()
        )
        await bridgeContract.mock.walletID
          .withArgs(frostWalletPublicKeyHash.toPrefixedString())
          .returns(constants.HashZero)
        await bridgeContract.mock.walletPubKeyHashForWalletID
          .withArgs(frostWalletID.toPrefixedString())
          .returns(frostWalletPublicKeyHash.toPrefixedString())

        await expect(
          identityHandle().activeWalletIdentity()
        ).to.be.rejectedWith("Active wallet identity is not canonically bound")
      })

      it("should reject two internally coherent provider identities that disagree", async () => {
        await bridgeContract.mock.activeWalletPubKeyHash.returns(
          frostWalletPublicKeyHash.toPrefixedString()
        )
        await bridgeContract.mock.activeWalletID.returns(
          frostWalletID.toPrefixedString()
        )
        await bridgeContract.mock.walletID
          .withArgs(frostWalletPublicKeyHash.toPrefixedString())
          .returns(frostWalletID.toPrefixedString())
        await bridgeContract.mock.walletPubKeyHashForWalletID
          .withArgs(frostWalletID.toPrefixedString())
          .returns(frostWalletPublicKeyHash.toPrefixedString())

        const attackerWalletID = Hex.from(
          "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        )
        const attackerWalletPublicKeyHash = BitcoinHashUtils.computeHash160(
          Hex.from(
            Buffer.concat([Buffer.from([0x02]), attackerWalletID.toBuffer()])
          )
        )
        const identityInterface = new utils.Interface([
          "function activeWalletPubKeyHash() view returns (bytes20)",
          "function activeWalletID() view returns (bytes32)",
          "function walletID(bytes20) view returns (bytes32)",
          "function walletPubKeyHashForWalletID(bytes32) view returns (bytes20)",
        ])
        const canonicalProvider = new Proxy(sourceProvider, {
          get(target, property) {
            if (property === "call") {
              return async (transaction: providers.TransactionRequest) => {
                const data = transaction.data?.toString() ?? ""
                const selector = data.slice(0, 10)
                if (
                  selector ===
                  identityInterface.getSighash("activeWalletPubKeyHash")
                ) {
                  return identityInterface.encodeFunctionResult(
                    "activeWalletPubKeyHash",
                    [attackerWalletPublicKeyHash.toPrefixedString()]
                  )
                }
                if (
                  selector === identityInterface.getSighash("activeWalletID")
                ) {
                  return identityInterface.encodeFunctionResult(
                    "activeWalletID",
                    [attackerWalletID.toPrefixedString()]
                  )
                }
                if (selector === identityInterface.getSighash("walletID")) {
                  return identityInterface.encodeFunctionResult("walletID", [
                    attackerWalletID.toPrefixedString(),
                  ])
                }
                if (
                  selector ===
                  identityInterface.getSighash("walletPubKeyHashForWalletID")
                ) {
                  return identityInterface.encodeFunctionResult(
                    "walletPubKeyHashForWalletID",
                    [attackerWalletPublicKeyHash.toPrefixedString()]
                  )
                }

                return target.call(transaction)
              }
            }

            const value = Reflect.get(target, property, target)
            return typeof value === "function" ? value.bind(target) : value
          },
        }) as providers.Provider

        await expect(
          identityHandle(canonicalProvider).activeWalletIdentity()
        ).to.be.rejectedWith("Active wallet identity providers disagree")
      })

      it("should authenticate and read each provider at its own finalized head", async () => {
        await bridgeContract.mock.activeWalletPubKeyHash.returns(
          frostWalletPublicKeyHash.toPrefixedString()
        )
        await bridgeContract.mock.activeWalletID.returns(
          frostWalletID.toPrefixedString()
        )
        await bridgeContract.mock.walletID
          .withArgs(frostWalletPublicKeyHash.toPrefixedString())
          .returns(frostWalletID.toPrefixedString())
        await bridgeContract.mock.walletPubKeyHashForWalletID
          .withArgs(frostWalletID.toPrefixedString())
          .returns(frostWalletPublicKeyHash.toPrefixedString())

        await originalSend("evm_mine", [])
        const canonicalFinalizedBlock = await sourceProvider.getBlock("latest")
        await originalSend("evm_mine", [])
        const sourceFinalizedBlock = await sourceProvider.getBlock("latest")
        const sourceIdentityBlockTags: Array<
          providers.BlockTag | Promise<providers.BlockTag>
        > = []
        const canonicalIdentityBlockTags: Array<
          providers.BlockTag | Promise<providers.BlockTag>
        > = []
        const sourceCall = sourceProvider.call.bind(sourceProvider)

        sourceProvider.send = async (method, params) => {
          if (method === "eth_getBlockByNumber" && params[0] === "finalized") {
            return {
              number: utils.hexValue(sourceFinalizedBlock.number),
              hash: sourceFinalizedBlock.hash,
            }
          }

          return originalSend(method, params)
        }
        sourceProvider.call = async (transaction, blockTag) => {
          sourceIdentityBlockTags.push(blockTag ?? "latest")
          return sourceCall(transaction, blockTag)
        }

        const canonicalProvider = new Proxy(sourceProvider, {
          get(target, property) {
            if (property === "send") {
              return async (method: string, params: unknown[]) => {
                if (
                  method === "eth_getBlockByNumber" &&
                  params[0] === "finalized"
                ) {
                  return {
                    number: utils.hexValue(canonicalFinalizedBlock.number),
                    hash: canonicalFinalizedBlock.hash,
                  }
                }

                return originalSend(method, params)
              }
            }
            if (property === "call") {
              return async (
                transaction: providers.TransactionRequest,
                blockTag?: providers.BlockTag
              ) => {
                canonicalIdentityBlockTags.push(blockTag ?? "latest")
                return sourceCall(transaction, blockTag)
              }
            }

            const value = Reflect.get(target, property, target)
            return typeof value === "function" ? value.bind(target) : value
          },
        }) as providers.Provider

        try {
          expect(
            await identityHandle(canonicalProvider).activeWalletIdentity()
          ).to.deep.equal({
            walletPublicKeyHash: frostWalletPublicKeyHash,
            walletID: frostWalletID,
          })
        } finally {
          sourceProvider.call = sourceCall
        }

        expect(sourceIdentityBlockTags).to.have.length(4)
        expect(canonicalIdentityBlockTags).to.have.length(4)
        for (const blockTag of sourceIdentityBlockTags) {
          expect(BigNumber.from(await blockTag).toNumber()).to.equal(
            sourceFinalizedBlock.number
          )
        }
        for (const blockTag of canonicalIdentityBlockTags) {
          expect(BigNumber.from(await blockTag).toNumber()).to.equal(
            canonicalFinalizedBlock.number
          )
        }
      })

      it("should reject an unauthenticated advertised finalized hash", async () => {
        const finalizedBlock = await sourceProvider.getBlock("latest")
        const canonicalProvider = new Proxy(sourceProvider, {
          get(target, property) {
            if (property === "send") {
              return async (method: string, params: unknown[]) => {
                if (
                  method === "eth_getBlockByNumber" &&
                  params[0] === "finalized"
                ) {
                  return {
                    number: utils.hexValue(finalizedBlock.number),
                    hash: constants.HashZero,
                  }
                }

                return originalSend(method, params)
              }
            }

            const value = Reflect.get(target, property, target)
            return typeof value === "function" ? value.bind(target) : value
          },
        }) as providers.Provider

        await expect(
          identityHandle(canonicalProvider).activeWalletIdentity()
        ).to.be.rejectedWith(
          "Active wallet identity canonical provider did not authenticate its finalized block"
        )
      })

      it("should reject a retired wallet from a stale finalized head", async () => {
        const retiredWalletID = Hex.from(
          "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        )
        const retiredWalletPublicKeyHash = BitcoinHashUtils.computeHash160(
          Hex.from(
            Buffer.concat([Buffer.from([0x02]), retiredWalletID.toBuffer()])
          )
        )

        await bridgeContract.mock.activeWalletPubKeyHash.returns(
          retiredWalletPublicKeyHash.toPrefixedString()
        )
        await bridgeContract.mock.activeWalletID.returns(
          retiredWalletID.toPrefixedString()
        )
        await bridgeContract.mock.walletID
          .withArgs(retiredWalletPublicKeyHash.toPrefixedString())
          .returns(retiredWalletID.toPrefixedString())
        await bridgeContract.mock.walletPubKeyHashForWalletID
          .withArgs(retiredWalletID.toPrefixedString())
          .returns(retiredWalletPublicKeyHash.toPrefixedString())
        const retiredWalletBlock = await sourceProvider.getBlock("latest")

        await bridgeContract.mock.activeWalletPubKeyHash.returns(
          frostWalletPublicKeyHash.toPrefixedString()
        )
        await bridgeContract.mock.activeWalletID.returns(
          frostWalletID.toPrefixedString()
        )
        await bridgeContract.mock.walletID
          .withArgs(frostWalletPublicKeyHash.toPrefixedString())
          .returns(frostWalletID.toPrefixedString())
        await bridgeContract.mock.walletPubKeyHashForWalletID
          .withArgs(frostWalletID.toPrefixedString())
          .returns(frostWalletPublicKeyHash.toPrefixedString())

        const canonicalProvider = new Proxy(sourceProvider, {
          get(target, property) {
            if (property === "send") {
              return async (method: string, params: unknown[]) => {
                if (
                  method === "eth_getBlockByNumber" &&
                  params[0] === "finalized"
                ) {
                  return {
                    number: utils.hexValue(retiredWalletBlock.number),
                    hash: retiredWalletBlock.hash,
                  }
                }

                return originalSend(method, params)
              }
            }

            const value = Reflect.get(target, property, target)
            return typeof value === "function" ? value.bind(target) : value
          },
        }) as providers.Provider

        await expect(
          identityHandle(canonicalProvider).activeWalletIdentity()
        ).to.be.rejectedWith("Active wallet identity providers disagree")
      })

      it("should not downgrade when V2 identity selectors are unavailable", async () => {
        await bridgeContract.mock.activeWalletPubKeyHash.returns(
          frostWalletPublicKeyHash.toPrefixedString()
        )

        await expect(
          identityHandle().activeWalletIdentity()
        ).to.be.rejectedWith(
          "could not prove upgraded Bridge wallet-identity selectors"
        )
      })
    })

    describe("pendingRedemptions", () => {
      beforeEach(async () => {
        // Set the mock to return a specific redemption data when called
        // with the redemption key (built as keccak256(keccak256(redeemerOutputScript) | walletPublicKeyHash))
        // that matches the wallet PKH and redeemer output script used during
        // the test call.
        await bridgeContract.mock.pendingRedemptions
          .withArgs(
            "0x4f5c364239f365622168b8fcb3f4556a8bbad22f5b5ae598757c4fe83b3a78d7"
          )
          .returns({
            redeemer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            requestedAmount: BigNumber.from(10000),
            treasuryFee: BigNumber.from(100),
            txMaxFee: BigNumber.from(50),
            requestedAt: BigNumber.from(1650623240),
          } as any)
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
          requestedAmount: BigNumber.from(10000),
          treasuryFee: BigNumber.from(100),
          txMaxFee: BigNumber.from(50),
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
        await bridgeContract.mock.timedOutRedemptions
          .withArgs(
            "0x4f5c364239f365622168b8fcb3f4556a8bbad22f5b5ae598757c4fe83b3a78d7"
          )
          .returns({
            redeemer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            requestedAmount: BigNumber.from(10000),
            treasuryFee: BigNumber.from(100),
            txMaxFee: BigNumber.from(50),
            requestedAt: BigNumber.from(1650623240),
          } as any)
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
          requestedAmount: BigNumber.from(10000),
          treasuryFee: BigNumber.from(100),
          txMaxFee: BigNumber.from(50),
          requestedAt: 1650623240,
        })
      })
    })

    describe("revealDeposit", () => {
      context("when deposit does not have optional extra data", () => {
        beforeEach(async () => {
          await bridgeContract.mock.revealDeposit.returns()

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
          assertContractCalledWith(bridgeContract, "revealDeposit", [
            {
              version: "0x00000000",
              inputVector: "0x11111111",
              outputVector: "0x22222222",
              locktime: "0x33333333",
            },
            {
              fundingOutputIndex: 2,
              blindingFactor: "0xf9f0c90d00039523",
              walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
              refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
              refundLocktime: "0x60bcea61",
              vault: "0x82883a4c7a8dd73ef165deb402d432613615ced4",
            },
          ])
        })
      })

      context("when deposit has optional extra data", () => {
        beforeEach(async () => {
          await bridgeContract.mock.revealDepositWithExtraData.returns()

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
          assertContractCalledWith(
            bridgeContract,
            "revealDepositWithExtraData",
            [
              {
                version: "0x00000000",
                inputVector: "0x11111111",
                outputVector: "0x22222222",
                locktime: "0x33333333",
              },
              {
                fundingOutputIndex: 2,
                blindingFactor: "0xf9f0c90d00039523",
                walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
                refundLocktime: "0x60bcea61",
                vault: "0x82883a4c7a8dd73ef165deb402d432613615ced4",
              },
              "0xaebfb5afc9ee6432374ed39b58b8cf87797f9468eca40569b67ac8d59415c9c0",
            ]
          )
        })
      })

      context("when deposit is Taproot-native", () => {
        beforeEach(async () => {
          await bridgeContract.mock.revealTaprootDeposit.returns()

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
                "c92a772f11bc97d8938a16a9db435401f4e6a7bc"
              ),
              walletXOnlyPublicKey: Hex.from(
                "2336f65004d8f122f1fe947ebd009a8b4add3a0d937356d568e30f7fcc2e4008"
              ),
              refundPublicKeyHash: Hex.from(
                "c2a27a88d8d03e271e8edc556923e9398619f17c"
              ),
              refundXOnlyPublicKey: Hex.from(
                "11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff"
              ),
              blindingFactor: Hex.from("f9f0c90d00039523"),
              refundLocktime: Hex.from("60bcea61"),
            },
            EthereumAddress.from("82883a4c7a8dd73ef165deb402d432613615ced4")
          )
        })

        it("should reveal the Taproot deposit", async () => {
          assertContractCalledWith(bridgeContract, "revealTaprootDeposit", [
            {
              version: "0x00000000",
              inputVector: "0x11111111",
              outputVector: "0x22222222",
              locktime: "0x33333333",
            },
            {
              fundingOutputIndex: 2,
              blindingFactor: "0xf9f0c90d00039523",
              walletPubKeyHash: "0xc92a772f11bc97d8938a16a9db435401f4e6a7bc",
              walletXOnlyPublicKey:
                "0x2336f65004d8f122f1fe947ebd009a8b4add3a0d937356d568e30f7fcc2e4008",
              refundPubKeyHash: "0xc2a27a88d8d03e271e8edc556923e9398619f17c",
              refundXOnlyPublicKey:
                "0x11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff",
              refundLocktime: "0x60bcea61",
              vault: "0x82883a4c7a8dd73ef165deb402d432613615ced4",
            },
          ])
        })
      })

      context("when Taproot-native deposit has optional extra data", () => {
        beforeEach(async () => {
          await bridgeContract.mock.revealTaprootDepositWithExtraData.returns()

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
                "c92a772f11bc97d8938a16a9db435401f4e6a7bc"
              ),
              walletXOnlyPublicKey: Hex.from(
                "2336f65004d8f122f1fe947ebd009a8b4add3a0d937356d568e30f7fcc2e4008"
              ),
              refundPublicKeyHash: Hex.from(
                "c2a27a88d8d03e271e8edc556923e9398619f17c"
              ),
              refundXOnlyPublicKey: Hex.from(
                "11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff"
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

        it("should reveal the Taproot deposit", async () => {
          assertContractCalledWith(
            bridgeContract,
            "revealTaprootDepositWithExtraData",
            [
              {
                version: "0x00000000",
                inputVector: "0x11111111",
                outputVector: "0x22222222",
                locktime: "0x33333333",
              },
              {
                fundingOutputIndex: 2,
                blindingFactor: "0xf9f0c90d00039523",
                walletPubKeyHash: "0xc92a772f11bc97d8938a16a9db435401f4e6a7bc",
                walletXOnlyPublicKey:
                  "0x2336f65004d8f122f1fe947ebd009a8b4add3a0d937356d568e30f7fcc2e4008",
                refundPubKeyHash: "0xc2a27a88d8d03e271e8edc556923e9398619f17c",
                refundXOnlyPublicKey:
                  "0x11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff",
                refundLocktime: "0x60bcea61",
                vault: "0x82883a4c7a8dd73ef165deb402d432613615ced4",
              },
              "0xaebfb5afc9ee6432374ed39b58b8cf87797f9468eca40569b67ac8d59415c9c0",
            ]
          )
        })
      })
    })

    describe("submitDepositSweepProof", () => {
      beforeEach(async () => {
        await bridgeContract.mock.submitDepositSweepProof.returns()

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
            value: BigNumber.from(9999),
          },
          EthereumAddress.from("82883a4c7a8dd73ef165deb402d432613615ced4")
        )
      })

      it("should submit the deposit sweep proof", () => {
        assertContractCalledWith(bridgeContract, "submitDepositSweepProof", [
          {
            version: "0x00000000",
            inputVector: "0x11111111",
            outputVector: "0x22222222",
            locktime: "0x33333333",
          },
          {
            merkleProof: "0x44444444",
            txIndexInBlock: 5,
            bitcoinHeaders: "0x66666666",
            coinbasePreimage: BitcoinHashUtils.computeSha256(
              Hex.from("77777777")
            ).toPrefixedString(),
            coinbaseProof: "0x88888888",
          },
          {
            txHash:
              "0x6896f9abcac13ce6bd2b80d125bedf997ff6330e999f2f605ea15ea542f2eaf8",
            txOutputIndex: 8,
            txOutputValue: BigNumber.from(9999),
          },
          "0x82883a4c7a8dd73ef165deb402d432613615ced4",
        ])
      })
    })

    describe("txProofDifficultyFactor", () => {
      beforeEach(async () => {
        await bridgeContract.mock.txProofDifficultyFactor.returns(
          BigNumber.from(6)
        )
      })

      it("should return the tx proof difficulty factor", async () => {
        expect(await bridgeHandle.txProofDifficultyFactor()).to.be.equal(6)
      })
    })

    describe("requestRedemption", () => {
      beforeEach(async () => {
        await bridgeContract.mock.requestRedemption.returns()

        await bridgeHandle.requestRedemption(
          Hex.from(
            "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
          ),
          {
            transactionHash: BitcoinTxHash.from(
              "f8eaf242a55ea15e602f9f990e33f67f99dfbe25d1802bbde63cc1caabf99668"
            ),
            outputIndex: 8,
            value: BigNumber.from(9999),
          },
          Hex.from("a9143ec459d0f3c29286ae5df5fcc421e2786024277e87"),
          BigNumber.from(10000)
        )
      })

      it("should request the redemption", async () => {
        assertContractCalledWith(bridgeContract, "requestRedemption", [
          "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
          {
            txHash:
              "0x6896f9abcac13ce6bd2b80d125bedf997ff6330e999f2f605ea15ea542f2eaf8",
            txOutputIndex: 8,
            txOutputValue: BigNumber.from(9999),
          },
          "0x17a9143ec459d0f3c29286ae5df5fcc421e2786024277e87",
          BigNumber.from(10000),
        ])
      })
    })

    describe("submitRedemptionProof", () => {
      beforeEach(async () => {
        await bridgeContract.mock.submitRedemptionProof.returns()

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
            value: BigNumber.from(9999),
          },
          Hex.from(
            "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
          )
        )
      })

      it("should submit the redemption proof", () => {
        assertContractCalledWith(bridgeContract, "submitRedemptionProof", [
          {
            version: "0x00000000",
            inputVector: "0x11111111",
            outputVector: "0x22222222",
            locktime: "0x33333333",
          },
          {
            merkleProof: "0x44444444",
            txIndexInBlock: 5,
            bitcoinHeaders: "0x66666666",
            coinbasePreimage: BitcoinHashUtils.computeSha256(
              Hex.from("77777777")
            ).toPrefixedString(),
            coinbaseProof: "0x88888888",
          },
          {
            txHash:
              "0x6896f9abcac13ce6bd2b80d125bedf997ff6330e999f2f605ea15ea542f2eaf8",
            txOutputIndex: 8,
            txOutputValue: BigNumber.from(9999),
          },
          "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        ])
      })
    })

    describe("deposits", () => {
      context("when the revealed deposit has a vault set", () => {
        beforeEach(async () => {
          // Set the mock to return a specific revealed deposit when called
          // with the deposit key (built as keccak256(depositTxHash | depositOutputIndex)
          // that matches the deposit transaction hash and output index used during
          // the test call.
          await bridgeContract.mock.deposits
            .withArgs(
              "0x01151be714c10edde62a310bf0604c01134450416a0bf8a7bfd43cef90644f0f"
            )
            .returns({
              depositor: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
              amount: BigNumber.from(10000),
              vault: "0x014e1BFbe0f85F129749a8ae0fcB20175433741B",
              revealedAt: 1654774330,
              sweptAt: 1655033516,
              treasuryFee: BigNumber.from(200),
              extraData: `0x${"11".repeat(32)}`,
            } as any)
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
            amount: BigNumber.from(10000),
            vault: EthereumAddress.from(
              "014e1bfbe0f85f129749a8ae0fcb20175433741b"
            ),
            revealedAt: 1654774330,
            sweptAt: 1655033516,
            treasuryFee: BigNumber.from(200),
            extraData: Hex.from("11".repeat(32)),
          })
        })
      })

      context("when the revealed deposit has no vault set", () => {
        beforeEach(async () => {
          // Set the mock to return a specific revealed deposit when called
          // with the deposit key (built as keccak256(depositTxHash | depositOutputIndex)
          // that matches the deposit transaction hash and output index used during
          // the test call.
          await bridgeContract.mock.deposits
            .withArgs(
              "0x01151be714c10edde62a310bf0604c01134450416a0bf8a7bfd43cef90644f0f"
            )
            .returns({
              depositor: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
              amount: BigNumber.from(10000),
              vault: constants.AddressZero,
              revealedAt: 1654774330,
              sweptAt: 1655033516,
              treasuryFee: BigNumber.from(200),
              extraData:
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            } as any)
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
            amount: BigNumber.from(10000),
            vault: undefined,
            revealedAt: 1654774330,
            sweptAt: 1655033516,
            treasuryFee: BigNumber.from(200),
          })
        })
      })
    })

    describe("taprootDepositOutputKeyCommitment", () => {
      it("should return the commitment for the endian-normalized deposit key", async () => {
        const commitment = Hex.from("11".repeat(32))
        await bridgeContract.mock.taprootDepositOutputKeyCommitment
          .withArgs(
            "0x01151be714c10edde62a310bf0604c01134450416a0bf8a7bfd43cef90644f0f"
          )
          .returns(commitment.toPrefixedString())

        expect(
          await bridgeHandle.taprootDepositOutputKeyCommitment(
            BitcoinTxHash.from(
              "c1082c460527079a84e39ec6481666db72e5a22e473a78db03b996d26fd1dc83"
            ),
            0
          )
        ).to.eql(commitment)
      })
    })

    describe("activeWalletPublicKeyHash", () => {
      context("when there is an active wallet", () => {
        beforeEach(async () => {
          await bridgeContract.mock.activeWalletPubKeyHash.returns(
            "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
          )
        })

        it("should return the active wallet's public key hash", async () => {
          expect(
            (await bridgeHandle.activeWalletPublicKeyHash())?.toString()
          ).to.be.equal("8db50eb52063ea9d98b3eac91489a90f738986f6")
        })
      })

      context("when there is no active wallet", () => {
        beforeEach(async () => {
          await bridgeContract.mock.activeWalletPubKeyHash.returns(
            "0x0000000000000000000000000000000000000000"
          )
        })

        it("should return undefined", async () => {
          expect(await bridgeHandle.activeWalletPublicKeyHash()).to.be.undefined
        })
      })
    })

    describe("activeWalletPublicKey", () => {
      context("when there is an active wallet", () => {
        beforeEach(async () => {
          await bridgeContract.mock.activeWalletPubKeyHash.returns(
            "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
          )

          await bridgeContract.mock.wallets
            .withArgs("0x8db50eb52063ea9d98b3eac91489a90f738986f6")
            .returns({
              ecdsaWalletID:
                "0x9ff37567d973e4d884bc42d2d1a6cb1ff22676ab64f82c62b58e2b0ffd3fff71",
              mainUtxoHash: constants.HashZero,
              pendingRedemptionsValue: BigNumber.from(0),
              createdAt: 1654846075,
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: 1,
              movingFundsTargetWalletsCommitmentHash: constants.HashZero,
            } as any)

          await bridgeContract.mock.walletID
            .withArgs("0x8db50eb52063ea9d98b3eac91489a90f738986f6")
            .returns(
              "0x0000000000000000000000008db50eb52063ea9d98b3eac91489a90f738986f6"
            )

          await walletRegistry.mock.getWalletPublicKey
            .withArgs(
              "0x9ff37567d973e4d884bc42d2d1a6cb1ff22676ab64f82c62b58e2b0ffd3fff71"
            )
            .returns(
              "0x989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9d218b65e7d91c752f7b22eaceb771a9af3a6f3d3f010a5d471a1aeef7d7713af" as any
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
          await bridgeContract.mock.activeWalletPubKeyHash.returns(
            "0x0000000000000000000000000000000000000000"
          )
        })

        it("should return undefined", async () => {
          expect(await bridgeHandle.activeWalletPublicKey()).to.be.undefined
        })
      })
    })
  })

  describe("EthereumTBTCToken", () => {
    let tbtcToken: MockContract
    let tokenHandle: EthereumTBTCToken
    const signer: Wallet = new MockProvider().getWallets()[0]

    beforeEach(async () => {
      tbtcToken = await deployMockContract(
        signer,
        `${JSON.stringify(TBTCTokenABI)}`
      )

      tokenHandle = new EthereumTBTCToken({
        address: tbtcToken.address,
        signerOrProvider: signer,
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
          value: BigNumber.from(9999),
        },
        redeemer: EthereumAddress.from(signer.address),
        amount: BigNumber.from(10000),
        redeemerOutputScript: {
          unprefixed: Hex.from(
            "0020cdbf909e935c855d3e8d1b61aeb9c5e3c03ae8021b286839b1a72f2e48fdba70"
          ),
          prefixed: Hex.from(
            "220020cdbf909e935c855d3e8d1b61aeb9c5e3c03ae8021b286839b1a72f2e48fdba70"
          ),
        },
      }

      beforeEach(async () => {
        await tbtcToken.mock.owner.returns(data.vault.identifierHex)
        await tbtcToken.mock.approveAndCall.returns(true)

        await tokenHandle.requestRedemption(
          data.walletPublicKey,
          data.mainUtxo,
          data.redeemerOutputScript.unprefixed,
          data.amount
        )
      })

      it("should request the redemption", async () => {
        const {
          walletPublicKey,
          mainUtxo,
          redeemerOutputScript,
          redeemer,
          vault,
          amount,
        } = data
        const expectedExtraData = utils.defaultAbiCoder.encode(
          ["address", "bytes20", "bytes32", "uint32", "uint64", "bytes"],
          [
            redeemer.identifierHex,
            BitcoinHashUtils.computeHash160(walletPublicKey).toPrefixedString(),
            mainUtxo.transactionHash.reverse().toPrefixedString(),
            mainUtxo.outputIndex,
            mainUtxo.value,
            redeemerOutputScript.prefixed.toPrefixedString(),
          ]
        )

        assertContractCalledWith(tbtcToken, "approveAndCall", [
          vault.identifierHex,
          amount,
          expectedExtraData,
        ])
      })
    })
  })

  describe("EthereumL1BitcoinDepositor - BASE", () => {
    let depositorContract: MockContract
    let depositorHandle: EthereumL1BitcoinDepositor

    beforeEach(async () => {
      const [signer] = new MockProvider().getWallets()

      depositorContract = await deployMockContract(
        signer,
        // Use Base for testing but this can be any supported L2 chain.
        `${JSON.stringify(BaseL1BitcoinDepositorABI)}`
      )

      depositorHandle = new EthereumL1BitcoinDepositor(
        {
          address: depositorContract.address,
          signerOrProvider: signer,
        },
        Chains.Ethereum.Sepolia,
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

      it("should declare Taproot deposits unsupported", () => {
        expect(depositorHandle.supportsTaprootDeposits()).to.be.false
      })

      it("should reject a Taproot receipt before encoding the legacy tuple", async () => {
        await expect(
          depositorHandle.initializeDeposit(
            depositTx,
            depositOutputIndex,
            {
              ...deposit,
              walletXOnlyPublicKey: Hex.from("11".repeat(32)),
              refundXOnlyPublicKey: Hex.from("22".repeat(32)),
            },
            vault
          )
        ).to.be.rejectedWith(
          "Taproot deposits are not supported by this depositor"
        )
      })

      context(
        "when L2 deposit owner is properly encoded in the extra data",
        () => {
          beforeEach(async () => {
            await depositorContract.mock.initializeDeposit.returns()

            await depositorHandle.initializeDeposit(
              depositTx,
              depositOutputIndex,
              deposit,
              vault
            )
          })

          it("should initialize the deposit", async () => {
            assertContractCalledWith(depositorContract, "initializeDeposit", [
              {
                version: "0x00000000",
                inputVector: "0x11111111",
                outputVector: "0x22222222",
                locktime: "0x33333333",
              },
              {
                fundingOutputIndex: 2,
                blindingFactor: "0xf9f0c90d00039523",
                walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
                refundLocktime: "0x60bcea61",
                vault: "0x82883a4c7a8dd73ef165deb402d432613615ced4",
              },
              "0x91fe5b7027c0cA767270bB1A474bA1338BA2A4d2",
            ])
          })
        }
      )

      context(
        "when L2 deposit owner is not properly encoded in the extra data",
        () => {
          it("should throw", async () => {
            await expect(
              depositorHandle.initializeDeposit(
                depositTx,
                depositOutputIndex,
                {
                  ...deposit,
                  extraData: undefined, // Set empty extra data.
                },
                vault
              )
            ).to.be.rejectedWith("Extra data is required")
          })
        }
      )
    })
  })

  describe("EthereumL1BitcoinDepositor - ARBITRUM", () => {
    let depositorContract: MockContract
    let depositorHandle: EthereumL1BitcoinDepositor

    beforeEach(async () => {
      const [signer] = new MockProvider().getWallets()

      depositorContract = await deployMockContract(
        signer,
        // Use Arbitrum for testing but this can be any supported L2 chain.
        `${JSON.stringify(ArbitrumL1BitcoinDepositorABI)}`
      )

      depositorHandle = new EthereumL1BitcoinDepositor(
        {
          address: depositorContract.address,
          signerOrProvider: signer,
        },
        Chains.Ethereum.Sepolia,
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

      context(
        "when L2 deposit owner is properly encoded in the extra data",
        () => {
          beforeEach(async () => {
            await depositorContract.mock.initializeDeposit.returns()

            await depositorHandle.initializeDeposit(
              depositTx,
              depositOutputIndex,
              deposit,
              vault
            )
          })

          it("should initialize the deposit", async () => {
            assertContractCalledWith(depositorContract, "initializeDeposit", [
              {
                version: "0x00000000",
                inputVector: "0x11111111",
                outputVector: "0x22222222",
                locktime: "0x33333333",
              },
              {
                fundingOutputIndex: 2,
                blindingFactor: "0xf9f0c90d00039523",
                walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
                refundLocktime: "0x60bcea61",
                vault: "0x82883a4c7a8dd73ef165deb402d432613615ced4",
              },
              "0x91fe5b7027c0cA767270bB1A474bA1338BA2A4d2",
            ])
          })
        }
      )

      context(
        "when L2 deposit owner is not properly encoded in the extra data",
        () => {
          it("should throw", async () => {
            await expect(
              depositorHandle.initializeDeposit(
                depositTx,
                depositOutputIndex,
                {
                  ...deposit,
                  extraData: undefined, // Set empty extra data.
                },
                vault
              )
            ).to.be.rejectedWith("Extra data is required")
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
    context("when the signer is a wallet", () => {
      const [mockSigner] = new MockProvider().getWallets()
      it("should return the signer's address", async () => {
        expect(await ethereumAddressFromSigner(mockSigner)).to.be.eql(
          EthereumAddress.from(mockSigner.address)
        )
      })
    })

    context("when the signer is a provider", () => {
      const mockProvider = getDefaultProvider()
      it("should return undefined", async () => {
        expect(await ethereumAddressFromSigner(mockProvider)).to.be.undefined
      })
    })
  })

  describe("chainIdFromSigner", () => {
    context("when the signer is a wallet", () => {
      const [mockSigner] = new MockProvider().getWallets()
      it("should return the signer's network", async () => {
        expect(await chainIdFromSigner(mockSigner)).to.be.eql("1337")
      })
    })

    context("when the signer is a provider", () => {
      const mockProvider = getDefaultProvider()
      it("should return the signer's network", async () => {
        expect(await chainIdFromSigner(mockProvider)).to.be.eql("1")
      })
    })
  })
})
