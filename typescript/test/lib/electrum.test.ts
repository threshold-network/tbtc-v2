import {
  BitcoinNetwork,
  ElectrumCredentials,
  ElectrumClient,
  computeElectrumScriptHash,
  Hex,
  BitcoinTxHash,
} from "../../src"
import {
  testnetAddress,
  testnetHeadersChain,
  testnetPublicKeyHash,
  testnetRawTransaction,
  testnetTransaction,
  testnetTransactionMerkleBranch,
  testnetTxHashes,
  testnetUTXO,
} from "../data/electrum"
import MainnetElectrumUrls from "../../src/lib/electrum/urls/mainnet.json"
import TestnetElectrumUrls from "../../src/lib/electrum/urls/testnet.json"
import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import https from "https"

chai.use(chaiAsPromised)

const BLOCKSTREAM_TESTNET_API_URL = "https://blockstream.info/testnet/api"

const testnetCredentials: ElectrumCredentials[] = [
  // BOAR testnet electrumx wss
  {
    host: "electrum.testnet.boar.network",
    port: 443,
    protocol: "wss",
    path: "/QxbJgaSLUHqrgAa9BW7bDpnGPxrlhnCa",
  },
  // electrs-esplora tcp
  {
    host: "electrum.blockstream.info",
    port: 60001,
    protocol: "tcp",
  },
  // FIXME: https://github.com/keep-network/tbtc-v2/issues/502
  // // electrs-esplora ssl
  // {
  //   host: "electrum.blockstream.info",
  //   port: 60002,
  //   protocol: "ssl",
  // },
  // fulcrum tcp
  {
    host: "testnet.aranguren.org",
    port: 51001,
    protocol: "tcp",
  },
  // FIXME: https://github.com/keep-network/tbtc-v2/issues/502
  // fulcrum ssl
  // {
  //   host: "testnet.aranguren.org",
  //   port: 51002,
  //   protocol: "ssl",
  // },
]

describe("Electrum", () => {
  describe("fromUrl", () => {
    it("should parse a URL with explicit port", () => {
      const client = ElectrumClient.fromUrl("wss://electrum.example.com:8443")
      const credentials = (client as any).credentials[0]
      expect(credentials.host).to.equal("electrum.example.com")
      expect(credentials.port).to.equal(8443)
      expect(credentials.protocol).to.equal("wss")
      expect(credentials.path).to.be.undefined
    })

    it("should parse a URL with path", () => {
      const client = ElectrumClient.fromUrl(
        "wss://electrum.example.com:8443/api-key-123"
      )
      const credentials = (client as any).credentials[0]
      expect(credentials.host).to.equal("electrum.example.com")
      expect(credentials.port).to.equal(8443)
      expect(credentials.protocol).to.equal("wss")
      expect(credentials.path).to.equal("/api-key-123")
    })

    it("should parse a URL with explicit default port", () => {
      const client = ElectrumClient.fromUrl(
        "wss://electrum.mainnet.boar.network:443/apikey123"
      )
      const credentials = (client as any).credentials[0]
      expect(credentials.host).to.equal("electrum.mainnet.boar.network")
      expect(credentials.port).to.equal(443)
      expect(credentials.protocol).to.equal("wss")
      expect(credentials.path).to.equal("/apikey123")
    })

    it("should use default port for wss:// protocol", () => {
      const client = ElectrumClient.fromUrl("wss://electrum.example.com")
      const credentials = (client as any).credentials[0]
      expect(credentials.host).to.equal("electrum.example.com")
      expect(credentials.port).to.equal(443)
      expect(credentials.protocol).to.equal("wss")
    })

    it("should use default port for ws:// protocol", () => {
      const client = ElectrumClient.fromUrl("ws://electrum.example.com")
      const credentials = (client as any).credentials[0]
      expect(credentials.port).to.equal(80)
      expect(credentials.protocol).to.equal("ws")
    })

    it("should use default port for ssl:// protocol", () => {
      const client = ElectrumClient.fromUrl("ssl://electrum.example.com")
      const credentials = (client as any).credentials[0]
      expect(credentials.port).to.equal(443)
      expect(credentials.protocol).to.equal("ssl")
    })

    it("should use default port for tls:// protocol", () => {
      const client = ElectrumClient.fromUrl("tls://electrum.example.com")
      const credentials = (client as any).credentials[0]
      expect(credentials.port).to.equal(443)
      expect(credentials.protocol).to.equal("tls")
    })

    it("should use default port for tcp:// protocol", () => {
      const client = ElectrumClient.fromUrl("tcp://electrum.example.com")
      const credentials = (client as any).credentials[0]
      expect(credentials.port).to.equal(50001)
      expect(credentials.protocol).to.equal("tcp")
    })

    it("should throw for a URL with unknown protocol and no port", () => {
      expect(() =>
        ElectrumClient.fromUrl("http://electrum.example.com")
      ).to.throw("missing or invalid port")
    })

    it("should parse an array of URLs", () => {
      const client = ElectrumClient.fromUrl([
        "ssl://electrum.example.com:50002",
        "wss://electrum.example.com:8443/api-key",
      ])
      const credentials = (client as any).credentials
      expect(credentials).to.have.length(2)
      expect(credentials[0].protocol).to.equal("ssl")
      expect(credentials[0].port).to.equal(50002)
      expect(credentials[0].path).to.be.undefined
      expect(credentials[1].protocol).to.equal("wss")
      expect(credentials[1].path).to.equal("/api-key")
    })

    it("should not set path for a URL with bare slash", () => {
      const client = ElectrumClient.fromUrl("wss://electrum.example.com:8443/")
      const credentials = (client as any).credentials[0]
      expect(credentials.path).to.be.undefined
    })
  })

  describe("config files", () => {
    it("should have exactly one mainnet URL pointing to BOAR", () => {
      expect(MainnetElectrumUrls.urls).to.have.length(1)
      expect(MainnetElectrumUrls.urls[0]).to.equal(
        "wss://electrum.boar.network:2083"
      )
    })

    it("should have exactly one testnet URL pointing to BOAR testnet", () => {
      expect(TestnetElectrumUrls.urls).to.have.length(1)
      expect(TestnetElectrumUrls.urls[0]).to.equal(
        "wss://electrum.testnet.boar.network:443/QxbJgaSLUHqrgAa9BW7bDpnGPxrlhnCa"
      )
    })

    it("should parse the BOAR testnet URL with correct credentials", () => {
      const client = ElectrumClient.fromUrl(TestnetElectrumUrls.urls)
      const credentials = (client as any).credentials[0]
      expect(credentials.host).to.equal("electrum.testnet.boar.network")
      expect(credentials.port).to.equal(443)
      expect(credentials.protocol).to.equal("wss")
      expect(credentials.path).to.equal("/QxbJgaSLUHqrgAa9BW7bDpnGPxrlhnCa")
    })
  })

  /**
   * This test suite is meant to check the behavior of the Electrum-based
   * Bitcoin client implementation. This suite requires an integration with a
   * real testnet Electrum server. That requirement makes those tests
   * time-consuming and vulnerable to external service health fluctuations.
   * Because of that, they are skipped by default and should be run only
   * on demand. Worth noting this test suite does not provide full coverage
   * of all Electrum client functions. The `broadcast` function is not covered
   * since it requires a proper Bitcoin transaction hex for each run which is
   * out of scope of this suite. The `broadcast` function was tested manually
   * though.
   */
  describe.skip("ElectrumClient", () => {
    testnetCredentials.forEach((credentials) => {
      describe(`${credentials.protocol}://${credentials.host}:${credentials.port}`, async () => {
        let electrumClient: ElectrumClient

        before(async () => {
          electrumClient = new ElectrumClient([credentials])
        })

        describe("getNetwork", () => {
          it("should return proper network", async () => {
            const result = await electrumClient.getNetwork()
            expect(result).to.be.eql(BitcoinNetwork.Testnet)
          })
        })

        describe("findAllUnspentTransactionOutputs", () => {
          it("should return proper UTXOs for the given address", async () => {
            const result =
              await electrumClient.findAllUnspentTransactionOutputs(
                testnetAddress
              )
            expect(result).to.be.eql([testnetUTXO])
          })
        })

        describe("getTransactionHistory", () => {
          it("should return proper transaction history for the given address", async () => {
            // https://live.blockcypher.com/btc-testnet/address/tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx
            const transactions = await electrumClient.getTransactionHistory(
              "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
              5
            )

            const transactionsHashes = transactions.map((t) =>
              t.transactionHash.toString()
            )

            expect(transactionsHashes).to.be.eql([
              "3ca4ae3f8ee3b48949192bc7a146c8d9862267816258c85e02a44678364551e1",
              "f65bc5029251f0042aedb37f90dbb2bfb63a2e81694beef9cae5ec62e954c22e",
              "44863a79ce2b8fec9792403d5048506e50ffa7338191db0e6c30d3d3358ea2f6",
              "4c6b33b7c0550e0e536a5d119ac7189d71e1296fcb0c258e0c115356895bc0e6",
              "605edd75ae0b4fa7cfc7aae8f1399119e9d7ecc212e6253156b60d60f4925d44",
            ])
          })
        })

        describe("getTransaction", () => {
          it("should return proper transaction for the given hash", async () => {
            const result = await electrumClient.getTransaction(
              testnetTransaction.transactionHash
            )
            expect(result).to.be.eql(testnetTransaction)
          })

          it("should throw for unknown transaction hash", async function () {
            // Set custom timeout as the electrum server attempts to execute the
            // function several times.
            this.timeout(100000)
            const unknownTransaction = BitcoinTxHash.from(
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            )
            await expect(electrumClient.getTransaction(unknownTransaction)).to
              .be.rejected
          })
        })

        describe("getRawTransaction", () => {
          it("should return proper raw transaction for the given hash", async () => {
            const result = await electrumClient.getRawTransaction(
              testnetTransaction.transactionHash
            )
            expect(result).to.be.eql(testnetRawTransaction)
          })
        })

        describe("getTransactionConfirmations", () => {
          let result: number

          before(async () => {
            result = await electrumClient.getTransactionConfirmations(
              testnetTransaction.transactionHash
            )
          })

          it("should return value greater than 6", async () => {
            // Strict comparison is not possible as the number of confirmations
            // constantly grows. We just make sure it's 6+.
            expect(result).to.be.greaterThan(6)
          })

          // This test depends on `latestBlockHeight` function.
          it("should return proper confirmations number for the given hash", async () => {
            const latestBlockHeight = await electrumClient.latestBlockHeight()

            const expectedResult =
              latestBlockHeight - testnetTransactionMerkleBranch.blockHeight

            expect(result).to.be.closeTo(expectedResult, 3)
          })
        })

        describe("getTxHashesForPublicKeyHash", () => {
          let actualHashes: BitcoinTxHash[]

          before(async () => {
            actualHashes = await electrumClient.getTxHashesForPublicKeyHash(
              testnetPublicKeyHash
            )
          })

          it("should return proper transaction hashes", async () => {
            const expectedHashes = testnetTxHashes
            // If the actual hashes set is greater than the expected set, we
            // need to adjust them to the same length to make a comparison that
            // makes sense.
            if (actualHashes.length > expectedHashes.length) {
              actualHashes = actualHashes.slice(
                actualHashes.length - expectedHashes.length
              )
            }
            expect(actualHashes).to.be.deep.equal(expectedHashes)
          })
        })

        describe("latestBlockHeight", () => {
          let result: number

          before(async () => {
            result = await electrumClient.latestBlockHeight()
          })

          it("should return value greater than 6", async () => {
            // Strict comparison is not possible as the latest block height
            // constantly grows. We just make sure it's bigger than 0.
            expect(result).to.be.greaterThan(0)
          })

          // This test depends on fetching the expected latest block height from Blockstream API.
          // It can fail if Blockstream API is down or if Blockstream API or if
          // Electrum Server used in tests is out-of-sync with the Blockstream API.
          it("should return proper latest block height", async () => {
            const expectedResult = await getExpectedLatestBlockHeight()

            expect(result).to.be.closeTo(expectedResult, 3)
          })
        })

        describe("getHeadersChain", () => {
          it("should return proper headers chain", async () => {
            const result = await electrumClient.getHeadersChain(
              testnetHeadersChain.blockHeight,
              testnetHeadersChain.headersChainLength
            )
            expect(result).to.be.eql(testnetHeadersChain.headersChain)
          })
        })

        describe("getTransactionMerkle", () => {
          it("should return proper transaction merkle", async () => {
            const result = await electrumClient.getTransactionMerkle(
              testnetTransaction.transactionHash,
              testnetTransactionMerkleBranch.blockHeight
            )
            expect(result).to.be.eql(testnetTransactionMerkleBranch)
          })
        })

        describe("computeElectrumScriptHash", () => {
          it("should convert Bitcoin script to an Electrum script hash correctly", () => {
            const script = Hex.from(
              "00144b47c798d12edd17dfb4ea98e5447926f664731c"
            )
            const expectedScriptHash =
              "cabdea0bfc10fb3521721dde503487dd1f0e41dd6609da228066757563f292ab"

            expect(computeElectrumScriptHash(script)).to.be.equal(
              expectedScriptHash
            )
          })
        })

        describe("getCoinbaseTxHash", () => {
          it("should return proper coinbase tx hash", async () => {
            const result = await electrumClient.getCoinbaseTxHash(2135502)
            expect(result.toString()).to.be.equal(
              "1f523d1ce7553ec609bae104812dede95aa38eb13d2c2c6b64ffe868bbc1a54c"
            )
          })
        })
      })
    })

    describe("fallback connection", async () => {
      let electrumClient: ElectrumClient

      before(async () => {
        electrumClient = new ElectrumClient(
          [
            // Invalid server
            {
              host: "non-existing-host.local",
              port: 50001,
              protocol: "tcp",
            },
            // Valid server
            testnetCredentials[0],
          ],
          undefined,
          2,
          1000,
          2000
        )
      })

      it("should establish connection with a fallback server", async () => {
        const result = await electrumClient.getNetwork()
        expect(result).to.be.eql(BitcoinNetwork.Testnet)
      })
    })
  })
})

/**
 * Gets the height of the last block fetched from the Blockstream API.
 * @returns Height of the last block.
 */
function getExpectedLatestBlockHeight(): Promise<number> {
  return new Promise((resolve, reject) => {
    https
      .get(`${BLOCKSTREAM_TESTNET_API_URL}/blocks/tip/height`, (resp) => {
        let data = ""

        // A chunk of data has been received.
        resp.on("data", (chunk) => {
          data += chunk
        })

        // The whole response has been received. Print out the result.
        resp.on("end", () => {
          resolve(JSON.parse(data))
        })
      })
      .on("error", (err) => {
        reject(err)
      })
  })
}
