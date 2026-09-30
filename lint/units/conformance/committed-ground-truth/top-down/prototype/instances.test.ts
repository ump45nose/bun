// Research prototype of the same blocks for the other form of the list: reference_instances.tsv holds every instance, so every difference is a name.
// usage: CGT_ASM=<assembled runner root> CGT_HOME=<conformance directory with corpus/ and reference_instances.tsv> bun test ./instances.test.ts
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isASAN, isDebug } from "/workspace/wt/conformance/test/harness.ts";

const asm = process.env.CGT_ASM!;
const home = process.env.CGT_HOME!;
const fx = process.env.CGT_FX ?? home;
const runner = join(asm, "test/cli/lint/conformance/runner");
const R = await import(join(runner, "index.ts"));
const small = isDebug || isASAN;
const pins = JSON.parse(readFileSync(join(fx, "reference_counts.json"), "utf8"));
const text = readFileSync(join(fx, "reference_instances.tsv"), "utf8");
const lines = text.split("\n").filter(l => l !== "");
const c = home + "/corpus";
const layout = {
  casesRoot: c + "/ts/tests/cases",
  libRoot: c + "/ts/tests/lib",
  tsgoBaselines: c + "/tsgo/testdata/baselines/reference/submodule",
  tsBaselines: c + "/ts/tests/baselines/reference",
  expectsNoErrors: c + "/tsgo.expects-no-errors.txt",
  accepted: c + "/tsgo/testdata/submoduleAccepted.txt",
  triaged: c + "/tsgo/testdata/submoduleTriaged.txt",
  postEmitOrder: home + "/post-emit-order.txt",
};
const corpus = R.loadCorpus(layout);
const cases: Map<string, string> = R.indexCases(layout.casesRoot);
const rowOf = (f: any) => `${f.name}\t${f.status}\t${f.reason}\t${f.kind ?? ""}`;
const group = (casePath: string) => Bun.hash.crc32(casePath) % 256;
// The rows of the list whose case is in a set of cases.
const rowsOf = (casePaths: Set<string>) => lines.filter(l => casePaths.has(cases.get(R.caseBaseName(l.slice(0, l.indexOf("\t")))) ?? ""));

describe("listed enumeration", () => {
  test("the list is the pinned one", () => {
    expect({ rows: lines.length, sha256: createHash("sha256").update(text).digest("hex") }).toEqual(pins.instancesFile);
  });

  // About 48 cases each: a debug build gets through one group within the time of one test.
  test.each([0, 1, 2, 3, 4, 5, 6, 7])("one of 256 cases, group %d: the rows of the list", k => {
    const sample = [...cases.values()].filter(p => group(p) === k).sort();
    const got = sample.flatMap(p => R.enumerateCase(layout.casesRoot, p)).map((i: any) => rowOf(R.factsOf(corpus, i)));
    expect(got.length).toBeGreaterThan(20);
    expect(got.sort()).toEqual(rowsOf(new Set(sample)).sort());
  });

  test.skipIf(small)(
    "every case: the rows of the list and the counts",
    () => {
      const e = R.enumerateInstances({ casesRoot: layout.casesRoot });
      const facts: any[] = e.instances.map((i: any) => R.factsOf(corpus, i));
      expect(facts.map(rowOf).sort()).toEqual(lines.slice().sort());
      const n = (f: (x: any) => boolean) => facts.filter(f).length;
      expect({
        files: e.files,
        droppedByName: e.droppedBySkippedTests.length,
        instances: facts.length,
        run: n(f => f.status === "run"),
        skipped: n(f => f.status === "skipped"),
        E: n(f => f.kind === "E"),
        C: n(f => f.kind === "C"),
      }).toEqual({
        files: pins.enumeration.files,
        droppedByName: pins.enumeration.droppedByName,
        instances: pins.enumeration.instances,
        run: pins.enumeration.run,
        skipped: pins.enumeration.skipped,
        E: pins.enumeration.E,
        C: pins.enumeration.C,
      });
    },
    30_000,
  );
});
