import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { ContractTransaction } from "ethers"
import type { SystemTestRelay, TestBitcoinTx } from "../../typechain"
import { assertGasUsed } from "../integration/utils/gas"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("BitcoinTx", () => {
  let relay: SystemTestRelay
  let bitcoinTx: TestBitcoinTx

  before(async () => {
    const SystemTestRelay = await ethers.getContractFactory("SystemTestRelay")
    relay = await SystemTestRelay.deploy()

    const TestBitcoinTx = await ethers.getContractFactory("TestBitcoinTx")
    bitcoinTx = await TestBitcoinTx.deploy(relay.address)
  })

  describe("validateProof", () => {
    context("when used with a valid but long proof", () => {
      let tx: ContractTransaction

      // Source: https://github.com/keep-network/bitcoin-spv/blob/releases/mainnet/solidity/v3.4.0-solc-0.8/testVectors.json#L910-L916
      const testData = {
        txInfo: {
          version: "0x01000000",
          inputVector:
            "0x011746bd867400f3494b8f44c24b83e1aa58c4f0ff25b4a61cffeffd4bc" +
            "0f9ba300000000000ffffffff",
          outputVector:
            "0x024897070000000000220020a4333e5612ab1a1043b25755c89b16d5518" +
            "4a42f81799e623e6bc39db8539c180000000000000000166a14edb1b5c2f3" +
            "9af0fec151732585b1049b07895211",
          locktime: "0x00000000",
        },
        proof: {
          merkleProof:
            "0xe35a0d6de94b656694589964a252957e4673a9fb1d2f8b4a92e3f0a7bb6" +
            "54fddb94e5a1e6d7f7f499fd1be5dd30a73bf5584bf137da5fdd77cc21aeb" +
            "95b9e35788894be019284bd4fbed6dd6118ac2cb6d26bc4be4e423f55a3a4" +
            "8f2874d8d02a65d9c87d07de21d4dfe7b0a9f4a23cc9a58373e9e6931fefd" +
            "b5afade5df54c91104048df1ee999240617984e18b6f931e2373673d0195b" +
            "8c6987d7ff7650d5ce53bcec46e13ab4f2da1146a7fc621ee672f62bc2274" +
            "2486392d75e55e67b09960c3386a0b49e75f1723d6ab28ac9a2028a0c7286" +
            "6e2111d79d4817b88e17c821937847768d92837bae3832bb8e5a4ab4434b9" +
            "7e00a6c10182f211f592409068d6f5652400d9a3d1cc150a7fb692e874cc4" +
            "2d76bdafc842f2fe0f835a7c24d2d60c109b187d64571efbaa8047be85821" +
            "f8e67e0e85f2f5894bc63d00c2ed9d64",
          txIndexInBlock: 281,
          bitcoinHeaders:
            "0x0000002073bd2184edd9c4fc76642ea6754ee40136970efc10c41900000" +
            "00000000000000296ef123ea96da5cf695f22bf7d94be87d49db1ad7ac371" +
            "ac43c4da4161c8c216349c5ba11928170d38782b00000020fe70e48339d6b" +
            "17fbbf1340d245338f57336e97767cc240000000000000000005af53b865c" +
            "27c6e9b5e5db4c3ea8e024f8329178a79ddb39f7727ea2fe6e6825d1349c5" +
            "ba1192817e2d9515900000020baaea6746f4c16ccb7cd961655b636d39b5f" +
            "e1519b8f15000000000000000000c63a8848a448a43c9e4402bd893f701cd" +
            "11856e14cbbe026699e8fdc445b35a8d93c9c5ba1192817b945dc6c000000" +
            "20f402c0b551b944665332466753f1eebb846a64ef24c7170000000000000" +
            "0000033fc68e070964e908d961cd11033896fa6c9b8b76f64a2db7ea928af" +
            "a7e304257d3f9c5ba11928176164145d0000ff3f63d40efa46403afd71a25" +
            "4b54f2b495b7b0164991c2d22000000000000000000f046dc1b71560b7d07" +
            "86cfbdb25ae320bd9644c98d5c7c77bf9df05cbe96212758419c5ba119281" +
            "7a2bb2caa00000020e2d4f0edd5edd80bdcb880535443747c6b22b48fb620" +
            "0d0000000000000000001d3799aa3eb8d18916f46bf2cf807cb89a9b1b4c5" +
            "6c3f2693711bf1064d9a32435429c5ba1192817752e49ae",
          coinbasePreimage:
            "0x77b98a5e6643973bba49dda18a75140306d2d8694b66f2dcb3561ad5aff" +
            "0b0c7",
          coinbaseProof:
            "0xdc20dadef477faab2852f2f8ae0c826aa7e05c4de0d36f0e63630429554" +
            "884c371da5974b6f34fa2c3536738f031b49f34e0c9d084d7280f26212e39" +
            "007ebe9ea0870c312745b58128a00a6557851e987ece02294d156f0020336" +
            "e158928e8964292642c6c4dc469f34b7bacf2d8c42115bab6afc9067f2ed3" +
            "0e8749729b63e0889e203ee58e355903c1e71f78c008df6c3597b2cc66d0b" +
            "8aae1a4a33caa775498e531cfb6af58e87db99e0f536dd226d18f43e38641" +
            "48ba5b7faca5c775f10bc810c602e1af2195a34577976921ce009a4ddc0a0" +
            "7f605c96b0f5fcf580831ebbe01a31fa29bde884609d286dccfa5ba8e558c" +
            "e3125bd4c3a19e888cf26852286202d2a7d302c75e0ff5ca8fe7299fb0d9d" +
            "1132bf2c56c2e3b73df799286193d60c109b187d64571efbaa8047be85821" +
            "f8e67e0e85f2f5894bc63d00c2ed9d64",
        },
        txHash:
          "0x48e5a1a0e616d8fd92b4ef228c424e0c816799a256c6a90892195ccfc53300d6",
      }

      before(async () => {
        await createSnapshot()

        await relay.setCurrentEpochDifficultyFromHeaders(
          testData.proof.bitcoinHeaders
        )

        tx = await bitcoinTx.validateProof(testData.txInfo, testData.proof)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should validate the proof with success", async () => {
        await expect(tx)
          .to.emit(bitcoinTx, "ProofValidated")
          .withArgs(
            "0x48e5a1a0e616d8fd92b4ef228c424e0c816799a256c6a90892195ccfc53300d6"
          )
      })

      it("should consume around 95000 gas", async () => {
        await assertGasUsed(tx, 95000, 1000)
      })
    })
  })

  describe("wallet output parsing", () => {
    const p2pkhHash = "0x1111111111111111111111111111111111111111"
    const p2wpkhHash = "0x2222222222222222222222222222222222222222"
    const xOnlyKey =
      "0x3333333333333333333333333333333333333333333333333333333333333333"

    const p2pkhOutput =
      "0x00000000000000001976a914111111111111111111111111111111111111111188ac"
    const p2wpkhOutput =
      "0x00000000000000001600142222222222222222222222222222222222222222"
    const p2trOutput =
      "0x00000000000000002251203333333333333333333333333333333333333333333333333333333333333333"

    it("extracts public key hash from P2PKH output", async () => {
      expect(await bitcoinTx.extractPubKeyHash(p2pkhOutput)).to.eq(p2pkhHash)
    })

    it("extracts public key hash from P2WPKH output", async () => {
      expect(await bitcoinTx.extractPubKeyHash(p2wpkhOutput)).to.eq(p2wpkhHash)
    })

    it("extracts wallet public key hash compatibility key from P2PKH output", async () => {
      expect(await bitcoinTx.extractWalletPubKeyHash(p2pkhOutput)).to.eq(
        p2pkhHash
      )
    })

    it("extracts wallet public key hash compatibility key from P2WPKH output", async () => {
      expect(await bitcoinTx.extractWalletPubKeyHash(p2wpkhOutput)).to.eq(
        p2wpkhHash
      )
    })

    it("rejects P2TR output when extracting wallet public key hash", async () => {
      await expect(bitcoinTx.extractPubKeyHash(p2trOutput)).to.be.revertedWith(
        "P2TR wallet outputs are not enabled"
      )
    })

    it("rejects P2TR output with unknown canonical wallet id", async () => {
      await expect(
        bitcoinTx.extractWalletPubKeyHash(p2trOutput)
      ).to.be.revertedWith("Unknown wallet ID")
    })

    it("extracts mapped wallet public key hash compatibility key from P2TR output", async () => {
      const mappedWalletPubKeyHash =
        await bitcoinTx.deriveWalletPubKeyHashFromXOnly(xOnlyKey)

      await bitcoinTx.setWalletPubKeyHashForWalletID(
        xOnlyKey,
        mappedWalletPubKeyHash
      )

      expect(await bitcoinTx.extractWalletPubKeyHash(p2trOutput)).to.eq(
        mappedWalletPubKeyHash
      )
    })

    it("extracts canonical wallet id from P2TR output", async () => {
      expect(await bitcoinTx.extractWalletID(p2trOutput)).to.eq(xOnlyKey)
    })

    it("extracts canonical wallet id from legacy output as left-padded bytes32", async () => {
      const expectedWalletID = ethers.utils.hexZeroPad(p2pkhHash, 32)

      expect(await bitcoinTx.extractWalletID(p2pkhOutput)).to.eq(
        expectedWalletID
      )
    })

    it("builds a proper P2TR script from x-only key", async () => {
      expect(await bitcoinTx.makeP2TRScript(xOnlyKey)).to.eq(
        `0x225120${xOnlyKey.substring(2)}`
      )
    })

    it("rejects malformed P2TR script", async () => {
      const malformedP2trOutput =
        "0x00000000000000002200203333333333333333333333333333333333333333333333333333333333333333"

      await expect(
        bitcoinTx.extractPubKeyHash(malformedP2trOutput)
      ).to.be.revertedWith("Invalid P2TR script")
    })
  })

  describe("extractStandardOutputScriptPayload", () => {
    const twentyByteHash = "0102030405060708090a0b0c0d0e0f1011121314"
    const thirtyTwoByteHash =
      "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

    it("extracts the 20-byte payload from a P2PKH script", async () => {
      const script = `0x1976a914${twentyByteHash}88ac`
      expect(await bitcoinTx.extractStandardOutputScriptPayload(script)).to.eq(
        `0x${twentyByteHash}`
      )
    })

    it("extracts the 20-byte payload from a P2WPKH script", async () => {
      const script = `0x160014${twentyByteHash}`
      expect(await bitcoinTx.extractStandardOutputScriptPayload(script)).to.eq(
        `0x${twentyByteHash}`
      )
    })

    it("extracts the 20-byte payload from a P2SH script", async () => {
      const script = `0x17a914${twentyByteHash}87`
      expect(await bitcoinTx.extractStandardOutputScriptPayload(script)).to.eq(
        `0x${twentyByteHash}`
      )
    })

    it("extracts the 32-byte payload from a P2WSH script", async () => {
      const script = `0x220020${thirtyTwoByteHash}`
      expect(await bitcoinTx.extractStandardOutputScriptPayload(script)).to.eq(
        `0x${thirtyTwoByteHash}`
      )
    })

    it("extracts the 32-byte x-only output key from a P2TR script", async () => {
      const script = `0x225120${thirtyTwoByteHash}`
      expect(await bitcoinTx.extractStandardOutputScriptPayload(script)).to.eq(
        `0x${thirtyTwoByteHash}`
      )
    })

    it("returns empty bytes for an OP_RETURN-style non-standard script", async () => {
      const opReturnScript = "0x046a02deadbeef"
      expect(
        await bitcoinTx.extractStandardOutputScriptPayload(opReturnScript)
      ).to.eq("0x")
    })

    it("returns empty bytes for a too-short script", async () => {
      const tooShort = "0x1976a9"
      expect(
        await bitcoinTx.extractStandardOutputScriptPayload(tooShort)
      ).to.eq("0x")
    })

    it("returns empty bytes for a P2PKH-length script that lacks the P2PKH prefix", async () => {
      // 26 bytes total (the P2PKH length) but the first three bytes are
      // 0xdeadbeef-style padding instead of the 0x1976a9 P2PKH prefix.
      const malformed = `0xdeadbeef14${twentyByteHash}88ac`
      expect(
        await bitcoinTx.extractStandardOutputScriptPayload(malformed)
      ).to.eq("0x")
    })
  })
})
