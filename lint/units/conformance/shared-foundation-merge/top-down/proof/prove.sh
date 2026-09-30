#!/bin/bash
# The whole proof of the merged foundation, from the reference clone and the notes alone. No network.
# 1. builds the ground-truth programs with the local Go toolchain and checks the merged set against them,
# 2. copies the notes twice, once unchanged and once with every copy of a foundation module replaced by the merged set,
# 3. runs every verifier of the upper prototypes in both copies and compares what they print,
# 4. runs the parts of the assembly against what the other passes recorded from the reference.
# usage: prove.sh [work directory, default /tmp/sfm-proof]
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
TOP=$(cd "$HERE/.." && pwd)
NOTES=$(cd "$TOP/../.." && pwd)
REF=${REF:-/workspace/ref/typescript-go}
W=${1:-/tmp/sfm-proof}
mkdir -p "$W"

python3 "$TOP/groundtruth/build.py" "$REF" "$W/gt"
"$W/gt/gt" tables "$W/gotab.txt"
"$W/gt/gt" vectors "$W/govec.jsonl"
bun "$TOP/groundtruth/gen_tables.ts" "$W/gotab.txt" "$W/unicode_tables.ts"
cmp "$W/unicode_tables.ts" "$TOP/runner/unicode_tables.ts" && echo "runner/unicode_tables.ts is what the tables of this toolchain give"
zcat "$TOP/vectors/gotab.txt.gz" | cmp - "$W/gotab.txt" && zcat "$TOP/vectors/govec.jsonl.gz" | cmp - "$W/govec.jsonl" && echo "the stored tables and vectors are what this toolchain gives"
bun "$TOP/groundtruth/make_test_vectors.ts" "$W/govec.jsonl" "$W/govec-test.jsonl" 40 > /dev/null
zcat "$TOP/vectors/govec-test.jsonl.gz" | cmp - "$W/govec-test.jsonl" && echo "the stored vectors of the fast test are every 40th row of them"
bun "$HERE/verify_foundation.ts" "$W/gotab.txt" "$W/govec.jsonl" | tail -14
bun "$HERE/foundation_test_cost.ts" "$TOP/vectors/govec-test.jsonl.gz"
bun "$HERE/foundation_test_cost.ts" "$TOP/vectors/govec-test.jsonl.gz" small
bun "$HERE/comment_runs.ts" "$TOP"/runner/*.ts | tail -1

python3 "$NOTES/error-baseline-format/groundtruth/build.py" "$REF" "$W/ebf-gt"
mkdir -p "$W/im-prefix"
cp "$NOTES/instance-materialisation/groundtruth/prefixes_main.go.txt" "$W/im-prefix/main.go"
printf 'module gt\n\ngo 1.24\n' > "$W/im-prefix/go.mod"
(cd "$W/im-prefix" && GOTOOLCHAIN=local GOFLAGS=-mod=mod GOPROXY=off go build -o gt .)
export EBGT="$W/ebf-gt/gt" IMPREFIX="$W/im-prefix/gt"

rm -rf "$W/orig" "$W/overlay" "$W/out-orig" "$W/out-overlay"
cp -a "$NOTES" "$W/orig"
python3 "$HERE/make_overlay.py" "$NOTES" "$W/overlay" > "$W/overlay.log"
tail -14 "$W/overlay.log"
bash "$HERE/run_all.sh" "$W/orig" "$W/out-orig" > "$W/run-orig.log" 2>&1
bash "$HERE/run_all.sh" "$W/overlay" "$W/out-overlay" > "$W/run-overlay.log" 2>&1
bash "$HERE/compare_runs.sh" "$W/out-orig" "$W/out-overlay"

for t in orig overlay; do
  (cd "$W/$t/test-file-and-sweep/top-down" && bun sweep.ts --check ./replay-check.ts --report "$W/out-$t/sweep.json" > "$W/out-$t/sweep.txt" 2>&1 || true)
  sed -n 9,10p "$W/out-$t/sweep.txt"
done
bun "$HERE/crosscheck_roots.ts" "$W/overlay" | head -3
bun "$HERE/crosscheck_vectors.ts" "$W/overlay" | grep "^=="
bun "$HERE/crosscheck_directives.ts" "$W/overlay" "$REF" | head -4
for t in orig overlay; do
  echo "names that are not ASCII through the writer, $t: $(bun "$HERE/nonascii_names.ts" "$W/$t" "$EBGT" "$W/writer-names-$t.jsonl" | head -1)"
done
zcat "$TOP/vectors/writer-names.jsonl.gz" | cmp - "$W/writer-names-overlay.jsonl" && echo "the stored vectors of the names are what the reference gives"
echo "the same from the stored vectors, without Go: $(bun "$HERE/nonascii_names.ts" "$W/overlay" "$TOP/vectors/writer-names.jsonl.gz" | head -1)"
bun "$HERE/corpus_invariants.ts" "$W/overlay" "$REF" | head -3
