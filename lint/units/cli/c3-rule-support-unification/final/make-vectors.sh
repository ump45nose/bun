#!/bin/sh
# Rebuilds vectors/vectors-<rule>.json and DIFFERENCES.txt from every case list, through the probe and ESLint at the pin.
# usage: sh make-vectors.sh [probe binary] [dir of eslint-pin]
cd "$(dirname "$0")"
PROBE=${1:-/tmp/rsu/fin/lintprobe}
PIN=${2:-/tmp/cmp-probe/eslint-pin}
C=../../rules-comparisons/cases
B=../../rules-expression-equality-bottomup/vectors
E=../../rules-expression-equality/cases
mkdir -p vectors
run() { r=$1; shift; node oracle/diff.cjs $r --probe $PROBE --eslint $PIN --show --out vectors/vectors-$r.json cases/upstream-$r.json $(ls cases/extra-$r.json cases/more-$r.*.json 2>/dev/null) "$@"; }
{
run no-debugger
run no-sparse-arrays
run no-empty-pattern
run no-dupe-keys
run no-dupe-class-members
run no-compare-neg-zero $C/final-ncnz.txt $C/ncnz.txt
run use-isnan $C/final-use-isnan.txt $C/isnan.txt $C/shadow.txt $C/chain.txt $C/dyn.txt $C/uni.txt $C/smoke.txt $C/naive.txt $C/html.txt $C/extra-pd.txt
run valid-typeof $C/final-valid-typeof.txt $C/typeof.txt $C/shadow.txt $C/uni.txt $C/smoke.txt
run no-unsafe-negation $C/final-no-unsafe-negation.txt $C/nun.txt $C/extra-nun.txt
run no-duplicate-case $B/vectors-no-duplicate-case.json $E/dup-diff.json $E/dup-edge.json $E/dup-eslint-tests.json $E/dup-final.json $E/dup-final-module.json
run no-self-assign $B/vectors-no-self-assign.json $E/self-edge.json $E/self-eslint-tests.json $E/self-static.json
} > DIFFERENCES.txt 2>&1
grep -E '^[a-z-]+: [0-9]+ cases' DIFFERENCES.txt
# Marks the vectors whose code is a case of ESLint's own test of the rule: `"eslintTest": true`.
for f in vectors/vectors-*.json; do r=${f#vectors/vectors-}; r=${r%.json}; node oracle/extract.cjs $r --all > /tmp/c3u-all-$r.json && node oracle/mark-origin.cjs $f /tmp/c3u-all-$r.json; done
