#!/usr/bin/env bash
# Targeted re-verification of the reservation contracts and SDK on one tbtc-v2 head.
#
# usage: run.sh --tbtc <tbtc-v2 worktree> [--keepcore <keep-core worktree>]
#               [--fork-ref <git ref holding the fork scripts>] [--steps a,b,c]
#
# steps (default: all that the given arguments allow):
#   killset    compile and run the reservation kill set
#   full       run the full Hardhat suite (one flaky cross-chain test is known)
#   survivors  re-apply the mutants listed in survivors.txt against the kill set
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
tbtc=""; kc=""; fork_ref=""; steps=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tbtc) tbtc="$2"; shift 2 ;;
    --keepcore) kc="$2"; shift 2 ;;
    --fork-ref) fork_ref="$2"; shift 2 ;;
    --steps) steps="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -d "$tbtc/solidity" ] || { echo "--tbtc must point at a tbtc-v2 worktree" >&2; exit 2; }
if [ -z "$steps" ]; then
  steps="killset,full,survivors,sdk"
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

mocha_summary() { # log -> "N passing, M failing, K pending"
  local p f k
  p=$(grep -aoE '^\s+[0-9]+ passing' "$1" | grep -oE '[0-9]+' | tail -1)
  f=$(grep -aoE '^\s+[0-9]+ failing' "$1" | grep -oE '[0-9]+' | tail -1)
  k=$(grep -aoE '^\s+[0-9]+ pending' "$1" | grep -oE '[0-9]+' | tail -1)
  echo "${p:-0} passing, ${f:-0} failing, ${k:-0} pending"
}

if has killset; then
  ( cd "$sol" && "${hh_env[@]}" npx hardhat test $(cat "$here/killset.txt") ) >"$OUT/killset.log" 2>&1
  s=$(mocha_summary "$OUT/killset.log")
  case "$s" in *" 0 failing"*) v=PASS ;; *) v=FAIL ;; esac
  record "kill set" "$v" "$s"
fi

if has full; then
  ( cd "$sol" && "${hh_env[@]}" npx hardhat test ) >"$OUT/full.log" 2>&1
  s=$(mocha_summary "$OUT/full.log")
  case "$s" in *" 0 failing"*) v=PASS ;; *) v=FAIL ;; esac
  record "full Hardhat suite" "$v" "$s (failures: $(grep -aE '^  [0-9]+\) ' "$OUT/full.log" | head -3 | tr '\n' ';'))"
fi

if has survivors; then
  ids=$(paste -sd, "$here/survivors.txt")
  res="$OUT/survivors.json"; rm -f "$res"
  T=test/bridge
  # The isPrivileged continuation lines are indented 16 after the repository Prettier pass.
  ONLY="$ids" RES_INDENT="${RES_INDENT:-16}" \
    KILLSET="$T/Bridge.ReservationStrandingLibrary.test.ts $T/Bridge.ReservationThirdPartyReanchorHolds.test.ts $T/Bridge.ReservationAcceptanceAuthorization.test.ts" \
    node "$here/mutate.cjs" "$tbtc" 0 1 "$res" >"$OUT/survivors.out" 2>&1
  if [ -f "$res" ]; then
    killed=$(node -e 'const r=require(process.argv[1]);console.log(Object.values(r).filter(x=>x.verdict==="KILLED").length+"/"+Object.keys(r).length)' "$res")
    bad=$(node -e 'const r=require(process.argv[1]);console.log(Object.entries(r).filter(([,x])=>x.verdict!=="KILLED").map(([k,x])=>k+":"+x.verdict).join(" "))' "$res")
    [ -z "$bad" ] && v=PASS || v=FAIL
    record "survivor mutants killed" "$v" "$killed ${bad}"
  else
    record "survivor mutants killed" FAIL "no result file"
  fi
  if ! git -C "$tbtc" diff --quiet -- solidity/contracts; then
    record "contracts restored after mutation" FAIL "git diff on solidity/contracts is not empty"
  fi
fi

if has sdk; then
  ts="$tbtc/typescript"
  (
    cd "$ts" || exit 1
    for c in $(eval echo "$(node -e 'console.log(require("./package.json").config.contracts)')"); do
      npx typechain --target ethers-v5 --out-dir ./typechain "$c" >/dev/null 2>&1 || echo "typechain failed: $c"
    done
    rm -f ./typechain/index.ts
    node ./scripts/rewrite-typechain-ethers-imports.js >/dev/null 2>&1
    NODE_OPTIONS=--max-old-space-size=4096 npx mocha --exit --recursive 'test/**/*.test.ts'
  ) >"$OUT/sdk.log" 2>&1
  s=$(mocha_summary "$OUT/sdk.log")
  case "$s" in *" 0 failing"*) v=PASS ;; *) v=FAIL ;; esac
  record "SDK suite" "$v" "$s"
fi

if has fork; then
  [ -n "$fork_ref" ] || { echo "fork step needs --fork-ref" >&2; exit 2; }
  [ -n "${FORKING_URL:-}" ] || { echo "fork step needs FORKING_URL in the environment" >&2; exit 2; }
  tmp=()
  for f in reservations-fork-common reservations-fork-dryrun reservations-fork-handoff reservations-fork-sdk; do
    git -C "$tbtc" show "$fork_ref:solidity/scripts/$f.ts" >"$sol/scripts/$f.ts" && tmp+=("$sol/scripts/$f.ts")
  done
  ( cd "$sol" && env FORKING_BLOCK="${FORKING_BLOCK:-26154824}" \
      RESERVATION_PER_WALLET_CAP_SATS=2000000 RESERVATION_SINGLE_AMOUNT_CAP_SATS=2000000 \
      RESERVATION_MAX_ACTIVE=5 RESERVATION_MAX_THIRD_PARTY_REANCHOR_HOLDS=1 \
      RESERVATION_HANDOFF_RESERVE_WALLETS=1 RESERVATION_MIN_AMOUNT_SATS=10000 \
      RESERVATION_TX_MAX_FEE_SATS=1000 RESERVATION_TERM_SECONDS=12960000 \
      RESERVATION_DISSOLUTION_DELAY_SECONDS=86400 RESERVATION_MAX_TOTAL_AMOUNT_SATS=10000000 \
      RESERVATION_MAX_PER_WALLET=1 RESERVATION_ACTION_TIMEOUT_SECONDS=86400 \
      RESERVATION_RENEWAL_WINDOW_SECONDS=86400 DRYRUN_LIFECYCLE=1 DRYRUN_SDK=1 DRYRUN_HANDOFF=1 \
      NODE_OPTIONS=--max-old-space-size=4096 \
      npx hardhat run --network hardhat scripts/reservations-fork-dryrun.ts ) >"$OUT/fork.raw" 2>&1
  strip <"$OUT/fork.raw" >"$OUT/fork.log"; rm -f "$OUT/fork.raw"
  for f in "${tmp[@]}"; do rm -f "$f"; done
  rm -f "$sol"/dryrun-artifacts/reservations-fork-*-"${FORKING_BLOCK:-26154824}".json
  rmdir "$sol/dryrun-artifacts" 2>/dev/null
  s=$(grep -aoE 'Summary: [0-9]+ pass / [0-9]+ fail / [0-9]+ skip' "$OUT/fork.log" | tail -1)
  case "$s" in *" 0 fail"*) v=PASS ;; *) v=FAIL ;; esac
  record "fork run" "$v" "${s:-no summary}"
fi

if has drift; then
  [ -n "$kc" ] || { echo "drift step needs --keepcore" >&2; exit 2; }
  # The survivors step leaves artifacts of the last mutant behind; rebuild from the restored source.
  ( cd "$sol" && "${hh_env[@]}" npx hardhat compile ) >"$OUT/drift-compile.log" 2>&1
  art="$OUT/artifacts"; mkdir -p "$art"
  b="$sol/build/contracts"
  cp "$b/bridge/Bridge.sol/Bridge.json" "$b/bridge/ReservationRouter.sol/ReservationRouter.json" \
     "$b/vault/ReservationVault.sol/ReservationVault.json" \
     "$b/bridge/WalletProposalValidator.sol/WalletProposalValidator.json" "$art/" 2>"$OUT/drift.log"
  GOTOOLCHAIN="${GOTOOLCHAIN:-go1.25.7}" GOFLAGS=-mod=readonly \
    make -C "$kc/pkg/chain/ethereum/tbtc/gen" artifacts_dir="$art" verify-vendored-fallback 2>&1 | strip >>"$OUT/drift.log"
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
