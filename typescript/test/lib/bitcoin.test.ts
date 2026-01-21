import { expect } from "chai"
import {
  BitcoinAddressConverter,
  BitcoinCompactSizeUint,
  BitcoinHashUtils,
  BitcoinHeader,
  BitcoinHeaderSerializer,
  BitcoinLocktimeUtils,
  BitcoinNetwork,
  toBitcoinJsLibNetwork,
  BitcoinPublicKeyUtils,
  BitcoinScriptUtils,
  BitcoinTargetConverter,
  extractBitcoinRawTxVectors,
  Hex,
  BitcoinTxHash,
  BitcoinTx,
  BitcoinSpvProof,
  assembleBitcoinSpvProof,
  validateBitcoinSpvProof,
  BitcoinRawTx,
  BitcoinTxMerkleBranch,
} from "../../src"
import { BigNumber } from "@ethersproject/bignumber"
import { btcAddresses, btcAddressFromPublicKey } from "../data/bitcoin"
import { depositSweepWithNoMainUtxoAndWitnessOutput } from "../data/deposit-sweep"
import { networks } from "bitcoinjs-lib"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import {
  multipleInputsProofTestData,
  ProofTestData,
  singleInputProofTestData,
  testnetTransactionData,
  transactionConfirmationsInOneEpochData,
  transactionConfirmationsInTwoEpochsData,
  TransactionProofData,
} from "../data/proof"

describe("Bitcoin", () => {
  describe("BitcoinNetwork", () => {
    const testData = [
      {
        enumKey: BitcoinNetwork.Unknown,
        enumValue: "unknown",
        // any value that doesn't match other supported networks
        genesisHash: BitcoinTxHash.from("0x00010203"),
        expectedToBitcoinJsLibResult: new Error("network not supported"),
      },
      {
        enumKey: BitcoinNetwork.Testnet,
        enumValue: "testnet",
        genesisHash: BitcoinTxHash.from(
          "0x000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943"
        ),
        expectedToBitcoinJsLibResult: networks.testnet,
      },
      {
        enumKey: BitcoinNetwork.Mainnet,
        enumValue: "mainnet",
        genesisHash: BitcoinTxHash.from(
          "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
        ),
        expectedToBitcoinJsLibResult: networks.bitcoin,
      },
    ]

    testData.forEach(
      ({ enumKey, enumValue, genesisHash, expectedToBitcoinJsLibResult }) => {
        context(enumKey, async () => {
          describe(`toString`, async () => {
            it(`should return correct value`, async () => {
              expect(enumKey.toString()).to.be.equal(enumValue)
            })
          })

          describe(`fromGenesisHash`, async () => {
            it(`should resolve correct enum key`, async () => {
              expect(BitcoinNetwork.fromGenesisHash(genesisHash)).to.be.equal(
                enumKey
              )
            })
          })

          describe(`toBitcoinJsLibNetwork`, async () => {
            if (expectedToBitcoinJsLibResult instanceof Error) {
              it(`should throw an error`, async () => {
                expect(() => toBitcoinJsLibNetwork(enumKey)).to.throw(
                  expectedToBitcoinJsLibResult.message
                )
              })
            } else {
              it(`should return ${expectedToBitcoinJsLibResult}`, async () => {
                expect(toBitcoinJsLibNetwork(enumKey)).to.be.equal(
                  expectedToBitcoinJsLibResult
                )
              })
            }
          })
        })
      }
    )
  })

  describe("BitcoinPublicKeyUtils", () => {
    const { compressPublicKey } = BitcoinPublicKeyUtils

    describe("compressPublicKey", () => {
      context("when public key parameter has a correct length", () => {
        context("when the Y coordinate is divisible by 2", () => {
          it("should compress the public key correctly", () => {
            const uncompressedPublicKey = Hex.from(
              "ff6e1857db52d6dba2bd4239fba722655622bc520709d38011f9adac8ea3477b" +
                "45ae275b657f7bac7c1e3d146a564051aee1356895f01e4f29f333502416fa4a"
            )
            const compressedPublicKey =
              "02ff6e1857db52d6dba2bd4239fba722655622bc520709d38011f9adac8ea3477b"

            expect(compressPublicKey(uncompressedPublicKey)).to.be.equal(
              compressedPublicKey
            )
          })
        })

        context("when the Y coordinate is not divisible by 2", () => {
          it("should compress the public key correctly", () => {
            const uncompressedPublicKey = Hex.from(
              "474444cca71c678f5019d16782b6522735717a94602085b4adf707b465c36ca8" +
                "7b5dff055ee1cc3a1fff4715dea2858ca4dd5bba0af30abcd881a6bda4fb70af"
            )
            const compressedPublicKey =
              "03474444cca71c678f5019d16782b6522735717a94602085b4adf707b465c36ca8"

            expect(compressPublicKey(uncompressedPublicKey)).to.be.equal(
              compressedPublicKey
            )
          })
        })
      })

      context("when public key parameter has an incorrect length", () => {
        it("should throw", () => {
          const uncompressedPublicKey = Hex.from(
            "04474444cca71c678f5019d16782b6522735717a94602085b4adf707b465c36ca8" +
              "7b5dff055ee1cc3a1fff4715dea2858ca4dd5bba0af30abcd881a6bda4fb70af"
          )
          expect(() => compressPublicKey(uncompressedPublicKey)).to.throw(
            "The public key parameter must be 64-byte. Neither 0x nor 04 prefix is allowed"
          )
        })
      })
    })
  })

  describe("BitcoinHashUtils", () => {
    const { computeHash160, computeHash256, hashLEToBigNumber, computeSha256 } =
      BitcoinHashUtils

    describe("computeHash160", () => {
      it("should compute hash160 correctly", () => {
        const compressedPublicKey = Hex.from(
          "03474444cca71c678f5019d16782b6522735717a94602085b4adf707b465c36ca8"
        )
        const expectedHash160 = "3e1dfbd72483fb3964ca828ee71cf3270cafdc65"

        expect(computeHash160(compressedPublicKey).toString()).to.be.equal(
          expectedHash160
        )
      })
    })

    describe("computeHash256", () => {
      it("should compute hash256 correctly", () => {
        const hexValue = Hex.from(
          "03474444cca71c678f5019d16782b6522735717a94602085b4adf707b465c36ca8"
        )
        const expectedHash256 = Hex.from(
          "9f0b7447ca6ea11b8badd8a60a4dec1b846451551ef455975b1720f52bc90546"
        )

        expect(computeHash256(hexValue).toString()).to.be.equal(
          expectedHash256.toString()
        )
      })
    })

    describe("hashLEToBigNumber", () => {
      it("calculates correct value", () => {
        const hash = Hex.from(
          "31552151fbef8e96a33f979e6253d29edf65ac31b04802319e00000000000000"
        )
        const expectedBigNumber = BigNumber.from(
          "992983769452983078390935942095592601503357651673709518345521"
        )
        expect(hashLEToBigNumber(hash)).to.equal(expectedBigNumber)
      })
    })

    describe("computeSha256", () => {
      it("should compute hash256 correctly", () => {
        const hexValue = Hex.from(
          "03474444cca71c678f5019d16782b6522735717a94602085b4adf707b465c36ca8"
        )
        const expectedSha256 = Hex.from(
          "c62e5cb26c97cb52fea7f9965e9ea1f8d41c97773688aa88674e64629fc02901"
        )

        expect(computeSha256(hexValue).toString()).to.be.equal(
          expectedSha256.toString()
        )
      })
    })
  })

  describe("BitcoinAddressConverter", () => {
    const publicKeyHash = Hex.from("3a38d44d6a0c8d0bb84e0232cc632b7e48c72e0e")
    const P2WPKHAddress = "bc1q8gudgnt2pjxshwzwqgevccet0eyvwtswt03nuy"
    const P2PKHAddress = "16JrGhLx5bcBSA34kew9V6Mufa4aXhFe9X"
    const P2WPKHAddressTestnet = "tb1q8gudgnt2pjxshwzwqgevccet0eyvwtswpf2q8h"
    const P2PKHAddressTestnet = "mkpoZkRvtd3SDGWgUDuXK1aEXZfHRM2gKw"

    const {
      publicKeyToAddress,
      publicKeyHashToAddress,
      addressToPublicKeyHash,
      addressToOutputScript,
      outputScriptToAddress,
    } = BitcoinAddressConverter

    describe("publicKeyToAddress", () => {
      Object.entries(btcAddressFromPublicKey).forEach(
        ([bitcoinNetwork, addressData]) => {
          context(`with ${bitcoinNetwork} addresses`, () => {
            Object.entries(addressData).forEach(
              ([addressType, { publicKey, address }]) => {
                it(`should return correct ${addressType} address for ${bitcoinNetwork}`, () => {
                  const witness = addressType === "P2WPKH"
                  const result = publicKeyToAddress(
                    publicKey,
                    bitcoinNetwork === "mainnet"
                      ? BitcoinNetwork.Mainnet
                      : BitcoinNetwork.Testnet,
                    witness
                  )
                  expect(result).to.eq(address)
                })
              }
            )
          })
        }
      )
    })

    describe("publicKeyHashToAddress", () => {
      context("when network is mainnet", () => {
        context("when witness option is true", () => {
          context("when proper public key hash is provided", () => {
            it("should encode public key hash into bitcoin address properly", () => {
              expect(
                publicKeyHashToAddress(
                  publicKeyHash,
                  true,
                  BitcoinNetwork.Mainnet
                )
              ).to.be.equal(P2WPKHAddress)
            })
          })

          context("when wrong public key hash is provided", () => {
            it("should throw", () => {
              const wrongPublicKeyHash = Hex.from(
                "02" + publicKeyHash.toString()
              )

              expect(() =>
                publicKeyHashToAddress(
                  wrongPublicKeyHash,
                  true,
                  BitcoinNetwork.Mainnet
                )
              ).to.throw(
                `Expected property "hash" of type Buffer(Length: 20), got Buffer(Length: 21)`
              )
            })
          })
        })

        context("when witness option is false", () => {
          context("when proper public key hash is provided", () => {
            it("should encode public key hash into bitcoin address properly", () => {
              expect(
                publicKeyHashToAddress(
                  publicKeyHash,
                  false,
                  BitcoinNetwork.Mainnet
                )
              ).to.be.equal(P2PKHAddress)
            })
          })

          context("when wrong public key hash is provided", () => {
            it("should throw", () => {
              const wrongPublicKeyHash = Hex.from(
                "02" + publicKeyHash.toString()
              )

              expect(() =>
                publicKeyHashToAddress(
                  wrongPublicKeyHash,
                  false,
                  BitcoinNetwork.Mainnet
                )
              ).to.throw(
                `Expected property "hash" of type Buffer(Length: 20), got Buffer(Length: 21)`
              )
            })
          })
        })
      })

      context("when network is testnet", () => {
        context("when witness option is true", () => {
          context("when proper public key hash is provided", () => {
            it("should encode public key hash into bitcoin address properly", () => {
              expect(
                publicKeyHashToAddress(
                  publicKeyHash,
                  true,
                  BitcoinNetwork.Testnet
                )
              ).to.be.equal(P2WPKHAddressTestnet)
            })
          })

          context("when wrong public key hash is provided", () => {
            it("should throw", () => {
              const wrongPublicKeyHash = Hex.from(
                "02" + publicKeyHash.toString()
              )

              expect(() =>
                publicKeyHashToAddress(
                  wrongPublicKeyHash,
                  true,
                  BitcoinNetwork.Testnet
                )
              ).to.throw(
                `Expected property "hash" of type Buffer(Length: 20), got Buffer(Length: 21)`
              )
            })
          })
        })

        context("when witness option is false", () => {
          context("when proper public key hash is provided", () => {
            it("should encode public key hash into bitcoin address properly", () => {
              expect(
                publicKeyHashToAddress(
                  publicKeyHash,
                  false,
                  BitcoinNetwork.Testnet
                )
              ).to.be.equal(P2PKHAddressTestnet)
            })
          })

          context("when wrong public key hash is provided", () => {
            it("should throw", () => {
              const wrongPublicKeyHash = Hex.from(
                "02" + publicKeyHash.toString()
              )

              expect(() =>
                publicKeyHashToAddress(
                  wrongPublicKeyHash,
                  false,
                  BitcoinNetwork.Testnet
                )
              ).to.throw(
                `Expected property "hash" of type Buffer(Length: 20), got Buffer(Length: 21)`
              )
            })
          })
        })
      })

      context("when network is unknown", () => {
        it("should throw", () => {
          expect(() =>
            publicKeyHashToAddress(publicKeyHash, true, BitcoinNetwork.Unknown)
          ).to.throw("network not supported")
        })
      })
    })

    describe("addressToPublicKeyHash", () => {
      context("when network is mainnet", () => {
        context("when proper P2WPKH address is provided", () => {
          it("should decode P2WPKH adress correctly", () => {
            expect(
              addressToPublicKeyHash(P2WPKHAddress, BitcoinNetwork.Mainnet)
            ).to.be.deep.equal(publicKeyHash)
          })
        })

        context("when proper P2PKH address is provided", () => {
          it("should decode P2PKH address correctly", () => {
            expect(
              addressToPublicKeyHash(P2PKHAddress, BitcoinNetwork.Mainnet)
            ).to.be.deep.equal(publicKeyHash)
          })
        })

        context("when wrong address is provided", () => {
          it("should throw", () => {
            const bitcoinAddress = "123" + P2PKHAddress

            expect(() =>
              addressToPublicKeyHash(bitcoinAddress, BitcoinNetwork.Mainnet)
            ).to.throw(
              "Address must be P2PKH or P2WPKH valid for given network"
            )
          })
        })

        context("when unsupported P2SH address is provided", () => {
          it("should throw", () => {
            expect(() =>
              addressToPublicKeyHash(
                "3EktnHQD7RiAE6uzMj2ZifT9YgRrkSgzQX",
                BitcoinNetwork.Mainnet
              )
            ).to.throw(
              "Address must be P2PKH or P2WPKH valid for given network"
            )
          })
        })

        context("when unsupported P2WSH address is provided", () => {
          it("should throw", () => {
            expect(() =>
              addressToPublicKeyHash(
                "bc1qma629cu92skg0t86lftyaf9uflzwhp7jk63h6mpmv3ezh6puvdhsdxuv4m",
                BitcoinNetwork.Mainnet
              )
            ).to.throw(
              "Address must be P2PKH or P2WPKH valid for given network"
            )
          })
        })

        context("when address from testnet network is provided", () => {
          it("should throw", () => {
            expect(() =>
              addressToPublicKeyHash(
                "mkpoZkRvtd3SDGWgUDuXK1aEXZfHRM2gKw",
                BitcoinNetwork.Mainnet
              )
            ).to.throw(
              "Address must be P2PKH or P2WPKH valid for given network"
            )
          })
        })
      })

      context("when network is testnet", () => {
        context("when proper P2WPKH address is provided", () => {
          it("should decode P2WPKH adress correctly", () => {
            expect(
              addressToPublicKeyHash(
                P2WPKHAddressTestnet,
                BitcoinNetwork.Testnet
              )
            ).to.be.deep.equal(publicKeyHash)
          })
        })

        context("when proper P2PKH address is provided", () => {
          it("should decode P2PKH address correctly", () => {
            expect(
              addressToPublicKeyHash(
                P2PKHAddressTestnet,
                BitcoinNetwork.Testnet
              )
            ).to.be.deep.equal(publicKeyHash)
          })
        })

        context("when wrong address is provided", () => {
          it("should throw", () => {
            const bitcoinAddress = "123" + P2PKHAddressTestnet

            expect(() =>
              addressToPublicKeyHash(bitcoinAddress, BitcoinNetwork.Testnet)
            ).to.throw(
              "Address must be P2PKH or P2WPKH valid for given network"
            )
          })
        })

        context("when unsupported P2SH address is provided", () => {
          it("should throw", () => {
            expect(() =>
              addressToPublicKeyHash(
                "2MyxShnGQ5NifGb8CHYrtmzosRySxZ9pZo5",
                BitcoinNetwork.Testnet
              )
            ).to.throw(
              "Address must be P2PKH or P2WPKH valid for given network"
            )
          })
        })

        context("when unsupported P2WSH address is provided", () => {
          it("should throw", () => {
            expect(() =>
              addressToPublicKeyHash(
                "tb1qma629cu92skg0t86lftyaf9uflzwhp7jk63h6mpmv3ezh6puvdhs6w2r05",
                BitcoinNetwork.Testnet
              )
            ).to.throw(
              "Address must be P2PKH or P2WPKH valid for given network"
            )
          })
        })

        context("when address from mainnet network is provided", () => {
          it("should throw", () => {
            expect(() =>
              addressToPublicKeyHash(
                "bc1q8gudgnt2pjxshwzwqgevccet0eyvwtswt03nuy",
                BitcoinNetwork.Testnet
              )
            ).to.throw(
              "Address must be P2PKH or P2WPKH valid for given network"
            )
          })
        })
      })
    })

    describe("addressToOutputScript", () => {
      Object.keys(btcAddresses).forEach((bitcoinNetwork) => {
        context(`with ${bitcoinNetwork} addresses`, () => {
          Object.entries(
            btcAddresses[bitcoinNetwork as keyof typeof btcAddresses]
          ).forEach(
            ([
              addressType,
              { address, scriptPubKey: expectedOutputScript },
            ]) => {
              it(`should create correct output script for ${addressType} address type`, () => {
                const network =
                  bitcoinNetwork === "mainnet"
                    ? BitcoinNetwork.Mainnet
                    : BitcoinNetwork.Testnet

                const result = addressToOutputScript(address, network)

                expect(result.toString()).to.eq(expectedOutputScript.toString())
              })
            }
          )
        })
      })
    })

    describe("outputScriptToAddress", () => {
      Object.keys(btcAddresses).forEach((bitcoinNetwork) => {
        context(`with ${bitcoinNetwork} addresses`, () => {
          Object.entries(
            btcAddresses[bitcoinNetwork as keyof typeof btcAddresses]
          ).forEach(([addressType, { address, scriptPubKey }]) => {
            it(`should return correct ${addressType} address`, () => {
              const result = outputScriptToAddress(
                scriptPubKey,
                bitcoinNetwork === "mainnet"
                  ? BitcoinNetwork.Mainnet
                  : BitcoinNetwork.Testnet
              )

              expect(result.toString()).to.eq(address)
            })
          })
        })
      })
    })
  })

  describe("BitcoinLocktimeUtils", () => {
    const { locktimeToNumber, calculateLocktime } = BitcoinLocktimeUtils

    describe("locktimeToNumber", () => {
      const locktimeStartedAt: number = 1640181600
      const locktimeDuration: number = 2592000
      const locktime = BitcoinLocktimeUtils.calculateLocktime(
        locktimeStartedAt,
        locktimeDuration
      )

      const testData = [
        {
          contextName: "when locktime is a block height",
          unprefixedHex: Hex.from("ede80600"),
          expectedLocktime: 452845,
        },
        {
          contextName: "when locktime is a timestamp",
          unprefixedHex: Hex.from("06241559"),
          expectedLocktime: 1494557702,
        },
        {
          contextName: "for locktime",
          unprefixedHex: locktime,
          expectedLocktime: locktimeStartedAt + locktimeDuration,
        },
      ]

      testData.forEach((test) => {
        context(test.contextName, () => {
          context("when input is non-prefixed hex string", () => {
            it("should return the locktime in seconds", async () => {
              expect(
                locktimeToNumber(test.unprefixedHex.toString())
              ).to.be.equal(test.expectedLocktime)
            })
          })

          context("when input is 0x prefixed hex string", () => {
            it("should return the locktime in seconds", async () => {
              expect(
                locktimeToNumber(test.unprefixedHex.toPrefixedString())
              ).to.be.equal(test.expectedLocktime)
            })
          })

          context("when input is Buffer object", () => {
            it("should return the locktime in seconds", async () => {
              expect(
                locktimeToNumber(test.unprefixedHex.toBuffer())
              ).to.be.equal(test.expectedLocktime)
            })
          })
        })
      })
    })

    describe("calculateLocktime", () => {
      context("when the resulting locktime is lesser than 4 bytes", () => {
        it("should throw", () => {
          // This will result with 2592001 as the locktime which is a 3-byte number.
          expect(() => calculateLocktime(1, 2592000)).to.throw(
            "Locktime must be a 4 bytes number"
          )
        })
      })

      context("when the resulting locktime is greater than 4 bytes", () => {
        it("should throw", () => {
          // This will result with 259200144444 as the locktime which is a 5-byte number.
          expect(() => calculateLocktime(259197552444, 2592000)).to.throw(
            "Locktime must be a 4 bytes number"
          )
        })
      })

      context("when the resulting locktime is a 4-byte number", () => {
        it("should compute a proper 4-byte little-endian locktime as un-prefixed hex string", () => {
          const locktimeStartedAt = 1652776752

          const locktime = calculateLocktime(locktimeStartedAt, 2592000)

          // The start timestamp is 1652776752 and locktime duration 2592000 (30 days).
          // So, the locktime timestamp is 1652776752 + 2592000 = 1655368752 which
          // is represented as 30ecaa62 hex in the little-endian format.
          expect(locktime.toString()).to.be.equal("30ecaa62")
        })
      })
    })
  })

  describe("BitcoinHeaderSerializer", () => {
    const { serializeHeader, deserializeHeader } = BitcoinHeaderSerializer

    describe("serializeHeader", () => {
      it("calculates correct value", () => {
        const blockHeader: BitcoinHeader = {
          version: 536870916,
          previousBlockHeaderHash: Hex.from(
            "a5a3501e6ba1f3e2a1ee5d29327a549524ed33f272dfef300045660000000000"
          ),
          merkleRootHash: Hex.from(
            "e27d241ca36de831ab17e6729056c14a383e7a3f43d56254f846b49649775112"
          ),
          time: 1641914003,
          bits: 436256810,
          nonce: 778087099,
        }

        const expectedSerializedBlockHeader = Hex.from(
          "04000020a5a3501e6ba1f3e2a1ee5d29327a549524ed33f272dfef30004566000000" +
            "0000e27d241ca36de831ab17e6729056c14a383e7a3f43d56254f846b496497751" +
            "12939edd612ac0001abbaa602e"
        )

        expect(serializeHeader(blockHeader)).to.be.deep.equal(
          expectedSerializedBlockHeader
        )
      })
    })

    describe("deserializeHeader", () => {
      it("calculates correct value", () => {
        const rawBlockHeader = Hex.from(
          "04000020a5a3501e6ba1f3e2a1ee5d29327a549524ed33f272dfef30004566000000" +
            "0000e27d241ca36de831ab17e6729056c14a383e7a3f43d56254f846b496497751" +
            "12939edd612ac0001abbaa602e"
        )

        const expectedBlockHeader: BitcoinHeader = {
          version: 536870916,
          previousBlockHeaderHash: Hex.from(
            "a5a3501e6ba1f3e2a1ee5d29327a549524ed33f272dfef300045660000000000"
          ),
          merkleRootHash: Hex.from(
            "e27d241ca36de831ab17e6729056c14a383e7a3f43d56254f846b49649775112"
          ),
          time: 1641914003,
          bits: 436256810,
          nonce: 778087099,
        }

        expect(deserializeHeader(rawBlockHeader)).to.deep.equal(
          expectedBlockHeader
        )
      })
    })
  })

  describe("BitcoinTargetConverter", () => {
    const { bitsToTarget, targetToDifficulty } = BitcoinTargetConverter

    describe("bitsToTarget", () => {
      it("calculates correct value for random block header bits", () => {
        const difficultyBits = 436256810
        const expectedDifficultyTarget = BigNumber.from(
          "1206233370197704583969288378458116959663044038027202007138304"
        )
        expect(bitsToTarget(difficultyBits)).to.equal(expectedDifficultyTarget)
      })

      it("calculates correct value for block header with difficulty of 1", () => {
        const difficultyBits = 486604799
        const expectedDifficultyTarget = BigNumber.from(
          "26959535291011309493156476344723991336010898738574164086137773096960"
        )
        expect(bitsToTarget(difficultyBits)).to.equal(expectedDifficultyTarget)
      })
    })

    describe("targetToDifficulty", () => {
      it("calculates correct value for random block header bits", () => {
        const target = BigNumber.from(
          "1206233370197704583969288378458116959663044038027202007138304"
        )
        const expectedDifficulty = BigNumber.from("22350181")
        expect(targetToDifficulty(target)).to.equal(expectedDifficulty)
      })

      it("calculates correct value for block header with difficulty of 1", () => {
        const target = BigNumber.from(
          "26959535291011309493156476344723991336010898738574164086137773096960"
        )
        const expectedDifficulty = BigNumber.from("1")
        expect(targetToDifficulty(target)).to.equal(expectedDifficulty)
      })
    })
  })

  describe("BitcoinCompactSizeUint", () => {
    const { read } = BitcoinCompactSizeUint

    describe("read", () => {
      context("when the compact size uint is empty", () => {
        it("should throw", () => {
          expect(() => {
            return read(Hex.from(""))
          }).to.throw("Empty variable length data argument")
        })
      })

      context("when the compact size uint is 1-byte", () => {
        it("should return the uint value and byte length", () => {
          expect(read(Hex.from("bb"))).to.be.eql({
            value: 187,
            byteLength: 1,
          })
        })
      })

      context("when the compact size uint is 3-byte", () => {
        it("should throw", () => {
          expect(() => read(Hex.from("fd0302"))).to.throw(
            "Support for 3, 5 and 9 bytes compact size uints is not implemented yet"
          )
        })
      })

      context("when the compact size uint is 5-byte", () => {
        it("should throw", () => {
          expect(() => read(Hex.from("fe703a0f00"))).to.throw(
            "Support for 3, 5 and 9 bytes compact size uints is not implemented yet"
          )
        })
      })

      context("when the compact size uint is 9-byte", () => {
        it("should throw", () => {
          expect(() => {
            return read(Hex.from("ff57284e56dab40000"))
          }).to.throw(
            "Support for 3, 5 and 9 bytes compact size uints is not implemented yet"
          )
        })
      })
    })
  })

  describe("BitcoinScriptUtils", () => {
    const { isP2PKHScript, isP2WPKHScript, isP2SHScript, isP2WSHScript } =
      BitcoinScriptUtils

    describe("isScript", () => {
      const testData = [
        {
          testFunction: isP2PKHScript,
          validScript: Hex.from(
            "76a9148db50eb52063ea9d98b3eac91489a90f738986f688ac"
          ),
          name: "P2PKH",
        },
        {
          testFunction: isP2WPKHScript,
          validScript: Hex.from("00148db50eb52063ea9d98b3eac91489a90f738986f6"),
          name: "P2WPKH",
        },
        {
          testFunction: isP2SHScript,
          validScript: Hex.from(
            "a914a9a5f97d5d3c4687a52e90718168270005b369c487"
          ),
          name: "P2SH",
        },
        {
          testFunction: isP2WSHScript,
          validScript: Hex.from(
            "0020b1f83e226979dc9fe74e87f6d303dbb08a27a1c7ce91664033f34c7f2d214cd7"
          ),
          name: "P2WSH",
        },
      ]

      testData.forEach(({ testFunction, validScript, name }) => {
        describe(`is${name}Script`, () => {
          it(`should return true for a valid ${name} script`, () => {
            expect(testFunction(validScript)).to.be.true
          })

          it("should return false for other scripts", () => {
            testData.forEach((data) => {
              if (data.name !== name) {
                expect(testFunction(data.validScript)).to.be.false
              }
            })
          })
        })
      })
    })
  })

  describe("extractBitcoinRawTxVectors", () => {
    it("should return correct transaction vectors", () => {
      const rawTransaction =
        depositSweepWithNoMainUtxoAndWitnessOutput.expectedSweep.transaction
      const decomposedTransaction = extractBitcoinRawTxVectors(rawTransaction)

      expect(decomposedTransaction.version.toString()).to.be.equal("01000000")
      expect(decomposedTransaction.inputs.toString()).to.be.equal(
        "02bc187be612bc3db8cfcdec56b75e9bc0262ab6eacfe27cc1a699bacd53e3d07400" +
          "000000c948304502210089a89aaf3fec97ac9ffa91cdff59829f0cb3ef852a468153" +
          "e2c0e2b473466d2e022072902bb923ef016ac52e941ced78f816bf27991c2b73211e" +
          "227db27ec200bc0a012103989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f25" +
          "64da4cc29dcf8581d94c5c14934b98637ca318a4d6e7ca6ffd1690b8e77df6377508" +
          "f9f0c90d000395237576a9148db50eb52063ea9d98b3eac91489a90f738986f68763" +
          "ac6776a914e257eccafbc07c381642ce6e7e55120fb077fbed8804e0250162b175ac" +
          "68ffffffffdc557e737b6688c5712649b86f7757a722dc3d42786f23b2fa826394df" +
          "ec545c0000000000ffffffff"
      )
      expect(decomposedTransaction.outputs.toString()).to.be.equal(
        "01488a0000000000001600148db50eb52063ea9d98b3eac91489a90f738986f6"
      )
      expect(decomposedTransaction.locktime.toString()).to.be.equal("00000000")
    })
  })

  describe("assembleBitcoinSpvProof", () => {
    let bitcoinClient: MockBitcoinClient

    beforeEach(async () => {
      bitcoinClient = new MockBitcoinClient()
    })

    context("when the transaction has one input", () => {
      let proof: BitcoinTx & BitcoinSpvProof

      beforeEach(async () => {
        proof = await runProofScenario(singleInputProofTestData)
      })

      it("should return the correct value of the proof", async () => {
        const expectedProof = singleInputProofTestData.expectedProof
        expect(proof.transactionHash).to.be.deep.equal(
          expectedProof.transactionHash
        )
        expect(proof.inputs).to.deep.equal(expectedProof.inputs)
        expect(proof.outputs).to.deep.equal(expectedProof.outputs)
        expect(proof.merkleProof).to.deep.equal(expectedProof.merkleProof)
        expect(proof.txIndexInBlock).to.equal(expectedProof.txIndexInBlock)
        expect(proof.bitcoinHeaders).to.deep.equal(expectedProof.bitcoinHeaders)
        expect(proof.coinbasePreimage).to.deep.equal(
          expectedProof.coinbasePreimage
        )
        expect(proof.coinbaseProof).to.deep.equal(expectedProof.coinbaseProof)
      })
    })

    context("when the transaction has multiple inputs", () => {
      let proof: BitcoinTx & BitcoinSpvProof

      beforeEach(async () => {
        proof = await runProofScenario(multipleInputsProofTestData)
      })

      it("should return the correct value of the proof", async () => {
        const expectedProof = multipleInputsProofTestData.expectedProof
        expect(proof.transactionHash).to.deep.equal(
          expectedProof.transactionHash
        )
        expect(proof.inputs).to.deep.equal(expectedProof.inputs)
        expect(proof.outputs).to.deep.equal(expectedProof.outputs)
        expect(proof.merkleProof).to.deep.equal(expectedProof.merkleProof)
        expect(proof.txIndexInBlock).to.equal(expectedProof.txIndexInBlock)
        expect(proof.bitcoinHeaders).to.deep.equal(expectedProof.bitcoinHeaders)
        expect(proof.coinbasePreimage).to.deep.equal(
          expectedProof.coinbasePreimage
        )
        expect(proof.coinbaseProof).to.deep.equal(expectedProof.coinbaseProof)
      })
    })

    context("when the transaction does not have enough confirmations", () => {
      let notEnoughConfirmationsSweepProofTestData: ProofTestData

      beforeEach(async () => {
        notEnoughConfirmationsSweepProofTestData = singleInputProofTestData
        notEnoughConfirmationsSweepProofTestData.bitcoinChainData.accumulatedTxConfirmations = 5
      })

      it("should revert", async () => {
        await expect(
          runProofScenario(notEnoughConfirmationsSweepProofTestData)
        ).to.be.rejectedWith(
          "Transaction confirmations number[5] is not enough, required [6]"
        )
      })
    })

    async function runProofScenario(
      data: ProofTestData
    ): Promise<BitcoinTx & BitcoinSpvProof> {
      const transactions = new Map<string, BitcoinTx>()
      const transactionHash = data.bitcoinChainData.transaction.transactionHash
      transactions.set(
        transactionHash.toString(),
        data.bitcoinChainData.transaction
      )
      bitcoinClient.transactions = transactions

      bitcoinClient.latestHeight = data.bitcoinChainData.latestBlockHeight

      bitcoinClient.headersChain = data.bitcoinChainData.headersChain

      const txBlockHeight =
        data.bitcoinChainData.latestBlockHeight -
        data.bitcoinChainData.accumulatedTxConfirmations +
        1

      const transactionMerkle = new Map<string, BitcoinTxMerkleBranch>()
      transactionMerkle.set(
        `${transactionHash.toString()}${txBlockHeight.toString(16)}`,
        data.bitcoinChainData.transactionMerkleBranch
      )

      const confirmations = new Map<string, number>()
      confirmations.set(
        transactionHash.toString(),
        data.bitcoinChainData.accumulatedTxConfirmations
      )
      bitcoinClient.confirmations = confirmations

      const coinbaseTxHash = BitcoinTxHash.from(
        BitcoinHashUtils.computeHash256(
          Hex.from(data.bitcoinChainData.coinbaseRawTransaction.transactionHex)
        ).toString()
      )

      const coinbaseHashes = new Map<number, BitcoinTxHash>()
      coinbaseHashes.set(txBlockHeight, coinbaseTxHash)
      bitcoinClient.coinbaseHashes = coinbaseHashes

      const rawTransactions = new Map<string, BitcoinRawTx>()
      rawTransactions.set(
        coinbaseTxHash.toString(),
        data.bitcoinChainData.coinbaseRawTransaction
      )
      bitcoinClient.rawTransactions = rawTransactions

      transactionMerkle.set(
        `${coinbaseTxHash.toString()}${txBlockHeight.toString(16)}`,
        data.bitcoinChainData.coinbaseMerkleBranch
      )
      bitcoinClient.transactionMerkle = transactionMerkle

      const proof = await assembleBitcoinSpvProof(
        transactionHash,
        data.requiredConfirmations,
        bitcoinClient
      )

      return proof
    }
  })

  describe("validateTransactionProof", () => {
    let bitcoinClient: MockBitcoinClient

    beforeEach(async () => {
      bitcoinClient = new MockBitcoinClient()
    })

    context("when the transaction proof is correct", () => {
      context("when the transaction is from Bitcoin Mainnet", () => {
        context(
          "when the transaction confirmations span only one epoch",
          () => {
            it("should not throw", async () => {
              await expect(
                runProofValidationScenario(
                  transactionConfirmationsInOneEpochData
                )
              ).not.to.be.rejected
            })
          }
        )

        context("when the transaction confirmations span two epochs", () => {
          it("should not throw", async () => {
            await expect(
              runProofValidationScenario(
                transactionConfirmationsInTwoEpochsData
              )
            ).not.to.be.rejected
          })
        })
      })

      context("when the transaction is from Bitcoin Testnet", () => {
        it("should not throw", async () => {
          await expect(runProofValidationScenario(testnetTransactionData)).not
            .to.be.rejected
        })
      })
    })

    context("when the transaction proof is incorrect", () => {
      context("when the length of headers chain is incorrect", () => {
        it("should throw", async () => {
          // Corrupt data by adding additional byte to the headers chain.
          const corruptedProofData: TransactionProofData = {
            ...transactionConfirmationsInOneEpochData,
            bitcoinChainData: {
              ...transactionConfirmationsInOneEpochData.bitcoinChainData,
              headersChain: Hex.from(
                transactionConfirmationsInOneEpochData.bitcoinChainData.headersChain.toString() +
                  "ff"
              ),
            },
          }
          await expect(
            runProofValidationScenario(corruptedProofData)
          ).to.be.rejectedWith("Incorrect length of Bitcoin headers")
        })
      })

      context(
        "when the headers chain contains an incorrect number of headers",
        () => {
          // Corrupt the data by adding additional 80 bytes to the headers chain.
          it("should throw", async () => {
            const corruptedProofData: TransactionProofData = {
              ...transactionConfirmationsInOneEpochData,
              bitcoinChainData: {
                ...transactionConfirmationsInOneEpochData.bitcoinChainData,
                headersChain: Hex.from(
                  transactionConfirmationsInOneEpochData.bitcoinChainData.headersChain.toString() +
                    "f".repeat(160)
                ),
              },
            }
            await expect(
              runProofValidationScenario(corruptedProofData)
            ).to.be.rejectedWith("Wrong number of confirmations")
          })
        }
      )

      context("when the merkle proof is of incorrect length", () => {
        it("should throw", async () => {
          // Corrupt the data by adding a byte to the Merkle proof.
          const merkle = [
            ...transactionConfirmationsInOneEpochData.bitcoinChainData
              .transactionMerkleBranch.merkle,
          ]
          merkle[merkle.length - 1] = Hex.from(
            merkle[merkle.length - 1].toString() + "ff"
          )

          const coinbaseMerkle = [
            ...transactionConfirmationsInOneEpochData.bitcoinChainData
              .coinbaseMerkleBranch.merkle,
          ]
          coinbaseMerkle[coinbaseMerkle.length - 1] = Hex.from(
            coinbaseMerkle[coinbaseMerkle.length - 1].toString() + "ff"
          )

          const corruptedProofData: TransactionProofData = {
            ...transactionConfirmationsInOneEpochData,
            bitcoinChainData: {
              ...transactionConfirmationsInOneEpochData.bitcoinChainData,
              transactionMerkleBranch: {
                ...transactionConfirmationsInOneEpochData.bitcoinChainData
                  .transactionMerkleBranch,
                merkle: merkle,
              },
              coinbaseMerkleBranch: {
                ...transactionConfirmationsInOneEpochData.bitcoinChainData
                  .coinbaseMerkleBranch,
                merkle: merkle,
              },
            },
          }

          await expect(
            runProofValidationScenario(corruptedProofData)
          ).to.be.rejectedWith("Incorrect length of Merkle proof")
        })
      })

      context("when the merkle proof is empty", () => {
        it("should throw", async () => {
          // Corrupt the data by making the Merkle proof empty.
          const corruptedProofData: TransactionProofData = {
            ...transactionConfirmationsInOneEpochData,
            bitcoinChainData: {
              ...transactionConfirmationsInOneEpochData.bitcoinChainData,
              transactionMerkleBranch: {
                ...transactionConfirmationsInOneEpochData.bitcoinChainData
                  .transactionMerkleBranch,
                merkle: [],
              },
              coinbaseMerkleBranch: {
                ...transactionConfirmationsInOneEpochData.bitcoinChainData
                  .coinbaseMerkleBranch,
                merkle: [],
              },
            },
          }

          await expect(
            runProofValidationScenario(corruptedProofData)
          ).to.be.rejectedWith("Invalid merkle tree")
        })
      })

      context("when the merkle proof contains incorrect hash", () => {
        it("should throw", async () => {
          // Corrupt the data by changing a byte of one of the hashes in the
          // Merkle proof.
          const merkle = [
            ...transactionConfirmationsInOneEpochData.bitcoinChainData
              .transactionMerkleBranch.merkle,
          ]

          merkle[3] = Hex.from("ff" + merkle[3].toString().slice(2))

          const corruptedProofData: TransactionProofData = {
            ...transactionConfirmationsInOneEpochData,
            bitcoinChainData: {
              ...transactionConfirmationsInOneEpochData.bitcoinChainData,
              transactionMerkleBranch: {
                ...transactionConfirmationsInOneEpochData.bitcoinChainData
                  .transactionMerkleBranch,
                merkle: merkle,
              },
            },
          }

          await expect(
            runProofValidationScenario(corruptedProofData)
          ).to.be.rejectedWith(
            "Transaction Merkle proof is not valid for provided header and transaction hash"
          )
        })
      })

      context("when the block headers do not form a chain", () => {
        it("should throw", async () => {
          // Corrupt data by modifying previous block header hash of one of the
          // headers.
          const headers: BitcoinHeader[] =
            BitcoinHeaderSerializer.deserializeHeadersChain(
              transactionConfirmationsInOneEpochData.bitcoinChainData
                .headersChain
            )
          headers[headers.length - 1].previousBlockHeaderHash = Hex.from(
            "ff".repeat(32)
          )
          const corruptedHeadersChain: string = headers
            .map(BitcoinHeaderSerializer.serializeHeader)
            .join("")

          const corruptedProofData: TransactionProofData = {
            ...transactionConfirmationsInOneEpochData,
            bitcoinChainData: {
              ...transactionConfirmationsInOneEpochData.bitcoinChainData,
              headersChain: Hex.from(corruptedHeadersChain),
            },
          }

          await expect(
            runProofValidationScenario(corruptedProofData)
          ).to.be.rejectedWith("Invalid headers chain")
        })
      })

      context("when one of the block headers has insufficient work", () => {
        it("should throw", async () => {
          // Corrupt data by modifying the nonce of one of the headers, so that
          // the resulting hash will be above the required difficulty target.
          const headers: BitcoinHeader[] =
            BitcoinHeaderSerializer.deserializeHeadersChain(
              transactionConfirmationsInOneEpochData.bitcoinChainData
                .headersChain
            )
          headers[headers.length - 1].nonce++
          const corruptedHeadersChain: string = headers
            .map(BitcoinHeaderSerializer.serializeHeader)
            .join("")

          const corruptedProofData: TransactionProofData = {
            ...transactionConfirmationsInOneEpochData,
            bitcoinChainData: {
              ...transactionConfirmationsInOneEpochData.bitcoinChainData,
              headersChain: Hex.from(corruptedHeadersChain),
            },
          }

          await expect(
            runProofValidationScenario(corruptedProofData)
          ).to.be.rejectedWith("Insufficient work in the header")
        })
      })

      context(
        "when some of the block headers are not at current or previous difficulty",
        () => {
          it("should throw", async () => {
            // Corrupt data by setting current difficulty to a different value
            // than stored in block headers.
            const corruptedProofData: TransactionProofData = {
              ...transactionConfirmationsInTwoEpochsData,
              bitcoinChainData: {
                ...transactionConfirmationsInTwoEpochsData.bitcoinChainData,
                currentDifficulty:
                  transactionConfirmationsInTwoEpochsData.bitcoinChainData.currentDifficulty.add(
                    1
                  ),
              },
            }

            await expect(
              runProofValidationScenario(corruptedProofData)
            ).to.be.rejectedWith(
              "Header difficulty not at current or previous Bitcoin difficulty"
            )
          })
        }
      )
    })

    async function runProofValidationScenario(data: TransactionProofData) {
      const transactions = new Map<string, BitcoinTx>()
      const transactionHash = data.bitcoinChainData.transaction.transactionHash
      transactions.set(
        transactionHash.toString(),
        data.bitcoinChainData.transaction
      )
      bitcoinClient.transactions = transactions

      bitcoinClient.latestHeight = data.bitcoinChainData.latestBlockHeight

      bitcoinClient.headersChain = data.bitcoinChainData.headersChain

      const txBlockHeight =
        data.bitcoinChainData.latestBlockHeight -
        data.bitcoinChainData.accumulatedTxConfirmations +
        1

      const transactionMerkle = new Map<string, BitcoinTxMerkleBranch>()
      transactionMerkle.set(
        `${transactionHash.toString()}${txBlockHeight.toString(16)}`,
        data.bitcoinChainData.transactionMerkleBranch
      )

      const confirmations = new Map<string, number>()
      confirmations.set(
        transactionHash.toString(),
        data.bitcoinChainData.accumulatedTxConfirmations
      )
      bitcoinClient.confirmations = confirmations

      const coinbaseTxHash = BitcoinTxHash.from(
        BitcoinHashUtils.computeHash256(
          Hex.from(data.bitcoinChainData.coinbaseRawTransaction.transactionHex)
        ).toString()
      )

      const coinbaseHashes = new Map<number, BitcoinTxHash>()
      coinbaseHashes.set(txBlockHeight, coinbaseTxHash)
      bitcoinClient.coinbaseHashes = coinbaseHashes

      const rawTransactions = new Map<string, BitcoinRawTx>()
      rawTransactions.set(
        coinbaseTxHash.toString(),
        data.bitcoinChainData.coinbaseRawTransaction
      )
      bitcoinClient.rawTransactions = rawTransactions

      transactionMerkle.set(
        `${coinbaseTxHash.toString()}${txBlockHeight.toString(16)}`,
        data.bitcoinChainData.coinbaseMerkleBranch
      )
      bitcoinClient.transactionMerkle = transactionMerkle

      await validateBitcoinSpvProof(
        data.bitcoinChainData.transaction.transactionHash,
        data.requiredConfirmations,
        data.bitcoinChainData.previousDifficulty,
        data.bitcoinChainData.currentDifficulty,
        bitcoinClient
      )
    }
  })
})
