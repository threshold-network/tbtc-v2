/**
 * Coverage for `releaseReservedDepositToPool`: the depositor-only release of
 * a revealed reserved deposit that never received an acceptance request,
 * turning it back into an ordinary pool deposit.
 *
 * The entry point lives on the `ReservationRouter` and is only reachable
 * through the Bridge fallback delegatecall, so the tests call it through a
 * contract view bound to the Bridge address with the release ABI fragment -
 * the production caller path. Before the router function exists every call
 * reverts (the router has no fallback, so the delegatecall returns nothing
 * and the Bridge reverts), which is the red state this suite records.
 */

import { ethers, helpers } from "hardhat"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { Contract, ContractTransactionResponse } from "ethers"
import { expect } from "chai"
import bridgeFixture from "../fixtures/bridge"
import { walletState } from "../fixtures"
import { createMock, expectCalledOnceWith } from "../helpers/mock"
import type { Mock } from "../helpers/mock"
import type {
  Bank,
  BankStub,
  Bridge,
  BridgeStub,
  IRelay,
  ReservationRouter,
  ReservationVault,
  IVault,
} from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

const ZERO_BYTES32 = ethers.ZeroHash

const RESERVATION_TERM = 31536000 // 365 days
const RESERVATION_GRACE = 2592000 // 30 days
const RESERVATION_MIN_AMOUNT = 10000
const RESERVATION_TX_MAX_FEE = 2000
const RESERVATION_MAX_TOTAL = BigInt("10000000")
const MAX_RESERVATIONS_PER_WALLET = 10
const RESERVATION_ACTION_TIMEOUT = 172800 // 48 hours
const RESERVATION_RENEWAL_WINDOW = 2592000 // 30 days

// Ordinary sweep fixture data: the sweep spends the revealed reserved
// deposit outpoint and pays a P2WPKH output to the custodian wallet, as in
// `SingleP2WSHDeposit` (`test/data/deposit-sweep.ts`).
const DEPOSIT_AMOUNT = 80000
const SWEEP_FEE = 2000

describe("Bridge - Reservation release to pool", () => {
  let governance: HardhatEthersSigner
  let spvMaintainer: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let deployer: HardhatEthersSigner

  let bank: Bank & BankStub
  let relay: Mock<IRelay>
  let bridge: Bridge & BridgeStub
  let reservationRouter: ReservationRouter
  let reservationVault: ReservationVault
  let bridgeGovernanceSigner: HardhatEthersSigner
  let releaseAbiBridge: Contract & {
    releaseReservedDepositToPool(
      depositKey: bigint,
      vault: string
    ): Promise<ContractTransactionResponse>
  }
  let refundLocktime: string

  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const blindingFactor = "0xf9f0c90d00039523"
  const refundPubKeyHash = "0x28e081f285138ccbe389c1eb8985716230129f89"

  const releaseAbi = [
    "function releaseReservedDepositToPool(uint256 depositKey, address vault)",
    "event ReservedDepositReleasedToPool(uint256 indexed depositKey, address indexed depositor, address vault)",
  ]

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      spvMaintainer,
      thirdParty,
      bank,
      relay,
      bridge,
    } = await bridgeFixture())

    // Router functions are only reachable through the `Bridge.fallback()`
    // delegatecall; binding the release ABI fragment to the Bridge address
    // gives the production caller path for the new entry point.
    releaseAbiBridge = new ethers.Contract(
      bridge.target,
      releaseAbi,
      bridge.runner
    ) as typeof releaseAbiBridge
    reservationRouter = await ethers.getContractAt(
      "ReservationRouter",
      bridge.target
    )
    reservationVault = await helpers.contracts.getContract("ReservationVault")
    bridgeGovernanceSigner = await impersonateContract(
      await bridge.governance()
    )
    refundLocktime = `0x${toLE((await lastBlockTime()) + 89 * 24 * 60 * 60, 4)}`

    await bridge
      .connect(bridgeGovernanceSigner)
      .setVaultStatus(reservationVault.target, true)
    await reservationRouter
      .connect(bridgeGovernanceSigner)
      .updateReservationCaps(
        RESERVATION_MAX_TOTAL,
        RESERVATION_MAX_TOTAL,
        10,
        1,
        1
      )
    await reservationRouter
      .connect(bridgeGovernanceSigner)
      .updateReservationParameters(
        reservationVault.target,
        RESERVATION_MIN_AMOUNT,
        RESERVATION_TX_MAX_FEE,
        RESERVATION_TERM,
        RESERVATION_GRACE,
        RESERVATION_MAX_TOTAL,
        MAX_RESERVATIONS_PER_WALLET,
        RESERVATION_ACTION_TIMEOUT,
        RESERVATION_RENEWAL_WINDOW
      )

    await relay.getCurrentEpochDifficulty.returns(0)
    await relay.getPrevEpochDifficulty.returns(0)

    await bridge.setDepositDustThreshold(10000)
    await bridge.setDepositTxMaxFee(SWEEP_FEE)
    await bridge.setDepositRevealAheadPeriod(0)
    await liveWallet(walletPubKeyHash)
    await liveWallet(`0x${"44".repeat(20)}`)
  })

  async function impersonateContract(
    address: string
  ): Promise<HardhatEthersSigner> {
    await ethers.provider.send("hardhat_impersonateAccount", [address])
    await ethers.provider.send("hardhat_setBalance", [
      address,
      "0x8AC7230489E80000",
    ])
    return ethers.getSigner(address)
  }

  async function liveWallet(pkh: string) {
    await bridge.setWallet(pkh, {
      ecdsaWalletID: ethers.randomBytes(32),
      mainUtxoHash: ZERO_BYTES32,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: ZERO_BYTES32,
    })
  }

  // ---- Bitcoin fixture crafting (regtest-style difficulty) ----

  const REGTEST_BITS_LE = "ffff7f20"
  const REGTEST_TARGET = BigInt(0x7fffff) * 2n ** BigInt(8 * (0x20 - 3))

  const reverseHex = (hex: string): string =>
    hex.replace(/^0x/, "").match(/../g)!.reverse().join("")

  const hash256 = (hexData: string): string =>
    ethers.sha256(ethers.sha256(hexData))

  const toLE = (value: number | bigint, byteLength: number): string =>
    reverseHex(
      BigInt(value)
        .toString(16)
        .padStart(byteLength * 2, "0")
    )

  const compactSize = (n: number): string => {
    if (n >= 0xfd) {
      throw new Error("compactSize > 252 not supported in fixtures")
    }
    return n.toString(16).padStart(2, "0")
  }

  function buildTx(
    inputs: { txHash: string; index: number }[],
    outputs: { valueSat: bigint | number; script: string }[]
  ) {
    const inputVector = `0x${compactSize(inputs.length)}${inputs
      .map((i) => `${i.txHash.slice(2)}${toLE(i.index, 4)}00ffffffff`)
      .join("")}`
    const outputVector = `0x${compactSize(outputs.length)}${outputs
      .map(
        (o) =>
          `${toLE(BigInt(o.valueSat), 8)}${compactSize(
            o.script.length / 2
          )}${o.script}`
      )
      .join("")}`
    const info = {
      version: "0x01000000",
      inputVector,
      outputVector,
      locktime: "0x00000000",
    }
    const txHash = hash256(
      `0x01000000${inputVector.slice(2)}${outputVector.slice(2)}00000000`
    )
    return { info, txHash }
  }

  function mineHeader(merkleRoot: string): string {
    const prevBlock = ethers.hexlify(ethers.randomBytes(32)).slice(2)
    const base = `20000000${prevBlock}${merkleRoot.slice(
      2
    )}662a2c68${REGTEST_BITS_LE}`
    for (let nonce = 0; ; nonce++) {
      const header = `0x${base}${toLE(nonce, 4)}`
      if (BigInt(`0x${reverseHex(hash256(header))}`) <= REGTEST_TARGET) {
        return header
      }
    }
  }

  function proofFor(txHash: string) {
    const coinbasePreimage = ethers.sha256(ethers.randomBytes(32))
    const coinbaseTxId = ethers.sha256(coinbasePreimage)
    const merkleRoot = hash256(`0x${coinbaseTxId.slice(2)}${txHash.slice(2)}`)
    return {
      merkleProof: coinbaseTxId,
      txIndexInBlock: 1,
      bitcoinHeaders: mineHeader(merkleRoot),
      coinbasePreimage,
      coinbaseProof: txHash,
    }
  }

  const buildDepositScript = (
    depositor: string,
    blinding: string,
    walletPkh: string,
    refundPkh: string,
    locktime: string
  ): string =>
    `14${depositor.slice(2)}7508${blinding.slice(2)}7576a914${walletPkh
      .slice(2)
      .toLowerCase()}8763ac6776a914${refundPkh.slice(2)}8804${locktime.slice(
      2
    )}b175ac68`

  const p2wshScript = (script: string): string =>
    `0020${ethers.sha256(`0x${script}`).slice(2)}`

  const p2wpkhScript = (pkh: string): string => `0014${pkh.slice(2)}`

  // Reveals a fresh reserved deposit to the reservation vault, without any
  // acceptance request. `bridge.revealDeposit` with
  // `vault = reservationVault` sets the pending reserved-deposit record and
  // increments `pendingReservedDeposits`.
  async function revealReservedDeposit(
    custodian: string = walletPubKeyHash,
    locktime: string = refundLocktime
  ) {
    const fundingTx = buildTx(
      [
        {
          txHash: ethers.hexlify(ethers.randomBytes(32)),
          index: 0,
        },
      ],
      [
        {
          valueSat: DEPOSIT_AMOUNT,
          script: p2wshScript(
            buildDepositScript(
              thirdParty.address,
              blindingFactor,
              custodian,
              refundPubKeyHash,
              locktime
            )
          ),
        },
      ]
    )

    await bridge.connect(thirdParty).revealDeposit(fundingTx.info, {
      fundingOutputIndex: 0,
      blindingFactor,
      walletPubKeyHash: custodian,
      refundPubKeyHash,
      refundLocktime: locktime,
      vault: reservationVault.target,
    })

    const depositKey = BigInt(
      ethers.solidityPackedKeccak256(
        ["bytes32", "uint32"],
        [fundingTx.txHash, 0]
      )
    )
    return { fundingTx, depositKey }
  }

  // A normal 1-input-1-output sweep spending the reserved deposit outpoint.
  function sweepOf(fundingTx: { txHash: string }) {
    const sweepTx = buildTx(
      [{ txHash: fundingTx.txHash, index: 0 }],
      [
        {
          valueSat: DEPOSIT_AMOUNT - SWEEP_FEE,
          script: p2wpkhScript(walletPubKeyHash),
        },
      ]
    )
    return { ...sweepTx, proof: proofFor(sweepTx.txHash) }
  }

  // The treasury-fee divisor at reveal time: the reserved deposit records
  // its `treasuryFee` at reveal (the rebate is skipped for reserved
  // deposits) and an ordinary sweep charges that recorded value.
  async function expectedDepositNet(
    depositKey: bigint,
    sweepFee: number = SWEEP_FEE
  ): Promise<bigint> {
    const deposit = await bridge.deposits(depositKey)
    return BigInt(deposit.amount) - BigInt(deposit.treasuryFee) - BigInt(sweepFee)
  }

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("releaseReservedDepositToPool happy path", () => {
    it("releases to a trusted vault, an ordinary sweep proof succeeds and credits the vault through the Bank", async () => {
      const vault = await createMock<IVault>("IVault")
      await bridge
        .connect(bridgeGovernanceSigner)
        .setVaultStatus(vault.address, true)

      const { fundingTx, depositKey } = await revealReservedDeposit()
      expect(await bridge.isReservedDeposit(depositKey)).to.be.true
      expect(await reservationRouter.pendingReservedDeposits()).to.equal(1n)

      await expect(
        releaseAbiBridge
          .connect(thirdParty)
          .releaseReservedDepositToPool(depositKey, vault.address)
      )
        .to.emit(releaseAbiBridge, "ReservedDepositReleasedToPool")
        .withArgs(depositKey, thirdParty.address, vault.address)

      // The release clears the reserved mark and re-routes the deposit.
      expect(await bridge.isReservedDeposit(depositKey)).to.be.false
      expect(await reservationRouter.pendingReservedDeposits()).to.equal(0n)
      expect(await reservationRouter.reservedDepositWallet(depositKey)).to.equal(
        "0x0000000000000000000000000000000000000000"
      )
      expect((await bridge.deposits(depositKey)).vault).to.equal(
        vault.address
      )

      // An ordinary sweep of the released deposit succeeds and routes the
      // net amount to the chosen vault through the Bank.
      const sweepTx = sweepOf(fundingTx)
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitDepositSweepProof(
            sweepTx.info,
            sweepTx.proof,
            { txHash: ZERO_BYTES32, txOutputIndex: 0, txOutputValue: 0 },
            vault.address
          )
      )
        .to.emit(bridge, "DepositsSwept")
        .withArgs(walletPubKeyHash, sweepTx.txHash)

      await expectCalledOnceWith(
        vault.receiveBalanceIncrease,
        [[thirdParty.address], [await expectedDepositNet(depositKey)]]
      )

      // The swept deposit can no longer be released.
      await expect(
        releaseAbiBridge
          .connect(thirdParty)
          .releaseReservedDepositToPool(depositKey, vault.address)
      ).to.be.revertedWith("Deposit already swept")
    })

    it("releases to the zero address and an ordinary sweep credits the depositor Bank balance", async () => {
      const { fundingTx, depositKey } = await revealReservedDeposit()

      await releaseAbiBridge
        .connect(thirdParty)
        .releaseReservedDepositToPool(depositKey, ethers.ZeroAddress)
      expect(await bridge.isReservedDeposit(depositKey)).to.be.false
      expect((await bridge.deposits(depositKey)).vault).to.equal(
        ethers.ZeroAddress
      )

      const sweepTx = sweepOf(fundingTx)
      await bridge
        .connect(spvMaintainer)
        .submitDepositSweepProof(
          sweepTx.info,
          sweepTx.proof,
          { txHash: ZERO_BYTES32, txOutputIndex: 0, txOutputValue: 0 },
          ethers.ZeroAddress
        )

      expect(await bank.balanceOf(thirdParty.address)).to.equal(
        await expectedDepositNet(depositKey)
      )
      expect((await bridge.deposits(depositKey)).sweptAt).to.not.equal(0)
    })

    it("lets governance re-point the reservation vault once the last pending reserved deposit is released", async () => {
      const { depositKey } = await revealReservedDeposit()

      const newVault = await createMock<IVault>("IVault")
      const updateParams = (vault: string) =>
        reservationRouter
          .connect(bridgeGovernanceSigner)
          .updateReservationParameters(
            vault,
            RESERVATION_MIN_AMOUNT,
            RESERVATION_TX_MAX_FEE,
            RESERVATION_TERM,
            RESERVATION_GRACE,
            RESERVATION_MAX_TOTAL,
            MAX_RESERVATIONS_PER_WALLET,
            RESERVATION_ACTION_TIMEOUT,
            RESERVATION_RENEWAL_WINDOW
          )

      // While one pending reserved deposit remains, the vault re-point is
      // blocked by the quiescence guard.
      await expect(updateParams(newVault.address)).to.be.revertedWith(
        "Pending reserved deposits exist"
      )

      // The release drops the counter to zero and unblocks the re-point.
      await releaseAbiBridge
        .connect(thirdParty)
        .releaseReservedDepositToPool(depositKey, ethers.ZeroAddress)
      expect(await reservationRouter.pendingReservedDeposits()).to.equal(0n)

      await expect(updateParams(newVault.address))
        .to.emit(reservationRouter, "ReservationVaultUpdated")
        .withArgs(newVault.address)
      expect(
        (await reservationRouter.reservationParameters()).reservationVault
      ).to.equal(newVault.address)
    })
  })

  describe("releaseReservedDepositToPool guards", () => {
    it("reverts when the caller is not the deposit's depositor", async () => {
      const { depositKey } = await revealReservedDeposit()
      // `thirdParty` is the revealer/depositor here; the deployer is not.
      await expect(
        releaseAbiBridge
          .connect(deployer)
          .releaseReservedDepositToPool(depositKey, ethers.ZeroAddress)
      ).to.be.revertedWith("Caller is not the deposit's depositor")
    })

    it("reverts when the deposit was not revealed as reserved", async () => {
      // Reveal an ordinary deposit routed to a plain trusted vault; no
      // pending reserved-deposit record exists for it.
      const ordinaryVault = await createMock<IVault>("IVault")
      await bridge
        .connect(bridgeGovernanceSigner)
        .setVaultStatus(ordinaryVault.address, true)

      const ordinary = await revealNonReservedDeposit(ordinaryVault.address)
      await expect(
        releaseAbiBridge
          .connect(thirdParty)
          .releaseReservedDepositToPool(ordinary.depositKey, ethers.ZeroAddress)
      ).to.be.revertedWith("Deposit was not revealed as reserved")
    })

    it("reverts after a pending acceptance request", async () => {
      const { depositKey, fundingTx } = await revealReservedDeposit()

      await reservationRouter
        .connect(thirdParty)
        .requestReservationAcceptance(
          fundingTx.info,
          proofFor(fundingTx.txHash),
          0,
          walletPubKeyHash
        )

      await expect(
        releaseAbiBridge
          .connect(thirdParty)
          .releaseReservedDepositToPool(depositKey, ethers.ZeroAddress)
      ).to.be.revertedWith("Acceptance was already requested")
    })

    it("reverts after a timed-out acceptance request", async () => {
      const { depositKey, fundingTx } = await revealReservedDeposit()

      await reservationRouter
        .connect(thirdParty)
        .requestReservationAcceptance(
          fundingTx.info,
          proofFor(fundingTx.txHash),
          0,
          walletPubKeyHash
        )

      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await reservationRouter.notifyReservationAcceptanceTimedOut(depositKey)

      await expect(
        releaseAbiBridge
          .connect(thirdParty)
          .releaseReservedDepositToPool(depositKey, ethers.ZeroAddress)
      ).to.be.revertedWith("Acceptance was already requested")
    })

    it("reverts when the release vault is the reservation vault", async () => {
      const { depositKey } = await revealReservedDeposit()
      await expect(
        releaseAbiBridge
          .connect(thirdParty)
          .releaseReservedDepositToPool(depositKey, reservationVault.target)
      ).to.be.revertedWith(
        "Vault must be the zero address or a trusted vault other than the reservation vault"
      )
    })

    it("reverts when the release vault is not trusted", async () => {
      const { depositKey } = await revealReservedDeposit()
      // An untrusted, non-zero vault address.
      await expect(
        releaseAbiBridge
          .connect(thirdParty)
          .releaseReservedDepositToPool(depositKey, deployer.address)
      ).to.be.revertedWith(
        "Vault must be the zero address or a trusted vault other than the reservation vault"
      )
    })

    it("reverts when the deposit is marked stale", async () => {
      const { depositKey } = await revealReservedDeposit()

      await reservationRouter
        .connect(bridgeGovernanceSigner)
        .forceStaleReservedDeposit(depositKey)

      await expect(
        releaseAbiBridge
          .connect(thirdParty)
          .releaseReservedDepositToPool(depositKey, ethers.ZeroAddress)
      ).to.be.revertedWith("Not a pending reserved deposit")
    })

    it("reverts when the refund margin for an ordinary sweep is exhausted", async () => {
      // A deposit whose refund locktime sits just inside the 24-hour
      // validator safety margin: a sweep proposal can no longer be
      // validated, so the deposit must not be released to the pool.
      const shortLocktime = `0x${toLE((await lastBlockTime()) + 23 * 3600, 4)}`
      const { fundingTx, depositKey } = await revealReservedDeposit(
        walletPubKeyHash,
        shortLocktime
      )
      void fundingTx

      // Cross the 24-hour margin without reaching the deadline itself.
      await increaseTime(1 * 3600)

      await expect(
        releaseAbiBridge
          .connect(thirdParty)
          .releaseReservedDepositToPool(depositKey, ethers.ZeroAddress)
      ).to.be.revertedWith("Deposit refund safety margin is not preserved")
    })

    it("cannot be swept with the vault parameter set to the reservation vault after a release", async () => {
      const { fundingTx, depositKey } = await revealReservedDeposit()
      await releaseAbiBridge
        .connect(thirdParty)
        .releaseReservedDepositToPool(depositKey, ethers.ZeroAddress)

      const { info, proof } = sweepOf(fundingTx)
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitDepositSweepProof(
            info,
            proof,
            { txHash: ZERO_BYTES32, txOutputIndex: 0, txOutputValue: 0 },
            reservationVault.target
          )
      ).to.be.revertedWith("Deposit should be routed to another vault")
    })

    it("leaves no acceptance request or stale notification possible after a release", async () => {
      const { depositKey, fundingTx } = await revealReservedDeposit()
      await releaseAbiBridge
        .connect(thirdParty)
        .releaseReservedDepositToPool(depositKey, ethers.ZeroAddress)

      await expect(
        reservationRouter
          .connect(thirdParty)
          .requestReservationAcceptance(
            fundingTx.info,
            proofFor(fundingTx.txHash),
            0,
            walletPubKeyHash
          )
      ).to.be.revertedWith("Deposit was not revealed as reserved")

      await expect(
        reservationRouter.notifyStaleReservedDeposit(depositKey)
      ).to.be.revertedWith("Not a pending reserved deposit")
    })
  })

  // Reveals a deposit routed to a plain trusted vault - the ordinary-deposit
  // shape, with no pending reserved-deposit record.
  async function revealNonReservedDeposit(vault: string) {
    const fundingTx = buildTx(
      [
        {
          txHash: ethers.hexlify(ethers.randomBytes(32)),
          index: 0,
        },
      ],
      [
        {
          valueSat: DEPOSIT_AMOUNT,
          script: p2wshScript(
            buildDepositScript(
              thirdParty.address,
              blindingFactor,
              walletPubKeyHash,
              refundPubKeyHash,
              refundLocktime
            )
          ),
        },
      ]
    )

    await bridge.connect(thirdParty).revealDeposit(fundingTx.info, {
      fundingOutputIndex: 0,
      blindingFactor,
      walletPubKeyHash,
      refundPubKeyHash,
      refundLocktime,
      vault,
    })

    const depositKey = BigInt(
      ethers.solidityPackedKeccak256(
        ["bytes32", "uint32"],
        [fundingTx.txHash, 0]
      )
    )
    return { fundingTx, depositKey }
  }
})
