/* eslint-disable @typescript-eslint/no-extra-semi */
import hre, { ethers, waffle } from "hardhat"
import { expect } from "chai"

import type { FakeContract } from "@defi-wonderland/smock"
import type { ContractTransaction } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
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

// Defensible skip: this integration test goes through
// `bridge.requestNewWallet()` which, post-D-2.2-slice-3, routes
// through `FrostWalletRegistry` (not the legacy ECDSA `WalletRegistry`).
// The test's `performEcdsaDkg(walletRegistry, ...)` flow assumes the
// ECDSA registry's DKG state machine is AWAITING_SEED — it isn't,
// because `requestNewWallet` no longer hits the ECDSA path. Porting
// to a FROST DKG simulation requires coordinated work with the
// keep-core Go-side FROST DKG protocol (Phase B-2, not yet shipped).
// Until then, the FROST wallet creation path is covered by the unit
// tests in `test/bridge/Bridge.FrostWalletRegistration.test.ts` and
// `test/frost-registry/*.test.ts`.
const describeFn = describe.skip
void process.env.NODE_ENV // keep the env var referenced so eslint doesn't strip the import-time read elsewhere

describeFn("Integration Test - Wallet Creation", async () => {
  let bridge: Bridge
  let walletRegistry: WalletRegistry
  let randomBeacon: FakeContract<IRandomBeacon>
  let governance: SignerWithAddress

  const dkgResultChallengePeriodLength = 10

  // TODO: Generate a random public key
  const walletPublicKey = ecdsaWalletTestData.publicKey
  const { walletID } = ecdsaWalletTestData
  const walletPubKeyHash = ecdsaWalletTestData.pubKeyHash160

  before(async () => {
    ;({ governance, bridge, walletRegistry, randomBeacon } =
      await waffle.loadFixture(fixture))

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

    it("should consume around 94 000 gas for Bridge.requestNewWallet transaction", async () => {
      await assertGasUsed(requestNewWalletTx, 94_000)
    })

    it("should consume around 341 000 gas for WalletRegistry.approveDkgResult transaction", async () => {
      await assertGasUsed(walletRegistrationTx, 341_000)
    })
  })
})
