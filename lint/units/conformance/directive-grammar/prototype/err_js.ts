import { decodeBytes } from "./vfs";
import { skipTrivia } from "./scanner";
import { extractCompilerSettings, getConfigNameFromFileName, parseTestFilesAndSymlinksWithOptions } from "./test_case_parser";
const inputs: any[] = JSON.parse(await Bun.file(process.argv[2]).text());
const obj = (m: Map<string, string>) => Object.fromEntries([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
const outs: any[] = [];
for (const i of inputs) {
  const raw = Buffer.from(i.bytes, "base64");
  const content = raw.length === 0 ? "" : decodeBytes(raw).contents;
  const bytes = new TextEncoder().encode(content);
  const o: any = { name: i.name, decoded: content, lines: content.split(/\r?\n/), settings: obj(extractCompilerSettings(content)), panic: "", units: [], configUnit: null, symlinks: {}, currentDirectory: "", globalOptions: {}, skipTrivia: skipTrivia(bytes, 0), error: "", decodedByteLen: bytes.length };
  const r = parseTestFilesAndSymlinksWithOptions(content, i.fileName, (name, content, fileOptions) =>
    i.failOn !== "" && name === i.failOn
      ? { value: { name: "FAILED:" + name, content, fileOptions: obj(fileOptions) }, error: "cannot parse " + name }
      : { value: { name, content, fileOptions: obj(fileOptions) }, error: undefined }, { allowImplicitFirstFile: !!i.allowImplicitFirstFile });
  if (!r.ok) o.panic = r.reason;
  else {
    let units = r.units;
    o.error = r.error ?? "";
    o.symlinks = obj(r.symlinks); o.currentDirectory = r.currentDirectory; o.globalOptions = obj(r.globalOptions);
    if (!i.allowImplicitFirstFile) {
      for (let k = 0; k < units.length; k++) {
        if (getConfigNameFromFileName(units[k].name) !== "") { o.configUnit = units[k]; units = units.slice(0, k).concat(units.slice(k + 1)); break; }
      }
    }
    o.units = units;
  }
  outs.push(o);
}
await Bun.write(process.argv[3], JSON.stringify(outs));
