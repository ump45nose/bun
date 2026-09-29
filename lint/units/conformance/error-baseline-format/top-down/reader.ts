// Reader of .errors.txt baselines: bytes to files and diagnostics that the writer takes as input.
import {
  type Diagnostic,
  type FileLike,
  Category,
  categoryFromName,
  computeECMALineStarts,
} from "./diagnosticwriter";
import { type TestFile, isDefaultLibraryFile } from "./error_baseline";
import { type ByteString, decodeRune } from "./go_compat";
import { comparePaths, getRootLength } from "./tspath";

export interface ReadOptions {
  // Name of the root that a default library file without a section gets, for the order of the first section.
  libraryRoot: ByteString;
  // Root of a relative name.
  sourceRoot: ByteString;
  // Line break that joins the source lines of a section.
  contentNewLines: ByteString[];
}

export const goReadOptions: ReadOptions = {
  libraryRoot: "bundled:///libs/",
  sourceRoot: "/.src/",
  contentNewLines: ["\n", "\r\n"],
};

export interface ParsedErrorBaseline {
  pretty: boolean;
  files: TestFile[];
  diagnostics: Diagnostic[];
  // Every place where the text did not determine the result and what the reader chose.
  decisions: string[];
}

export class ReadError extends Error {}

interface Entry {
  fileName: ByteString | undefined;
  // 1-based as printed; undefined when masked as (--,--).
  line: number | undefined;
  character: number | undefined;
  category: Category;
  code: number;
  messageLines: ByteString[];
  // Pretty form only: the span as the code snippet shows it.
  snippet?: Snippet;
  related: RelatedEntry[];
  relatedKnown: boolean;
  // Filled from the file sections.
  squiggles: Squiggle[];
  messageSeen: boolean;
}

interface RelatedEntry {
  fileName: ByteString | undefined;
  line: number | undefined;
  character: number | undefined;
  code: number | undefined;
  messageLines: ByteString[];
  snippet?: Snippet;
}

interface Snippet {
  firstLine: number;
  lastLine: number;
  firstLineSpaces: number;
  firstLineTildes: number;
  lastLineTildes: number;
}

interface Squiggle {
  section: number;
  lineIndex: number;
  prefix: ByteString;
  tildes: number;
  ended: boolean;
}

interface Section {
  name: ByteString;
  count: number;
  lines: ByteString[];
  contentLines: ByteString[];
  entries: Entry[];
}

const plainHead = /^(?:(.+?)\((\d+|--),(\d+|--)\): )?(error|warning|suggestion|message) TS(-?\d+): (.*)$/s;
const globalHead = /^(error|warning|suggestion|message) TS(-?\d+): (.*)$/s;
const sectionHead = /^==== (.*) \((\d+) errors\) ====$/s;
const relatedLine = /^!!! related TS(-?\d+)(?: (.+?):(\d+|--):(\d+|--))?: (.*)$/s;
const squiggleLine = /^    [\t\n\f\r ]*~*$/;

const esc = "\x1b";
const reset = esc + "[0m";
const locationPattern = `${esc}\\[96m(.*?)${esc}\\[0m:${esc}\\[93m(\\d+)${esc}\\[0m:${esc}\\[93m(\\d+)${esc}\\[0m`;
const prettyHead = new RegExp(
  `^(?:${locationPattern} - )?${esc}\\[9[0134]m(error|warning|suggestion|message)${esc}\\[0m${esc}\\[90m TS(-?\\d+): ${esc}\\[0m(.*)$`,
  "s",
);
const prettyRelatedHead = new RegExp(`^  ${locationPattern} - (.*)$`, "s");
const gutterLine = new RegExp(`^( *)${esc}\\[7m( *)(\\d+|\\.\\.\\.| *)${esc}\\[0m (.*)$`, "s");
const gutterSquiggle = new RegExp(`^( *)${esc}\\[7m( *)${esc}\\[0m ${esc}\\[9[01346]m( *)(~*)${esc}\\[0m$`, "s");

export function readErrorBaseline(text: ByteString, options: ReadOptions = goReadOptions): ParsedErrorBaseline {
  const decisions: string[] = [];
  const pretty = text.startsWith(esc + "[");
  const boundary = text.indexOf("\r\n\r\n\r\n");
  if (boundary < 0) throw new ReadError("no end of the first section");
  const top = text.slice(0, boundary + 2);
  let body = text.slice(boundary + 6);

  const entries = pretty ? readPrettyTop(top, decisions) : readPlainTop(top, decisions);

  let bodyLines = body === "" ? [] : body.split("\r\n");
  let summary: ByteString | undefined;
  if (pretty) {
    // The summary starts with a line break, so its first line is a body line that no section owns.
    let at = -1;
    for (let i = 0; i < bodyLines.length; i++) {
      const l = bodyLines[i];
      if (!l.startsWith("    ") && !l.startsWith("!!! ") && !(l.startsWith("==== ") && sectionHead.test(l))) {
        at = i;
        break;
      }
    }
    if (at >= 0) {
      summary = bodyLines.slice(at).join("\r\n");
      bodyLines = bodyLines.slice(0, at);
    }
  }
  void summary;

  // Global section: the lines before the first header.
  let i = 0;
  const globalLines: ByteString[] = [];
  while (i < bodyLines.length && !isSectionHead(bodyLines[i])) {
    globalLines.push(bodyLines[i]);
    i++;
  }
  readGlobalSection(globalLines, entries, decisions);

  const sections: Section[] = [];
  while (i < bodyLines.length) {
    const m = sectionHead.exec(bodyLines[i]);
    if (m === null) throw new ReadError(`expected a file header at body line ${i + 1}`);
    i++;
    const lines: ByteString[] = [];
    while (i < bodyLines.length && !isSectionHead(bodyLines[i])) {
      lines.push(bodyLines[i]);
      i++;
    }
    sections.push({ name: m[1], count: Number(m[2]), lines, contentLines: [], entries: [] });
  }

  for (const section of sections) {
    section.entries = entries.filter(
      e =>
        e.fileName !== undefined &&
        comparePaths(e.fileName, section.name, { useCaseSensitiveFileNames: false, currentDirectory: "" }) === 0,
    );
    if (section.entries.length !== section.count) {
      throw new ReadError(
        `header of ${section.name} counts ${section.count}, the first section has ${section.entries.length}`,
      );
    }
  }

  sections.forEach((section, index) => readSection(section, index, decisions));

  for (const e of entries) {
    if (e.fileName !== undefined && !e.messageSeen) {
      e.relatedKnown = false;
    }
  }

  // Files and positions.
  let lastError: unknown;
  for (const contentNewLine of options.contentNewLines) {
    try {
      const result = build(pretty, entries, sections, options, contentNewLine, decisions.slice());
      if (contentNewLine !== options.contentNewLines[0]) {
        result.decisions.push(`source lines joined with ${JSON.stringify(contentNewLine)}`);
      }
      return result;
    } catch (e) {
      if (!(e instanceof ReadError)) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

function isSectionHead(line: ByteString): boolean {
  return line.startsWith("==== ") && sectionHead.test(line);
}

function readPlainTop(top: ByteString, decisions: string[]): Entry[] {
  const lines = top.split("\r\n");
  lines.pop();
  const entries: Entry[] = [];
  for (const line of lines) {
    let m = globalHead.exec(line);
    let fileName: ByteString | undefined;
    let ln: number | undefined;
    let ch: number | undefined;
    let category: Category | undefined;
    let code = 0;
    let first = "";
    if (m !== null) {
      category = categoryFromName(m[1]);
      code = Number(m[2]);
      first = m[3];
    } else {
      m = plainHead.exec(line);
      if (m !== null && m[1] !== undefined) {
        fileName = m[1];
        ln = m[2] === "--" ? undefined : Number(m[2]);
        ch = m[3] === "--" ? undefined : Number(m[3]);
        category = categoryFromName(m[4]);
        code = Number(m[5]);
        first = m[6];
      }
    }
    if (category === undefined) {
      if (entries.length === 0) throw new ReadError("the first section does not start with a diagnostic");
      entries[entries.length - 1].messageLines.push(line);
      continue;
    }
    entries.push({
      fileName,
      line: ln,
      character: ch,
      category,
      code,
      messageLines: [first],
      related: [],
      relatedKnown: true,
      squiggles: [],
      messageSeen: false,
    });
  }
  void decisions;
  return entries;
}

function readPrettyTop(top: ByteString, decisions: string[]): Entry[] {
  const lines = top.split("\r\n");
  lines.pop();
  const entries: Entry[] = [];
  let i = 0;
  const readSnippet = (indent: string): Snippet | undefined => {
    // An empty line, then pairs of a gutter line and a squiggle line.
    let j = i;
    const shown: { line: number; spaces: number; tildes: number }[] = [];
    while (j + 1 < lines.length) {
      const g = gutterLine.exec(lines[j]);
      if (g === null || g[1] !== indent) break;
      if (g[3] === "...") {
        j++;
        continue;
      }
      const s = gutterSquiggle.exec(lines[j + 1]);
      if (s === null || s[1] !== indent) break;
      shown.push({ line: Number(g[3]), spaces: s[3].length, tildes: s[4].length });
      j += 2;
    }
    if (shown.length === 0) return undefined;
    i = j;
    const firstShown = shown[0];
    const lastShown = shown[shown.length - 1];
    return {
      firstLine: firstShown.line,
      lastLine: lastShown.line,
      firstLineSpaces: firstShown.spaces,
      firstLineTildes: firstShown.tildes,
      lastLineTildes: lastShown.tildes,
    };
  };
  while (i < lines.length) {
    const m = prettyHead.exec(lines[i]);
    if (m === null) throw new ReadError(`pretty first section: no diagnostic at line ${i + 1}`);
    i++;
    const entry: Entry = {
      fileName: m[1],
      line: m[2] === undefined ? undefined : Number(m[2]),
      character: m[3] === undefined ? undefined : Number(m[3]),
      category: categoryFromName(m[4])!,
      code: Number(m[5]),
      messageLines: [m[6]],
      related: [],
      relatedKnown: true,
      squiggles: [],
      messageSeen: false,
    };
    entries.push(entry);
    // Message lines up to the empty line before the snippet, or up to the next diagnostic.
    while (i < lines.length && lines[i] !== "" && prettyHead.exec(lines[i]) === null) {
      entry.messageLines.push(lines[i]);
      i++;
    }
    if (entry.fileName !== undefined) {
      if (lines[i] === "") {
        i++;
        entry.snippet = readSnippet("");
      }
      if (entry.snippet === undefined) decisions.push(`no code snippet for ${entry.fileName}, code ${entry.code}`);
    }
    // Related information: an empty line, then "  location - message", chain lines and a snippet.
    while (i + 1 < lines.length && lines[i] === "" && prettyRelatedHead.test(lines[i + 1])) {
      const r = prettyRelatedHead.exec(lines[i + 1])!;
      i += 2;
      const related: RelatedEntry = {
        fileName: r[1],
        line: Number(r[2]),
        character: Number(r[3]),
        code: undefined,
        messageLines: [r[4]],
      };
      while (i < lines.length && lines[i] !== "" && gutterLine.exec(lines[i]) === null) {
        related.messageLines.push(lines[i]);
        i++;
      }
      related.snippet = readSnippet("    ");
      entry.related.push(related);
    }
    // The line break between two diagnostics.
    if (i < lines.length && lines[i] === "") i++;
  }
  return entries;
}

function expectedMessageLines(e: { category?: Category; code: number; messageLines: ByteString[] }): ByteString[] {
  return e.messageLines.filter(l => l.length > 0);
}

function readGlobalSection(lines: ByteString[], entries: Entry[], decisions: string[]): void {
  let i = 0;
  for (const e of entries) {
    if (e.fileName !== undefined) continue;
    i = readMessageLines(lines, i, e, decisions);
  }
  if (i !== lines.length) throw new ReadError(`global section: ${lines.length - i} lines left over`);
}

// Reads the lines of one diagnostic at lines[i]: message lines, then related lines. Returns the next index.
function readMessageLines(lines: ByteString[], i: number, e: Entry, decisions: string[]): number {
  const want = expectedMessageLines(e);
  const head = `!!! ${["warning", "error", "suggestion", "message"][e.category]} TS${e.code}: `;
  for (const w of want) {
    const line = lines[i];
    if (line === undefined || line !== head + w) {
      throw new ReadError(`message line differs from the first section: ${JSON.stringify(line)} against ${JSON.stringify(head + w)}`);
    }
    i++;
  }
  const related: RelatedEntry[] = [];
  while (i < lines.length && lines[i].startsWith("!!! related TS")) {
    const m = relatedLine.exec(lines[i]);
    if (m === null) throw new ReadError(`related line not understood: ${lines[i]}`);
    related.push({
      fileName: m[2],
      line: m[3] === undefined || m[3] === "--" ? undefined : Number(m[3]),
      character: m[4] === undefined || m[4] === "--" ? undefined : Number(m[4]),
      code: Number(m[1]),
      messageLines: [m[5]],
    });
    i++;
    // A related message of several lines continues on lines that carry no mark.
    while (
      i < lines.length &&
      !lines[i].startsWith("!!! ") &&
      !lines[i].startsWith("    ") &&
      !isSectionHead(lines[i])
    ) {
      related[related.length - 1].messageLines.push(lines[i]);
      decisions.push("related message continues on an unmarked line");
      i++;
    }
  }
  if (e.messageSeen) {
    // The same diagnostic in a second section: the related lines must repeat.
    if (JSON.stringify(stripSnippets(e.related)) !== JSON.stringify(stripSnippets(related)) && !e.related.some(r => r.snippet)) {
      throw new ReadError("related lines differ between two sections");
    }
  } else if (e.related.length > 0) {
    // Pretty form: the first section gave the related entries, the lines here give their codes.
    if (e.related.length !== related.length) throw new ReadError("related count differs from the first section");
    for (let k = 0; k < related.length; k++) {
      e.related[k].code = related[k].code;
    }
  } else {
    e.related = related;
  }
  e.messageSeen = true;
  return i;
}

function stripSnippets(r: RelatedEntry[]): unknown {
  return r.map(x => [x.fileName, x.line, x.character, x.code, x.messageLines]);
}

function readSection(section: Section, sectionIndex: number, decisions: string[]): void {
  const lines = section.lines;
  const entries = section.entries;
  // 0 not started, 1 started, 2 message written
  const state: number[] = entries.map(() => 0);
  let i = 0;
  let lineIndex = 0;

  const isLastLine = (from: number): boolean => {
    let j = from;
    for (let k = 0; k < entries.length; k++) {
      if (state[k] === 2) continue;
      if (j >= lines.length || lines[j].startsWith("!!! ") || !squiggleLine.test(lines[j])) return false;
      j++;
      if (j >= lines.length || !lines[j].startsWith("!!! ")) return false;
      while (j < lines.length && lines[j].startsWith("!!! ")) j++;
    }
    return j === lines.length;
  };

  if (lines.length === 0) throw new ReadError(`section ${section.name} has no line`);
  while (i < lines.length) {
    const contentLine = lines[i];
    if (!contentLine.startsWith("    ")) {
      throw new ReadError(`section ${section.name}: source line without indent: ${JSON.stringify(contentLine)}`);
    }
    i++;
    section.contentLines.push(contentLine.slice(4));
    const last = isLastLine(i);
    for (let k = 0; k < entries.length; k++) {
      if (state[k] === 2) continue;
      const e = entries[k];
      let expects: boolean;
      if (state[k] === 1 || last) {
        expects = true;
      } else if (e.line !== undefined) {
        expects = e.line - 1 <= lineIndex;
      } else {
        // Masked position: the line tells. Tildes, or a message after it, make it a squiggle line.
        const l = lines[i];
        expects =
          l !== undefined &&
          squiggleLine.test(l) &&
          (l.includes("~") || (lines[i + 1] !== undefined && lines[i + 1].startsWith("!!! ")));
        if (expects) decisions.push(`masked position in ${section.name}: squiggle line taken by its look`);
      }
      if (!expects) continue;
      const l = lines[i];
      if (l === undefined || !squiggleLine.test(l)) {
        throw new ReadError(
          `section ${section.name}: squiggle line expected after source line ${lineIndex + 1}, found ${JSON.stringify(l)}`,
        );
      }
      i++;
      const tildeAt = l.indexOf("~");
      const prefix = tildeAt < 0 ? l.slice(4) : l.slice(4, tildeAt);
      const tildes = tildeAt < 0 ? 0 : l.length - tildeAt;
      state[k] = 1;
      const ended = i < lines.length && lines[i].startsWith("!!! ");
      if (e.fileName !== undefined) {
        e.squiggles.push({ section: sectionIndex, lineIndex, prefix, tildes, ended });
      }
      if (ended) {
        i = readMessageLines(lines, i, e, decisions);
        state[k] = 2;
      }
    }
    lineIndex++;
  }
  for (let k = 0; k < entries.length; k++) {
    if (state[k] !== 2) throw new ReadError(`section ${section.name}: a diagnostic has no message`);
  }
}

// Byte offset in line of the position that is `units` UTF-16 code units after `from`.
function advanceUTF16(text: ByteString, from: number, units: number, limit: number): number | undefined {
  let pos = from;
  let n = 0;
  while (n < units) {
    if (pos >= limit) return undefined;
    const c = text.charCodeAt(pos);
    if (c < 0x80) {
      pos++;
      n++;
    } else {
      const [r, size] = decodeRune(text, pos);
      pos += size;
      n += r >= 0x10000 ? 2 : 1;
    }
  }
  return n === units ? pos : undefined;
}

function advanceRunes(text: ByteString, from: number, runes: number): number | undefined {
  let pos = from;
  for (let n = 0; n < runes; n++) {
    if (pos >= text.length) return undefined;
    const c = text.charCodeAt(pos);
    pos += c < 0x80 ? 1 : decodeRune(text, pos)[1];
  }
  return pos;
}

interface SyntheticFile extends FileLike {
  wanted: [number, number][];
}

function build(
  pretty: boolean,
  entries: Entry[],
  sections: Section[],
  options: ReadOptions,
  contentNewLine: ByteString,
  decisions: string[],
): ParsedErrorBaseline {
  const files: TestFile[] = sections.map(s => ({
    unitName: s.name,
    content: s.contentLines.join(contentNewLine),
  }));
  const sectionFiles: FileLike[] = sections.map((s, k) => ({
    fileName: realName(s.name, true, options),
    text: files[k].content,
  }));
  const lineStarts = sectionFiles.map(f => computeECMALineStarts(f.text));
  sectionFiles.forEach((f, k) => (f.lineMap = lineStarts[k]));

  // The file of a name: the last section of that exact name, else the last one that compares equal.
  const sectionOf = (name: ByteString): number => {
    let found = -1;
    for (let k = 0; k < sections.length; k++) if (sections[k].name === name) found = k;
    if (found >= 0) return found;
    for (let k = 0; k < sections.length; k++) {
      if (comparePaths(name, sections[k].name, { useCaseSensitiveFileNames: false, currentDirectory: "" }) === 0) {
        found = k;
      }
    }
    return found;
  };

  const synthetic = new Map<ByteString, SyntheticFile>();
  const syntheticOf = (name: ByteString): SyntheticFile => {
    let f = synthetic.get(name);
    if (f === undefined) {
      f = { fileName: realName(name, false, options), text: "", wanted: [] };
      synthetic.set(name, f);
    }
    return f;
  };
  const namedFiles = new Map<ByteString, FileLike>();
  const fileOf = (name: ByteString): { file: FileLike; section: number } => {
    const k = sectionOf(name);
    if (k < 0) return { file: syntheticOf(name), section: -1 };
    if (sections[k].name === name) return { file: sectionFiles[k], section: k };
    // The name differs from the header (case, or a leading "./"): same text, own name.
    let f = namedFiles.get(name);
    if (f === undefined) {
      f = { fileName: realName(name, true, options), text: sectionFiles[k].text, lineMap: lineStarts[k] };
      namedFiles.set(name, f);
    }
    return { file: f, section: k };
  };

  const pending: (() => void)[] = [];
  const position = (
    name: ByteString,
    line: number | undefined,
    character: number | undefined,
    set: (file: FileLike, pos: number, section: number) => void,
  ): void => {
    const { file, section } = fileOf(name);
    if (section < 0) {
      const s = file as SyntheticFile;
      if (line === undefined || character === undefined) {
        // Masked: the order of appearance is all that is known.
        const index = s.wanted.length;
        s.wanted.push([-1, index]);
        pending.push(() => set(s, syntheticPosition(s, -1, index), -1));
      } else {
        s.wanted.push([line, character]);
        pending.push(() => set(s, syntheticPosition(s, line, character), -1));
      }
      return;
    }
    if (line === undefined || character === undefined) {
      set(file, -1, section);
      return;
    }
    const starts = lineStarts[section];
    if (line - 1 >= starts.length) throw new ReadError(`line ${line} is outside ${name}`);
    const lineStart = starts[line - 1];
    const lineEnd = line < starts.length ? starts[line] : file.text.length;
    const pos = advanceUTF16(file.text, lineStart, character - 1, lineEnd + 1);
    if (pos === undefined) throw new ReadError(`column ${character} is outside line ${line} of ${name}`);
    set(file, pos, section);
  };

  const diagnostics: Diagnostic[] = [];
  for (const e of entries) {
    const d: Diagnostic = {
      file: undefined,
      pos: -1,
      end: -1,
      code: e.code,
      category: e.category,
      messageText: "",
      messageChain: [],
      relatedInformation: [],
    };
    chainFromLines(e.messageLines, d);
    if (e.fileName !== undefined) {
      position(e.fileName, e.line, e.character, (file, pos, section) => {
        d.file = file;
        d.pos = pos;
        d.end = pos;
        if (section >= 0) spanFromSquiggles(e, d, section, sections, lineStarts, decisions);
        else if (e.snippet !== undefined) decisions.push(`span of a diagnostic in ${e.fileName} not read from its snippet`);
      });
    }
    if (!e.relatedKnown) {
      decisions.push(`related information of a diagnostic in ${e.fileName} is not in the text`);
    }
    for (const r of e.related) {
      const rd: Diagnostic = {
        file: undefined,
        pos: -1,
        end: -1,
        code: r.code ?? 0,
        category: Category.Message,
        messageText: "",
        messageChain: [],
        relatedInformation: [],
      };
      chainFromLines(r.messageLines, rd);
      if (r.fileName !== undefined) {
        position(r.fileName, r.line, r.character, (file, pos, section) => {
          rd.file = file;
          rd.pos = Math.max(pos, 0);
          rd.end = rd.pos;
          if (r.snippet !== undefined && section >= 0) {
            spanFromSnippet(r.snippet, rd, lineStarts[section], decisions);
          }
        });
      }
      d.relatedInformation.push(rd);
    }
    diagnostics.push(d);
  }
  for (const s of synthetic.values()) fillSynthetic(s);
  for (const p of pending) p();

  return { pretty, files, diagnostics, decisions };
}

// Text in which each wanted line has the wanted columns; a masked entry is a column of line 1.
function fillSynthetic(s: SyntheticFile): void {
  const masked = s.wanted.filter(w => w[0] < 0).length;
  let maxLine = masked > 0 ? 1 : 0;
  const width = new Map<number, number>();
  if (masked > 0) width.set(1, masked);
  for (const [line, character] of s.wanted) {
    if (line < 0) continue;
    maxLine = Math.max(maxLine, line);
    width.set(line, Math.max(width.get(line) ?? 0, character - 1));
  }
  const lines: string[] = [];
  for (let l = 1; l <= maxLine; l++) lines.push(" ".repeat(width.get(l) ?? 0));
  s.text = lines.join("\n");
  s.lineMap = computeECMALineStarts(s.text);
}

function syntheticPosition(s: SyntheticFile, line: number, character: number): number {
  if (line < 0) return character;
  return s.lineMap![line - 1] + character - 1;
}

// The name that the sort compares: a rooted name as printed, a library name without section under the library root.
function realName(name: ByteString, hasSection: boolean, options: ReadOptions): ByteString {
  if (getRootLength(name) !== 0) return name;
  if (!hasSection && isDefaultLibraryFile(name)) return options.libraryRoot + name;
  return options.sourceRoot + name;
}

function chainFromLines(lines: ByteString[], root: Diagnostic): void {
  root.messageText = lines[0];
  const stack: Diagnostic[] = [root];
  for (let k = 1; k < lines.length; k++) {
    const line = lines[k];
    let indent = 0;
    while (indent < line.length && line.charCodeAt(indent) === 0x20) indent++;
    const level = Math.min(indent >> 1, stack.length);
    if (level === 0) {
      // A line break inside the text of a message.
      stack[stack.length - 1].messageText += "\r\n" + line;
      continue;
    }
    const node: Diagnostic = {
      file: undefined,
      pos: -1,
      end: -1,
      code: root.code,
      category: root.category,
      messageText: line.slice(2 * level),
      messageChain: [],
      relatedInformation: [],
    };
    stack.length = level;
    stack[level - 1].messageChain.push(node);
    stack.push(node);
  }
}

function spanFromSquiggles(
  e: Entry,
  d: Diagnostic,
  section: number,
  sections: Section[],
  lineStarts: number[][],
  decisions: string[],
): void {
  const own = e.squiggles.filter(s => s.section === section);
  if (own.length === 0) throw new ReadError(`no squiggle line for a diagnostic in ${e.fileName}`);
  const first = own[0];
  const last = own[own.length - 1];
  if (!last.ended) throw new ReadError("the last squiggle line of a diagnostic has no message");
  const starts = lineStarts[section];
  const content = sections[section].contentLines;
  if (d.pos < 0) {
    // Masked position: the first squiggle line gives the start.
    const at = advanceRunes(content[first.lineIndex], 0, first.prefix.length);
    if (at === undefined) throw new ReadError("squiggle prefix is longer than its line");
    d.pos = starts[first.lineIndex] + at;
    decisions.push(`masked position in ${e.fileName}: start read from the squiggle line`);
  }
  const line = content[last.lineIndex];
  const thisLineStart = starts[last.lineIndex];
  const squiggleStart = Math.max(0, d.pos - thisLineStart);
  if (squiggleStart > line.length) throw new ReadError("squiggle starts after the end of its line");
  const stop = advanceRunes(line, squiggleStart, last.tildes);
  if (stop === undefined) throw new ReadError("more tildes than characters");
  d.end = Math.max(d.pos, thisLineStart + stop);
  // A message that is written before the last line says that the span ends before the next line.
  const isLastLine = last.lineIndex === content.length - 1;
  if (!isLastLine && last.lineIndex + 1 < starts.length && d.end >= starts[last.lineIndex + 1]) {
    throw new ReadError("span runs into the next line but its message is written here");
  }
  if (last.lineIndex > 0 && own.length > 1 && d.end < thisLineStart) {
    throw new ReadError("span ends before the line of its last squiggle");
  }
}

function spanFromSnippet(snippet: Snippet, d: Diagnostic, starts: number[], decisions: string[]): void {
  const file = d.file!;
  const lineStart = starts[snippet.lastLine - 1];
  if (lineStart === undefined) throw new ReadError("snippet line outside the file");
  const lineEnd = snippet.lastLine < starts.length ? starts[snippet.lastLine] : file.text.length;
  const units =
    snippet.firstLine === snippet.lastLine ? snippet.firstLineSpaces + snippet.firstLineTildes : snippet.lastLineTildes;
  const end = advanceUTF16(file.text, lineStart, units, lineEnd + 1);
  if (end === undefined) {
    // One tilde after the end of the text is how a span of no length prints.
    d.end = d.pos;
    decisions.push("snippet squiggle runs past its line: span of no length");
    return;
  }
  if (snippet.firstLine === snippet.lastLine && snippet.firstLineTildes === 1) {
    decisions.push("snippet with one tilde: length 1 chosen, length 0 prints the same");
  }
  d.end = Math.max(d.pos, end);
}
