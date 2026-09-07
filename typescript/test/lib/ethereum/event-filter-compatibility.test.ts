import { expect } from "chai"
import { zeroAddress, type Abi } from "viem"
import { EthereumBridge } from "../../../src/lib/ethereum/bridge"
import { EthereumTBTCVault } from "../../../src/lib/ethereum/tbtc-vault"
import { Chains } from "../../../src/lib/contracts"
import BridgeDeployment from "../../../src/lib/ethereum/artifacts/mainnet/Bridge.json"
import VaultDeployment from "../../../src/lib/ethereum/artifacts/mainnet/TBTCVault.json"
import { MockEvm } from "../../utils/mock-evm"

describe("event filter compatibility", () => {
  const address = "0x8888888888888888888888888888888888888888"
  const depositor = "0x1111111111111111111111111111111111111111"
  const wallet = "0x2222222222222222222222222222222222222222"
  const other = "0x3333333333333333333333333333333333333333"

  for (const { name, filter, expected } of [
    { name: "a hex deposit key", filter: "0x2a", expected: ["0x2a"] },
    { name: "a bigint deposit key", filter: 42n, expected: ["0x2a"] },
    {
      name: "an OR list of hex deposit keys",
      filter: ["0x2a", "0x2b"],
      expected: ["0x2a", "0x2b"],
    },
  ]) {
    it(`should accept the minting monitor's six-position filter with ${name}`, async () => {
      const mock = new MockEvm()
      const vault = new EthereumTBTCVault(
        { address, signerOrProvider: mock, deployedAtBlockNumber: 0 },
        Chains.Ethereum.Mainnet
      )
      mock.stubLogs(
        address,
        VaultDeployment.abi as Abi,
        "OptimisticMintingRequested",
        [42n, 43n].map((depositKey) => ({
          blockNumber: 5,
          args: {
            minter: other,
            depositKey,
            depositor,
            amount: 10000n,
            fundingTxHash: `0x${"44".repeat(32)}`,
            fundingOutputIndex: 0,
          },
        }))
      )

      const events = await vault.getOptimisticMintingRequestedEvents(
        { retries: 0 },
        null,
        filter,
        null,
        null,
        null,
        null
      )

      expect(
        events.map((event) => event.depositKey.toPrefixedString())
      ).to.deep.equal(expected)
      expect(events[0].minter.identifierHex).to.equal(other.slice(2))
    })
  }

  it("should preserve depositor and wallet positions in DepositRevealed", async () => {
    const mock = new MockEvm()
    const bridge = new EthereumBridge(
      { address, signerOrProvider: mock, deployedAtBlockNumber: 0 },
      Chains.Ethereum.Mainnet
    )
    mock.stubLogs(
      address,
      BridgeDeployment.abi as Abi,
      "DepositRevealed",
      [
        { depositor, walletPubKeyHash: other },
        { depositor: other, walletPubKeyHash: wallet },
        { depositor, walletPubKeyHash: wallet },
      ].map((indexed, index) => ({
        blockNumber: 5 + index,
        args: {
          ...indexed,
          fundingTxHash: `0x${"44".repeat(32)}`,
          fundingOutputIndex: index,
          amount: 10000n,
          blindingFactor: `0x${"55".repeat(8)}`,
          refundPubKeyHash: other,
          refundLocktime: "0x01020304",
          vault: zeroAddress,
        },
      }))
    )

    const events = await bridge.getDepositRevealedEvents(
      { retries: 0 },
      null,
      null,
      depositor,
      null,
      null,
      wallet
    )

    expect(events).to.have.lengthOf(1)
    expect(events[0].blockNumber).to.equal(7)
    expect(events[0].depositor.identifierHex).to.equal(depositor.slice(2))
    expect(events[0].walletPublicKeyHash.toPrefixedString()).to.equal(wallet)
  })
})
