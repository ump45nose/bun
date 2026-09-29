// Cuts the vectors of the ground-truth program down to what a test of ten seconds can hold: the digests, the small
// kinds whole, and every n-th row of the large kinds.
// usage: bun make_test_vectors.ts <govec.jsonl> <out.jsonl> [n, default 40]
import { readFileSync, writeFileSync } from "node:fs";
const every = Number(process.argv[4] ?? 40);
const seen: Record<string, number> = {};
const out: string[] = [];
for (const line of readFileSync(process.argv[2], "utf8").split("\n")) {
  if (line === "") continue;
  const k: string = JSON.parse(line).k ?? "pad";
  const n = (seen[k] = (seen[k] ?? 0) + 1);
  const large = k === "text" || k === "pair" || k === "path";
  if (!large || (n - 1) % every === 0) out.push(line);
}
writeFileSync(process.argv[3], out.join("\n") + "\n");
console.log(JSON.stringify({ rows: out.length, kinds: seen }));
