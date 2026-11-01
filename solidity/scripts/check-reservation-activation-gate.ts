/* eslint-disable no-console -- this script's output is the release gate verdict */
/* eslint-disable no-restricted-syntax -- checks are reported in the order they ran */

/**
 * The 3a/3b release gate that `cascade-2026-11-03-v2.md` section 8.3 asks for.
 *
 * It answers one question per step, from chain state and the release's own
 * numbers, and exits non-zero on any failure:
 *
 *   3a  does the validator address the client names carry the M1 validator
 *       surface in its *deployed* runtime (the reserved-deposit call and both
 *       reservation proposal entry points), and does the Bridge it points at
 *       expose `isReservedDeposit`?
 *   3b  is the activation block compiled into the release an explicit height
 *       that satisfies both orderings?
 *
 * The 3b relation, stated once:
 *
 *     releaseBlock < activationBlock <= setVaultStatusBlock
 *
 * The left bound is the operator constraint: every operator must be running
 * the release before the feature activates. The right bound is the client's
 * own rule (`pkg/tbtc/reservations_activation.go`): with an entry B, a chain
 * head below B while the Bridge already trusts the reservation vault is
 * `ReservationsActivationError` - the C-4 violation. So the on-chain
 * activation must not happen before B is reached, and it must happen after the
 * release is out; B sits between them.
 *
 * Usage:
 *   CHAIN_API_URL=https://... \
 *   ACTIVATION_BLOCK=26400000 \
 *   RELEASE_BLOCK=26390000 \
 *   SET_VAULT_STATUS_BLOCK=26400100 \
 *   npx hardhat run --network mainnet scripts/check-reservation-activation-gate.ts
 *
 * Addresses default to the `mainnet` deployment records; override with
 * BRIDGE_ADDRESS / VALIDATOR_ADDRESS.
 */

import { ethers, deployments } from "hardhat"
import {
  bridgeAnswersIsReservedDeposit,
  validatorRuntimeChecks,
} from "./validator-runtime-guard"

interface GateCheck {
  name: string
  ok: boolean
  detail: string
}

function requireBlock(name: string): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `${name} is required: pass the number the ceremony and the release ` +
        "actually use, not a placeholder"
    )
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive integer block height, got ${raw}`
    )
  }
  return value
}

async function main(): Promise<void> {
  const activationBlock = requireBlock("ACTIVATION_BLOCK")
  const releaseBlock = requireBlock("RELEASE_BLOCK")
  const setVaultStatusBlock = requireBlock("SET_VAULT_STATUS_BLOCK")

  const chainId = Number((await ethers.provider.getNetwork()).chainId)
  const bridgeAddress =
    process.env.BRIDGE_ADDRESS ?? (await deployments.get("Bridge")).address
  const validatorAddress =
    process.env.VALIDATOR_ADDRESS ??
    (await deployments.get("WalletProposalValidator")).address

  const checks: GateCheck[] = []
  checks.push({
    name: "chain id is 1",
    ok: chainId === 1,
    detail: `chainId ${chainId}`,
  })

  const validatorCode = await ethers.provider.getCode(validatorAddress)
  checks.push({
    name: "validator has code",
    ok: validatorCode !== "0x",
    detail: `${validatorAddress} (${
      validatorCode === "0x" ? "0" : (validatorCode.length - 2) / 2
    } bytes)`,
  })
  checks.push(...validatorRuntimeChecks(validatorCode))

  const bridgeProbe = await bridgeAnswersIsReservedDeposit(
    ethers.provider,
    bridgeAddress
  )
  checks.push({
    name: "Bridge answers isReservedDeposit",
    ok: bridgeProbe.ok,
    detail: bridgeProbe.detail,
  })

  checks.push({
    name: "activation block is above the release block",
    ok: activationBlock > releaseBlock,
    detail: `activation ${activationBlock} > release ${releaseBlock}`,
  })
  checks.push({
    name: "activation block is at or below the setVaultStatus block",
    ok: activationBlock <= setVaultStatusBlock,
    detail: `activation ${activationBlock} <= setVaultStatus ${setVaultStatusBlock}`,
  })

  for (const check of checks) {
    console.log(
      `[${check.ok ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`
    )
  }

  const failures = checks.filter((check) => !check.ok).length
  console.log(
    `\n${checks.length - failures}/${checks.length} checks passed ` +
      `(validator ${validatorAddress}, bridge ${bridgeAddress})`
  )
  if (failures > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(2)
})
