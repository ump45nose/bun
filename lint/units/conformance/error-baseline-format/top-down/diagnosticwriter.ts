// Port of internal/diagnosticwriter/diagnosticwriter.go, with the parts of core.go, scanner.go and ast/diagnostic.go it calls.
// All text is a ByteString: a JavaScript string whose char codes are the UTF-8 bytes, so offsets are byte offsets as in Go.
import { type ByteString, decodeRune, padLeft, runeCount, trimRightSpace, utf16Len } from "./go_compat";
import { type ComparePathsOptions, convertToRelativePath, pathIsAbsolute } from "./tspath";

export const enum Category {
  Warning = 0,
  Error = 1,
  Suggestion = 2,
  Message = 3,
}

export function categoryName(category: Category): string {
  switch (category) {
    case Category.Warning:
      return "warning";
    case Category.Error:
      return "error";
    case Category.Suggestion:
      return "suggestion";
    case Category.Message:
      return "message";
  }
}

export function categoryFromName(name: string): Category | undefined {
  switch (name) {
    case "warning":
      return Category.Warning;
    case "error":
      return Category.Error;
    case "suggestion":
      return Category.Suggestion;
    case "message":
      return Category.Message;
  }
  return undefined;
}

export interface FileLike {
  fileName: ByteString;
  text: ByteString;
  lineMap?: number[];
}

export interface Diagnostic {
  file: FileLike | undefined;
  pos: number;
  end: number;
  code: number;
  category: Category;
  messageText: ByteString;
  messageChain: Diagnostic[];
  relatedInformation: Diagnostic[];
}

export interface FormattingOptions extends ComparePathsOptions {
  newLine: string;
}

// core.ComputeECMALineStarts
export function computeECMALineStarts(text: ByteString): number[] {
  const result: number[] = [];
  const textLen = text.length;
  let pos = 0;
  let lineStart = 0;
  while (pos < textLen) {
    const b = text.charCodeAt(pos);
    if (b < 0x80) {
      pos++;
      if (b === 0x0d) {
        if (pos < textLen && text.charCodeAt(pos) === 0x0a) pos++;
        result.push(lineStart);
        lineStart = pos;
      } else if (b === 0x0a) {
        result.push(lineStart);
        lineStart = pos;
      }
    } else {
      const [ch, size] = decodeRune(text, pos);
      pos += size;
      if (ch === 0x2028 || ch === 0x2029) {
        result.push(lineStart);
        lineStart = pos;
      }
    }
  }
  result.push(lineStart);
  return result;
}

export function ecmaLineMap(file: FileLike): number[] {
  return (file.lineMap ??= computeECMALineStarts(file.text));
}

// scanner.ComputeLineOfPosition
export function computeLineOfPosition(lineStarts: number[], pos: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = low + ((high - low) >> 1);
    const value = lineStarts[middle];
    if (value < pos) low = middle + 1;
    else if (value > pos) high = middle - 1;
    else return middle;
  }
  return low - 1;
}

export function getECMALineOfPosition(file: FileLike, pos: number): number {
  return computeLineOfPosition(ecmaLineMap(file), pos);
}

// scanner.GetECMALineAndUTF16CharacterOfPosition; the reference panics when pos is outside the text.
export function getECMALineAndUTF16CharacterOfPosition(file: FileLike, pos: number): [number, number] {
  const lineMap = ecmaLineMap(file);
  const line = computeLineOfPosition(lineMap, pos);
  const character = utf16Len(file.text.slice(lineMap[line], pos));
  return [line, character];
}

function getECMAPositionOfLineAndByteOffset(file: FileLike, line: number, byteOffset: number): number {
  return ecmaLineMap(file)[line] + byteOffset;
}

const foregroundColorEscapeGrey = "\u001b[90m";
const foregroundColorEscapeRed = "\u001b[91m";
const foregroundColorEscapeYellow = "\u001b[93m";
const foregroundColorEscapeBlue = "\u001b[94m";
const foregroundColorEscapeCyan = "\u001b[96m";
const gutterStyleSequence = "\u001b[7m";
const gutterSeparator = " ";
const resetEscapeSequence = "\u001b[0m";
const ellipsis = "...";

const fileAppearsToBeBinaryCode = 1490;

export function formatDiagnosticsWithColorAndContext(diags: Diagnostic[], formatOpts: FormattingOptions): ByteString {
  let output = "";
  for (let i = 0; i < diags.length; i++) {
    if (i > 0) output += formatOpts.newLine;
    output += formatDiagnosticWithColorAndContext(diags[i], formatOpts);
  }
  return output;
}

export function formatDiagnosticWithColorAndContext(diagnostic: Diagnostic, formatOpts: FormattingOptions): ByteString {
  let output = "";
  if (diagnostic.file !== undefined) {
    output += writeLocation(diagnostic.file, diagnostic.pos, formatOpts, writeWithStyleAndReset);
    output += " - ";
  }
  output += writeWithStyleAndReset(categoryName(diagnostic.category), getCategoryFormat(diagnostic.category));
  output += foregroundColorEscapeGrey + " TS" + diagnostic.code + ": " + resetEscapeSequence;
  output += flattenDiagnosticMessage(diagnostic, formatOpts.newLine);

  if (diagnostic.file !== undefined && diagnostic.code !== fileAppearsToBeBinaryCode) {
    output += formatOpts.newLine;
    output += writeCodeSnippet(
      diagnostic.file,
      diagnostic.pos,
      diagnostic.end - diagnostic.pos,
      getCategoryFormat(diagnostic.category),
      "",
      formatOpts,
    );
    output += formatOpts.newLine;
  }

  for (const relatedInformation of diagnostic.relatedInformation) {
    const file = relatedInformation.file;
    if (file !== undefined) {
      output += formatOpts.newLine;
      output += "  ";
      const pos = relatedInformation.pos;
      output += writeLocation(file, pos, formatOpts, writeWithStyleAndReset);
      output += " - ";
      output += flattenDiagnosticMessage(relatedInformation, formatOpts.newLine);
      output += writeCodeSnippet(
        file,
        pos,
        relatedInformation.end - relatedInformation.pos,
        foregroundColorEscapeCyan,
        "    ",
        formatOpts,
      );
    }
    output += formatOpts.newLine;
  }
  return output;
}

export function writeCodeSnippet(
  sourceFile: FileLike,
  start: number,
  length: number,
  squiggleColor: string,
  indent: string,
  formatOpts: FormattingOptions,
): ByteString {
  let writer = "";
  const [firstLine, firstLineChar] = getECMALineAndUTF16CharacterOfPosition(sourceFile, start);
  let [lastLine, lastLineChar] = getECMALineAndUTF16CharacterOfPosition(sourceFile, start + length);
  if (length === 0) {
    lastLineChar++; // When length is zero, squiggle the character right after the start position.
  }

  const lastLineOfFile = getECMALineOfPosition(sourceFile, sourceFile.text.length);

  const hasMoreThanFiveLines = lastLine - firstLine >= 4;
  let gutterWidth = String(lastLine + 1).length;
  if (hasMoreThanFiveLines) {
    gutterWidth = Math.max(ellipsis.length, gutterWidth);
  }

  for (let i = firstLine; i <= lastLine; i++) {
    writer += formatOpts.newLine;

    // If the error spans over 5 lines, we'll only show the first 2 and last 2 lines,
    // so we'll skip ahead to the second-to-last line.
    if (hasMoreThanFiveLines && firstLine + 1 < i && i < lastLine - 1) {
      writer += indent;
      writer += gutterStyleSequence;
      writer += padLeft(ellipsis, gutterWidth);
      writer += resetEscapeSequence;
      writer += gutterSeparator;
      writer += formatOpts.newLine;
      i = lastLine - 1;
    }

    const lineStart = getECMAPositionOfLineAndByteOffset(sourceFile, i, 0);
    const lineEnd =
      i < lastLineOfFile ? getECMAPositionOfLineAndByteOffset(sourceFile, i + 1, 0) : sourceFile.text.length;

    let lineContent = trimRightSpace(sourceFile.text.slice(lineStart, lineEnd)); // trim from end
    lineContent = lineContent.replaceAll("\t", " "); // convert tabs to single spaces

    // Output the gutter and the actual contents of the line.
    writer += indent;
    writer += gutterStyleSequence;
    writer += padLeft(String(i + 1), gutterWidth);
    writer += resetEscapeSequence;
    writer += gutterSeparator;
    writer += lineContent;
    writer += formatOpts.newLine;

    // Output the gutter and the error span for the line using tildes.
    writer += indent;
    writer += gutterStyleSequence;
    writer += padLeft("", gutterWidth);
    writer += resetEscapeSequence;
    writer += gutterSeparator;
    writer += squiggleColor;
    if (i === firstLine) {
      // If we're on the last line, then limit it to the last character of the last line.
      // Otherwise, we'll just squiggle the rest of the line, giving 'slice' no end position.
      const lastCharForLine = i === lastLine ? lastLineChar : utf16Len(lineContent);

      // Fill with spaces until the first character,
      // then squiggle the remainder of the line.
      writer += repeat(" ", firstLineChar);
      writer += repeat("~", lastCharForLine - firstLineChar);
    } else if (i === lastLine) {
      // Squiggle until the final character.
      writer += repeat("~", lastLineChar);
    } else {
      // Squiggle the entire line.
      writer += repeat("~", utf16Len(lineContent));
    }

    writer += resetEscapeSequence;
  }
  return writer;
}

// strings.Repeat panics on a negative count; the port reports it.
export class WriterPanic extends Error {}

function repeat(s: string, count: number): string {
  if (count < 0) throw new WriterPanic("strings: negative Repeat count");
  return s.repeat(count);
}

export function flattenDiagnosticMessage(d: Diagnostic, newLine: string): ByteString {
  let output = d.messageText;
  for (const chain of d.messageChain) {
    output += flattenDiagnosticMessageChain(chain, newLine, 1 /*level*/);
  }
  return output;
}

function flattenDiagnosticMessageChain(chain: Diagnostic, newLine: string, level: number): ByteString {
  let output = newLine;
  for (let i = 0; i < level; i++) {
    output += "  ";
  }
  output += chain.messageText;
  for (const child of chain.messageChain) {
    output += flattenDiagnosticMessageChain(child, newLine, level + 1);
  }
  return output;
}

function getCategoryFormat(category: Category): string {
  switch (category) {
    case Category.Error:
      return foregroundColorEscapeRed;
    case Category.Warning:
      return foregroundColorEscapeYellow;
    case Category.Suggestion:
      return foregroundColorEscapeGrey;
    case Category.Message:
      return foregroundColorEscapeBlue;
  }
}

export type FormattedWriter = (text: string, formatStyle: string) => string;

export function writeWithStyleAndReset(text: string, formatStyle: string): string {
  return formatStyle + text + resetEscapeSequence;
}

export function writeLocation(
  file: FileLike,
  pos: number,
  formatOpts: FormattingOptions | undefined,
  write: FormattedWriter,
): ByteString {
  const [firstLine, firstChar] = getECMALineAndUTF16CharacterOfPosition(file, pos);
  const relativeFileName =
    formatOpts !== undefined ? convertToRelativePath(file.fileName, formatOpts) : file.fileName;
  let output = "";
  output += write(relativeFileName, foregroundColorEscapeCyan);
  output += ":";
  output += write(String(firstLine + 1), foregroundColorEscapeYellow);
  output += ":";
  output += write(String(firstChar + 1), foregroundColorEscapeYellow);
  return output;
}

interface ErrorSummary {
  totalErrorCount: number;
  globalErrors: Diagnostic[];
  errorsByFile: Map<FileLike, Diagnostic[]>;
  sortedFiles: FileLike[];
}

export function writeErrorSummaryText(allDiagnostics: Diagnostic[], formatOpts: FormattingOptions): ByteString {
  const errorSummary = getErrorSummary(allDiagnostics);
  const totalErrorCount = errorSummary.totalErrorCount;
  if (totalErrorCount === 0) {
    return "";
  }

  const firstFile = errorSummary.sortedFiles.length > 0 ? errorSummary.sortedFiles[0] : undefined;
  const firstFileName = prettyPathForFileError(
    firstFile,
    firstFile !== undefined ? (errorSummary.errorsByFile.get(firstFile) ?? []) : [],
    formatOpts,
  );
  const numErroringFiles = errorSummary.errorsByFile.size;

  let message: string;
  if (totalErrorCount === 1) {
    // Special-case a single error.
    if (errorSummary.globalErrors.length > 0 || firstFileName === "") {
      message = "Found 1 error.";
    } else {
      message = `Found 1 error in ${firstFileName}`;
    }
  } else {
    switch (numErroringFiles) {
      case 0:
        // No file-specific errors.
        message = `Found ${totalErrorCount} errors.`;
        break;
      case 1:
        // One file with errors.
        message = `Found ${totalErrorCount} errors in the same file, starting at: ${firstFileName}`;
        break;
      default:
        // Multiple files with errors.
        message = `Found ${totalErrorCount} errors in ${numErroringFiles} files.`;
    }
  }
  let output = "";
  output += formatOpts.newLine;
  output += message;
  output += formatOpts.newLine;
  output += formatOpts.newLine;
  if (numErroringFiles > 1) {
    output += writeTabularErrorsDisplay(errorSummary, formatOpts);
    output += formatOpts.newLine;
  }
  return output;
}

function getErrorSummary(diags: Diagnostic[]): ErrorSummary {
  let totalErrorCount = 0;
  const globalErrors: Diagnostic[] = [];
  const errorsByFile = new Map<FileLike, Diagnostic[]>();

  for (const diagnostic of diags) {
    if (diagnostic.category !== Category.Error) {
      continue;
    }

    totalErrorCount++;
    if (diagnostic.file === undefined) {
      globalErrors.push(diagnostic);
    } else {
      const list = errorsByFile.get(diagnostic.file);
      if (list === undefined) errorsByFile.set(diagnostic.file, [diagnostic]);
      else list.push(diagnostic);
    }
  }

  // The reference sorts with a sort that is not stable; two files with one name are not ordered by it.
  const sortedFiles = [...errorsByFile.keys()].sort((a, b) =>
    a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0,
  );

  return { totalErrorCount, globalErrors, errorsByFile, sortedFiles };
}

function writeTabularErrorsDisplay(errorSummary: ErrorSummary, formatOpts: FormattingOptions): ByteString {
  const sortedFiles = errorSummary.sortedFiles;

  let maxErrors = 0;
  for (const errorsForFile of errorSummary.errorsByFile.values()) {
    maxErrors = Math.max(maxErrors, errorsForFile.length);
  }

  const headerRow = "Errors  Files";
  const leftColumnHeadingLength = headerRow.split(" ")[0].length;
  const lengthOfBiggestErrorCount = String(maxErrors).length;
  const leftPaddingGoal = Math.max(leftColumnHeadingLength, lengthOfBiggestErrorCount);
  const headerPadding = Math.max(lengthOfBiggestErrorCount - leftColumnHeadingLength, 0);

  let output = "";
  output += " ".repeat(headerPadding);
  output += headerRow;
  output += formatOpts.newLine;

  for (const file of sortedFiles) {
    const fileErrors = errorSummary.errorsByFile.get(file) ?? [];
    const errorCount = fileErrors.length;

    output += padLeft(String(errorCount), leftPaddingGoal) + "  ";
    output += prettyPathForFileError(file, fileErrors, formatOpts);
    output += formatOpts.newLine;
  }
  return output;
}

function prettyPathForFileError(
  file: FileLike | undefined,
  fileErrors: Diagnostic[],
  formatOpts: FormattingOptions,
): ByteString {
  if (file === undefined || fileErrors.length === 0) {
    return "";
  }
  const line = getECMALineOfPosition(file, fileErrors[0].pos);
  let fileName = file.fileName;
  if (pathIsAbsolute(fileName) && pathIsAbsolute(formatOpts.currentDirectory)) {
    fileName = convertToRelativePath(file.fileName, formatOpts);
  }
  return fileName + foregroundColorEscapeGrey + ":" + (line + 1) + resetEscapeSequence;
}

export function writeFormatDiagnostics(diagnostics: Diagnostic[], formatOpts: FormattingOptions): ByteString {
  let output = "";
  for (const diagnostic of diagnostics) {
    output += writeFormatDiagnostic(diagnostic, formatOpts);
  }
  return output;
}

export function writeFormatDiagnostic(diagnostic: Diagnostic, formatOpts: FormattingOptions): ByteString {
  let output = "";
  if (diagnostic.file !== undefined) {
    const [line, character] = getECMALineAndUTF16CharacterOfPosition(diagnostic.file, diagnostic.pos);
    const fileName = diagnostic.file.fileName;
    const relativeFileName = convertToRelativePath(fileName, formatOpts);
    output += `${relativeFileName}(${line + 1},${character + 1}): `;
  }

  output += `${categoryName(diagnostic.category)} TS${diagnostic.code}: `;
  output += flattenDiagnosticMessage(diagnostic, formatOpts.newLine);
  output += formatOpts.newLine;
  return output;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function getDiagnosticPath(d: Diagnostic): ByteString {
  return d.file !== undefined ? d.file.fileName : "";
}

function compareMessageChainSize(c1: Diagnostic[], c2: Diagnostic[]): number {
  let c = c2.length - c1.length;
  if (c !== 0) return c;
  for (let i = 0; i < c1.length; i++) {
    c = compareMessageChainSize(c1[i].messageChain, c2[i].messageChain);
    if (c !== 0) return c;
  }
  return 0;
}

// The reference compares the message arguments of each link; a diagnostic read from text has the text only.
function compareMessageChainContent(c1: Diagnostic[], c2: Diagnostic[]): number {
  for (let i = 0; i < c1.length; i++) {
    let c = compareStrings(c1[i].messageText, c2[i].messageText);
    if (c !== 0) return c;
    if (c1[i].messageChain.length > 0) {
      c = compareMessageChainContent(c1[i].messageChain, c2[i].messageChain);
      if (c !== 0) return c;
    }
  }
  return 0;
}

function compareRelatedInfo(r1: Diagnostic[], r2: Diagnostic[]): number {
  const c = r2.length - r1.length;
  if (c !== 0) return c;
  for (let i = 0; i < r1.length; i++) {
    const c2 = compareDiagnostics(r1[i], r2[i]);
    if (c2 !== 0) return c2;
  }
  return 0;
}

// ast.CompareDiagnostics; getDiagnosticMessageIdentity is the message text, as for a deserialized diagnostic.
export function compareDiagnostics(d1: Diagnostic, d2: Diagnostic): number {
  if (d1 === d2) return 0;
  let c = compareStrings(getDiagnosticPath(d1), getDiagnosticPath(d2));
  if (c !== 0) return c;
  c = d1.pos - d2.pos;
  if (c !== 0) return c;
  c = d1.end - d2.end;
  if (c !== 0) return c;
  c = d1.code - d2.code;
  if (c !== 0) return c;
  c = d1.category - d2.category;
  if (c !== 0) return c;
  c = compareStrings(d1.messageText, d2.messageText);
  if (c !== 0) return c;
  c = compareMessageChainSize(d1.messageChain, d2.messageChain);
  if (c !== 0) return c;
  c = compareMessageChainContent(d1.messageChain, d2.messageChain);
  if (c !== 0) return c;
  return compareRelatedInfo(d1.relatedInformation, d2.relatedInformation);
}

export { runeCount };
