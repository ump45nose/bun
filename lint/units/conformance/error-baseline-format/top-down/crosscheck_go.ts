// The port of the writer against the reference's own functions (the ground-truth program that
// ../groundtruth/build.py cuts out of the reference and compiles), on the corpus and on generated cases.
// usage: bun crosscheck_go.ts <path of the gt binary> <corpus|fuzz> [count] [seed]
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Diagnostic, type FileLike, WriterPanic, compareDiagnostics, tsgoRules } from "./diagnosticwriter";
import { type TestFile, getErrorBaseline } from "./error_baseline";
import { readErrorBaseline } from "./reader";

const GO = "/workspace/ref/typescript-go/testdata/baselines/reference/submodule";
const gt = process.argv[2];
const mode = process.argv[3] ?? "corpus";
const rules = tsgoRules;

interface Case {
  name: string;
  pretty: boolean;
  files: FileLike[];
  inputs: TestFile[];
  diagnostics: Diagnostic[];
  expected?: string;
}

const b64 = (s: string) => Buffer.from(s, "latin1").toString("base64");

function toJson(c: Case): string {
  const fileIndex = new Map<FileLike, number>();
  const files: { name: string; text: string }[] = [];
  const indexOf = (f: FileLike | undefined): number => {
    if (f === undefined) return -1;
    let k = fileIndex.get(f);
    if (k === undefined) {
      k = files.length;
      fileIndex.set(f, k);
      files.push({ name: b64(f.fileName), text: b64(f.text) });
    }
    return k;
  };
  const conv = (d: Diagnostic): unknown => ({
    file: indexOf(d.file),
    pos: d.pos,
    end: d.end,
    code: d.code,
    category: d.category,
    source: "",
    message: b64(d.messageText),
    chain: d.messageChain.map(conv),
    related: d.relatedInformation.map(conv),
  });
  // The ground truth keeps the order of its input: the order is the one of the port's sort.
  const sorted = c.diagnostics.slice().sort((a, b) => compareDiagnostics(rules, a, b));
  const diagnostics = sorted.map(conv);
  return JSON.stringify({
    name: c.name,
    pretty: c.pretty,
    files,
    inputs: c.inputs.map(f => ({ name: b64(f.unitName), text: b64(f.content) })),
    diagnostics,
  });
}

// Deterministic generator.
let seed = Number(process.argv[5] ?? 12345);
function rnd(n: number): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return Math.floor((seed / 0x100000000) * n);
}
const pick = <T>(a: readonly T[]): T => a[rnd(a.length)];
const utf8 = (s: string) => Buffer.from(s, "utf8").toString("latin1");

const atoms = [
  "a", "b", "x", "foo", " ", " ", "  ", "\t", "(", ")", ";", "=", "~", "!!! ", "==== ",
  utf8("\u00a0"), "\x0b", "\x0c", utf8("\ufeff"), utf8("\u00e9"), utf8("\u4e2d"), utf8("\ud83d\ude00"), utf8("\u{10000}"),
  utf8("\u2028"), utf8("\u2029"), utf8("\u0085"), utf8("\u3000"), utf8("\u1680"), utf8("\u200b"),
  "\xff", "\x80", "\xe2\x80", "\xf0\x9f", "\xc0\xaf", "\xed\xa0\x80", "\x00",
];
const breaks = ["\n", "\n", "\n", "\r\n", "\r\n", "\r", "\r\r\n", utf8("\u2028"), "\n\n"];

function genContent(): string {
  const lines = rnd(7);
  let out = "";
  const style = rnd(4);
  for (let l = 0; l <= lines; l++) {
    const n = rnd(8);
    for (let k = 0; k < n; k++) out += rnd(3) === 0 ? pick(atoms) : pick(["a", "b", "c", " ", "let", "x"]);
    if (l < lines || rnd(2) === 0) out += style === 0 ? "\n" : style === 1 ? "\r\n" : pick(breaks);
  }
  return out;
}

const messagePool = [
  "Type 'A' is not assignable to type 'B'.",
  "Cannot find name 'x'.",
  utf8("Unicode \u00e9\u4e2d\ud83d\ude00 text."),
  "File '/.src/a.ts' is not under 'rootDir' '/.lib/x'.",
  "See file:///.ts/lib.d.ts and file:///./ts/lib.d.ts and bundled:///libs/lib.es5.d.ts.",
  "line one\nline two",
  "line one\r\nline two\r\n\r\nafter empty",
  "  starts with spaces",
  "",
  "lib.d.ts(1,2): error TS1: inside a message lib.x.d.ts(3,4)",
  "ends with cr\r",
  "a.ts(1,1): error TS1: looks like a head",
];

function genChain(depth: number, file: FileLike | undefined): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (depth > 3) return out;
  const n = rnd(4) === 0 ? rnd(3) : rnd(2);
  for (let k = 0; k < n; k++) {
    out.push({
      file,
      pos: 0,
      end: 0,
      code: 1000 + rnd(9000),
      category: 1,
      messageText: pick(messagePool),
      messageChain: genChain(depth + 1, file),
      relatedInformation: [],
    });
  }
  return out;
}

function genPos(text: string, wild: boolean): [number, number] {
  const len = text.length;
  let pos = rnd(len + 1);
  let end: number;
  const kind = rnd(10);
  if (kind < 2) end = pos;
  else if (kind < 7) end = Math.min(len, pos + 1 + rnd(6));
  else if (kind < 9) end = Math.min(len, pos + rnd(len + 1));
  else end = len;
  if (wild && rnd(40) === 0) end = len + rnd(3);
  if (wild && rnd(60) === 0) pos = -1;
  if (wild && rnd(60) === 0) end = pos - 1;
  return [pos, end];
}

function genCase(index: number, wild: boolean): Case {
  const names = ["/.src/a.ts", "/.src/b.ts", "/.src/A.ts", "/.src/dir/c.tsx", "/.src/tsconfig.json", "/.src/lib.d.ts", "/abs/d.ts", "/.src/a.ts", "/.src/./e.ts", "/.lib/react.d.ts", "/.src/lib.es5.d.ts"];
  const inputs: TestFile[] = [];
  const files: FileLike[] = [];
  const nInputs = rnd(4);
  for (let k = 0; k < nInputs; k++) {
    const name = pick(names);
    const content = genContent();
    inputs.push({ unitName: name, content });
    // The file of a diagnostic has the text of the input file, or another text when the names are equal twice.
    files.push({ fileName: name, text: content });
  }
  const outside: FileLike[] = [
    { fileName: "bundled:///libs/lib.es5.d.ts", text: genContent() },
    { fileName: "/.src/other.ts", text: genContent() },
    { fileName: "/.ts/lib.dom.d.ts", text: genContent() },
    { fileName: "LIB.x.D.TS", text: genContent() },
    { fileName: "file:///./src/u.ts", text: genContent() },
  ];
  const anyFile = (): FileLike | undefined => {
    const r = rnd(10);
    if (r === 0) return undefined;
    if (r < 8 && files.length > 0) return pick(files);
    return pick(outside);
  };
  const diagnostics: Diagnostic[] = [];
  const n = rnd(6) + (rnd(5) === 0 ? 0 : 1);
  for (let k = 0; k < n; k++) {
    const file = anyFile();
    const [pos, end] = file === undefined ? [-1, -1] : genPos(file.text, wild);
    const related: Diagnostic[] = [];
    const nr = rnd(4) === 0 ? 1 + rnd(2) : 0;
    for (let j = 0; j < nr; j++) {
      const rf = anyFile();
      const [rp, re] = rf === undefined ? [-1, -1] : genPos(rf.text, false);
      related.push({
        file: rf,
        pos: rp,
        end: re,
        code: 1000 + rnd(9000),
        category: 3,
        messageText: pick(messagePool),
        messageChain: rnd(5) === 0 ? genChain(1, rf) : [],
        relatedInformation: [],
      });
    }
    diagnostics.push({
      file,
      pos,
      end,
      code: rnd(30) === 0 ? 1490 : rnd(40) === 0 ? -1 : 1000 + rnd(9000),
      category: pick([1, 1, 1, 1, 0, 2, 3]),
      messageText: pick(messagePool),
      messageChain: genChain(1, file),
      relatedInformation: related,
    });
  }
  // Without a file the position is the rank.
  let rank = 0;
  for (const d of diagnostics) if (d.file === undefined) d.pos = d.end = rank++;
  return { name: `fuzz-${index}`, pretty: rnd(4) === 0, files, inputs, diagnostics };
}

const cases: Case[] = [];
if (mode === "corpus") {
  for (const suite of ["compiler", "conformance"]) {
    for (const f of readdirSync(join(GO, suite)).sort()) {
      if (!f.endsWith(".errors.txt")) continue;
      const text = rules.model.fromBytes(readFileSync(join(GO, suite, f)));
      const parsed = readErrorBaseline(rules, text);
      cases.push({
        name: `${suite}/${f}`,
        pretty: parsed.pretty,
        files: [],
        inputs: parsed.files,
        diagnostics: parsed.diagnostics,
        expected: text,
      });
    }
  }
} else {
  const count = Number(process.argv[4] ?? 5000);
  for (let k = 0; k < count; k++) cases.push(genCase(k, mode === "wild"));
}

const input = join("/tmp", `crosscheck-${mode}-${process.pid}.jsonl`);
writeFileSync(input, cases.map(toJson).join("\n") + "\n");
const run = spawnSync(gt, [input], { maxBuffer: 1 << 30, encoding: "utf8" });
if (run.status !== 0) {
  console.log("ground truth failed:", run.status, run.stderr.slice(0, 2000));
  process.exit(1);
}
const results = run.stdout
  .split("\n")
  .filter(l => l !== "")
  .map(l => JSON.parse(l) as { name: string; text: string; failed: string[] | null; panic: string });
if (results.length !== cases.length) {
  console.log(`ground truth gave ${results.length} results for ${cases.length} cases`);
  process.exit(1);
}
let same = 0;
let samePanic = 0;
let differ = 0;
let sameAsBaseline = 0;
const shown: string[] = [];
const panicKinds: Record<string, number> = {};
const mismatches: unknown[] = [];
for (let k = 0; k < cases.length; k++) {
  const c = cases[k];
  const r = results[k];
  const goText = Buffer.from(r.text, "base64").toString("latin1");
  let mine: string | undefined;
  let minePanic = "";
  let mineFailed: string[] = [];
  try {
    const w = getErrorBaseline(rules, c.inputs, c.diagnostics, c.pretty);
    mine = w.text;
    mineFailed = w.failedChecks;
  } catch (e) {
    if (!(e instanceof WriterPanic)) throw e;
    minePanic = e.message;
  }
  if (r.panic !== "") panicKinds[r.panic.replace(/\d+/g, "N")] = (panicKinds[r.panic.replace(/\d+/g, "N")] ?? 0) + 1;
  const goFailed = (r.failed ?? []).length;
  if (r.panic !== "" && minePanic !== "") {
    samePanic++;
  } else if (r.panic === "" && minePanic === "" && mine === goText && (goFailed > 0) === (mineFailed.length > 0)) {
    same++;
    if (c.expected !== undefined && c.expected === goText) sameAsBaseline++;
  } else {
    differ++;
    mismatches.push({ case: JSON.parse(toJson(c)), go: r, mine: mine === undefined ? undefined : b64(mine), minePanic, mineFailed });
    if (shown.length < 15) {
      let detail = "";
      if (r.panic !== "" || minePanic !== "") detail = `panic go=${JSON.stringify(r.panic)} port=${JSON.stringify(minePanic)}`;
      else if (mine !== goText) {
        const a = goText.split("\r\n");
        const b = mine!.split("\r\n");
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        detail = `line ${i + 1}: go ${JSON.stringify(a[i])?.slice(0, 150)} port ${JSON.stringify(b[i])?.slice(0, 150)}`;
      } else detail = `failed checks go=${JSON.stringify(r.failed)} port=${JSON.stringify(mineFailed)}`;
      shown.push(`${c.name}: ${detail}`);
    }
  }
}
console.log(`== ${mode}: ${cases.length} cases; same text ${same}, both panic ${samePanic}, differ ${differ}`);
if (mode === "corpus") console.log(`   ground truth equals the baseline bytes: ${sameAsBaseline}`);
console.log("   panics of the ground truth:", JSON.stringify(panicKinds));
for (const s of shown) console.log("  DIFF " + s);
writeFileSync(join(import.meta.dir, `crosscheck-${mode}-mismatches.json`), JSON.stringify(mismatches.slice(0, 50), null, 1));
