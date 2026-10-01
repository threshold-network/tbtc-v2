import { ethers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber } from "ethers"
import type { Bridge, BridgeStub, ReservationRouter } from "../../typechain"

// Builders for reserved deposits and their acceptance proofs: Bitcoin
// transactions, regtest-difficulty headers and SPV proofs that the Bridge's
// stubbed relay (difficulty 0) accepts, and the reveal / request / proof
// sequence of an acceptance, driven through the production router entry
// points reached by the Bridge's fallback.

/**
 * Impersonates the given address and funds it with 10 ETH, so a contract
 * (for example the Bridge governance) can send transactions in tests.
 */
export async function impersonateContract(
  address: string
): Promise<SignerWithAddress> {
  await ethers.provider.send("hardhat_impersonateAccount", [address])
  await ethers.provider.send("hardhat_setBalance", [
    address,
    "0x8AC7230489E80000",
  ])
  return ethers.getSigner(address)
}

// ---- Bitcoin fixture crafting (regtest-style difficulty) ----

const REGTEST_BITS_LE = "ffff7f20"
const REGTEST_TARGET = BigNumber.from("0x7fffff").mul(
  BigNumber.from(2).pow(8 * (0x20 - 3))
)

const reverseHex = (hex: string): string =>
  hex.replace(/^0x/, "").match(/../g)!.reverse().join("")

const hash256 = (hexData: string): string =>
  ethers.utils.sha256(ethers.utils.sha256(hexData))

/**
 * Little-endian hex of `value` over `byteLength` bytes, without a 0x prefix.
 */
export const toLE = (value: number | BigNumber, byteLength: number): string =>
  reverseHex(
    BigNumber.from(value)
      .toHexString()
      .slice(2)
      .padStart(byteLength * 2, "0")
  )

/**
 * The 4-byte little-endian refund locktime of a deposit refundable at the
 * given Unix timestamp, as `revealDeposit` takes it.
 */
export const refundLocktimeAt = (timestamp: number): string =>
  `0x${toLE(timestamp, 4)}`

const compactSize = (n: number): string => {
  if (n >= 0xfd) {
    throw new Error("compactSize > 252 not supported in fixtures")
  }
  return n.toString(16).padStart(2, "0")
}

/**
 * A Bitcoin transaction as the Bridge takes it, and its hash.
 */
export interface BuiltTx {
  info: {
    version: string
    inputVector: string
    outputVector: string
    locktime: string
  }
  txHash: string
}

/**
 * An SPV proof as the Bridge takes it.
 */
export interface SpvProof {
  merkleProof: string
  txIndexInBlock: number
  bitcoinHeaders: string
  coinbasePreimage: string
  coinbaseProof: string
}

export function buildTx(
  inputs: { txHash: string; index: number }[],
  outputs: { valueSat: BigNumber | number; script: string }[]
): BuiltTx {
  const inputVector = `0x${compactSize(inputs.length)}${inputs
    .map((i) => `${i.txHash.slice(2)}${toLE(i.index, 4)}00ffffffff`)
    .join("")}`
  const outputVector = `0x${compactSize(outputs.length)}${outputs
    .map(
      (o) =>
        `${toLE(BigNumber.from(o.valueSat), 8)}${compactSize(
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

export function mineHeader(merkleRoot: string): string {
  const prevBlock = ethers.utils.hexlify(ethers.utils.randomBytes(32)).slice(2)
  const base = `20000000${prevBlock}${merkleRoot.slice(
    2
  )}662a2c68${REGTEST_BITS_LE}`
  for (let nonce = 0; ; nonce++) {
    const header = `0x${base}${toLE(nonce, 4)}`
    if (
      BigNumber.from(`0x${reverseHex(hash256(header))}`).lte(REGTEST_TARGET)
    ) {
      return header
    }
  }
}

export function proofFor(txHash: string): SpvProof {
  const coinbasePreimage = ethers.utils.sha256(ethers.utils.randomBytes(32))
  const coinbaseTxId = ethers.utils.sha256(coinbasePreimage)
  const merkleRoot = hash256(`0x${coinbaseTxId.slice(2)}${txHash.slice(2)}`)
  return {
    merkleProof: coinbaseTxId,
    txIndexInBlock: 1,
    bitcoinHeaders: mineHeader(merkleRoot),
    coinbasePreimage,
    coinbaseProof: txHash,
  }
}

export const buildDepositScript = (
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

export const p2wshScript = (script: string): string =>
  `0020${ethers.utils.sha256(`0x${script}`).slice(2)}`

export const p2wpkhScript = (pkh: string): string => `0014${pkh.slice(2)}`

// ---- Reserved deposit and acceptance sequence ----

/**
 * Everything one reserved deposit and its acceptance need, so a test can
 * drive several depositors, locktimes, amounts and terms side by side.
 */
export interface ReservationProofContext {
  bridge: Bridge | (Bridge & BridgeStub)
  // The router ABI bound to the Bridge's address.
  reservationRouter: ReservationRouter
  // The reservation vault the deposit is revealed to.
  reservationVault: string
  depositor: SignerWithAddress
  spvMaintainer: SignerWithAddress
  walletPubKeyHash: string
  blindingFactor: string
  refundPubKeyHash: string
  // 4-byte little-endian refund locktime (see `refundLocktimeAt`).
  refundLocktime: string
  depositAmount: BigNumber
  // Value of the anchor output; the rest of the deposit is the miner fee.
  anchorAmount: BigNumber
  // Term id passed on the acceptance request.
  termId: number
}

/**
 * A revealed reserved deposit: its funding transaction, the anchor
 * transaction spending it to the context's wallet, and its reservation key.
 */
export interface RevealedReservation {
  fundingTx: BuiltTx
  anchorTx: BuiltTx
  reservationKey: BigNumber
}

/**
 * Reveals a fresh reserved deposit to the reservation vault and builds the
 * anchor transaction spending it to the context's wallet, without
 * requesting acceptance.
 */
export async function revealReservedDeposit(
  ctx: Omit<ReservationProofContext, "termId">
): Promise<RevealedReservation> {
  const fundingTx = buildTx(
    [
      {
        txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
        index: 0,
      },
    ],
    [
      {
        valueSat: ctx.depositAmount,
        script: p2wshScript(
          buildDepositScript(
            ctx.depositor.address,
            ctx.blindingFactor,
            ctx.walletPubKeyHash,
            ctx.refundPubKeyHash,
            ctx.refundLocktime
          )
        ),
      },
    ]
  )

  await ctx.bridge.connect(ctx.depositor).revealDeposit(fundingTx.info, {
    fundingOutputIndex: 0,
    blindingFactor: ctx.blindingFactor,
    walletPubKeyHash: ctx.walletPubKeyHash,
    refundPubKeyHash: ctx.refundPubKeyHash,
    refundLocktime: ctx.refundLocktime,
    vault: ctx.reservationVault,
  })

  const reservationKey = BigNumber.from(
    ethers.utils.solidityKeccak256(["bytes32", "uint32"], [fundingTx.txHash, 0])
  )

  const anchorTx = buildTx(
    [{ txHash: fundingTx.txHash, index: 0 }],
    [{ valueSat: ctx.anchorAmount, script: p2wpkhScript(ctx.walletPubKeyHash) }]
  )

  return { fundingTx, anchorTx, reservationKey }
}

/**
 * Reveals a fresh reserved deposit and requests acceptance (generation 1)
 * on the context's term id, as the depositor.
 */
export async function makeRequestedReservation(
  ctx: ReservationProofContext
): Promise<RevealedReservation> {
  const { fundingTx, anchorTx, reservationKey } = await revealReservedDeposit(
    ctx
  )

  await ctx.reservationRouter
    .connect(ctx.depositor)
    .requestReservationAcceptance(
      reservationKey,
      ctx.walletPubKeyHash,
      ctx.termId
    )

  return { fundingTx, anchorTx, reservationKey }
}

/**
 * Reveals a fresh reserved deposit, requests acceptance (generation 1) and
 * proves the anchor.
 */
export async function makeAcceptedReservation(
  ctx: ReservationProofContext
): Promise<RevealedReservation> {
  const { fundingTx, anchorTx, reservationKey } =
    await makeRequestedReservation(ctx)

  await ctx.reservationRouter
    .connect(ctx.spvMaintainer)
    .submitReservationAcceptanceProof(
      anchorTx.info,
      proofFor(anchorTx.txHash),
      reservationKey,
      1
    )

  return { fundingTx, anchorTx, reservationKey }
}
