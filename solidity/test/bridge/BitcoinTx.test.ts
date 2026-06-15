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

  describe("determineRequestedDifficulty", () => {
    // 80-byte header with nBits = 0x1d00ffff (DIFF1 / minimum difficulty).
    // Bytes 72-75 in LE = ff ff 00 1d.  calculateDifficulty() returns 1.
    const DIFF1_HEADER = `0x${"00".repeat(72)}ffff001d00000000`

    // First 80 bytes of the mainnet headers used in the validateProof test
    // above.  nBits LE = a1 19 28 17 -> difficulty 7019199231177.
    const NORMAL_HEADER =
      "0x" +
      "0000002073bd2184edd9c4fc76642ea6754ee401" +
      "36970efc10c4190000000000000000000296ef12" +
      "3ea96da5cf695f22bf7d94be87d49db1ad7ac371" +
      "ac43c4da4161c8c216349c5ba11928170d38782b"

    const NORMAL_DIFFICULTY = 7019199231177

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callDetermineRequestedDifficulty = (
      headers: string,
      currentDiff: number | bigint,
      prevDiff: number | bigint
    ) =>
      // callStatic because the function is pure
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (bitcoinTx as any).callStatic.exposeDetermineRequestedDifficulty(
        headers,
        currentDiff,
        prevDiff
      )

    context("when a header matches the current epoch difficulty", () => {
      it("returns the current epoch difficulty", async () => {
        const result = await callDetermineRequestedDifficulty(
          NORMAL_HEADER,
          NORMAL_DIFFICULTY,
          NORMAL_DIFFICULTY
        )
        expect(result).to.equal(NORMAL_DIFFICULTY)
      })
    })

    context("when a header matches the previous epoch difficulty", () => {
      it("returns the previous epoch difficulty", async () => {
        const result = await callDetermineRequestedDifficulty(
          NORMAL_HEADER,
          999999, // current does not match
          NORMAL_DIFFICULTY // prev matches
        )
        expect(result).to.equal(NORMAL_DIFFICULTY)
      })
    })

    context(
      "when current and previous epoch difficulties differ and DIFF1 skip is asymmetric",
      () => {
        it("does not skip a leading DIFF1 when previous difficulty is 1 (binds to previous)", async () => {
          const twoHeaders = DIFF1_HEADER.slice(2) + NORMAL_HEADER.slice(2)
          const result = await callDetermineRequestedDifficulty(
            `0x${twoHeaders}`,
            NORMAL_DIFFICULTY,
            1
          )
          expect(result).to.equal(1)
        })

        it("does not skip a leading DIFF1 when current difficulty is 1 (binds to current)", async () => {
          const result = await callDetermineRequestedDifficulty(
            DIFF1_HEADER,
            1,
            NORMAL_DIFFICULTY
          )
          expect(result).to.equal(1)
        })
      }
    )

    context("when a DIFF1 header is first and epoch difficulty is 1", () => {
      // When the relay epoch is minimum difficulty (1), DIFF1 headers are
      // not skipped and must be accepted directly by matching epoch = 1.
      it("returns 1 without skipping the DIFF1 header", async () => {
        const result = await callDetermineRequestedDifficulty(
          DIFF1_HEADER,
          1,
          1
        )
        expect(result).to.equal(1)
      })
    })

    context(
      "when a DIFF1 header precedes a normal header and epoch difficulty is above 1",
      () => {
        // The DIFF1 header must be skipped; the subsequent normal header
        // provides the SPV difficulty baseline.
        it("skips the DIFF1 header and returns the epoch difficulty", async () => {
          const twoHeaders = DIFF1_HEADER.slice(2) + NORMAL_HEADER.slice(2)
          const result = await callDetermineRequestedDifficulty(
            `0x${twoHeaders}`,
            NORMAL_DIFFICULTY,
            NORMAL_DIFFICULTY
          )
          expect(result).to.equal(NORMAL_DIFFICULTY)
        })
      }
    )

    context(
      "when all headers are DIFF1 and epoch difficulty is above 1",
      () => {
        // All headers are skipped; the function must revert because no header
        // can be used as the SPV difficulty baseline.
        it("reverts", async () => {
          const twoHeaders = DIFF1_HEADER.slice(2) + DIFF1_HEADER.slice(2)
          await expect(
            callDetermineRequestedDifficulty(
              `0x${twoHeaders}`,
              NORMAL_DIFFICULTY,
              NORMAL_DIFFICULTY
            )
          ).to.be.revertedWith("Not at current or previous difficulty")
        })
      }
    )

    context("when no header matches any epoch difficulty", () => {
      it("reverts", async () => {
        await expect(
          callDetermineRequestedDifficulty(NORMAL_HEADER, 9999, 8888)
        ).to.be.revertedWith("Not at current or previous difficulty")
      })
    })

    context("when the headers input is empty", () => {
      it("reverts", async () => {
        await expect(
          callDetermineRequestedDifficulty(
            "0x",
            NORMAL_DIFFICULTY,
            NORMAL_DIFFICULTY
          )
        ).to.be.revertedWith("Not at current or previous difficulty")
      })
    })

    context("when the headers input length is not a multiple of 80", () => {
      // The structural length check must run before the scan so a malformed
      // proof reverts with an explicit message rather than a low-level
      // out-of-bounds panic from reading a partial trailing header.
      it("reverts with an invalid length error", async () => {
        // A full 80-byte header followed by a 20-byte partial header.
        const malformed = NORMAL_HEADER + "00".repeat(20)
        await expect(
          callDetermineRequestedDifficulty(
            malformed,
            NORMAL_DIFFICULTY,
            NORMAL_DIFFICULTY
          )
        ).to.be.revertedWith("Invalid length of the headers chain")
      })
    })
  })
})
