// Every regexp of the assembled runner that ports a regexp of Go has the source that re2.ts composes from the proven classes.
// usage: bun regex_sites.ts <assembled tree>      exit code 1 when a place differs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sites } from "./re2";

const runner = join(process.argv[2], "test/cli/lint/conformance/runner");
let bad = 0;
for (const [file, before, source, flags] of sites) {
  const text = readFileSync(join(runner, file), "utf8");
  const at = text.indexOf(before);
  if (at < 0) {
    console.log(`FAIL ${file}: no ${JSON.stringify(before)}`);
    bad++;
    continue;
  }
  const rest = text.slice(at + before.length);
  const literal = rest.slice(0, rest.indexOf("\n")).replace(/[;,]$/, "");
  const re = new Function("return " + literal)() as RegExp;
  const same = re instanceof RegExp && re.source === source && re.flags === flags;
  console.log(`${same ? "ok  " : "FAIL"} ${file}: ${before.trim().replace(/\s*[=:]$/, "")} is ${literal}`);
  if (!same) {
    console.log(`     wanted /${source}/${flags}`);
    bad++;
  }
}

// A class of JavaScript that is not the class of Go may stand only where the rules of TypeScript's own harness are ported.
const allowed: Record<string, RegExp> = {
  // ts.formatCodeSpan of program.ts and the rules "tsc" of harnessIO.ts are JavaScript: their classes are the ones of JavaScript.
  "diagnosticwriter.ts": /\.replace\(\/\\S\/g, " "\)|\.replace\(\/\.\/g, "~"\)/,
  "text_model.ts": /blankNonWhitespace: slice => slice\.replace\(\/\\S\/g, " "\)|squigglePattern: \/\^\\s\*~\*\$\//,
  "error_baseline.ts": /const diagnosticsLocation(Prefix|Pattern)Tsc = /,
  // Readers of text that the runner or a linter wrote, not ports of a regexp of Go.
  "reader.ts": /^const (plainHead|globalHead|sectionHead|relatedLine|summaryHead|locationPattern|prettyHead|prettyRelatedHeadGo|prettyRelatedHeadTsc|gutterLine|gutterSquiggle) = |^  `\^\(\?:\$\{locationPattern\} - \)\?/,
  "plain.ts": /^const (globalHead|head) =|^  \/\^\(\\S\.\*\?\)/,
  "checks.ts": /const head = /,
  "run.ts": /const sectionHead = |lines\.findIndex\(/,
  "sweep_args.ts": /new RegExp\("\^" \+ selector/,
};
const suspect = /\\s|\\S|\\w|\\W|\\b|\\B|\(\?i\)|\/[dgsuy]*[im][dgimsuy]*[;,.)\s]/;
const literalLine = /(^|[=(,:!&|?]\s*|return\s+)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuvy]*|new RegExp\(/;
let notes = 0;
for (const file of readdirSync(runner).filter(f => f.endsWith(".ts")).sort()) {
  const lines = readFileSync(join(runner, file), "utf8").split("\n");
  lines.forEach((line, k) => {
    if (line.trimStart().startsWith("//")) return;
    if (!literalLine.test(line) && !/^\s*`[^`]*\\\\[sSwWbB]/.test(line)) return;
    if (!suspect.test(line)) return;
    if (allowed[file]?.test(line)) return;
    console.log(`FAIL ${file}:${k + 1}: a class, a word boundary or a flag of JavaScript that Go reads in another way: ${line.trim().slice(0, 160)}`);
    notes++;
  });
}
console.log(`${sites.length} places, ${bad} differ; ${notes} other regexps with a class or flag whose meaning differs between Go and JavaScript`);
process.exit(bad + notes === 0 ? 0 : 1);
