// Writes reference_counts.json and reference_skips.tsv for a corpus in the committed layout: the prototype of the script that runs after sync.sh.
// usage: bun pin.ts <assembled runner root> <conformance directory with UPSTREAM and corpus/> <out directory>
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [asm, home, out] = process.argv.slice(2);
const runner = join(asm, "test/cli/lint/conformance/runner");
const R = await import(join(runner, "index.ts"));
const B = await import(join(runner, "baseline.ts"));
const G = await import(join(runner, "gostrings.ts"));
const cmp = G.compareStrings as (a: string, b: string) => number;
const sha = (x: string | Uint8Array) => createHash("sha256").update(x).digest("hex");
// The digest of a set of rows: sha256 of the rows in byte order, each with its line feed.
const digestOf = (rows: string[]) => sha(rows.slice().sort(cmp).join(""));
export const buckets = 40;
export const bucketOf = (casePath: string) => Bun.hash.crc32(casePath) % buckets;

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
const e = R.enumerateInstances({ casesRoot: layout.casesRoot });
const facts: any[] = e.instances.map((i: any) => R.factsOf(corpus, i));
const n = (f: (x: any) => boolean) => facts.filter(f).length;
const inSuite = (s: string) => (f: any) => f.casePath.startsWith(s + "/");

const shortReason = (r: string) => r.replace(/^(unsupported (?:baseUrl|outFile)) .*/s, "$1");
const reasons = new Map<string, number>();
for (const f of facts) if (f.status === "skipped") reasons.set(shortReason(f.reason), (reasons.get(shortReason(f.reason)) ?? 0) + 1);

const tags = new Map<string, number>();
e.instances.forEach((i: any, k: number) => {
  for (const t of [...i.tags, ...facts[k].tags]) tags.set(t, (tags.get(t) ?? 0) + 1);
});

const sources = new Map<string, number>();
const oracleRows: string[] = [];
let pretty = 0;
for (const i of e.instances) {
  if (i.status !== "run") continue;
  const o = B.oracleOf(corpus, i.suite, i.name);
  sources.set(o.source, (sources.get(o.source) ?? 0) + 1);
  if (o.kind !== "E") continue;
  const bytes = Buffer.from(B.readOracle(o)!);
  oracleRows.push(`${i.name}\t${sha(bytes)}\n`);
  if (bytes.includes("\x1b[")) pretty++;
}

const paths: string[] = [];
const walk = (dir: string, rel: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = rel === "" ? entry.name : rel + "/" + entry.name;
    if (entry.isDirectory()) walk(dir + "/" + entry.name, p);
    else paths.push(p);
  }
};
walk(c, "");
paths.sort(cmp);
const listing = createHash("sha256");
let corpusBytes = 0;
for (const p of paths) {
  const bytes = readFileSync(c + "/" + p);
  corpusBytes += bytes.length;
  listing.update(`${p}\t${bytes.length}\t${sha(bytes)}\n`);
}

const row = (f: any) => `${f.name}\t${f.status}\t${f.reason}\t${f.kind ?? ""}\n`;
const bucketRows: (number | string)[][] = [];
for (let k = 0; k < buckets; k++) {
  const part = facts.filter(f => bucketOf(f.casePath) === k);
  bucketRows.push([k, part.length, part.filter(f => f.status === "run").length, part.filter(f => f.status === "skipped").length, part.filter(f => f.kind === "E").length, part.filter(f => f.kind === "C").length, digestOf(part.map(row)).slice(0, 16)]);
}

const skipsText = facts.filter(f => f.status === "skipped").map(f => `${f.name}\t${f.reason}\n`).sort(cmp).join("");
const upstream = Object.fromEntries(readFileSync(home + "/UPSTREAM", "utf8").split("\n").map(l => l.split(" ")).filter(w => w[0] === "commit").map(w => [w[1], w[2]]));
const sortedByCount = (m: Map<string, number>) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])));

const pins = {
  upstream,
  corpus: {
    files: paths.length,
    bytes: corpusBytes,
    sha256: listing.digest("hex"),
    cases: R.indexCases(layout.casesRoot).size,
    tsBaselines: corpus.ts.size,
    tsgoBaselines: { compiler: corpus.tsgo.get("compiler").size, conformance: corpus.tsgo.get("conformance").size },
    expectsNoErrors: corpus.expectsNoErrors.size,
    accepted: corpus.accepted.size,
    triaged: corpus.triaged.size,
    postEmitOrder: corpus.postEmitOrder.size,
  },
  enumeration: {
    files: e.files,
    droppedByName: e.droppedBySkippedTests.length,
    instances: facts.length,
    run: n(f => f.status === "run"),
    skipped: n(f => f.status === "skipped"),
    invalid: n(f => f.status === "invalid"),
    E: n(f => f.kind === "E"),
    C: n(f => f.kind === "C"),
    compiler: { instances: n(inSuite("compiler")), run: n(f => inSuite("compiler")(f) && f.status === "run"), E: n(f => inSuite("compiler")(f) && f.kind === "E"), C: n(f => inSuite("compiler")(f) && f.kind === "C") },
    conformance: { instances: n(inSuite("conformance")), run: n(f => inSuite("conformance")(f) && f.status === "run"), E: n(f => inSuite("conformance")(f) && f.kind === "E"), C: n(f => inSuite("conformance")(f) && f.kind === "C") },
    skippedByReason: sortedByCount(reasons),
    tags: sortedByCount(tags),
    oracleSource: sortedByCount(sources),
    prettyOracles: pretty,
  },
  digests: {
    subtests: digestOf(e.instances.map((i: any) => `${i.status === "run" ? "PASS" : i.status === "skipped" ? "SKIP" : i.status}\t${i.testName.replaceAll(" ", "_")}\n`)),
    names: digestOf(facts.map(f => `${f.name}\n`)),
    status: digestOf(facts.map(f => `${f.name}\t${f.status}\t${f.reason}\n`)),
    kinds: digestOf(facts.filter(f => f.status === "run").map(f => `${f.name}\t${f.kind}\n`)),
    oracles: digestOf(oracleRows),
  },
  skips: { rows: n(f => f.status === "skipped"), sha256: sha(skipsText) },
  buckets: { of: buckets, rows: bucketRows },
};

// One form: two spaces, the rows of the buckets one per line, a line feed at the end.
export function formatPins(p: typeof pins): string {
  const marker = "@@rows@@";
  const text = JSON.stringify({ ...p, buckets: { of: p.buckets.of, rows: marker } }, null, 2);
  const rows = "[\n" + p.buckets.rows.map(r => "      " + JSON.stringify(r).replaceAll(",", ", ")).join(",\n") + "\n    ]";
  return text.replace(JSON.stringify(marker), rows) + "\n";
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "reference_counts.json"), formatPins(pins));
writeFileSync(join(out, "reference_skips.tsv"), skipsText);
console.log(formatPins(pins));
