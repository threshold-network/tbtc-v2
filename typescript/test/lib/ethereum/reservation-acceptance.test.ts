import { expect } from "chai"
import { MockProvider } from "@ethereum-waffle/provider"
import { deployMockContract } from "@ethereum-waffle/mock-contract"
import { Interface } from "@ethersproject/abi"
import { abi as BridgeABI } from "@keep-network/tbtc-v2/artifacts/Bridge.json"
import { EthereumReservations, Hex } from "../../../src/core"
import { BitcoinRawTxVectors, BitcoinSpvProof } from "../../../src/lib/bitcoin"
import { reservationBridgeAbiFragments } from "../../../src/lib/ethereum/artifacts/reservation-bridge-fragments"

import type { MockContract } from "@ethereum-waffle/mock-contract"

// Selector of the compiled ReservationRouter function
// `requestReservationAcceptance(BitcoinTx.Info,BitcoinTx.Proof,uint32,bytes20)`.
// It is the router's selector from the compiled artifact, not a value derived
// from the SDK fragment, so an SDK fragment left on an older signature fails.
const ROUTER_ACCEPTANCE_SELECTOR = "0x19821f16"

describe("Ethereum reservation acceptance request", function () {
  this.timeout(20000)
  const [signer] = new MockProvider().getWallets()
  const wallet = Hex.from("11".repeat(20))

  const fundingTx: BitcoinRawTxVectors = {
    version: Hex.from("01000000"),
    inputs: Hex.from(
      "0101010101010101010101010101010101010101010101010101010101010101010000000000ffffffff"
    ),
    outputs: Hex.from("01e803000000000000160014" + "22".repeat(20)),
    locktime: Hex.from("00000000"),
  }
  const fundingProof: BitcoinSpvProof = {
    merkleProof: Hex.from("aa".repeat(64)),
    txIndexInBlock: 3,
    bitcoinHeaders: Hex.from("bb".repeat(160)),
    coinbasePreimage: Hex.from("cc".repeat(32)),
    coinbaseProof: Hex.from("dd".repeat(32)),
  }

  it("uses the selector of the compiled router function", () => {
    const iface = new Interface([
      ...BridgeABI,
      ...reservationBridgeAbiFragments,
    ])

    expect(iface.getSighash("requestReservationAcceptance")).to.equal(
      ROUTER_ACCEPTANCE_SELECTOR
    )
  })

  context("when the Bridge handle sends the request", () => {
    let contract: MockContract
    let handle: EthereumReservations

    beforeEach(async () => {
      contract = await deployMockContract(
        signer,
        JSON.stringify([...BridgeABI, ...reservationBridgeAbiFragments])
      )
      handle = new EthereumReservations({
        address: contract.address,
        signerOrProvider: signer,
      })
    })

    it("encodes the funding transaction, the proof, the output index and the wallet", async () => {
      // The mock reverts for any calldata other than the exact encoding
      // below, so this fails if the adapter passes a field wrongly.
      await contract.mock.requestReservationAcceptance
        .withArgs(
          {
            version: "0x01000000",
            inputVector: `0x${fundingTx.inputs.toString()}`,
            outputVector: `0x${fundingTx.outputs.toString()}`,
            locktime: "0x00000000",
          },
          {
            merkleProof: `0x${"aa".repeat(64)}`,
            txIndexInBlock: 3,
            bitcoinHeaders: `0x${"bb".repeat(160)}`,
            coinbasePreimage: `0x${"cc".repeat(32)}`,
            coinbaseProof: `0x${"dd".repeat(32)}`,
          },
          7,
          `0x${wallet.toString()}`
        )
        .returns()

      const txHash = await handle.requestReservationAcceptance(
        fundingTx,
        fundingProof,
        7,
        wallet
      )

      expect(txHash.toPrefixedString()).to.match(/^0x[0-9a-f]{64}$/)
    })
  })
})
