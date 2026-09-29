Prototype of the reader and writer of .errors.txt baselines (research pass "top-down"). Not repository code.

diagnosticwriter.ts  port of internal/diagnosticwriter/diagnosticwriter.go, rules tsgo and tsc
error_baseline.ts    port of internal/testutil/tsbaseline/error_baseline.go and util.go (the writer)
reader.ts            the reader
shape.ts             the plain data shape for the runner and its conversion to the input of the writer
text_model.ts        unit of positions: UTF-8 bytes (tsgo), UTF-16 code units (tsc)
go_compat.ts, tspath.ts  copies of ../prototype/ as of the first hour of the pass

roundtrip.ts <ts|go|godiff> <tsgo|tsc> [shape]     write(read(bytes)) against bytes
check_units.ts <go|ts>                             the same with the units of the case as input files
crosscheck_go.ts <gt> <corpus|fuzz|wild> [n] [seed] the port against the reference's own functions
reader_fuzz.ts <n> <seed> <sane|tricky> <alone|units> <plain|library|repeated|all> <lf|all> [valid]
ties.ts, stats_spans.ts, survey1.ts, examples.ts   counts and worked examples

The ground truth program: python3 ../groundtruth/build.py /workspace/ref/typescript-go /tmp/gt
