#!/usr/bin/env bash
# Verification script for migration debt NatSpec documentation.
# Checks that the required NatSpec documentation exists on the
# migration debt registration and repayment functions.
#
# Exit codes:
#   0 - All required NatSpec documentation is present
#   1 - One or more required NatSpec blocks are missing

set -euo pipefail

CONTRACTS_DIR="$(cd "$(dirname "$0")/../contracts/vault" && pwd)"
FAIL_COUNT=0

check_pattern() {
  local file="$1"
  local pattern="$2"
  local description="$3"

  if ! grep -qE "$pattern" "$file" 2> /dev/null; then
    echo "FAIL: $description"
    echo "  File: $file"
    echo "  Missing pattern: $pattern"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  else
    echo "PASS: $description"
  fi
}

echo "=== Migration Debt NatSpec Verification ==="
echo ""

# 1. ITBTCVaultMigrationDebt.sol - registerMigrationDebt must have @notice
check_pattern \
  "$CONTRACTS_DIR/ITBTCVaultMigrationDebt.sol" \
  "@notice.*[Rr]egister.*migration.*debt" \
  "ITBTCVaultMigrationDebt.registerMigrationDebt has @notice"

# 2. ITBTCVaultMigrationDebt.sol - registerMigrationDebt must have @param
check_pattern \
  "$CONTRACTS_DIR/ITBTCVaultMigrationDebt.sol" \
  "@param revealer" \
  "ITBTCVaultMigrationDebt.registerMigrationDebt has @param revealer"

check_pattern \
  "$CONTRACTS_DIR/ITBTCVaultMigrationDebt.sol" \
  "@param amount" \
  "ITBTCVaultMigrationDebt.registerMigrationDebt has @param amount"

# 3. ITBTCVaultMigrationDebt.sol - canRevealMigration must have @notice
check_pattern \
  "$CONTRACTS_DIR/ITBTCVaultMigrationDebt.sol" \
  "@notice.*canRevealMigration|@notice.*[Rr]eturn.*whether.*reveal" \
  "ITBTCVaultMigrationDebt.canRevealMigration has @notice"

# 4. TBTCMigrationDebtOperations.sol - registerDebt must have @notice
check_pattern \
  "$CONTRACTS_DIR/TBTCMigrationDebtOperations.sol" \
  "@notice.*[Rr]ecord.*migration.*debt|@notice.*[Rr]egister.*migration.*debt" \
  "TBTCMigrationDebtOperations.registerDebt has @notice"

# 5. TBTCMigrationDebtOperations.sol - registerDebt must have @dev about gross-vs-net
check_pattern \
  "$CONTRACTS_DIR/TBTCMigrationDebtOperations.sol" \
  "@dev.*precision|@dev.*[Oo]ne-time" \
  "TBTCMigrationDebtOperations.registerDebt has @dev"

# 6. TBTCMigrationDebtOperations.sol - repayDebt must have @notice
check_pattern \
  "$CONTRACTS_DIR/TBTCMigrationDebtOperations.sol" \
  "@notice.*[Rr]epay.*migration.*debt|@notice.*[Rr]epay.*debt.*sweep" \
  "TBTCMigrationDebtOperations.repayDebt has @notice"

# 7. TBTCMigrationDebtOperations.sol - repayDebt must have @dev about fee deduction
check_pattern \
  "$CONTRACTS_DIR/TBTCMigrationDebtOperations.sol" \
  "@dev.*treasuryFee|@dev.*treasury.*fee|@dev.*fee.*deduct" \
  "TBTCMigrationDebtOperations.repayDebt has @dev about fee deduction"

# 8. TBTCOptimisticMinting.sol - registerMigrationDebt must have @dev
check_pattern \
  "$CONTRACTS_DIR/TBTCOptimisticMinting.sol" \
  "/// @dev.*[Oo]nly callable by.*owner|/// @dev.*onlyOwner.*requireCanonical|/// @dev.*[Oo]ver-registration" \
  "TBTCOptimisticMinting.registerMigrationDebt has @dev"

# 9. TBTCOptimisticMinting.sol - repayMigrationDebt must have @dev about fee deduction
check_pattern \
  "$CONTRACTS_DIR/TBTCOptimisticMinting.sol" \
  "/// @dev.*[Bb]ridge fee|/// @dev.*fee deduction|/// @dev.*post-fee|/// @dev.*DepositSweep" \
  "TBTCOptimisticMinting.repayMigrationDebt has @dev about fee interaction"

# 10. Documentation covers over-registration path
check_pattern \
  "$CONTRACTS_DIR/ITBTCVaultMigrationDebt.sol" \
  "[Oo]ver-registration|residual.*debt|gross.*registration" \
  "Over-registration path documented in interface"

# 11. Documentation covers under-registration path
check_pattern \
  "$CONTRACTS_DIR/ITBTCVaultMigrationDebt.sol" \
  "[Uu]nder-registration|excess.*tBTC|net.*registration" \
  "Under-registration path documented in interface"

echo ""
echo "=== Results ==="
echo "Failures: $FAIL_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "STATUS: FAIL - Missing NatSpec documentation"
  exit 1
else
  echo "STATUS: PASS - All required NatSpec documentation present"
  exit 0
fi
