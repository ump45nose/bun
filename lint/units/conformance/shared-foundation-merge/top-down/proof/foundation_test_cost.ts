// What a test of the foundation costs: the digests of the tables, the digests of the UTF-8 sets and the reduced vectors.
// usage: bun foundation_test_cost.ts [govec-test.jsonl.gz]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { type ByteString, byteStringToUtf8, decodeLastRune, decodeRune, runeCount, utf8ToByteString, validString } from "../runner/bytestring";
import { computeECMALineStarts, utf16Len } from "../runner/core";
import { compareStrings, equalFold, foldKey, isSpace, toLower, trimSpace, unicodeToLower } from "../runner/gostrings";
import { skipTrivia } from "../runner/scanner";
import { compareStringsCaseInsensitive, isLineBreak, isWhiteSpaceLike, isWhiteSpaceSingleLine } from "../runner/stringutil";
import * as tspath from "../runner/tspath";

const t0 = performance.now();
const rows = gunzipSync(readFileSync(process.argv[2] ?? import.meta.dir + "/../vectors/govec-test.jsonl.gz")).toString("utf8").split("\n").filter(l => l !== "").map(l => JSON.parse(l));
const t1 = performance.now();
const b = (s: string): ByteString => Buffer.from(s, "base64").toString("latin1");
const hex = (s: ByteString) => Buffer.from(s, "latin1").toString("hex");
let bad = 0;
const want = rows.find(r => r.k === "tables");
const h = [createHash("sha256"), createHash("sha256"), createHash("sha256"), createHash("sha256")];
for (let r = 0; r <= 0x10ffff; r++) {
  const l = unicodeToLower(r);
  if (l !== r) h[0].update(`${r.toString(16)} ${l.toString(16)}\n`);
  const k = foldKey(r);
  if (k !== r) h[1].update(`${r.toString(16)} ${k.toString(16)}\n`);
  if (isSpace(r)) h[2].update(`${r.toString(16)}\n`);
  if (isWhiteSpaceLike(r)) h[3].update(`${r.toString(16)} ${isWhiteSpaceSingleLine(r)} ${isLineBreak(r)}\n`);
}
if (JSON.stringify(h.map(x => x.digest("hex"))) !== JSON.stringify([want.lower, want.foldKey, want.space, want.white])) bad++;
const t2 = performance.now();
const edge = [0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc2, 0xe0, 0xed, 0xf0, 0xf4, 0xff];
function* seqSet(set: string): Generator<ByteString> {
  const s = String.fromCharCode;
  if (set === "one") for (let a = 0; a < 256; a++) yield s(a);
  else if (set.startsWith("two-")) {
    const a = parseInt(set.slice(4), 16);
    for (let x = a; x < a + 16; x++) for (let y = 0; y < 256; y++) yield s(x, y);
  } else if (set === "three") {
    for (let a = 0xe0; a <= 0xef; a++) for (const x of edge) for (const y of edge) yield s(a, x, y);
  } else if (set === "four") {
    for (let a = 0xf0; a <= 0xf7; a++) for (const x of edge) for (const y of edge) for (const z of edge) yield s(a, x, y, z);
  } else if (set === "scalars") {
    for (let r = 0; r <= 0x10ffff; r += 7) if (!(r >= 0xd800 && r <= 0xdfff)) yield "x" + utf8ToByteString(String.fromCodePoint(r)) + "y";
  }
}
for (const v of rows) {
  if (v.k === "seq") {
    const d = createHash("sha256");
    for (const s of seqSet(v.set)) {
      const [r, size] = decodeRune(s, 0);
      const [lr, lsize] = decodeLastRune(s, 0, s.length);
      d.update(`${hex(s)} ${r} ${size} ${lr} ${lsize} ${runeCount(s)} ${validString(s)} ${utf16Len(s)}\n`, "latin1");
    }
    if (d.digest("hex") !== v.digest) bad++;
  }
}
const t3 = performance.now();
for (const v of rows) {
  if (v.k === "text") {
    const s = b(v.s);
    if (JSON.stringify(computeECMALineStarts(s)) !== JSON.stringify(v.ls)) bad++;
    for (let p = 0; p <= s.length; p++) if (skipTrivia(s, p) !== v.skip[p]) bad++;
    if (v.valid) {
      const d = byteStringToUtf8(s);
      if (hex(utf8ToByteString(trimSpace(d))) !== hex(b(v.trimSpace))) bad++;
      if (hex(utf8ToByteString(toLower(d))) !== hex(b(v.toLower))) bad++;
    }
  } else if (v.k === "pair") {
    const x = byteStringToUtf8(b(v.a));
    const y = byteStringToUtf8(b(v.b));
    if (equalFold(x, y) !== v.equalFold || compareStrings(x, y) !== v.compare || compareStringsCaseInsensitive(x, y) !== v.compareCaseInsensitive) bad++;
  } else if (v.k === "path") {
    const name = byteStringToUtf8(b(v.name));
    const dir = byteStringToUtf8(b(v.dir));
    const d = (x: string) => byteStringToUtf8(b(x));
    if (tspath.getNormalizedAbsolutePath(name, dir) !== d(v.getNormalizedAbsolutePath)) bad++;
    if (tspath.comparePaths(name, dir, { useCaseSensitiveFileNames: false, currentDirectory: "" }) !== v.comparePathsCaseInsensitive) bad++;
    if (tspath.toPath(name, dir, false) !== d(v.toPathCaseInsensitive)) bad++;
  }
}
const t4 = performance.now();
console.log(JSON.stringify({ rows: rows.length, bad, msLoad: Math.round(t1 - t0), msTables: Math.round(t2 - t1), msUtf8Sets: Math.round(t3 - t2), msRows: Math.round(t4 - t3), msAll: Math.round(t4 - t0) }));
