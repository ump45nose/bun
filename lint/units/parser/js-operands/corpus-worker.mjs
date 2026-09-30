// Transpiles each listed file with the loaders js, jsx, ts, tsx and writes one JSON line per file.
// usage: bun corpus-worker.mjs <list file> <out jsonl>
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
const [listFile, outFile] = process.argv.slice(2);
const files = readFileSync(listFile, "utf8").split("\n").filter(Boolean);
const base = { trimUnusedImports: false, deadCodeElimination: false, target: "bun" };
const transpilers = {};
for (const loader of ["js", "jsx", "ts", "tsx"]) transpilers[loader] = new Bun.Transpiler({ ...base, loader });
writeFileSync(outFile, "");
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    appendFileSync(outFile, JSON.stringify({ file, skip: String(e.code || e.message) }) + "\n");
    continue;
  }
  const rec = { file, bytes: text.length, sha: Bun.hash(text).toString(16) };
  for (const loader of ["js", "jsx", "ts", "tsx"]) {
    try {
      const out = transpilers[loader].transformSync(text);
      rec[loader] = { ok: true, h: Bun.hash(out).toString(16), n: out.length };
    } catch (e) {
      const errs = e && e.errors ? e.errors : [e];
      rec[loader] = {
        ok: false,
        errors: errs.slice(0, 3).map(x => ({ m: String(x && x.message), line: x?.position?.line, col: x?.position?.column, text: x?.position?.lineText?.slice(0, 200) })),
      };
    }
  }
  appendFileSync(outFile, JSON.stringify(rec) + "\n");
}
