// The reader of .errors.txt baselines: bytes to diagnostics and files, the inverse of getErrorBaseline.
import { Category, type Diagnostic, type FileLike, computeECMALineStarts, flattenDiagnosticMessage } from "./diagnosticwriter";
import { type Rules, type TestFile, isDefaultLibraryFile, removeTestPathPrefixes } from "./error_baseline";
import { type ByteString, decodeRune, replaceNonWhitespace, runeCount, utf16Len } from "./go_compat";
import * as tsc from "./tsc_rules";
import { comparePaths } from "./tspath";

export interface ParsedFile extends FileLike {
  // False when the baseline has no section for the file: the text is a stand-in that gives back the printed
  // line and column of every position that the baseline names, and nothing else.
  hasText: boolean;
}

export interface ParsedDiagnostic extends Diagnostic {
  file: ParsedFile | undefined;
  messageChain: ParsedDiagnostic[];
  relatedInformation: ParsedDiagnostic[];
  // As printed: 1-based line and 1-based UTF-16 column. Undefined for a global diagnostic and for a masked position.
  line: number | undefined;
  character: number | undefined;
  // False when the baseline does not give the length of the span (no section, or a related span in the plain format).
  hasLength: boolean;
  // The index in the first section.
  order: number;
}

export interface ParsedBaseline {
  pretty: boolean;
  rules: Rules;
  diagnostics: ParsedDiagnostic[];
  files: TestFile[];
  // Places where the text did not decide and the reader took its default.
  ambiguities: string[];
}

export interface ReadOptions {
  rules?: Rules;
  // The units of the case, when the caller has them: name as the header prints it, and content.
  units?: TestFile[];
}

export class BaselineReadError extends Error {}

function fail(message: string): never {
  throw new BaselineReadError(message);
}

const categories: Record<string, Category> = {
  warning: Category.Warning,
  error: Category.Error,
  suggestion: Category.Suggestion,
  message: Category.Message,
};

const headPattern = /^(?:([^]*?)\((\d+|--),(\d+|--)\): )?(error|warning|suggestion|message) TS(-?\d+): ([^]*)$/;
const globalHeadPattern = /^(error|warning|suggestion|message) TS(-?\d+): ([^]*)$/;
const sectionHeaderPattern = /^==== ([^]*) \((\d+) errors\) ====$/;
const relatedPattern = /^!!! related TS(-?\d+)(?: ([^]*?):(\d+|--):(\d+|--))?: ([^]*)$/;
const comparePathsOptions = { useCaseSensitiveFileNames: false, currentDirectory: "" };

interface Head {
  fileName: string | undefined;
  line: number | undefined;
  character: number | undefined;
  category: Category;
  code: number;
  messageLines: string[];
}

// The flattened text of a message and its chain: one line per chain element, two spaces per level.
function parseFlattenedMessage(lines: string[], make: (message: string) => ParsedDiagnostic): ParsedDiagnostic {
  const root = make(lines[0]);
  const stack: ParsedDiagnostic[] = [root];
  let last = root;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    let spaces = 0;
    while (spaces < line.length && line[spaces] === " ") spaces++;
    const level = Math.min(spaces >> 1, stack.length);
    if (level === 0) {
      // Not a chain element: the message itself holds a line break.
      last.message += "\r\n" + line;
      continue;
    }
    const node = make(line.slice(level * 2));
    stack.length = level;
    stack[level - 1].messageChain.push(node);
    stack.push(node);
    last = node;
  }
  return root;
}

function byteOffsetOfUtf16Column(text: ByteString, from: number, units: number): number {
  let pos = from;
  let n = 0;
  while (n < units && pos < text.length) {
    const [r, size] = decodeRune(text, pos);
    n += r >= 0x10000 ? 2 : 1;
    pos += size;
  }
  if (n !== units) fail(`column ${units + 1} is outside of the text`);
  return pos;
}

// The stand-in for a file that has no section: spaces and line feeds that give back each named line and column.
class StandInFile implements ParsedFile {
  hasText = false;
  text = "";
  ecmaLineMap: number[] | undefined;
  private columns = new Map<number, number>();
  private users: { d: ParsedDiagnostic; line: number; character: number }[] = [];
  constructor(public fileName: string) {}
  use(d: ParsedDiagnostic, line: number | undefined, character: number | undefined): void {
    if (line === undefined || character === undefined) {
      d.pos = 0;
      d.end = 0;
      return;
    }
    this.columns.set(line, Math.max(this.columns.get(line) ?? 0, character));
    this.users.push({ d, line, character });
  }
  finish(): void {
    let maxLine = 0;
    for (const line of this.columns.keys()) maxLine = Math.max(maxLine, line);
    const starts: number[] = [];
    let text = "";
    for (let line = 1; line <= maxLine; line++) {
      starts.push(text.length);
      text += " ".repeat(Math.max(0, (this.columns.get(line) ?? 1) - 1));
      if (line < maxLine) text += "\n";
    }
    this.text = text;
    this.ecmaLineMap = undefined;
    for (const { d, line, character } of this.users) {
      d.pos = starts[line - 1] + character - 1;
      d.end = d.pos;
    }
  }
}

interface RuleOps {
  stripPrefixes(text: string): string;
  // The squiggle line of the writer without its four spaces, for a span of `length` bytes from `squiggleStart`.
  squigglePrefix(line: ByteString, squiggleStart: number): ByteString;
  // The number of bytes that `count` tildes cover from `squiggleStart`.
  bytesOfTildes(line: ByteString, squiggleStart: number, count: number): number;
}

const tsgoOps: RuleOps = {
  stripPrefixes: text => removeTestPathPrefixes(text, false),
  squigglePrefix(line, squiggleStart) {
    if (squiggleStart > line.length) fail("the span starts after the end of its line, where the Go writer cannot slice");
    return replaceNonWhitespace(line.slice(0, squiggleStart));
  },
  bytesOfTildes(line, squiggleStart, count) {
    let pos = squiggleStart;
    for (let n = 0; n < count; n++) {
      if (pos >= line.length) fail("more tildes than runes on the line");
      pos += decodeRune(line, pos)[1];
    }
    return pos - squiggleStart;
  },
};

const tscOps: RuleOps = {
  stripPrefixes: tsc.removeTestPathPrefixes,
  squigglePrefix: (line, squiggleStart) => tsc.squiggle(line, squiggleStart, 0),
  bytesOfTildes(line, squiggleStart, count) {
    let pos = squiggleStart;
    let n = 0;
    while (n < count) {
      if (pos >= line.length) fail("more tildes than UTF-16 code units on the line");
      const [r, size] = decodeRune(line, pos);
      n += r >= 0x10000 ? 2 : 1;
      pos += size;
    }
    if (n !== count) fail("the tildes end inside a surrogate pair");
    return pos - squiggleStart;
  },
};

interface Section {
  unitName: string;
  errorCount: number;
  lines: string[];
}

export function readErrorBaseline(text: ByteString, options: ReadOptions = {}): ParsedBaseline {
  const rules = options.rules ?? "tsgo";
  const ops = rules === "tsc" ? tscOps : tsgoOps;
  const pretty = text.startsWith("\u001b[");
  const ambiguities: string[] = [];

  const split = /\r\n\r\n(?===== |!!! )/.exec(text);
  if (split === null) fail("no end of the first section");
  const top = text.slice(0, split.index);
  let rest = text.slice(split.index + 4);

  let summary: string | undefined;
  if (pretty) {
    const at = rest.lastIndexOf("\r\nFound ");
    if (at < 0) fail("a pretty baseline without a summary");
    summary = rest.slice(at);
    rest = rest.slice(0, at);
  }

  const files = new Map<string, ParsedFile>();
  const standIns: StandInFile[] = [];
  const fileFor = (name: string): ParsedFile => {
    let file = files.get(name);
    if (file === undefined) {
      const standIn = new StandInFile(name);
      standIns.push(standIn);
      files.set(name, (file = standIn));
    }
    return file;
  };

  let order = 0;
  const make = (head: Omit<Head, "messageLines">, message: string): ParsedDiagnostic => ({
    file: head.fileName === undefined ? undefined : fileFor(head.fileName),
    pos: 0,
    end: 0,
    code: head.code,
    category: head.category,
    source: "",
    message,
    messageChain: [],
    relatedInformation: [],
    line: head.line,
    character: head.character,
    hasLength: false,
    order: -1,
  });

  const prettyRelated = new Map<ParsedDiagnostic, PrettyRelated[]>();
  const diagnostics: ParsedDiagnostic[] = [];
  if (pretty) {
    for (const p of rules === "tsc" ? readPrettyTopTsc(top) : readPrettyTopTsgo(top)) {
      const chainHead = { ...p.head, fileName: undefined, line: undefined, character: undefined };
      const d = parseFlattenedMessage(p.head.messageLines, message => make(chainHead, message));
      d.file = p.head.fileName === undefined ? undefined : fileFor(p.head.fileName);
      d.line = p.head.line;
      d.character = p.head.character;
      d.order = order++;
      diagnostics.push(d);
      prettyRelated.set(d, p.related);
      (d as { tscEmptyRelated?: boolean }).tscEmptyRelated = p.emptyRelatedBlock;
    }
  } else {
    if (!top.endsWith("\r\n")) fail("the first section does not end with a line break");
    const topLines = top.slice(0, -2).split("\r\n");
    const heads: Head[] = [];
    for (const line of topLines) {
      const g = globalHeadPattern.exec(line);
      if (g !== null) {
        heads.push({ fileName: undefined, line: undefined, character: undefined, category: categories[g[1]], code: Number(g[2]), messageLines: [g[3]] });
        continue;
      }
      const m = headPattern.exec(line);
      if (m !== null && m[1] !== undefined) {
        const masked = m[2] === "--" || m[3] === "--";
        if (masked && (m[2] !== "--" || m[3] !== "--")) fail("a position that is half masked");
        heads.push({
          fileName: m[1],
          line: masked ? undefined : Number(m[2]),
          character: masked ? undefined : Number(m[3]),
          category: categories[m[4]],
          code: Number(m[5]),
          messageLines: [m[6]],
        });
        continue;
      }
      if (heads.length === 0) fail("the first section starts with a line that is not a diagnostic");
      heads[heads.length - 1].messageLines.push(line);
    }
    for (const head of heads) {
      const chainHead = { ...head, fileName: undefined, line: undefined, character: undefined };
      const d = parseFlattenedMessage(head.messageLines, message => make(chainHead, message));
      d.file = head.fileName === undefined ? undefined : fileFor(head.fileName);
      d.line = head.line;
      d.character = head.character;
      d.order = order++;
      diagnostics.push(d);
    }
  }

  // The lines after the first section: the global block, then one block per input file.
  const lines = rest.split("\r\n");
  const sections: Section[] = [];
  const globalLines: string[] = [];
  for (const line of lines) {
    const h = line.startsWith("==== ") ? sectionHeaderPattern.exec(line) : null;
    if (h !== null) {
      sections.push({ unitName: h[1], errorCount: Number(h[2]), lines: [] });
    } else if (sections.length === 0) {
      globalLines.push(line);
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }

  const pendingRelated = new Map<ParsedDiagnostic, { fileName: string; line: number | undefined; character: number | undefined }>();
  const readBlocks = new Map<ParsedDiagnostic, string>();

  // The message lines of a diagnostic and its related information, from block[i]. Returns the next index.
  // acceptChainLine is asked about each line that the text alone cannot tell from a line of the file.
  const readMessageBlock: ReadMessageBlock = (block, i, d, acceptChainLine) => {
    const first = i;
    const message = flattenDiagnosticMessage(d, "\r\n");
    for (let line of ops.stripPrefixes(message).split("\n")) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      const expected = `!!! ${categoryNameOf(d.category)} TS${d.code}: ${line}`;
      if (block[i] !== expected) fail(`message line ${JSON.stringify(block[i])} is not ${JSON.stringify(expected)}`);
      i++;
    }
    const related: ParsedDiagnostic[] = [];
    while (i < block.length && block[i].startsWith("!!! related TS")) {
      const m = relatedPattern.exec(block[i]);
      if (m === null) fail(`related line ${JSON.stringify(block[i])}`);
      i++;
      const messageLines = [m[5]];
      let level = 0;
      while (i < block.length) {
        const line = block[i];
        if (line.startsWith("!!! ") || line.startsWith("==== ")) break;
        let spaces = 0;
        while (spaces < line.length && line[spaces] === " ") spaces++;
        // A line of the file has four spaces in front; a chain line of the first level has two.
        if (spaces >= 4 && (level === 0 || spaces === line.length || !acceptChainLine(i))) break;
        messageLines.push(line);
        level = Math.max(1, Math.min(spaces >> 1, level + 1));
        i++;
      }
      const masked = m[3] === "--";
      const head = {
        fileName: undefined,
        line: m[2] === undefined || masked ? undefined : Number(m[3]),
        character: m[2] === undefined || masked ? undefined : Number(m[4]),
        category: Category.Message,
        code: Number(m[1]),
      };
      const chainHead = { ...head, line: undefined, character: undefined };
      const r = parseFlattenedMessage(messageLines, message => make(chainHead, message));
      r.line = head.line;
      r.character = head.character;
      if (m[2] !== undefined) {
        pendingRelated.set(r, { fileName: m[2], line: head.line, character: head.character });
      }
      related.push(r);
    }
    const printed = block.slice(first, i).join("\r\n");
    const before = readBlocks.get(d);
    if (before === undefined) {
      d.relatedInformation = related;
      readBlocks.set(d, printed);
    } else if (before !== printed) {
      fail("two sections print one diagnostic with different messages");
    }
    return i;
  };

  // Global diagnostics.
  {
    let i = 0;
    for (const d of diagnostics) {
      if (d.file !== undefined) continue;
      i = readMessageBlock(globalLines, i, d, () => true);
    }
    if (i !== globalLines.length && !(i === 0 && globalLines.length === 1 && globalLines[0] === "")) {
      fail(`${globalLines.length - i} lines of the global block are left`);
    }
  }

  const testFiles: TestFile[] = [];
  for (const section of sections) {
    const fileErrors = diagnostics.filter(d => d.file !== undefined && comparePaths(ops.stripPrefixes(d.file.fileName), ops.stripPrefixes(section.unitName), comparePathsOptions) === 0);
    if (fileErrors.length !== section.errorCount) {
      fail(`the header of ${section.unitName} counts ${section.errorCount} errors and the first section has ${fileErrors.length}`);
    }
    const unit = options.units?.find(u => comparePaths(ops.stripPrefixes(u.unitName), ops.stripPrefixes(section.unitName), comparePathsOptions) === 0);
    const content = readSection(section, fileErrors, ops, readMessageBlock, ambiguities, unit);
    testFiles.push({ unitName: section.unitName, content });
    for (const d of fileErrors) {
      const file = d.file!;
      if (file instanceof StandInFile) {
        const real: ParsedFile = { fileName: file.fileName, text: content, hasText: true };
        files.set(file.fileName, real);
        standIns.splice(standIns.indexOf(file), 1);
        for (const other of diagnostics) if (other.file === file) other.file = real;
      }
    }
  }

  // A section whose file has no diagnostic still gives the text of related positions.
  const textOf = (fileName: string): ParsedFile | undefined => {
    for (const f of testFiles) {
      if (comparePaths(ops.stripPrefixes(f.unitName), fileName, comparePathsOptions) === 0) {
        let file = files.get(fileName);
        if (file === undefined || !file.hasText) {
          const real: ParsedFile = { fileName, text: f.content, hasText: true };
          if (file !== undefined) {
            standIns.splice(standIns.indexOf(file as StandInFile), 1);
            for (const other of diagnostics) if (other.file === file) other.file = real;
          }
          files.set(fileName, (file = real));
        }
        return file;
      }
    }
    return undefined;
  };

  for (const d of diagnostics) {
    if (d.file !== undefined && !d.file.hasText) {
      const real = textOf(d.file.fileName);
      if (real === undefined) (d.file as StandInFile).use(d, d.line, d.character);
    }
  }
  const relatedOf = (list: ParsedDiagnostic[]): ParsedDiagnostic[] => list.flatMap(d => d.relatedInformation);
  for (const d of relatedOf(diagnostics)) {
    const where = pendingRelated.get(d);
    if (where === undefined) continue;
    const { fileName, line, character } = where;
    const real = textOf(fileName);
    if (real !== undefined) {
      d.file = real;
      if (line === undefined || character === undefined) fail("a masked related position in a file that has a section");
      const starts = computeECMALineStarts(real.text);
      if (line > starts.length) fail(`related line ${line} is outside of ${fileName}`);
      d.pos = byteOffsetOfUtf16Column(real.text, starts[line - 1], character - 1);
      d.end = d.pos;
    } else {
      const standIn = fileFor(fileName) as StandInFile;
      d.file = standIn;
      standIn.use(d, line, character);
    }
  }
  for (const standIn of standIns) standIn.finish();

  if (pretty) {
    applyPrettyRelated(diagnostics, prettyRelated, rules);
  }
  void summary;
  void isDefaultLibraryFile;

  return { pretty, rules, diagnostics, files: testFiles, ambiguities };
}

function categoryNameOf(category: Category): string {
  return category === Category.Warning ? "warning" : category === Category.Error ? "error" : category === Category.Suggestion ? "suggestion" : "message";
}

type ReadMessageBlock = (block: string[], i: number, d: ParsedDiagnostic, acceptChainLine: (at: number) => boolean) => number;

interface SectionState {
  i: number;
  contentLines: string[];
  lineStarts: number[];
  // Per diagnostic of the file: 0 pending, 1 active, 2 done.
  state: number[];
  spans: { pos: number; end: number; hasLength: boolean; related: ParsedDiagnostic[] }[];
  // The decisions taken so far at the lines that the text does not decide, in order.
  decisions: boolean[];
}

// One section: the lines of the file, each followed by the squiggles and messages of the spans that touch it.
// A chain line of related information with four spaces or more looks like a line of the file: the reader tries
// both readings, the chain first, and keeps the first one with which the rest of the section reads.
function readSection(section: Section, fileErrors: ParsedDiagnostic[], ops: RuleOps, readMessageBlock: ReadMessageBlock, ambiguities: string[], unit: TestFile | undefined): ByteString {
  const raw = section.lines;
  const unitLines = unit?.content.split(/\r?\n/).map(l => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const unitLineStarts = unit === undefined ? undefined : computeECMALineStarts(unit.content);
  for (const d of fileErrors) {
    if (d.line === undefined || d.character === undefined) fail(`a masked position in ${section.unitName}, which has a section`);
  }

  // Reads the section with the given decisions for the undecided lines; further ones take the default.
  const attempt = (decisions: boolean[]): { content: ByteString; undecided: number; taken: boolean[] } => {
    const taken: boolean[] = [];
    let undecided = 0;
    const contentLines: string[] = [];
    const lineStarts: number[] = [0];
    const state = fileErrors.map(() => 0);
    let i = 0;
    while (i < raw.length) {
      const rawLine = raw[i];
      if (!rawLine.startsWith("    ")) fail(`line ${JSON.stringify(rawLine)} of ${section.unitName} is neither text nor message`);
      const line = rawLine.slice(4);
      const lineIndex = contentLines.length;
      if (unitLines !== undefined && unitLines[lineIndex] !== line) fail(`line ${lineIndex + 1} of ${section.unitName} is not the line of the unit`);
      if (/\r|\xe2\x80[\xa8\xa9]/.test(line) && state.some((s, k) => s !== 2 && fileErrors[k].line! - 1 >= lineIndex)) {
        fail(`a line break inside line ${lineIndex + 1} of ${section.unitName}, before a span`);
      }
      contentLines.push(line);
      i++;
      const thisLineStart = lineStarts[lineIndex];
      const nextLineStart = unitLineStarts !== undefined && lineIndex + 1 < unitLineStarts.length ? unitLineStarts[lineIndex + 1] : thisLineStart + line.length + 1;
      lineStarts.push(nextLineStart);
      for (let k = 0; k < fileErrors.length; k++) {
        const d = fileErrors[k];
        if (state[k] === 2) continue;
        if (state[k] === 0) {
          if (d.line! - 1 < lineIndex) fail(`the span at line ${d.line} of ${section.unitName} has no squiggle`);
          if (d.line! - 1 !== lineIndex) continue;
          d.pos = byteOffsetOfUtf16Column(line, 0, d.character! - 1) + thisLineStart;
          state[k] = 1;
        }
        const errStart = d.pos;
        const squiggleStart = Math.max(0, errStart - thisLineStart);
        const prefix = ops.squigglePrefix(line, squiggleStart);
        if (i >= raw.length) fail(`the squiggle line of a span is missing in ${section.unitName}`);
        const squiggleLine = raw[i];
        if (!squiggleLine.startsWith("    " + prefix)) fail(`squiggle line ${JSON.stringify(squiggleLine)} does not start at column ${d.character}`);
        const tildes = squiggleLine.slice(4 + prefix.length);
        if (!/^~*$/.test(tildes)) fail(`squiggle line ${JSON.stringify(squiggleLine)} has text after column ${d.character}`);
        i++;
        const covered = ops.bytesOfTildes(line, Math.min(squiggleStart, line.length), tildes.length);
        const ends = i < raw.length && raw[i].startsWith("!!! ");
        if (ends) {
          d.end = Math.max(errStart, thisLineStart) + covered;
          d.hasLength = true;
          state[k] = 2;
          i = readMessageBlock(raw, i, d, () => {
            const n = taken.length;
            const decision = n < decisions.length ? decisions[n] : true;
            if (n >= decisions.length) undecided++;
            taken.push(decision);
            return decision;
          });
        }
      }
    }
    for (let k = 0; k < fileErrors.length; k++) {
      if (state[k] !== 2) fail(`a span of ${section.unitName} at line ${fileErrors[k].line} has no message`);
    }
    if (unitLines !== undefined && unitLines.length !== contentLines.length) fail(`${section.unitName} has ${contentLines.length} lines and the unit has ${unitLines.length}`);
    return { content: contentLines.join("\n"), undecided, taken };
  };

  // Depth-first over the undecided lines: the chain reading first, then the text reading.
  const search = (decisions: boolean[]): { content: ByteString; taken: boolean[] } => {
    let firstError: unknown;
    try {
      const result = attempt(decisions);
      return result;
    } catch (e) {
      if (!(e instanceof BaselineReadError)) throw e;
      firstError = e;
    }
    // Find the decisions that the failed attempt took by default and flip the last of them.
    const probe = probeDecisions(decisions);
    for (let n = probe.length - 1; n >= decisions.length; n--) {
      const flipped = [...probe.slice(0, n), false];
      try {
        return search(flipped);
      } catch (e) {
        if (!(e instanceof BaselineReadError)) throw e;
      }
    }
    throw firstError;
  };
  // The decisions that an attempt takes until it fails or ends.
  const probeDecisions = (decisions: boolean[]): boolean[] => {
    const seen: boolean[] = [];
    const saved = fileErrors.map(d => ({ pos: d.pos, end: d.end, hasLength: d.hasLength }));
    try {
      const raw2 = attemptRecording(decisions, seen);
      void raw2;
    } catch (e) {
      if (!(e instanceof BaselineReadError)) throw e;
    }
    fileErrors.forEach((d, k) => Object.assign(d, saved[k]));
    return seen;
  };
  const attemptRecording = (decisions: boolean[], seen: boolean[]): void => {
    const original = readMessageBlock;
    void original;
    const result = attemptWith(decisions, seen);
    void result;
  };
  const attemptWith = (decisions: boolean[], seen: boolean[]): void => {
    // The same walk as attempt, which records each decision in `seen` before it can fail.
    const recording: ReadMessageBlock = (block, i, d, accept) => readMessageBlock(block, i, d, at => {
      const decision = accept(at);
      seen.push(decision);
      return decision;
    });
    readSectionOnce(section, fileErrors, ops, recording, unitLines, unitLineStarts, decisions);
  };

  const result = search([]);
  if (result.taken.length > 0) {
    ambiguities.push(`${section.unitName}: ${result.taken.length} lines after related information read as ${result.taken.map(t => (t ? "chain" : "text")).join(",")}`);
  }
  return result.content;
}

interface PrettyRelated {
  fileName: string;
  line: number;
  character: number;
  messageLines: string[];
  // The last line and column of the span in UTF-16 units, from the code snippet.
  lastLine: number;
  lastCharacter: number;
  snippet: { line: number; text: string }[];
}

interface PrettyTop {
  head: Head;
  related: PrettyRelated[];
  emptyRelatedBlock: boolean;
  snippet: { lastLine: number; lastCharacter: number } | undefined;
}

const ESC = "\u001b";
const locationPattern = new RegExp(`^${ESC}\\[96m([^]*?)${ESC}\\[0m:${ESC}\\[93m(\\d+)${ESC}\\[0m:${ESC}\\[93m(\\d+)${ESC}\\[0m`);
const categoryPattern = new RegExp(`^${ESC}\\[9[1304]m(error|warning|suggestion|message)${ESC}\\[0m${ESC}\\[90m TS(-?\\d+): ${ESC}\\[0m([^]*)$`);
const gutterPattern = new RegExp(`^( *)${ESC}\\[7m( *)(\\d+|\\.\\.\\.|)${ESC}\\[0m ([^]*)$`);
const squigglePattern = new RegExp(`^${ESC}\\[9[0-6]m( *)(~*)${ESC}\\[0m$`);

function readSnippet(lines: string[], i: number, indent: string): { next: number; rows: { line: number; text: string; spaces: number; tildes: number }[] } {
  const rows: { line: number; text: string; spaces: number; tildes: number }[] = [];
  while (i + 1 < lines.length) {
    const g = gutterPattern.exec(lines[i]);
    if (g === null || g[1] !== indent) break;
    if (g[3] === "...") {
      i++;
      continue;
    }
    if (g[3] === "") break;
    const s = gutterPattern.exec(lines[i + 1]);
    if (s === null || s[1] !== indent || s[3] !== "") fail(`snippet line ${JSON.stringify(lines[i + 1])}`);
    const q = squigglePattern.exec(s[4]);
    if (q === null) fail(`snippet squiggle ${JSON.stringify(lines[i + 1])}`);
    rows.push({ line: Number(g[3]), text: g[4], spaces: q[1].length, tildes: q[2].length });
    i += 2;
  }
  return { next: i, rows };
}

function snippetEnd(rows: { line: number; spaces: number; tildes: number }[]): { lastLine: number; lastCharacter: number } {
  const last = rows[rows.length - 1];
  return { lastLine: last.line, lastCharacter: rows.length === 1 ? last.spaces + last.tildes : last.tildes };
}

function readPrettyHead(line: string): Head | undefined {
  let fileName: string | undefined;
  let l: number | undefined;
  let c: number | undefined;
  let restOfLine = line;
  const loc = locationPattern.exec(line);
  if (loc !== null) {
    if (!line.startsWith(" - ", loc[0].length)) return undefined;
    fileName = loc[1];
    l = Number(loc[2]);
    c = Number(loc[3]);
    restOfLine = line.slice(loc[0].length + 3);
  }
  const m = categoryPattern.exec(restOfLine);
  if (m === null) return undefined;
  return { fileName, line: l, character: c, category: categories[m[1]], code: Number(m[2]), messageLines: [m[3]] };
}

// FormatDiagnosticsWithColorAndContext of the Go writer.
function readPrettyTopTsgo(top: string): PrettyTop[] {
  const lines = top.split("\r\n");
  const result: PrettyTop[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = readPrettyHead(lines[i]);
    if (head === undefined) fail(`pretty line ${JSON.stringify(lines[i])} is not a diagnostic`);
    i++;
    while (i < lines.length && lines[i] !== "" && readPrettyHead(lines[i]) === undefined && !lines[i].startsWith(`  ${ESC}[96m`)) {
      head.messageLines.push(lines[i++]);
    }
    const entry: PrettyTop = { head, related: [], emptyRelatedBlock: false, snippet: undefined };
    if (head.fileName !== undefined && head.code !== 1490) {
      if (lines[i] !== "") fail("no empty line before the code snippet");
      i++;
      const snippet = readSnippet(lines, i, "");
      if (snippet.rows.length === 0) fail("no code snippet");
      entry.snippet = snippetEnd(snippet.rows);
      i = snippet.next;
    }
    // Each related entry: an empty line, then two spaces, the location, " - ", the message, and its snippet.
    while (i + 1 < lines.length && lines[i] === "" && lines[i + 1].startsWith(`  ${ESC}[96m`)) {
      i++;
      const loc = locationPattern.exec(lines[i].slice(2));
      if (loc === null || !lines[i].startsWith(" - ", 2 + loc[0].length)) fail(`related line ${JSON.stringify(lines[i])}`);
      const messageLines = [lines[i].slice(2 + loc[0].length + 3)];
      i++;
      while (i < lines.length && gutterPattern.exec(lines[i])?.[1] !== "    ") messageLines.push(lines[i++]);
      const snippet = readSnippet(lines, i, "    ");
      if (snippet.rows.length === 0) fail("no code snippet of related information");
      i = snippet.next;
      entry.related.push({
        fileName: loc[1],
        line: Number(loc[2]),
        character: Number(loc[3]),
        messageLines,
        ...snippetEnd(snippet.rows),
        snippet: snippet.rows,
      });
    }
    result.push(entry);
    // The separator between two diagnostics is one line break; a diagnostic with a file ends with one of its own.
    if (i < lines.length && lines[i] === "" && (head.fileName !== undefined || entry.related.length > 0)) i++;
  }
  return result;
}

// formatDiagnosticsWithColorAndContext of TypeScript.
function readPrettyTopTsc(top: string): PrettyTop[] {
  if (!top.endsWith("\r\n")) fail("the first section does not end with a line break");
  const lines = top.slice(0, -2).split("\r\n");
  const result: PrettyTop[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = readPrettyHead(lines[i]);
    if (head === undefined) fail(`pretty line ${JSON.stringify(lines[i])} is not a diagnostic`);
    i++;
    while (i < lines.length && lines[i] !== "" && readPrettyHead(lines[i]) === undefined) {
      head.messageLines.push(lines[i++]);
    }
    const entry: PrettyTop = { head, related: [], emptyRelatedBlock: false, snippet: undefined };
    if (head.fileName !== undefined && head.code !== 1490) {
      if (lines[i] !== "") fail("no empty line before the code snippet");
      i++;
      const snippet = readSnippet(lines, i, "");
      if (snippet.rows.length === 0) fail("no code snippet");
      entry.snippet = snippetEnd(snippet.rows);
      i = snippet.next;
    }
    if (i < lines.length && lines[i] === "") {
      // The related block: an empty line, then per entry the location, the snippet and the indented message.
      i++;
      entry.emptyRelatedBlock = true;
      while (i < lines.length && (lines[i].startsWith(`  ${ESC}[96m`) || (lines[i].startsWith("    ") && readPrettyHead(lines[i]) === undefined))) {
        entry.emptyRelatedBlock = false;
        if (lines[i].startsWith(`  ${ESC}[96m`)) {
          const loc = locationPattern.exec(lines[i].slice(2));
          if (loc === null || lines[i].length !== 2 + loc[0].length) fail(`related line ${JSON.stringify(lines[i])}`);
          i++;
          const snippet = readSnippet(lines, i, "    ");
          if (snippet.rows.length === 0) fail("no code snippet of related information");
          i = snippet.next;
          if (!lines[i].startsWith("    ")) fail("no message of related information");
          const messageLines = [lines[i++].slice(4)];
          while (i < lines.length && lines[i].startsWith("  ") && !lines[i].startsWith(`  ${ESC}[96m`) && readPrettyHead(lines[i]) === undefined) messageLines.push(lines[i++]);
          entry.related.push({ fileName: loc[1], line: Number(loc[2]), character: Number(loc[3]), messageLines, ...snippetEnd(snippet.rows), snippet: snippet.rows });
        } else {
          fail("related information without a file in a pretty baseline");
        }
      }
    }
    result.push(entry);
  }
  return result;
}

// The spans of related information: the plain lines give the start, the pretty snippet gives the end.
function applyPrettyRelated(diagnostics: ParsedDiagnostic[], prettyRelated: Map<ParsedDiagnostic, PrettyRelated[]>, rules: Rules): void {
  void rules;
  for (const d of diagnostics) {
    const list = prettyRelated.get(d) ?? [];
    const withFile = d.relatedInformation.filter(r => r.file !== undefined);
    if (d.file !== undefined && d.file.hasText && withFile.length !== list.length) {
      fail(`the first section has ${list.length} related entries and the section has ${withFile.length}`);
    }
    for (let k = 0; k < withFile.length && k < list.length; k++) {
      const r = withFile[k];
      const p = list[k];
      const file = r.file!;
      if (!file.hasText) fail("related information of a pretty baseline in a file without a section");
      const starts = computeECMALineStarts(file.text);
      const firstLineChar = utf16Len(file.text.slice(starts[p.line - 1], r.pos));
      let lastCharacter = p.lastCharacter;
      if (p.lastLine === p.line && lastCharacter === firstLineChar + 1) {
        // One tilde is what a span of no length and a span of one code unit both draw.
        const next = r.pos < file.text.length ? decodeRune(file.text, r.pos) : [0, 0];
        if (next[1] === 0 || next[0] === 0x0a || next[0] === 0x0d) lastCharacter = firstLineChar;
      }
      r.end = byteOffsetOfUtf16Column(file.text, starts[p.lastLine - 1], lastCharacter);
      r.hasLength = true;
    }
  }
}

export { runeCount };
