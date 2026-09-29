// Builds the file set of the runner as it would be committed, from the module map below: one source per file,
// imports routed to the merged bottom layer, and the listed edits. The result has the layout of the repository.
// usage: bun assemble.ts <directory of the notes of the unit> <output directory>
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const [notesArg, outArg] = process.argv.slice(2);
const notes = resolve(notesArg);
const out = resolve(outArg);
const here = "shared-foundation-merge/bottom-up";
const runner = "test/cli/lint/conformance/runner/";

// Committed file -> surviving source, both as paths below their roots.
export const moduleMap: [committed: string, source: string][] = [
  [runner + "gostrings.ts", here + "/runner/gostrings.ts"],
  [runner + "stringutil.ts", here + "/runner/stringutil.ts"],
  [runner + "core.ts", here + "/runner/core.ts"],
  [runner + "scanner.ts", here + "/runner/scanner.ts"],
  [runner + "tspath.ts", here + "/runner/tspath.ts"],
  [runner + "vfs.ts", here + "/runner/vfs.ts"],
  [runner + "vfstest.ts", here + "/runner/vfstest.ts"],
  [runner + "text_model.ts", here + "/runner/text_model.ts"],
  [runner + "test_case_parser.ts", "instance-materialisation/prototype/test_case_parser.ts"],
  [runner + "harnessutil.ts", "instance-materialisation/prototype/harnessutil.ts"],
  [runner + "options_table.json", "instance-materialisation/prototype/options_table.json"],
  [runner + "tsconfig.ts", "instance-materialisation/prototype/tsconfig.ts"],
  [runner + "compiler_runner.ts", "instance-materialisation/prototype/enum_runner.ts"],
  [runner + "compiler_test.ts", "instance-materialisation/prototype/compiler_test.ts"],
  [runner + "config_files.ts", "instance-materialisation/prototype/config_files.ts"],
  [runner + "vfsmatch.ts", "instance-materialisation/prototype/vfsmatch.ts"],
  [runner + "materialize.ts", "instance-materialisation/prototype/materialize.ts"],
  [runner + "diagnosticwriter.ts", "error-baseline-format/top-down/diagnosticwriter.ts"],
  [runner + "error_baseline.ts", "error-baseline-format/top-down/error_baseline.ts"],
  [runner + "reader.ts", "error-baseline-format/top-down/reader.ts"],
  [runner + "shape.ts", "error-baseline-format/top-down/shape.ts"],
  [runner + "check.ts", "check-contract-default-spawn/top-down/check.ts"],
  [runner + "checks.ts", "check-contract-default-spawn/top-down/checks.ts"],
  [runner + "plain.ts", "check-contract-default-spawn/top-down/plain.ts"],
  [runner + "run.ts", "check-contract-default-spawn/top-down/run.ts"],
  [runner + "manifest.ts", "check-contract-default-spawn/top-down/manifest.ts"],
  [runner + "baseline.ts", "oracle-and-expectations/top-down/prototype/baseline.ts"],
  [runner + "expectations.ts", "oracle-and-expectations/top-down/prototype/expectations.ts"],
  [runner + "sweep_args.ts", "oracle-and-expectations/top-down/prototype/sweep_args.ts"],
  [runner + "index.ts", "test-file-and-sweep/top-down/index.ts"],
  ["test/cli/lint/conformance/sweep.ts", "test-file-and-sweep/top-down/sweep.ts"],
  ["test/cli/lint/conformance/expectations.json", "test-file-and-sweep/top-down/expectations.json"],
  ["test/cli/lint/conformance/post-emit-order.txt", "oracle-and-expectations/top-down/vectors/post-emit-order.txt"],
  ["test/cli/lint/conformance.test.ts", "test-file-and-sweep/top-down/conformance.test.ts"],
];

// Old copies of the bottom layer: where each exported name lives in the merged set, and under which name.
type Route = Record<string, [module: string, name?: string]>;
const stringutilRoute: Route = {
  isWhiteSpaceLike: ["stringutil"],
  isWhiteSpaceSingleLine: ["stringutil"],
  isLineBreak: ["stringutil"],
  isGoSpace: ["gostrings", "isSpace"],
  trimSpace: ["gostrings"],
  trimSuffix: ["gostrings"],
  toLower: ["gostrings"],
};
const all = (module: string, names: string[]): Route => Object.fromEntries(names.map(n => [n, [module]]));
const tspathRoute: Route = all("tspath", [
  "hasTrailingDirectorySeparator",
  "isVolumeCharacter",
  "getEncodedRootLength",
  "getRootLength",
  "normalizeSlashes",
  "removeTrailingDirectorySeparator",
  "removeTrailingDirectorySeparators",
  "getBaseFileName",
  "isRootedDiskPath",
  "pathIsAbsolute",
  "ensureTrailingDirectorySeparator",
  "combinePaths",
  "getDirectoryPath",
  "getNormalizedAbsolutePath",
  "normalizePath",
  "toPath",
  "getAnyExtensionFromPath",
  "getPathComponents",
  "reducePathComponents",
  "getPathFromPathComponents",
  "comparePaths",
  "convertToRelativePath",
  "ComparePathsOptions",
]);
const tspathMoreRoute: Route = {
  ...all("tspath", [
    "ExtensionTs",
    "ExtensionTsx",
    "ExtensionDts",
    "ExtensionJs",
    "ExtensionJsx",
    "ExtensionJson",
    "ExtensionTsBuildInfo",
    "ExtensionMjs",
    "ExtensionMts",
    "ExtensionDmts",
    "ExtensionCjs",
    "ExtensionCts",
    "ExtensionDcts",
    "AllSupportedExtensions",
    "SupportedTSExtensions",
    "AllSupportedExtensionsWithJson",
    "SupportedTSExtensionsWithJson",
    "fileExtensionIs",
    "fileExtensionIsOneOf",
    "hasExtension",
    "ComparePathsOptions",
    "getComparer",
    "getPathComponents",
    "reducePathComponents",
    "getPathFromPathComponents",
    "getNormalizedPathComponents",
    "containsPath",
    "toFileNameLowerCase",
    "getCanonicalFileName",
    "getPathComponentsRelativeTo",
    "convertToRelativePath",
    "changeAnyExtension",
    "changeExtension",
  ]),
  toPathEx: ["tspath", "toPath"],
  getAnyExtensionFromPathEx: ["tspath", "getAnyExtensionFromPath"],
  equalFold: ["gostrings"],
  compareStringsCaseInsensitive: ["stringutil"],
  compareStringsCaseSensitive: ["stringutil"],
};
const routes: Record<string, Route> = {
  "instance-materialisation/prototype/stringutil.ts": stringutilRoute,
  "enumerator/prototype/stringutil.ts": stringutilRoute,
  "instance-materialisation/prototype/scanner.ts": all("scanner", ["skipTrivia"]),
  "instance-materialisation/prototype/tspath.ts": tspathRoute,
  "instance-materialisation/prototype/tspath_more.ts": tspathMoreRoute,
  "instance-materialisation/prototype/readfile.ts": all("vfs", ["readFile", "decodeBytes", "decodeUtf16", "ReadFileResult"]),
  "instance-materialisation/prototype/memfs.ts": all("vfstest", ["MemFs", "MemFsPanic", "MemInput", "MemEntry", "Entries"]),
  "error-baseline-format/top-down/go_compat.ts": {
    ...all("gostrings", [
      "ByteString",
      "RuneError",
      "toByteString",
      "fromByteString",
      "utf8ToByteString",
      "byteStringToUtf8",
      "decodeRune",
      "decodeLastRune",
      "runeCount",
      "isSpace",
      "trimRightSpace",
      "replaceNonWhitespace",
      "padLeft",
      "compareStrings",
    ]),
    utf16Len: ["core"],
  },
  "error-baseline-format/top-down/text_model.ts": { ...all("text_model", ["TextModel", "utf8Model", "utf16Model"]), isSpace: ["gostrings"] },
  "error-baseline-format/top-down/tspath.ts": {
    ...tspathRoute,
    compareStringsCaseInsensitive: ["stringutil"],
    compareStringsCaseSensitive: ["stringutil"],
  },
};

const committedOf = new Map(moduleMap.map(([committed, source]) => [source, committed]));
const specifier = (fromCommitted: string, toCommitted: string) => {
  const r = relative(dirname(fromCommitted), toCommitted).replace(/\.ts$/, "");
  return r.startsWith(".") ? r : "./" + r;
};

function resolveSource(fromSource: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = relative(notes, resolve(notes, dirname(fromSource), spec));
  for (const candidate of [base, base + ".ts"]) if (existsSync(join(notes, candidate)) && !candidate.endsWith("/")) return candidate;
  throw new Error(`${fromSource}: cannot resolve ${spec}`);
}

function rewriteImports(committed: string, source: string, text: string): string {
  // Named lists first: they may need to be split by the module of each name.
  text = text.replace(/^(import|export)( type)? \{([^}]*)\} from "([^"]+)";$/gms, (statement, keyword, typeOnly, list, spec) => {
    const target = resolveSource(source, spec);
    if (target === undefined) return statement;
    const route = routes[target];
    if (route === undefined) {
      const to = committedOf.get(target);
      if (to === undefined) throw new Error(`${source}: ${spec} is no file of the module map`);
      return statement.replace(`"${spec}"`, `"${specifier(committed, to)}"`);
    }
    const byModule = new Map<string, string[]>();
    for (const item of (list as string).split(",").map(s => s.trim()).filter(s => s !== "")) {
      const m = /^(type )?([A-Za-z_$][\w$]*)(?: as ([A-Za-z_$][\w$]*))?$/.exec(item);
      if (m === null) throw new Error(`${source}: cannot read the import of ${item}`);
      const [, isType, name, alias] = m;
      const to = route[name];
      if (to === undefined) throw new Error(`${source}: ${name} of ${target} has no place in the merged set`);
      const [module, newName = name] = to;
      const local = alias ?? name;
      const entry = (isType ?? "") + (newName === local ? newName : `${newName} as ${local}`);
      byModule.set(module, [...(byModule.get(module) ?? []), entry]);
    }
    return [...byModule]
      .map(([module, names]) => `${keyword}${typeOnly ?? ""} { ${names.join(", ")} } from "${specifier(committed, runner + module + ".ts")}";`)
      .join("\n");
  });
  // Every other form keeps its shape: only the specifier changes.
  text = text.replace(/^((?:import|export) (?:type )?(?:\* as [\w$]+|[\w$]+|\*) from )"([^"]+)";$/gm, (statement, head, spec) => {
    const target = resolveSource(source, spec);
    if (target === undefined) return statement;
    if (routes[target] !== undefined) throw new Error(`${source}: ${spec} is imported whole and has no single place in the merged set`);
    const to = committedOf.get(target);
    if (to === undefined) throw new Error(`${source}: ${spec} is no file of the module map`);
    return `${head}"${specifier(committed, to)}";`;
  });
  return text;
}

// Edits of a committed file after its imports are routed: [file, old text, new text, times the old text occurs].
type Edit = [file: string, oldText: string, newText: string, times: number];
const r = (name: string) => runner + name;
const edits: Edit[] = [
  // test_case_parser.ts: the trivia scan takes the byte string of the text.
  [r("test_case_parser.ts"), `import { toLower, trimSpace, trimSuffix } from "./gostrings";`, `import { toLower, trimSpace, trimSuffix, utf8ToByteString } from "./gostrings";`, 1],
  [r("test_case_parser.ts"), `const encoder = new TextEncoder();\n\n`, "", 1],
  [r("test_case_parser.ts"), "const bytes = encoder.encode(currentFileContent);", "const bytes = utf8ToByteString(currentFileContent);", 1],
  [r("test_case_parser.ts"), `export const counters = { reachedSkipTrivia: 0 };\n\n`, "", 1],
  [r("test_case_parser.ts"), `          counters.reachedSkipTrivia++;\n`, "", 1],
  // harnessutil.ts: strings.EqualFold and strings.Compare of the merged set in place of the local copies.
  [r("harnessutil.ts"), `import { toLower, trimSpace } from "./gostrings";`, `import { compareStrings, equalFold, toLower, trimFunc, trimSpace } from "./gostrings";`, 1],
  [
    r("harnessutil.ts"),
    `function trimFunc(s: string, f: (ch: number) => boolean): string {\n  const cps = [...s];\n  let start = 0;\n  let end = cps.length;\n  while (start < end && f(cps[start].codePointAt(0)!)) start++;\n  while (end > start && f(cps[end - 1].codePointAt(0)!)) end--;\n  return cps.slice(start, end).join("");\n}\n`,
    "",
    1,
  ],
  [r("harnessutil.ts"), `// strings.EqualFold on ASCII names\nfunction equalFold(a: string, b: string): boolean {\n  return a.length === b.length && a.toLowerCase() === b.toLowerCase();\n}\n\n`, "", 1],
  [r("harnessutil.ts"), `const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));\n\n`, "", 1],
  [r("harnessutil.ts"), "[...config.keys()].sort(byBytes)", "[...config.keys()].sort(compareStrings)", 1],
  // vfsmatch.ts: strings.ToLower.
  [r("vfsmatch.ts"), "if (!p.caseSensitive) lit = lit.toLowerCase();", "if (!p.caseSensitive) lit = toLower(lit);", 1],
  [r("vfsmatch.ts"), `import type { MemFs } from "./vfstest";\n`, `import { toLower } from "./gostrings";\nimport type { MemFs } from "./vfstest";\n`, 1],
  // The two functions of tspath that had a short form take the arguments of upstream.
  [r("tsconfig.ts"), "toPath(configFileName, basePath)", "toPath(configFileName, basePath, true)", 1],
  [r("compiler_runner.ts"), "getAnyExtensionFromPath(basename)", "getAnyExtensionFromPath(basename, undefined, false)", 1],
  [r("compiler_runner.ts"), `const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));\n`, `import { compareStrings as byBytes } from "./gostrings";\n`, 1],
  // config_files.ts and compiler_test.ts: the conversions that throw in place of the ones that replace.
  [r("config_files.ts"), `constructor(readonly host: MemFs, readonly decoder = new TextDecoder("utf-8")) {}`, "constructor(readonly host: MemFs) {}", 1],
  [r("config_files.ts"), "return b === undefined ? undefined : this.decoder.decode(b);", "return b === undefined ? undefined : utf8String(decodeBytes(b));", 1],
  [r("config_files.ts"), `import type { MemFs } from "./vfstest";\n`, `import { utf8String } from "./gostrings";\nimport { decodeBytes } from "./vfs";\nimport type { MemFs } from "./vfstest";\n`, 1],
  [r("compiler_test.ts"), `const encoder = new TextEncoder();\n\n`, "", 1],
  [r("compiler_test.ts"), "encoder.encode(", "utf8Bytes(", 3],
  [r("compiler_test.ts"), `import { Undecided, getConfigFileNames } from "./config_files";\n`, `import { Undecided, getConfigFileNames } from "./config_files";\nimport { utf8Bytes } from "./gostrings";\n`, 1],
  // baseline.ts: the two lists are decoded with the conversion that throws.
  [r("baseline.ts"), `readFileNameSet(readFileSync(p, "utf8"))`, "readFileNameSet(utf8String(readFileSync(p)))", 1],
  [r("baseline.ts"), `import { trimSpace } from "./gostrings";`, `import { trimSpace, utf8String } from "./gostrings";`, 1],
  // The baseline modules: the name of the line split, and names decoded before tspath compares them.
  [r("error_baseline.ts"), "model.splitLines(", "model.contentLines(", 1],
  [r("reader.ts"), "model.splitLines(", "model.contentLines(", 1],
  [
    r("error_baseline.ts"),
    `import { comparePaths, ensureTrailingDirectorySeparator, getBaseFileName } from "./tspath";\n`,
    `import { type ComparePathsOptions, comparePaths, ensureTrailingDirectorySeparator, getBaseFileName } from "./tspath";\n\n// tspath.ComparePaths on names of the model: its comparers fold runes, so the names are decoded first.\nexport function comparePathsOf(rules: Rules, a: string, b: string, options: ComparePathsOptions): number {\n  return comparePaths(rules.model.toString(a), rules.model.toString(b), options);\n}\n`,
    1,
  ],
  [r("error_baseline.ts"), "comparePaths(removeTestPathPrefixes(rules, e.file.fileName), removeTestPathPrefixes(rules, inputFile.unitName), {", "comparePathsOf(rules, removeTestPathPrefixes(rules, e.file.fileName), removeTestPathPrefixes(rules, inputFile.unitName), {", 1],
  [r("reader.ts"), `import { type TestFile, isDefaultLibraryFile } from "./error_baseline";`, `import { type TestFile, comparePathsOf, isDefaultLibraryFile } from "./error_baseline";`, 1],
  [r("reader.ts"), `import { comparePaths, getBaseFileName, getRootLength } from "./tspath";`, `import { getBaseFileName, getRootLength } from "./tspath";`, 1],
  [r("reader.ts"), "comparePaths(e.fileName, section.name, caseInsensitive)", "comparePathsOf(rules, e.fileName, section.name, caseInsensitive)", 1],
  [r("reader.ts"), "comparePaths(unitName, realName(rules, sectionName, true), caseInsensitive)", "comparePathsOf(rules, unitName, realName(rules, sectionName, true), caseInsensitive)", 1],
  [r("reader.ts"), "comparePaths(name, sections[k].name, caseInsensitive)", "comparePathsOf(rules, name, sections[k].name, caseInsensitive)", 1],
  [r("shape.ts"), `import { type TestFile, isDefaultLibraryFile, removeTestPathPrefixes } from "./error_baseline";`, `import { type TestFile, comparePathsOf, isDefaultLibraryFile, removeTestPathPrefixes } from "./error_baseline";`, 1],
  [r("shape.ts"), `import { comparePaths } from "./tspath";\n`, "", 1],
  [r("shape.ts"), "comparePaths(shown, removeTestPathPrefixes(rules, f.unitName), caseInsensitive)", "comparePathsOf(rules, shown, removeTestPathPrefixes(rules, f.unitName), caseInsensitive)", 1],
  // scanner.ComputeLineOfPosition lives in scanner.ts.
  [
    r("diagnosticwriter.ts"),
    `// scanner.ComputeLineOfPosition\nexport function computeLineOfPosition(lineStarts: number[], pos: number): number {\n  let low = 0;\n  let high = lineStarts.length - 1;\n  while (low <= high) {\n    const middle = low + ((high - low) >> 1);\n    const value = lineStarts[middle];\n    if (value < pos) low = middle + 1;\n    else if (value > pos) high = middle - 1;\n    else return middle;\n  }\n  return low - 1;\n}\n\n`,
    "",
    1,
  ],
  [r("diagnosticwriter.ts"), `import { padLeft } from "./gostrings";\n`, `import { padLeft } from "./gostrings";\nimport { computeLineOfPosition } from "./scanner";\n`, 1],
  [r("shape.ts"), `  categoryName,\n  computeLineOfPosition,\n} from "./diagnosticwriter";\n`, `  categoryName,\n} from "./diagnosticwriter";\n`, 1],
  [r("shape.ts"), `import type { ParsedErrorBaseline } from "./reader";\n`, `import type { ParsedErrorBaseline } from "./reader";\nimport { computeLineOfPosition } from "./scanner";\n`, 1],
  // index.ts: a case that cannot be read is told apart, and the file of the post-emit order is beside the runner.
  [r("index.ts"), `  const content = readFile(file).contents;\n`, `  const read = readFile(file);\n  if (!read.ok) return { ok: false, status: "invalid", reason: "Could not read test file: " + file };\n  const content = read.contents;\n`, 1],
  [r("index.ts"), `new URL("../../oracle-and-expectations/top-down/vectors/post-emit-order.txt", import.meta.url)`, `new URL("../post-emit-order.txt", import.meta.url)`, 1],
  // sweep.ts and the test: the runner is a directory, and the test reads the vectors of the research where they are.
  ["test/cli/lint/conformance/sweep.ts", `} from "./runner/index";`, `} from "./runner";`, 1],
  ["test/cli/lint/conformance.test.ts", `} from "./conformance/runner/index";`, `} from "./conformance/runner";`, 1],
  ["test/cli/lint/conformance.test.ts", `const notes = join(import.meta.dir, "..", "..");`, `const notes = ${JSON.stringify(notes)};`, 1],
  ["test/cli/lint/conformance.test.ts", `join(import.meta.dir, "expectations.json")`, `join(import.meta.dir, "conformance", "expectations.json")`, 1],
  // The test of the directive parser: one parser, bytes that are not UTF-8 throw, the trivia scan takes a byte string.
  [
    "test/cli/lint/conformance.test.ts",
    `import { getConfigNameFromFileName } from "../../directive-grammar/prototype/harnessutil";\nimport { skipTrivia } from "../../directive-grammar/prototype/scanner";\nimport * as directives from "../../directive-grammar/prototype/test_case_parser";\nimport { decodeBytes } from "../../directive-grammar/prototype/vfs";\n`,
    `import { InvalidUtf8Error, utf8String, utf8ToByteString } from "./conformance/runner/gostrings";\nimport { skipTrivia } from "./conformance/runner/scanner";\nimport * as directives from "./conformance/runner/test_case_parser";\nimport { decodeBytes } from "./conformance/runner/vfs";\n`,
    1,
  ],
  [
    "test/cli/lint/conformance.test.ts",
    `      const d = raw.length === 0 ? { ok: true as const, value: "" } : decodeBytes(raw);\n      if (!d.ok) return { name: i.name, refused: d.reason };\n      const content = d.value;\n      const bytes = new TextEncoder().encode(content);\n`,
    `      let content: string;\n      try {\n        content = raw.length === 0 ? "" : utf8String(decodeBytes(raw));\n      } catch (e) {\n        if (!(e instanceof InvalidUtf8Error)) throw e;\n        return { name: i.name, refused: "not valid UTF-8" };\n      }\n      const bytes = utf8ToByteString(content);\n`,
    1,
  ],
  ["test/cli/lint/conformance.test.ts", "let units = r.value.units;", "let units: any[] = r.units;", 1],
  ["test/cli/lint/conformance.test.ts", `o.error = r.value.error ?? "";`, `o.error = r.error ?? "";`, 1],
  ["test/cli/lint/conformance.test.ts", "o.symlinks = obj(r.value.symlinks);", "o.symlinks = obj(r.symlinks);", 1],
  ["test/cli/lint/conformance.test.ts", "o.currentDirectory = r.value.currentDirectory;", "o.currentDirectory = r.currentDirectory;", 1],
  ["test/cli/lint/conformance.test.ts", "o.globalOptions = obj(r.value.globalOptions);", "o.globalOptions = obj(r.globalOptions);", 1],
  ["test/cli/lint/conformance.test.ts", "getConfigNameFromFileName(u.name)", "directives.getConfigNameFromFileName(u.name)", 1],
];

if (import.meta.main) {
  rmSync(out, { recursive: true, force: true });
  const texts = new Map<string, string>();
  for (const [committed, source] of moduleMap) {
    const from = join(notes, source);
    const to = join(out, committed);
    mkdirSync(dirname(to), { recursive: true });
    if (!committed.endsWith(".ts")) {
      cpSync(from, to);
      continue;
    }
    let text = readFileSync(from, "utf8");
    // The four imports of the test that name the directive-grammar prototype are replaced whole by an edit below.
    const direct = committed.endsWith("conformance.test.ts");
    if (direct) text = text.replace(/^import .* from "\.\.\/\.\.\/directive-grammar\/prototype\/[a-z_]+";$/gm, s => "//KEEP " + s);
    text = source.startsWith(here) ? text : rewriteImports(committed, source, text);
    if (direct) text = text.replace(/^\/\/KEEP /gm, "");
    texts.set(committed, text);
  }
  for (const [file, oldText, newText, times] of edits) {
    const text = texts.get(file);
    if (text === undefined) throw new Error("edit of a file that is not in the module map: " + file);
    const found = text.split(oldText).length - 1;
    if (found !== times) throw new Error(`${file}: the text of an edit occurs ${found} times, not ${times}: ${oldText.slice(0, 90)}`);
    texts.set(file, text.replaceAll(oldText, newText));
  }
  for (const [file, text] of texts) writeFileSync(join(out, file), text);
  const edited = new Map<string, number>();
  for (const [file] of edits) edited.set(file, (edited.get(file) ?? 0) + 1);
  console.log(`${moduleMap.length} files in ${out}; ${edits.length} edits in ${edited.size} files`);
  for (const [committed, source] of moduleMap) console.log(`  ${committed}\t<- ${source}${edited.has(committed) ? "\t(" + edited.get(committed) + " edits)" : ""}`);
}
