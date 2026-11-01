#!/usr/bin/env bash
# Targeted re-verification of the reservation contracts and SDK on one tbtc-v2 head.
#
# usage: run.sh --tbtc <tbtc-v2 worktree> [--keepcore <keep-core worktree>]
#               [--fork-ref <git ref holding the fork scripts>]
#               [--old-head <ref> --new-head <ref> [--reference <ref>]] [--steps a,b,c]
#
# steps (default: all that the given arguments allow):
#   reconcile  after the PR head moved: check that its contract and deploy
#              changes are present in the head under test (see reconcile.sh;
#              needs --old-head and --new-head; --reference adds a contract comparison)
#   killset    compile and run the reservation kill set
#   full       run the full Hardhat suite
#   survivors  re-apply the mutants listed in survivors.txt against the kill set
#   exclusions check that every uncovered coverage unit and every surviving
#              mutant has a written reason in exclusions.txt (see
#              check-exclusions.js); needs a coverage report and, for the
#              mutation half, a mutants JSON
#   sdk        generate typechain bindings and run the SDK suite
#   fork       run the mainnet-fork lifecycle, SDK and hand-off scripts
#              (needs FORKING_URL in the environment and --fork-ref)
#   drift      keep-core vendored-fallback check against artifacts from this head
#              (needs --keepcore)
#
# The tbtc-v2 worktree needs solidity/node_modules and typescript/node_modules.
# Output goes to $OUT (default /dev/shm/reservations-verify-<time>). Nothing in
# the environment is printed; URLs are stripped from every log excerpt.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tbtc=""
kc=""
fork_ref=""
steps=""
old_head=""
new_head=""
reference=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tbtc)
      tbtc="$2"
      shift 2
      ;;
    --keepcore)
      kc="$2"
      shift 2
      ;;
    --fork-ref)
      fork_ref="$2"
      shift 2
      ;;
    --old-head)
      old_head="$2"
      shift 2
      ;;
    --new-head)
      new_head="$2"
      shift 2
      ;;
    --reference)
      reference="$2"
      shift 2
      ;;
    --steps)
      steps="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done
[ -d "$tbtc/solidity" ] || {
  echo "--tbtc must point at a tbtc-v2 worktree" >&2
  exit 2
}
if [ -z "$steps" ]; then
  steps="killset,full,survivors,exclusions,sdk"
  [ -n "$old_head" ] && [ -n "$new_head" ] && steps="reconcile,$steps"
  [ -n "$fork_ref" ] && [ -n "${FORKING_URL:-}" ] && steps="$steps,fork"
  [ -n "$kc" ] && steps="$steps,drift"
fi
OUT="${OUT:-/dev/shm/reservations-verify-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
sol="$tbtc/solidity"
hh_env=(env -u FORKING_URL -u FORKING_BLOCK USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true NODE_OPTIONS=--max-old-space-size=4096)
strip() { sed -E 's#(https?|wss?)://[^ "'"'"']+#<url>#g'; }
declare -a rows
record() { rows+=("| $1 | $2 | $3 |"); }
has() { case ",$steps," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

mocha_count() { # log word -> the number before "passing"/"failing"/"pending", 0 when absent
  local n
  n=$(grep -aoE "^\s+[0-9]+ $2" "$1" | grep -oE '[0-9]+' | tail -1)
  echo "${n:-0}"
}
mocha_summary() { # log -> "N passing, M failing, K pending"
  echo "$(mocha_count "$1" passing) passing, $(mocha_count "$1" failing) failing, $(mocha_count "$1" pending) pending"
}
mocha_verdict() { # log min -> PASS only with no failures and at least <min> passing tests
  # "0 passing, 0 failing" (the suite never ran, or a filter matched no file) is not a pass.
  if [ "$(mocha_count "$1" failing)" = 0 ] && [ "$(mocha_count "$1" passing)" -ge "$2" ]; then echo PASS; else echo FAIL; fi
}
# Floors for the number of passing tests; a smaller count means part of the suite did not run.
min_killset="${MIN_KILLSET:-200}"
min_full="${MIN_FULL:-3000}"
min_sdk="${MIN_SDK:-500}"

if has reconcile; then
  [ -n "$old_head" ] && [ -n "$new_head" ] || {
    echo "reconcile step needs --old-head and --new-head" >&2
    exit 2
  }
  bash "$here/reconcile.sh" "$tbtc" "$old_head" "$new_head" "$reference" "$OUT/reconcile" > "$OUT/reconcile.log" 2>&1
  rrc=$?
  record "reconcile" "$([ "$rrc" = 0 ] && echo PASS || echo FAIL)" "$(grep -E '^  (formatting|real change|not clean)|^contracts at' "$OUT/reconcile.log" | tr -s ' ' | tr '\n' ';') exit $rrc"
fi

if has killset; then
  (cd "$sol" && "${hh_env[@]}" npx hardhat test $(cat "$here/killset.txt")) > "$OUT/killset.log" 2>&1
  s=$(mocha_summary "$OUT/killset.log")
  record "kill set" "$(mocha_verdict "$OUT/killset.log" "$min_killset")" "$s (needs at least $min_killset passing)"
fi

if has full; then
  (cd "$sol" && "${hh_env[@]}" npx hardhat test) > "$OUT/full.log" 2>&1
  s=$(mocha_summary "$OUT/full.log")
  record "full Hardhat suite" "$(mocha_verdict "$OUT/full.log" "$min_full")" "$s (needs at least $min_full passing; failures: $(grep -aE '^  [0-9]+\) ' "$OUT/full.log" | head -3 | tr '\n' ';'))"
fi

if has survivors; then
  ids=$(paste -sd, "$here/survivors.txt")
  res="$OUT/survivors.json"
  rm -f "$res"
  T=test/bridge
  # The isPrivileged continuation lines are indented 16 after the repository Prettier pass.
  ONLY="$ids" RES_INDENT="${RES_INDENT:-16}" \
    KILLSET="$T/Bridge.ReservationStrandingLibrary.test.ts $T/Bridge.ReservationThirdPartyReanchorHolds.test.ts $T/Bridge.ReservationAcceptanceAuthorization.test.ts" \
    node "$here/mutate.cjs" "$tbtc" 0 1 "$res" > "$OUT/survivors.out" 2>&1
  mrc=$?
  want=$(grep -c . "$here/survivors.txt")
  if [ "$mrc" = 3 ]; then
    record "survivor mutants killed" FAIL "unmutated baseline is not green; no mutant ran ($(tail -1 "$OUT/survivors.out"))"
  elif [ -f "$res" ]; then
    killed=$(node -e 'const r=require(process.argv[1]);console.log(Object.values(r).filter(x=>x.verdict==="KILLED").length)' "$res")
    total=$(node -e 'console.log(Object.keys(require(process.argv[1])).length)' "$res")
    bad=$(node -e 'const r=require(process.argv[1]);console.log(Object.entries(r).filter(([,x])=>x.verdict!=="KILLED").map(([k,x])=>k+":"+x.verdict).join(" "))' "$res")
    # Every listed mutant has to be present, and each has to be KILLED with a named failing test.
    if [ -z "$bad" ] && [ "$total" = "$want" ] && [ "$killed" -gt 0 ]; then v=PASS; else v=FAIL; fi
    record "survivor mutants killed" "$v" "$killed/$want killed ($total ran) ${bad}"
  else
    record "survivor mutants killed" FAIL "no result file"
  fi
  if ! git -C "$tbtc" diff --quiet -- solidity/contracts; then
    record "contracts restored after mutation" FAIL "git diff on solidity/contracts is not empty"
  fi
fi

if has exclusions; then
  # The coverage half needs a coverage-final.json; the mutation half needs the
  # mutants JSON the survivors step writes. Each half runs on its own when its
  # input is there, and a missing input is a FAIL rather than a silent pass.
  cov="${COVERAGE_REPORT:-$sol/coverage/coverage-final.json}"
  mut="${MUTANTS_JSON:-$OUT/survivors.json}"
  ec=0
  detail=""
  if [ -f "$cov" ]; then
    node "$here/check-exclusions.js" coverage --coverage "$cov" > "$OUT/exclusions-coverage.log" 2>&1
    crc=$?
    # The count comes from the checker's own total line, not from counting the
    # listed lines, so the header of the listing is not counted as a gap.
    detail="coverage: $(sed -nE 's/^  total: ([0-9]+) uncovered statement.*/\1/p' "$OUT/exclusions-coverage.log") uncovered statement(s) without a written reason"
    [ "$crc" -ne 0 ] && ec=1
  else
    detail="coverage: no report at $cov"
    ec=1
  fi
  if [ -f "$mut" ]; then
    node "$here/check-exclusions.js" mutation --mutants "$mut" > "$OUT/exclusions-mutation.log" 2>&1
    mrc=$?
    detail="$detail; mutation: $(sed -nE 's/^  total: ([0-9]+) surviving mutant.*/\1/p' "$OUT/exclusions-mutation.log") surviving mutant(s) without a written reason"
    [ "$mrc" -ne 0 ] && ec=1
  else
    detail="$detail; mutation: no mutants file at $mut"
    ec=1
  fi
  v=$([ "$ec" -eq 0 ] && echo PASS || echo FAIL)
  record "known exclusions accounted for" "$v" "$detail"
fi

if has sdk; then
  ts="$tbtc/typescript"
  (
    cd "$ts" || exit 1
    for c in $(eval echo "$(node -e 'console.log(require("./package.json").config.contracts)')"); do
      npx typechain --target ethers-v5 --out-dir ./typechain "$c" > /dev/null 2>&1 || echo "typechain failed: $c"
    done
    rm -f ./typechain/index.ts
    node ./scripts/rewrite-typechain-ethers-imports.js > /dev/null 2>&1
    NODE_OPTIONS=--max-old-space-size=4096 npx mocha --exit --recursive 'test/**/*.test.ts'
  ) > "$OUT/sdk.log" 2>&1
  s=$(mocha_summary "$OUT/sdk.log")
  record "SDK suite" "$(mocha_verdict "$OUT/sdk.log" "$min_sdk")" "$s (needs at least $min_sdk passing)"
fi

if has fork; then
  [ -n "$fork_ref" ] || {
    echo "fork step needs --fork-ref" >&2
    exit 2
  }
  [ -n "${FORKING_URL:-}" ] || {
    echo "fork step needs FORKING_URL in the environment" >&2
    exit 2
  }
  tmp=()
  for f in reservations-fork-common reservations-fork-dryrun reservations-fork-handoff reservations-fork-sdk; do
    git -C "$tbtc" show "$fork_ref:solidity/scripts/$f.ts" > "$sol/scripts/$f.ts" && tmp+=("$sol/scripts/$f.ts")
  done
  (cd "$sol" && env FORKING_BLOCK="${FORKING_BLOCK:-26154824}" \
    RESERVATION_PER_WALLET_CAP_SATS=2000000 RESERVATION_SINGLE_AMOUNT_CAP_SATS=2000000 \
    RESERVATION_MAX_ACTIVE=5 RESERVATION_MAX_THIRD_PARTY_REANCHOR_HOLDS=1 \
    RESERVATION_HANDOFF_RESERVE_WALLETS=1 RESERVATION_MIN_AMOUNT_SATS=10000 \
    RESERVATION_TX_MAX_FEE_SATS=1000 RESERVATION_TERM_SECONDS=12960000 \
    RESERVATION_DISSOLUTION_DELAY_SECONDS=86400 RESERVATION_MAX_TOTAL_AMOUNT_SATS=10000000 \
    RESERVATION_MAX_PER_WALLET=1 RESERVATION_ACTION_TIMEOUT_SECONDS=86400 \
    RESERVATION_RENEWAL_WINDOW_SECONDS=86400 DRYRUN_LIFECYCLE=1 DRYRUN_SDK=1 DRYRUN_HANDOFF=1 \
    NODE_OPTIONS=--max-old-space-size=4096 \
    npx hardhat run --network hardhat scripts/reservations-fork-dryrun.ts) > "$OUT/fork.raw" 2>&1
  strip < "$OUT/fork.raw" > "$OUT/fork.log"
  rm -f "$OUT/fork.raw"
  for f in "${tmp[@]}"; do rm -f "$f"; done
  rm -f "$sol"/dryrun-artifacts/reservations-fork-*-"${FORKING_BLOCK:-26154824}".json
  rmdir "$sol/dryrun-artifacts" 2> /dev/null
  s=$(grep -aoE 'Summary: [0-9]+ pass / [0-9]+ fail / [0-9]+ skip' "$OUT/fork.log" | tail -1)
  fp=$(echo "$s" | sed -nE 's/^Summary: ([0-9]+) pass.*/\1/p')
  ff=$(echo "$s" | sed -nE 's/.* \/ ([0-9]+) fail.*/\1/p')
  min_fork="${MIN_FORK:-20}"
  if [ -n "$fp" ] && [ "$fp" -ge "$min_fork" ] && [ "${ff:-1}" = 0 ]; then v=PASS; else v=FAIL; fi
  record "fork run" "$v" "${s:-no summary} (needs at least $min_fork pass)"
fi

if has drift; then
  [ -n "$kc" ] || {
    echo "drift step needs --keepcore" >&2
    exit 2
  }
  # The survivors step leaves artifacts of the last mutant behind; rebuild from the restored source.
  (cd "$sol" && "${hh_env[@]}" npx hardhat compile) > "$OUT/drift-compile.log" 2>&1
  art="$OUT/artifacts"
  mkdir -p "$art"
  b="$sol/build/contracts"
  cp "$b/bridge/Bridge.sol/Bridge.json" "$b/bridge/ReservationRouter.sol/ReservationRouter.json" \
    "$b/vault/ReservationVault.sol/ReservationVault.json" \
    "$b/bridge/WalletProposalValidator.sol/WalletProposalValidator.json" "$art/" 2> "$OUT/drift.log"
  GOTOOLCHAIN="${GOTOOLCHAIN:-go1.25.7}" GOFLAGS=-mod=readonly \
    make -C "$kc/pkg/chain/ethereum/tbtc/gen" artifacts_dir="$art" verify-vendored-fallback 2>&1 | strip >> "$OUT/drift.log"
  rc=${PIPESTATUS[0]}
  n=$(grep -c ' matches the real ' "$OUT/drift.log")
  [ "$rc" = 0 ] && [ "$n" = 8 ] && v=PASS || v=FAIL
  record "keep-core drift check" "$v" "$n of 8 comparisons match, exit $rc"
fi

echo
echo "| Check | Result | Detail |"
echo "|---|---|---|"
printf '%s\n' "${rows[@]}"
echo
echo "logs: $OUT"
printf '%s\n' "${rows[@]}" | grep -q '| FAIL |' && exit 1
exit 0
