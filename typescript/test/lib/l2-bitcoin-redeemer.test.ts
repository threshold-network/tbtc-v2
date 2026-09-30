import { expect } from "chai"
import { stub } from "sinon"
import type { Address } from "viem"
import { BaseL2BitcoinRedeemer } from "../../src/lib/base/l2-bitcoin-redeemer"
import { ArbitrumL2BitcoinRedeemer } from "../../src/lib/arbitrum/l2-bitcoin-redeemer"
import { asDeployment } from "../../src/lib/ethereum/adapter"
import type { EthereumSigner } from "../../src/lib/ethereum/evm-connection"
import { Chains } from "../../src/lib/contracts"
import { Hex } from "../../src/lib/utils"
import { expectContractWrite, MockEvm } from "../utils/mock-evm"
import BaseRedeemer from "../../src/lib/base/artifacts/base/BaseL2BitcoinRedeemer.json"
import BaseWormhole from "../../src/lib/base/artifacts/base/WormholeCore.json"
import ArbitrumRedeemer from "../../src/lib/arbitrum/artifacts/arbitrumOne/ArbitrumL2BitcoinRedeemer.json"
import ArbitrumWormhole from "../../src/lib/arbitrum/artifacts/arbitrumOne/WormholeCore.json"

const networks = [
  {
    name: "Base",
    chainId: Chains.Base.Base,
    deployment: asDeployment(BaseRedeemer),
    wormhole: asDeployment(BaseWormhole),
    create: (signer: EthereumSigner) =>
      new BaseL2BitcoinRedeemer({ signerOrProvider: signer }, Chains.Base.Base),
  },
  {
    name: "Arbitrum",
    chainId: Chains.Arbitrum.Arbitrum,
    deployment: asDeployment(ArbitrumRedeemer),
    wormhole: asDeployment(ArbitrumWormhole),
    create: (signer: EthereumSigner) =>
      new ArbitrumL2BitcoinRedeemer(
        { signerOrProvider: signer },
        Chains.Arbitrum.Arbitrum
      ),
  },
]

for (const network of networks) {
  describe(`${network.name} L2 redemption submission`, () => {
    const amount = 1000n
    const script = Hex.from(`0014${"11".repeat(20)}`)
    const wormholeNonce = 7
    const messageFee = 123n
    const expectedArgs = [
      amount,
      2,
      `0x160014${"11".repeat(20)}`,
      wormholeNonce,
    ]
    let mock: MockEvm

    beforeEach(() => {
      mock = new MockEvm()
      mock.chainId = Number(network.chainId)
      mock.stubRead(
        network.wormhole.address as Address,
        network.wormhole.abi,
        "messageFee",
        [],
        messageFee
      )
      mock.stubRead(
        network.deployment.address as Address,
        network.deployment.abi,
        "requestRedemption",
        expectedArgs,
        1n
      )
    })

    it("should submit once with the Wormhole fee and redemption arguments", async () => {
      const redeemer = network.create(mock.asSigner())

      const hash = await redeemer.requestRedemption(
        amount,
        script,
        wormholeNonce
      )

      expect(hash.toPrefixedString()).to.match(/^0x[0-9a-f]{64}$/)
      expect(mock.sentTransactions).to.have.lengthOf(1)
      expect(BigInt(mock.sentTransactions[0].value!)).to.equal(messageFee)
      expectContractWrite(
        mock,
        network.deployment.address as Address,
        network.deployment.abi,
        "requestRedemption",
        expectedArgs
      )
    })

    it("should not resubmit when a transaction response is lost", async () => {
      const request = mock.request
      stub(mock, "request").callsFake(async (args) => {
        const result = await request(args)
        if (args.method === "eth_sendTransaction") {
          throw new Error("Transaction response unavailable")
        }
        return result
      })
      const redeemer = network.create(mock.asSigner())

      const error = await redeemer
        .requestRedemption(amount, script, wormholeNonce)
        .catch((error: unknown) => error)

      expect(error).to.be.instanceOf(Error)
      expect((error as Error).message).to.include(
        "Transaction response unavailable"
      )
      expect(mock.sentTransactions).to.have.lengthOf(1)
    }).timeout(15000)
  })
}
