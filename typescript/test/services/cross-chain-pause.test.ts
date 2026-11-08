import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import sinon from "sinon"
import { BigNumber } from "ethers"
import {
  CrossChainDepositor,
  CrossChainDepositorMode,
  CrossChainInterfaces,
  BitcoinNetwork,
  Deposit,
  DepositFunding,
  DepositReceipt,
  DepositRefund,
  DepositScript,
  DepositsService,
  DestinationChainName,
  EthereumAddress,
  extractBitcoinRawTxVectors,
  Hex,
  RedemptionsService,
} from "../../src"
import { EthereumL1BitcoinDepositor } from "../../src/lib/ethereum/l1-bitcoin-depositor"
import { EthereumBridge } from "../../src/lib/ethereum/bridge"
import { EthereumL1BitcoinRedeemer } from "../../src/lib/ethereum/l1-bitcoin-redeemer"
import { ArbitrumBitcoinDepositor } from "../../src/lib/arbitrum/l2-bitcoin-depositor"
import { ArbitrumL2BitcoinRedeemer } from "../../src/lib/arbitrum/l2-bitcoin-redeemer"
import { BaseBitcoinDepositor } from "../../src/lib/base/l2-bitcoin-depositor"
import { BaseL2BitcoinRedeemer } from "../../src/lib/base/l2-bitcoin-redeemer"
import { SuiBitcoinDepositor } from "../../src/lib/sui/bitcoin-depositor"
import { StarkNetBitcoinDepositor } from "../../src/lib/starknet/starknet-depositor"
import { SolanaDepositorInterface } from "../../src/lib/solana/solana-depositor-interface"
import { depositRefundOfWitnessDepositAndWitnessRefunderAddress } from "../data/deposit-refund"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { MockDepositorProxy } from "../utils/mock-depositor-proxy"
import {
  MockBitcoinDepositor,
  MockCrossChainExtraDataEncoder,
  MockDestinationChainTBTCToken,
  MockL1BitcoinDepositor,
  MockL1BitcoinRedeemer,
} from "../utils/mock-cross-chain"

chai.use(chaiAsPromised)

describe("temporary cross-chain pause", () => {
  const paused = "Cross-chain deposits and redemptions are temporarily paused"
  const chains: DestinationChainName[] = [
    "Arbitrum",
    "Base",
    "StarkNet",
    "Sui",
    "Solana",
  ]
  const funded = depositRefundOfWitnessDepositAndWitnessRefunderAddress.deposit
  const receipt: DepositReceipt = {
    ...funded.data,
    extraData: Hex.from("11".repeat(32)),
  }
  const depositTx = extractBitcoinRawTxVectors(funded.utxo)
  let bitcoinClient: MockBitcoinClient
  let tbtcContracts: MockTBTCContracts
  let crossChainContracts: CrossChainInterfaces

  beforeEach(() => {
    bitcoinClient = new MockBitcoinClient()
    tbtcContracts = new MockTBTCContracts()
    crossChainContracts = {
      l1BitcoinDepositor: new MockL1BitcoinDepositor(
        receipt.depositor,
        new MockCrossChainExtraDataEncoder()
      ),
      destinationChainBitcoinDepositor: new MockBitcoinDepositor(
        EthereumAddress.from("22".repeat(20)),
        new MockCrossChainExtraDataEncoder()
      ),
      destinationChainTbtcToken: new MockDestinationChainTBTCToken(),
      l1BitcoinRedeemer: new MockL1BitcoinRedeemer(
        EthereumAddress.from("33".repeat(20))
      ),
    }
  })

  afterEach(() => sinon.restore())

  for (const chain of chains) {
    it(`rejects new ${chain} deposit receipts before resolving contracts or Bitcoin data`, async () => {
      const resolveContracts = sinon.stub().returns(crossChainContracts)
      const bitcoinNetwork = sinon.spy(bitcoinClient, "getNetwork")
      const activeWallet = sinon.spy(
        tbtcContracts.bridge,
        "activeWalletPublicKey"
      )
      const service = new DepositsService(
        tbtcContracts,
        bitcoinClient,
        resolveContracts
      )

      await expect(
        service.initiateCrossChainDeposit("invalid recovery address", chain)
      ).to.be.rejectedWith(paused)

      expect(resolveContracts.called).to.be.false
      expect(bitcoinNetwork.called).to.be.false
      expect(activeWallet.called).to.be.false
    })

    it(`rejects ${chain} redemption and relay requests before resolving contracts`, async () => {
      const resolveContracts = sinon
        .stub()
        .throws(new Error("must not resolve"))
      const service = new RedemptionsService(
        tbtcContracts,
        bitcoinClient,
        resolveContracts
      )

      await expect(
        service.requestCrossChainRedemption(
          "invalid address",
          BigNumber.from(1),
          chain
        )
      ).to.be.rejectedWith(paused)
      await expect(
        service.relayRedemptionRequestToL1(BigNumber.from(1), "0x", chain, "00")
      ).to.be.rejectedWith(paused)
      expect(resolveContracts.called).to.be.false
    })
  }

  it("rejects a built-in cross-chain proxy passed through the generic deposit API", async () => {
    const proxy = new CrossChainDepositor(crossChainContracts)
    const identifier = sinon.spy(proxy, "getChainIdentifier")
    const activeWallet = sinon.spy(
      tbtcContracts.bridge,
      "activeWalletPublicKey"
    )
    const service = new DepositsService(tbtcContracts, bitcoinClient)

    await expect(
      service.initiateDepositWithProxy(
        "invalid recovery address",
        proxy,
        receipt.extraData
      )
    ).to.be.rejectedWith(paused)
    expect(identifier.called).to.be.false
    expect(activeWallet.called).to.be.false
  })

  it("rejects new metadata-bearing receipts through either generic deposit API", async () => {
    const service = new DepositsService(tbtcContracts, bitcoinClient)
    service.setDefaultDepositor(receipt.depositor)
    const proxy = new MockDepositorProxy()
    const identifier = sinon.spy(proxy, "getChainIdentifier")
    const activeWallet = sinon.spy(
      tbtcContracts.bridge,
      "activeWalletPublicKey"
    )
    const bitcoinNetwork = sinon.spy(bitcoinClient, "getNetwork")

    await expect(
      service.initiateDeposit("invalid recovery address", receipt.extraData)
    ).to.be.rejectedWith(paused)
    await expect(
      service.initiateDepositWithProxy(
        "invalid recovery address",
        proxy,
        receipt.extraData
      )
    ).to.be.rejectedWith(paused)
    expect(identifier.called).to.be.false
    expect(activeWallet.called).to.be.false
    expect(bitcoinNetwork.called).to.be.false
  })

  for (const useProxy of [false, true]) {
    it(`blocks a restored metadata-bearing deposit ${
      useProxy ? "with a plain proxy" : "without a proxy"
    }`, async () => {
      const proxy = useProxy ? new MockDepositorProxy() : undefined
      const deposit = await Deposit.fromReceipt(
        receipt,
        tbtcContracts,
        bitcoinClient,
        proxy
      )
      const fundingLookup = sinon.spy(
        bitcoinClient,
        "findAllUnspentTransactionOutputs"
      )
      const rawTransaction = sinon.spy(bitcoinClient, "getRawTransaction")

      await expect(deposit.initiateMinting()).to.be.rejectedWith(paused)
      await expect(deposit.initiateMinting(funded.utxo)).to.be.rejectedWith(
        paused
      )
      expect(fundingLookup.called).to.be.false
      expect(rawTransaction.called).to.be.false
      expect(tbtcContracts.bridge.revealDepositLog).to.be.empty
      if (proxy) expect(proxy.revealDepositLog).to.be.empty
    })
  }

  it("blocks funding a saved cross-chain script before reading UTXOs, signing, or broadcasting", async () => {
    const funding = DepositFunding.fromScript(
      DepositScript.fromReceipt(receipt)
    )
    const rawTransaction = sinon.spy(bitcoinClient, "getRawTransaction")
    const bitcoinNetwork = sinon.spy(bitcoinClient, "getNetwork")
    const broadcast = sinon.spy(bitcoinClient, "broadcast")

    await expect(
      funding.assembleTransaction(
        BitcoinNetwork.Testnet,
        BigNumber.from(1),
        [],
        BigNumber.from(1),
        "invalid-key"
      )
    ).to.be.rejectedWith(paused)
    await expect(
      funding.submitTransaction(
        BigNumber.from(1),
        [funded.utxo],
        BigNumber.from(1),
        "invalid-key",
        bitcoinClient
      )
    ).to.be.rejectedWith(paused)
    expect(rawTransaction.called).to.be.false
    expect(bitcoinNetwork.called).to.be.false
    expect(broadcast.called).to.be.false
  })

  it("blocks a direct Bridge reveal of cross-chain receipt metadata", async () => {
    const bridge = Object.create(EthereumBridge.prototype) as EthereumBridge
    await expect(
      bridge.revealDeposit(depositTx, 0, receipt)
    ).to.be.rejectedWith(paused)
  })

  for (const mode of [
    "L1Transaction",
    "L2Transaction",
  ] as CrossChainDepositorMode[]) {
    it(`blocks saved cross-chain mint submissions and direct reveals in ${mode} mode`, async () => {
      const proxy = new CrossChainDepositor(crossChainContracts, mode)
      const deposit = await Deposit.fromReceipt(
        receipt,
        tbtcContracts,
        bitcoinClient,
        proxy
      )
      const fundingLookup = sinon.spy(
        bitcoinClient,
        "findAllUnspentTransactionOutputs"
      )
      const rawTransaction = sinon.spy(bitcoinClient, "getRawTransaction")
      const l1Initialize = sinon.spy(
        crossChainContracts.l1BitcoinDepositor,
        "initializeDeposit"
      )
      const l2Initialize = sinon.spy(
        crossChainContracts.destinationChainBitcoinDepositor,
        "initializeDeposit"
      )

      await expect(deposit.initiateMinting()).to.be.rejectedWith(paused)
      await expect(deposit.initiateMinting(funded.utxo)).to.be.rejectedWith(
        paused
      )
      await expect(
        proxy.revealDeposit(depositTx, 0, receipt)
      ).to.be.rejectedWith(paused)

      expect(fundingLookup.called).to.be.false
      expect(rawTransaction.called).to.be.false
      expect(l1Initialize.called).to.be.false
      expect(l2Initialize.called).to.be.false
    })
  }

  it("preserves receipt inspection, funding monitoring and refund construction", async () => {
    const proxy = new CrossChainDepositor(crossChainContracts)
    const deposit = await Deposit.fromReceipt(
      receipt,
      tbtcContracts,
      bitcoinClient,
      proxy
    )
    const address = await deposit.getBitcoinAddress()
    bitcoinClient.unspentTransactionOutputs = new Map([
      [address, [funded.utxo]],
    ])

    expect(deposit.getReceipt()).to.deep.equal(receipt)
    expect(address).to.be.a("string").and.not.empty
    expect(await deposit.detectFunding()).to.deep.equal([funded.utxo])
    expect(
      DepositRefund.fromScript(DepositScript.fromReceipt(receipt))
    ).to.be.instanceOf(DepositRefund)
  })

  for (const useProxy of [false, true]) {
    it(`preserves new L1 deposit receipts ${
      useProxy ? "through a custom L1 proxy" : "directly"
    }`, async () => {
      const service = new DepositsService(tbtcContracts, bitcoinClient)
      service.setDefaultDepositor(funded.data.depositor)
      tbtcContracts.bridge.setActiveWalletPublicKey(
        Hex.from(
          "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
        )
      )
      const recoveryAddress =
        depositRefundOfWitnessDepositAndWitnessRefunderAddress.refunderAddress
      const proxy = new MockDepositorProxy()

      const deposit = useProxy
        ? await service.initiateDepositWithProxy(recoveryAddress, proxy)
        : await service.initiateDeposit(recoveryAddress)

      expect(deposit.getReceipt().extraData).to.be.undefined
      expect(deposit.getReceipt().depositor).to.deep.equal(
        useProxy ? proxy.getChainIdentifier() : funded.data.depositor
      )
      expect(await deposit.getBitcoinAddress()).to.be.a("string").and.not.empty
    })

    it(`preserves L1 minting ${
      useProxy ? "through a custom L1 proxy" : "directly"
    }`, async () => {
      const proxy = useProxy ? new MockDepositorProxy() : undefined
      const deposit = await Deposit.fromReceipt(
        funded.data,
        tbtcContracts,
        bitcoinClient,
        proxy
      )
      bitcoinClient.rawTransactions = new Map([
        [funded.utxo.transactionHash.toString(), funded.utxo],
      ])

      await deposit.initiateMinting(funded.utxo)

      expect(
        proxy
          ? proxy.revealDepositLog.length
          : tbtcContracts.bridge.revealDepositLog.length
      ).to.equal(1)
    })
  }

  const depositAdapters = [
    EthereumL1BitcoinDepositor,
    ArbitrumBitcoinDepositor,
    BaseBitcoinDepositor,
    SuiBitcoinDepositor,
    StarkNetBitcoinDepositor,
    SolanaDepositorInterface,
  ]
  for (const Adapter of depositAdapters) {
    it(`blocks direct ${Adapter.name} writes before accessing a signer or transport`, async () => {
      // No adapter internals or signer are initialized. The pause must reject
      // before reading them, including the off-chain relayer transports.
      const adapter = Object.create(Adapter.prototype) as InstanceType<
        typeof Adapter
      >
      await expect(
        adapter.initializeDeposit(depositTx, 0, receipt)
      ).to.be.rejectedWith(paused)
    })
  }

  for (const Adapter of [ArbitrumL2BitcoinRedeemer, BaseL2BitcoinRedeemer]) {
    it(`blocks direct ${Adapter.name} redemption requests before signer access`, async () => {
      const adapter = Object.create(Adapter.prototype) as InstanceType<
        typeof Adapter
      >
      await expect(
        adapter.requestRedemption(BigNumber.from(1), Hex.from("00"), 1)
      ).to.be.rejectedWith(paused)
    })
  }

  it("blocks direct L1 cross-chain redemption relay before signer access", async () => {
    const adapter = Object.create(
      EthereumL1BitcoinRedeemer.prototype
    ) as EthereumL1BitcoinRedeemer
    await expect(
      adapter.requestRedemption(Hex.from("00"), funded.utxo, "0x")
    ).to.be.rejectedWith(paused)
  })
})
