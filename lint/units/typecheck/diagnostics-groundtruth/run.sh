#!/bin/sh
# Differential check of the Rust prototype in ../diagnostics-scratch/crate against typescript-go itself: usage run.sh [golden|go] [work dir].
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
MODE=${1:-golden}
W=${2:-/tmp/tcdiag-gt}
REF=/workspace/ref/typescript-go
GO=${GO126:-/tmp/rr/go126}
mkdir -p "$W/mod/internal" "$W/mod/cmd/gt" "$W/crate"
if [ "$MODE" = go ]; then
  test -x "$GO/bin/go" || { echo "Go 1.26 is missing: run ../ts-dump-and-test-importer/groundtruth/build.sh first"; exit 1; }
  for p in parser ast collections core debug diagnostics scanner stringutil tspath locale spanmap json repo jsnum diagnosticwriter; do
    rm -rf "$W/mod/internal/$p"
    cp -r "$REF/internal/$p" "$W/mod/internal/$p"
    find "$W/mod/internal/$p" -name "*_test.go" -delete
  done
  cp "$HERE/gt/main.go" "$W/mod/cmd/gt/main.go"
  (cd "$W" && bun "$HERE/gt/gen_bycode.mjs" "$W/mod/cmd/gt/zz_bycode.go")
  D=$(dirname "$GO")/deps
  printf 'module github.com/microsoft/typescript-go\n\ngo 1.26\n\nrequire (\n\tgithub.com/go-json-experiment/json v0.0.0\n\tgithub.com/zeebo/xxh3 v1.1.0\n\tgithub.com/klauspost/cpuid/v2 v2.2.10\n\tgolang.org/x/sync v0.21.0\n\tgolang.org/x/text v0.38.0\n)\n\nreplace github.com/go-json-experiment/json => %s/json\nreplace github.com/zeebo/xxh3 => %s/xxh3\nreplace github.com/klauspost/cpuid/v2 => %s/cpuid\nreplace golang.org/x/sync => %s/sync\nreplace golang.org/x/text => %s/text\n' "$D" "$D" "$D" "$D" "$D" > "$W/mod/go.mod"
  (cd "$W/mod" && GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off PATH="$GO/bin:$PATH" GOROOT="$GO" GOFLAGS=-mod=mod go build -o "$W/gt" ./cmd/gt)
  (cd "$W" && bun "$HERE/diff/genvec.mjs" "$W/vectors.txt")
  "$W/gt" < "$W/vectors.txt" > "$W/go.out"
  (cd "$W" && bun "$HERE/diff/genext.mjs" "$W/vectors-external.txt" "$W/vectors-keys.txt")
  "$W/gt" < "$W/vectors-external.txt" > "$W/go-external.out"
  "$W/gt" < "$W/vectors-keys.txt" > "$W/go-keys.out"
else
  gzip -dc "$HERE/golden/vectors.txt.gz" > "$W/vectors.txt"
  gzip -dc "$HERE/golden/go.out.gz" > "$W/go.out"
fi
rm -rf "$W/crate"
cp -r "$HERE/../diagnostics-scratch/crate" "$W/crate"
if [ "${PDQSORT:-1}" = 1 ]; then cp "$HERE/diff/slices.rs" "$W/crate/slices.rs"; fi
(cd "$W/crate" && rustc --edition 2024 --crate-type rlib --crate-name diagproto -C opt-level=1 -o "$W/libdiagproto.rlib" lib.rs)
rustc --edition 2024 -C opt-level=1 --extern diagproto="$W/libdiagproto.rlib" -o "$W/driver" "$HERE/diff/driver.rs"
"$W/driver" < "$W/vectors.txt" > "$W/rust.out"
grep -v -E '^(PRETTY|REL) ' "$W/go.out" > "$W/go.cmp"
sed -e 's/ INVALID kept=.*$//' "$W/rust.out" > "$W/rust.cmp"
(cd "$W" && bun "$HERE/diff/cmp.mjs")
cmp "$W/go.cmp" "$W/rust.cmp" && echo "ground truth ok"
