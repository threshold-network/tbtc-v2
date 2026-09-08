/* eslint-disable @typescript-eslint/no-extra-semi */
import hre, { ethers } from "hardhat"
import { expect } from "chai"

import type { ContractTransaction } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type { Mock } from "../helpers/mock"
import type { Bridge, IRandomBeacon, WalletRegistry } from "../../typechain"

import {
  performEcdsaDkg,
  updateWalletRegistryDkgResultChallengePeriodLength,
} from "./utils/ecdsa-wallet-registry"
import { ecdsaWalletTestData } from "../data/ecdsa"
import { produceRelayEntry } from "./utils/fake-random-beacon"

import { assertGasUsed } from "./utils/gas"
import { fixture } from "./utils/fixture"
import { walletState } from "../fixtures"

const NO_MAIN_UTXO = {
  txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  txOutputIndex: 0,
  txOutputValue: 0,
}

const describeFn =
  process.env.NODE_ENV === "integration-test" ? describe : describe.skip

describeFn("Integration Test - Wallet Creation", async () => {
  let bridge: Bridge
  let walletRegistry: WalletRegistry
  let randomBeacon: Mock<IRandomBeacon>
  let governance: SignerWithAddress

  const dkgResultChallengePeriodLength = 10

  // TODO: Generate a random public key
  const walletPublicKey = ecdsaWalletTestData.publicKey
  const { walletID } = ecdsaWalletTestData
  const walletPubKeyHash = ecdsaWalletTestData.pubKeyHash160

  before(async () => {
    ;({ governance, bridge, walletRegistry, randomBeacon } = await fixture())

    // Update only the parameters that are crucial for this test.
    await updateWalletRegistryDkgResultChallengePeriodLength(
      hre,
      walletRegistry,
      governance,
      dkgResultChallengePeriodLength
    )
  })

  describe("new wallet creation (happy path)", async () => {
    let requestNewWalletTx: ContractTransaction
    let walletRegistrationTx: ContractTransaction

    before(async () => {
      expect(await bridge.activeWalletPubKeyHash()).to.be.equal(
        ethers.constants.AddressZero
      )

      // `requestNewWallet` reaches the beacon, and this suite asserts on the
      // gas it costs. Recording a call SSTOREs its calldata, which smock did
      // not have to pay for, so leaving it on measures the mock rather than
      // the Bridge — it is worth ~130k here. Nothing below inspects the
      // beacon's calls.
      await randomBeacon.setRecording(false)

      requestNewWalletTx = await bridge.requestNewWallet(NO_MAIN_UTXO)
      const startBlock = requestNewWalletTx.blockNumber

      await produceRelayEntry(walletRegistry, randomBeacon)
      ;({ approveDkgResultTx: walletRegistrationTx } = await performEcdsaDkg(
        hre,
        walletRegistry,
        walletPublicKey,
        startBlock
      ))

      await walletRegistrationTx.wait()
    })

    it("should register a new wallet in the WalletRegistry", async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await walletRegistry.isWalletRegistered(walletID)).to.be.true
    })

    it("should register a new wallet details in the Bridge", async () => {
      const storedWallet = await bridge.wallets(walletPubKeyHash)

      expect(storedWallet.ecdsaWalletID).to.be.equal(
        ecdsaWalletTestData.walletID
      )

      expect(storedWallet.state).to.be.equal(walletState.Live)

      expect(storedWallet.createdAt).to.be.equal(
        (
          await ethers.provider.getBlock(
            (
              await walletRegistrationTx.wait()
            ).blockNumber
          )
        ).timestamp
      )
    })

    it("should register a new wallet as active in the Bridge", async () => {
      expect(await bridge.activeWalletPubKeyHash()).to.be.equal(
        walletPubKeyHash
      )
    })

    it("should consume around 107 000 gas for Bridge.requestNewWallet transaction", async () => {
      // Was 94 000 while the beacon was a smock fake, which cost nothing to
      // call. It is a `MockContract` now, so the dispatch through its fallback
      // is real work: ~13k with recording already switched off above. The
      // remaining budget still guards the Bridge against a regression of more
      // than the usual 1000, it is just measured from a higher floor. In
      // production the beacon is a real contract and costs more than either.
      await assertGasUsed(requestNewWalletTx, 107_000)
    })

    it("should consume around 341 000 gas for WalletRegistry.approveDkgResult transaction", async () => {
      await assertGasUsed(walletRegistrationTx, 341_000)
    })
  })
})
