// Canonical per-case record computed by the port; one line per case: path TAB sha256(record).
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile } from "./vfs";
import { extractCompilerSettings, parseTestFilesAndSymlinks, getConfigNameFromFileName } from "./test_case_parser";

const root = process.argv[2];
const files: string[] = [];
function walk(dir: string) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(p)) files.push(p); } }
walk(join(root, "conformance")); walk(join(root, "compiler"));
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const rels = files.map(f => f.slice(root.length + 1)).sort(byBytes);
const sha = (s: string | Buffer) => createHash("sha256").update(typeof s === "string" ? Buffer.from(s, "utf8") : s).digest("hex");
const unitLine = (content: string) => `${Buffer.byteLength(content, "utf8")} ${sha(content)}`;

const out: string[] = [];
for (const rel of rels) {
  const r = readFile(join(root, rel));
  const content = r.contents;
  const rec: string[] = [];
  rec.push(`decoded ${Buffer.byteLength(content, "utf8")} ${sha(content)}`);
  const parsed = parseTestFilesAndSymlinks(content, rel, (name, content) => ({ value: { name, content }, error: undefined }));
  rec.push("panic " + (parsed.ok ? "" : parsed.reason));
  rec.push("currentDirectory " + (parsed.ok ? parsed.currentDirectory : ""));
  const maps: [string, Map<string, string>][] = [["settings", extractCompilerSettings(content)], ["globalOptions", parsed.ok ? parsed.globalOptions : new Map()]];
  for (const [field, m] of maps) {
    rec.push(`${field} ${m.size}`);
    for (const k of [...m.keys()].sort(byBytes)) rec.push(k + "=" + m.get(k));
  }
  const sym = parsed.ok ? parsed.symlinks : new Map<string, string>();
  rec.push(`symlinks ${sym.size}`);
  for (const k of [...sym.keys()].sort(byBytes)) { rec.push(k); rec.push(sym.get(k)!); }
  let units = parsed.ok ? parsed.units : [];
  const i = units.findIndex(u => getConfigNameFromFileName(u.name) !== "");
  rec.push(`configUnit ${i >= 0 ? 1 : 0}`);
  if (i >= 0) { rec.push(units[i].name); rec.push(unitLine(units[i].content)); units = units.filter((_, k) => k !== i); }
  rec.push(`units ${units.length}`);
  for (const u of units) { rec.push(u.name); rec.push(unitLine(u.content)); }
  out.push(rel + "\t" + sha(rec.map(x => x + "\n").join("")) + "\n");
}
await Bun.write(process.argv[3], out.join(""));
