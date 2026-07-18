/**
 * Minimal pinned Keccak-256 primitive for Ethereum runtime-code hashing.
 * It intentionally exposes only the one operation needed by activation and
 * is covered by the canonical Ethereum empty/"abc" vectors.
 */

const MASK_64 = (1n << 64n) - 1n
const RATE_BYTES = 136

const ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
] as const

const ROTATION_OFFSETS = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
] as const

export function ethereumKeccak256(value: string | Uint8Array): string {
  const input = typeof value === "string" ? decodeHex(value) : value
  const state = Array<bigint>(25).fill(0n)
  let offset = 0
  while (offset + RATE_BYTES <= input.length) {
    absorb(state, input.subarray(offset, offset + RATE_BYTES))
    keccakF1600(state)
    offset += RATE_BYTES
  }
  const finalBlock = new Uint8Array(RATE_BYTES)
  finalBlock.set(input.subarray(offset))
  finalBlock[input.length - offset] ^= 0x01
  finalBlock[RATE_BYTES - 1] ^= 0x80
  absorb(state, finalBlock)
  keccakF1600(state)

  const output = Buffer.alloc(32)
  for (let index = 0; index < output.length; index++) {
    output[index] = Number(
      (state[Math.floor(index / 8)] >> BigInt((index % 8) * 8)) & 0xffn
    )
  }
  return `0x${output.toString("hex")}`
}

function absorb(state: bigint[], block: Uint8Array): void {
  for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
    let value = 0n
    for (let byte = 0; byte < 8; byte++) {
      value |= BigInt(block[lane * 8 + byte]) << BigInt(byte * 8)
    }
    state[lane] = (state[lane] ^ value) & MASK_64
  }
}

function keccakF1600(state: bigint[]): void {
  const c = Array<bigint>(5).fill(0n)
  const d = Array<bigint>(5).fill(0n)
  const b = Array<bigint>(25).fill(0n)
  for (const roundConstant of ROUND_CONSTANTS) {
    for (let x = 0; x < 5; x++) {
      c[x] =
        state[x] ^
        state[x + 5] ^
        state[x + 10] ^
        state[x + 15] ^
        state[x + 20]
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotateLeft64(c[(x + 1) % 5], 1)
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] = (state[x + 5 * y] ^ d[x]) & MASK_64
      }
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const nextX = y
        const nextY = (2 * x + 3 * y) % 5
        b[nextX + 5 * nextY] = rotateLeft64(
          state[x + 5 * y],
          ROTATION_OFFSETS[x + 5 * y]
        )
      }
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] =
          (b[x + 5 * y] ^
            ((~b[((x + 1) % 5) + 5 * y] & MASK_64) &
              b[((x + 2) % 5) + 5 * y])) &
          MASK_64
      }
    }
    state[0] = (state[0] ^ roundConstant) & MASK_64
  }
}

function rotateLeft64(value: bigint, offset: number): bigint {
  if (offset === 0) return value & MASK_64
  const shift = BigInt(offset)
  return ((value << shift) | (value >> (64n - shift))) & MASK_64
}

function decodeHex(value: string): Uint8Array {
  if (typeof value !== "string") throw new Error("Keccak input is malformed")
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^(?:[0-9a-f]{2})*$/.test(normalized)) {
    throw new Error("Keccak input must be even-length hexadecimal")
  }
  return Buffer.from(normalized, "hex")
}
