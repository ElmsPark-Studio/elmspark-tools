#!/usr/bin/env bash
# Self-test for verify-overflow.mjs. Every case states the verdict it MUST give,
# so the gate is negative-controlled: it has to be seen failing on purpose before
# a clean run on real pages means anything.
#
#   bash fixtures/overflow/run.sh
#
# Exit 0 = all cases behaved. Exit 1 = the tool's behaviour has changed.
set -u
cd "$(dirname "$0")"
TOOL=../../verify-overflow.mjs
declare -a CASES=(
  "clean.html|PASS|nothing wide, nothing clipped"
  "ellipsis-benign.html|PASS|deliberate single-line ellipsis on TEXT is not a defect"
  "ellipsis-hiding-element.html|FAIL|ellipsis cannot ellipsise an ELEMENT child, so this really is cut off"
  "real-clip.html|FAIL|classic silent clipping, the bug this tool exists for"
)
rc=0
for c in "${CASES[@]}"; do
  IFS='|' read -r file want why <<< "$c"
  got=$(node "$TOOL" "$file" --width=320,375 2>&1 | grep -oE '^(PASS|FAIL)' | head -1)
  if [ "$got" = "$want" ]; then
    printf '  ok    %-32s %s\n' "$file" "$want"
  else
    printf '  FAIL  %-32s wanted %s, got %s\n        (%s)\n' "$file" "$want" "${got:-<no verdict>}" "$why"
    rc=1
  fi
done
[ $rc -eq 0 ] && echo && echo "all 4 cases behaved" || { echo; echo "verify-overflow.mjs behaviour has CHANGED"; }
exit $rc
