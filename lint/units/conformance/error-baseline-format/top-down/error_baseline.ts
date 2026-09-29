// Port of internal/testutil/tsbaseline/error_baseline.go and util.go (the writer), Go rules only.
import {
  type Diagnostic,
  type FormattingOptions,
  categoryName,
  compareDiagnostics,
  computeECMALineStarts,
  flattenDiagnosticMessage,
  formatDiagnosticsWithColorAndContext,
  writeErrorSummaryText,
  writeFormatDiagnostics,
  writeLocation,
  WriterPanic,
} from "./diagnosticwriter";
import { type ByteString, replaceNonWhitespace, runeCount } from "./go_compat";
import { comparePaths, ensureTrailingDirectorySeparator, getBaseFileName } from "./tspath";

export const harnessNewLine = "\r\n";

export const formatOpts: FormattingOptions = {
  newLine: harnessNewLine,
  useCaseSensitiveFileNames: false,
  currentDirectory: "",
};

export interface TestFile {
  unitName: ByteString;
  content: ByteString;
}

// (?im)^(lib.*\.d\.ts)\(\d+,\d+\) on bytes: Go's ^ is the start or after LF, its dot is all but LF, its (?i) folds s with U+017F.
const diagnosticsLocationPrefix =
  /(?<![^\n])([lL][iI][bB][^\n]*\.[dD]\.[tT](?:[sS]|\xc5\xbf))\(\d+,\d+\)/g;
// (?i)(lib.*\.d\.ts):\d+:\d+
const diagnosticsLocationPattern = /([lL][iI][bB][^\n]*\.[dD]\.[tT](?:[sS]|\xc5\xbf)):\d+:\d+/g;

const lineDelimiter = /\r?\n/;

const libFolder = "built/local/";
const builtFolder = "/.ts";

// strings.NewReplacer: at each position the first pair in argument order that matches wins, without overlap.
const testPathPrefixReplacer =
  /\/\.ts\/|\/\.lib\/|\/\.src\/|bundled:\/\/\/libs\/|file:\/\/\/\.\/ts\/|file:\/\/\/\.\/lib\/|file:\/\/\/\.\/src\//g;

export function removeTestPathPrefixes(text: ByteString, retainTrailingDirectorySeparator: boolean): ByteString {
  return text.replace(testPathPrefixReplacer, match => {
    if (match.startsWith("file:")) return "file:///";
    return retainTrailingDirectorySeparator ? "/" : "";
  });
}

export function isDefaultLibraryFile(filePath: ByteString): boolean {
  const fileName = getBaseFileName(filePath);
  return fileName.startsWith("lib.") && fileName.endsWith(".d.ts");
}

export function isBuiltFile(filePath: ByteString): boolean {
  return filePath.startsWith(libFolder) || filePath.startsWith(ensureTrailingDirectorySeparator(builtFolder));
}

export function isTsConfigFile(path: ByteString): boolean {
  return path.includes("tsconfig") && path.includes("json");
}

export interface ErrorBaselineResult {
  text: ByteString;
  // The two assert.Check calls of the reference: a failed check fails the test and still writes the text.
  failedChecks: string[];
}

function minimalDiagnosticsToString(diagnostics: Diagnostic[], pretty: boolean): ByteString {
  if (pretty) {
    return formatDiagnosticsWithColorAndContext(diagnostics, formatOpts);
  }
  return writeFormatDiagnostics(diagnostics, formatOpts);
}

export function getErrorBaseline(
  inputFiles: TestFile[],
  diagnostics: Diagnostic[],
  pretty: boolean,
): ErrorBaselineResult {
  const failedChecks: string[] = [];
  const outputLines = iterateErrorBaseline(inputFiles, diagnostics, pretty, failedChecks);

  if (pretty) {
    const summary = removeTestPathPrefixes(writeErrorSummaryText(diagnostics, formatOpts), false);
    outputLines.push(summary);
  }
  return { text: outputLines.join(""), failedChecks };
}

function iterateErrorBaseline(
  inputFiles: TestFile[],
  inputDiagnostics: Diagnostic[],
  pretty: boolean,
  failedChecks: string[],
): ByteString[] {
  const diagnostics = inputDiagnostics.slice();
  diagnostics.sort(compareDiagnostics);

  let outputLines = "";
  // Count up all errors that were found in files other than lib.d.ts so we don't miss any
  let totalErrorsReportedInNonLibraryNonTsconfigFiles = 0;

  let firstLine = true;

  const newLine = (): string => {
    if (firstLine) {
      firstLine = false;
      return "";
    }
    return "\r\n";
  };

  const result: ByteString[] = [];

  const outputErrorText = (diag: Diagnostic): void => {
    const message = flattenDiagnosticMessage(diag, harnessNewLine);

    const errLines: ByteString[] = [];
    for (let line of removeTestPathPrefixes(message, false).split("\n")) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) {
        continue;
      }
      errLines.push(`!!! ${categoryName(diag.category)} TS${diag.code}: ${line}`);
    }

    for (const info of diag.relatedInformation) {
      let location = "";
      if (info.file !== undefined) {
        location = " " + writeLocation(info.file, info.pos, formatOpts, text => text);
      }
      location = removeTestPathPrefixes(location, false);
      if (location.length > 0 && isDefaultLibraryFile(info.file!.fileName)) {
        location = location.replace(diagnosticsLocationPattern, "$1:--:--");
      }
      errLines.push(`!!! related TS${info.code}${location}: ${flattenDiagnosticMessage(info, harnessNewLine)}`);
    }

    for (const e of errLines) {
      outputLines += newLine();
      outputLines += e;
    }

    // do not count errors from lib.d.ts here, they are computed separately as numLibraryDiagnostics
    if (
      diag.file === undefined ||
      (!isDefaultLibraryFile(diag.file.fileName) && !isTsConfigFile(diag.file.fileName))
    ) {
      totalErrorsReportedInNonLibraryNonTsconfigFiles++;
    }
  };

  let topDiagnostics = minimalDiagnosticsToString(diagnostics, pretty);
  topDiagnostics = removeTestPathPrefixes(topDiagnostics, false);
  topDiagnostics = topDiagnostics.replace(diagnosticsLocationPrefix, "$1(--,--)");

  result.push(topDiagnostics + harnessNewLine + harnessNewLine);

  // Report global errors
  for (const error of diagnostics) {
    if (error.file === undefined) {
      outputErrorText(error);
    }
  }

  result.push(outputLines);
  outputLines = "";

  // 'merge' the lines of each input file with any errors associated with it
  for (const inputFile of inputFiles) {
    // Filter down to the errors in the file
    const fileErrors = diagnostics.filter(
      e =>
        e.file !== undefined &&
        comparePaths(
          removeTestPathPrefixes(e.file.fileName, false),
          removeTestPathPrefixes(inputFile.unitName, false),
          { useCaseSensitiveFileNames: false, currentDirectory: "" },
        ) === 0,
    );

    // Header
    outputLines += `${newLine()}==== ${removeTestPathPrefixes(inputFile.unitName, false)} (${fileErrors.length} errors) ====`;

    // Make sure we emit something for every error
    let markedErrorCount = 0;
    // For each line, emit the line followed by any error squiggles matching this line

    const lineStarts = computeECMALineStarts(inputFile.content);
    const lines = inputFile.content.split(lineDelimiter);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      let line = lines[lineIndex];
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 0x0d) {
        line = line.slice(0, -1);
      }

      const thisLineStart = lineStarts[lineIndex];
      // On the last line of the file, fake the next line start number so that we handle errors on the last character of the file correctly
      const nextLineStart = lineIndex === lines.length - 1 ? inputFile.content.length : lineStarts[lineIndex + 1];
      // Emit this line from the original file
      outputLines += newLine();
      outputLines += "    ";
      outputLines += line;
      for (const errDiagnostic of fileErrors) {
        // Does any error start or continue on to this line? Emit squiggles
        const errStart = errDiagnostic.pos;
        const end = errDiagnostic.end;
        if (end >= thisLineStart && (errStart < nextLineStart || lineIndex === lines.length - 1)) {
          // How many characters from the start of this line the error starts at (could be positive or negative)
          const relativeOffset = errStart - thisLineStart;
          // How many characters of the error are on this line (might be longer than this line in reality)
          const length = end - errStart - Math.max(0, thisLineStart - errStart);
          // Calculate the start of the squiggle
          const squiggleStart = Math.max(0, relativeOffset);
          outputLines += newLine();
          outputLines += "    ";
          if (squiggleStart > line.length) {
            throw new WriterPanic(
              `slice bounds out of range [:${squiggleStart}] with length ${line.length} in ${inputFile.unitName} line ${lineIndex + 1}`,
            );
          }
          outputLines += replaceNonWhitespace(line.slice(0, squiggleStart));
          // This was `new Array(count).join("~")`; which maps 0 to "", 1 to "", 2 to "~", 3 to "~~", etc.
          const squiggleEnd = Math.max(squiggleStart, Math.min(squiggleStart + length, line.length));
          outputLines += "~".repeat(runeCount(line.slice(squiggleStart, squiggleEnd)));
          // If the error ended here, or we're at the end of the file, emit its message
          if (lineIndex === lines.length - 1 || nextLineStart > end) {
            outputErrorText(errDiagnostic);
            markedErrorCount++;
          }
        }
      }
    }

    // Verify we didn't miss any errors in this file
    if (markedErrorCount !== fileErrors.length) {
      failedChecks.push(`count of errors in ${inputFile.unitName}: ${markedErrorCount} != ${fileErrors.length}`);
    }
    result.push(outputLines);
    outputLines = "";
  }

  const numLibraryDiagnostics = diagnostics.filter(
    d => d.file !== undefined && (isDefaultLibraryFile(d.file.fileName) || isBuiltFile(d.file.fileName)),
  ).length;
  const numTsconfigDiagnostics = diagnostics.filter(
    d => d.file !== undefined && isTsConfigFile(d.file.fileName),
  ).length;
  // Verify we didn't miss any errors in total
  const total = totalErrorsReportedInNonLibraryNonTsconfigFiles + numLibraryDiagnostics + numTsconfigDiagnostics;
  if (total !== diagnostics.length) {
    failedChecks.push(`total number of errors: ${total} != ${diagnostics.length}`);
  }

  return result;
}
