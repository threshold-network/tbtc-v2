/* eslint-disable no-restricted-syntax */

/**
 * Deployment artifact validation helpers.
 *
 * Pure functions that check structural consistency of Hardhat deployment
 * artifact JSON files (transactionHash, address, library references).
 * Used by the deployment-artifacts test suite and CI guard.
 */

// Known vulnerable library address that must never appear in production
// deployment artifacts. The Deposit library at this address contained a
// bug in the rebate handling logic.
const VULNERABLE_DEPOSIT_LIBRARY = "0xCD2EbDA2beA80484C55675e1965149054dCcD137"

// Precomputed lowercase for repeated comparisons in library validation
const VULNERABLE_DEPOSIT_LIBRARY_LC = VULNERABLE_DEPOSIT_LIBRARY.toLowerCase()

// Ethereum address format: 0x prefix followed by exactly 40 hex characters
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Minimal shape of a Hardhat deployment artifact for validation purposes.
 * Only the fields consumed by the validation functions are declared here.
 */
interface DeploymentArtifact {
  address?: string
  transactionHash?: string
  receipt?: {
    transactionHash?: string
    contractAddress?: string | null
  }
  libraries?: Record<string, string>
}

interface ValidationResult {
  valid: boolean
  error?: string
  skipped?: boolean
}

/**
 * Validates that an artifact's top-level `transactionHash` matches the
 * `receipt.transactionHash` value.
 *
 * Artifacts without a `receipt` field (non-standard files) are skipped
 * and marked as valid with `skipped: true`.
 */
function validateTransactionHash(
  artifact: DeploymentArtifact
): ValidationResult {
  if (!artifact.receipt) {
    return { valid: true, skipped: true }
  }

  if (artifact.transactionHash !== artifact.receipt.transactionHash) {
    return {
      valid: false,
      error: `transactionHash mismatch: top-level "${artifact.transactionHash}" != receipt "${artifact.receipt.transactionHash}"`,
    }
  }

  return { valid: true }
}

/**
 * Validates that an artifact's `address` field matches the
 * `receipt.contractAddress` value (case-insensitive comparison).
 *
 * Artifacts without `receipt.contractAddress` or where it is null are
 * considered valid (e.g., proxy deployments where the receipt reflects
 * the proxy factory, not the deployed contract).
 */
function validateAddress(artifact: DeploymentArtifact): ValidationResult {
  if (!artifact.receipt || artifact.receipt.contractAddress == null) {
    return { valid: true }
  }

  if (!artifact.address) {
    return {
      valid: false,
      error: `address field missing but receipt.contractAddress is "${artifact.receipt.contractAddress}"`,
    }
  }

  if (
    artifact.address.toLowerCase() !==
    artifact.receipt.contractAddress.toLowerCase()
  ) {
    return {
      valid: false,
      error: `address mismatch: "${artifact.address}" != receipt.contractAddress "${artifact.receipt.contractAddress}"`,
    }
  }

  return { valid: true }
}

/**
 * Validates that an artifact's library references are consistent:
 * - No library may point to the known vulnerable Deposit address
 * - Each library address must be a valid 40-hex-character Ethereum address
 * - Each library address must exist among the known deployment addresses
 *
 * @param artifact - The parsed deployment artifact JSON
 * @param knownAddresses - Set of lowercased addresses from all artifacts
 *   in the same deployment directory
 */
function validateLibraries(
  artifact: DeploymentArtifact,
  knownAddresses: Set<string>
): ValidationResult {
  if (!artifact.libraries) {
    return { valid: true }
  }

  for (const [name, addr] of Object.entries(artifact.libraries)) {
    // Check for the known vulnerable Deposit library address
    if (addr.toLowerCase() === VULNERABLE_DEPOSIT_LIBRARY_LC) {
      return {
        valid: false,
        error: `library "${name}" points to vulnerable address ${addr}`,
      }
    }

    // Validate address format (0x followed by 40 hex characters)
    if (!ETH_ADDRESS_RE.test(addr)) {
      return {
        valid: false,
        error: `library "${name}" has invalid address format: "${addr}"`,
      }
    }

    // Validate the library address exists among known deployment addresses
    if (!knownAddresses.has(addr.toLowerCase())) {
      return {
        valid: false,
        error: `library "${name}" address ${addr} not found among known deployment addresses`,
      }
    }
  }

  return { valid: true }
}

module.exports = {
  VULNERABLE_DEPOSIT_LIBRARY,
  validateTransactionHash,
  validateAddress,
  validateLibraries,
}
