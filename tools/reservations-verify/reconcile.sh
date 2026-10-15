#!/usr/bin/env bash
# After the public PR head moved: are its changes to solidity/contracts and solidity/deploy
# present in the head under test, once formatting is ignored?
#
# usage: reconcile.sh <tbtc-v2 worktree> <old-pr-ref> <new-pr-ref> [<audited-ref>] [<out dir>]
#
# Every file in those two directories is exported at four refs (the old and new PR head,
# the worktree's HEAD, and the audited ref when given) and run through the Prettier of the
# worktree, using the configuration of the new PR head, so that formatting cannot hide or
# fake a difference. Then, for each file the PR changed between <old-pr-ref> and <new-pr-ref>:
#   - identical after normalizing           -> formatting only
#   - three-way merge (base old PR, ours the head under test, theirs new PR) leaves the
#     head's file unchanged                 -> change already present
#   - anything else                         -> listed as not clean
# A not-clean contract file (*.sol) makes the script exit 1; a not-clean deploy script is
# listed for a human to read. With <audited-ref>, the normalized contracts at that ref and at
# the head under test are compared, every differing file is listed and the script exits 1.
set -u
tbtc="$1"; old="$2"; new="$3"; audited="${4:-}"; out="${5:-/dev/shm/reservations-reconcile-$(date +%Y%m%d-%H%M%S)}"
sol="$tbtc/solidity"
[ -x "$sol/node_modules/.bin/prettier" ] || { echo "prettier not found in $sol/node_modules" >&2; exit 2; }
git -C "$tbtc" rev-parse --verify -q "$old^{commit}" >/dev/null && git -C "$tbtc" rev-parse --verify -q "$new^{commit}" >/dev/null \
  || { echo "unknown ref" >&2; exit 2; }
if [ -n "$(ls -A "$out" 2>/dev/null)" ]; then echo "output directory $out is not empty; pass a fresh one" >&2; exit 2; fi
mkdir -p "$out"
line_sha=$(git -C "$tbtc" rev-parse HEAD)

export_ref() { # label ref
  mkdir -p "$out/$1"
  git -C "$tbtc" archive "$2" solidity/contracts solidity/deploy | tar -x -C "$out/$1"
  git -C "$tbtc" show "$new:solidity/.prettierrc.js" >"$out/$1/solidity/.prettierrc.js"
  git -C "$tbtc" show "$new:solidity/.prettierignore" >"$out/$1/solidity/.prettierignore" 2>/dev/null || true
  ln -s "$sol/node_modules" "$out/$1/solidity/node_modules"
  (cd "$out/$1/solidity" && ./node_modules/.bin/prettier --write "contracts/**/*.sol" "deploy/**/*.ts" >"$out/$1.prettier.log" 2>&1) \
    || { echo "prettier failed on $2; see $out/$1.prettier.log" >&2; exit 2; }
}
export_ref old "$old"; export_ref new "$new"; export_ref line "$line_sha"
[ -n "$audited" ] && export_ref audited "$audited"

changed=$(git -C "$tbtc" diff --name-only "$old" "$new" -- solidity/contracts solidity/deploy | sed 's#^solidity/##')
total=0; fmt=0; present=0; notclean=0; notclean_sol=0; : >"$out/not-clean.txt"
for g in $changed; do
  total=$((total+1))
  o="$out/old/solidity/$g"; n="$out/new/solidity/$g"; l="$out/line/solidity/$g"
  if [ ! -f "$n" ]; then # deleted on the PR side
    if [ -f "$l" ]; then echo "$g: deleted by the PR, still in the head under test" >>"$out/not-clean.txt"; notclean=$((notclean+1)); case "$g" in *.sol) notclean_sol=$((notclean_sol+1)) ;; esac
    else present=$((present+1)); fi
    continue
  fi
  if [ -f "$o" ] && cmp -s "$o" "$n"; then fmt=$((fmt+1)); continue; fi
  if [ ! -f "$l" ]; then echo "$g: added by the PR, missing in the head under test" >>"$out/not-clean.txt"; notclean=$((notclean+1)); case "$g" in *.sol) notclean_sol=$((notclean_sol+1)) ;; esac; continue; fi
  if [ ! -f "$o" ]; then # new file on the PR side: present only when identical
    if cmp -s "$l" "$n"; then present=$((present+1)); else echo "$g: added by the PR, differs in the head under test" >>"$out/not-clean.txt"; notclean=$((notclean+1)); case "$g" in *.sol) notclean_sol=$((notclean_sol+1)) ;; esac; fi
    continue
  fi
  if git merge-file -p "$l" "$o" "$n" >"$out/merged.tmp" 2>/dev/null && cmp -s "$out/merged.tmp" "$l"; then
    present=$((present+1))
  else
    echo "$g: PR change is not in the head under test (or conflicts with it)" >>"$out/not-clean.txt"; notclean=$((notclean+1)); case "$g" in *.sol) notclean_sol=$((notclean_sol+1)) ;; esac
  fi
done

echo "files the PR changed under contracts and deploy ($old to $new): $total"
echo "  formatting only (identical after normalizing): $fmt"
echo "  real change, already present in $(echo "$line_sha" | cut -c1-9): $present"
echo "  not clean: $notclean (contracts: $notclean_sol)"
[ -s "$out/not-clean.txt" ] && sed 's/^/    /' "$out/not-clean.txt"
aud_diff=0
if [ -n "$audited" ]; then
  aud_diff=$(diff -rq "$out/audited/solidity/contracts" "$out/line/solidity/contracts" | wc -l | tr -d ' ')
  echo "contracts at $audited against the head under test, both normalized: $aud_diff differing files"
  [ "$aud_diff" != 0 ] && diff -rq "$out/audited/solidity/contracts" "$out/line/solidity/contracts" | sed -E "s#$out/##g; s/^/    /"
fi
echo "details: $out"
[ "$notclean_sol" = 0 ] && [ "$aud_diff" = 0 ] || exit 1
exit 0
