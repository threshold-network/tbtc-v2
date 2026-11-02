import { expect } from "chai"
import { MockProvider } from "@ethereum-waffle/provider"
import { deployMockContract } from "@ethereum-waffle/mock-contract"
import { BigNumber, constants } from "ethers"
import { abi as BridgeABI } from "@keep-network/tbtc-v2/artifacts/Bridge.json"
import {
  EthereumReservations,
  EthereumAddress,
  Hex,
  WalletState,
} from "../../../src/core"
import { reservationBridgeAbiFragments } from "../../../src/lib/ethereum/artifacts/reservation-bridge-fragments"

import type { MockContract } from "@ethereum-waffle/mock-contract"

// The fixture runs in an EVM. Calls pass through the real ethers Contract
// encoder and decoder, including the functions API's outer Result array.
describe("Ethereum reservation view output decoding", function () {
  this.timeout(20000)
  const [signer] = new MockProvider().getWallets()
  const wallet = Hex.from("11".repeat(20))
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

  it("does not treat a cleared reserved mark or an untrusted vault as true", async () => {
    await contract.mock.isReservedDeposit.returns(false)
    await contract.mock.isVaultTrusted.returns(false)
    expect(await handle.isReservedDeposit(BigNumber.from(42))).to.equal(false)
    expect(
      await handle.isVaultTrusted(EthereumAddress.from(`0x${"22".repeat(20)}`))
    ).to.equal(false)
  })

  it("keeps uint256 wallet occupancy and satoshi amounts as scalars", async () => {
    await contract.mock.walletReservationsCount.returns(0)
    await contract.mock.walletReservationsAmount.returns(1500000)
    await contract.mock.pendingReservedDeposits.returns(2)
    expect(await handle.walletReservationsCount(wallet)).to.equal(0)
    expect((await handle.walletReservationsAmount(wallet)).toString()).to.equal(
      "1500000"
    )
    expect(await handle.pendingReservedDeposits()).to.equal(2)
  })

  it("does not interpret a live-wallet count as a byte array", async () => {
    await contract.mock.liveWalletsCount.returns(300)
    await contract.mock.reservationHandoffReserveWallets.returns(2)
    expect(await handle.liveWalletsCount()).to.equal(300)
    expect(await handle.reservationHandoffReserveWallets()).to.equal(2)
  })

  it("preserves the Live state from a single struct output", async () => {
    await contract.mock.wallets.returns({
      ecdsaWalletID: constants.HashZero,
      mainUtxoHash: constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: 1654846075,
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: WalletState.Live,
      movingFundsTargetWalletsCommitmentHash: constants.HashZero,
    })
    expect((await handle.wallet(wallet)).state).to.equal(WalletState.Live)
  })

  it("retains separate outputs for global occupancy and governance caps", async () => {
    await contract.mock.activeReservationsCount.returns(2, 5)
    await contract.mock.reservationCaps.returns(2000000, 1500000, 5, 1)
    expect(await handle.activeReservationsCount()).to.deep.equal({
      count: 2,
      maxActive: 5,
    })
    const caps = await handle.reservationCaps()
    expect(caps.maxAmountPerWallet.toString()).to.equal("2000000")
    expect(caps.maxSingleAmount.toString()).to.equal("1500000")
    expect(caps.maxActiveReservations).to.equal(5)
    expect(caps.maxThirdPartyReanchorHoldsPerWallet).to.equal(1)
  })
})
