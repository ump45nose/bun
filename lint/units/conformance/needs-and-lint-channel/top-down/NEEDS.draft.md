# NEEDS of the unit "conformance" (draft from research)

Nothing below is granted yet, and nothing was implemented on the side of another unit.
The ids of this file (CH, RP, LB, LC, VN, CK, CI) replace the ids N1 to N6 of the earlier findings, which
named different things in different findings.

State when this was written (2026-09-29): the four unit worktrees are at e3566be889. No binary on the machine
has `--lint`: the installed bun 1.4.3 and the debug build of the cli worktree (1.4.3-debug+e3566be88) both RUN
the operand of `bun --lint x.ts`. No unit has an `API.md` or a `NEEDS.md`.

Every number was measured on Linux x64 on the pinned clones (typescript-go 89d5d5b, TypeScript 5848bc5) with
`needs-and-lint-channel/top-down/probes/run.sh`. Nothing was measured on Windows or on macOS: no such machine
was available.

How to read an entry. To: the owner of the file. Ask: the exact thing. Unlocks: how many of the 12,797 run
instances depend on it (E: the oracle has errors, 7,027. C: the oracle has none, 5,770). The sets of different
entries overlap. Until then: what the runner does without it.

## 1. The channel between `bun --lint` and the runner

### The decision: the batch form

`BUN_INTERNAL_LINT_CONFORMANCE=1 bun --lint <manifest.json>`: the operand is a manifest of instances, and the
binary writes one line of JSON per instance on stdout. This is proposal (c) of the earlier findings. Its
runner side exists as a prototype with tests that pass (`check-contract-default-spawn/top-down/manifest.ts`,
`manifest.test.ts`, `fakes/lints.ts`).

It is NOT on the path of K5. `typecheck.md` K5 plugs the checker into the runner "through the test importer":
that check is a function of the test process (CH-4), and options, span length, related information and the
stand-in log cross as fields of its input and output. No pass of K5 waits for the binary. The batch form is
what the binary needs before an instance can pass END TO END (Bun's own parser, the lowering, the checker).

Why this one and not the three others:

| | variables added to `src/bun_core/env_var.rs` | processes for n instances | which instance a crash belongs to |
|---|---|---|---|
| (a) `BUN_INTERNAL_LINT_COMPILER_OPTIONS`, `_DIAGNOSTICS`, `_ROOT`, and `error TS-1` lines | 3 | n | the one of the process |
| (b) one request file, `BUN_INTERNAL_LINT_REQUEST` | 1 | 1 per request | the runner has to follow the report file while the process runs |
| (c) `BUN_INTERNAL_LINT_CONFORMANCE=1`, manifest operand, JSON lines on stdout | 1 (a boolean) | 1 per 256 | the first instance without a line |
| (d) `BUN_INTERNAL_LINT_OPTIONS`, `BUN_INTERNAL_LINT_REPORT` | 2 | n | the one of the process |

- One process per instance is too slow in the build that every unit tests with. Measured now, on a loaded
  machine: the start of one process (`--revision`) has a median of 2.4 ms to 61 ms with the release build and
  of 272 ms to 351 ms with the debug build (the maximum was 5.3 s). 12,788 of the 12,797 run instances load
  default libraries (9 set `noLib`). The 15 library files of a `target: es2015` program are 2,669,841 bytes:
  today's parser, which skips the types, needs 6 ms for them in the release build and 284 ms to 311 ms in the
  debug build. So one process per instance costs at least 0.56 s per instance in a debug build before any
  check: about two hours for one sweep. The batch form pays the start and the libraries once per process.
- (a) marks a stand-in with `error TS-1`. The reference uses the code -1 itself for an ad hoc message
  (`internal/diagnostics/diagnostics.go:152-159`, used at `internal/testutil/harnessutil/harnessutil.go:699`),
  so the runner could not tell a stand-in from a diagnostic of the reference.
- (b) has the power of (c) when the request lists instances. Then the operands of the command line say what
  the request says a second time, or there are none, which `cli.md` C1.3 makes a usage error.
- (c) adds no flag (`cli.md` C2.2: "Do not add a format flag") and leaves the plain form of a normal run as
  it is. The variable is internal and read only when `BUN_FEATURE_FLAG_EXPERIMENTAL_LINT=1` is set.

The entries CH-1 to CH-3 are the binary side. CH-4 is the K5 side. CH-5 and CH-6 are what no unit owns.

### CH-1. The operand form: what `cli.md` C2 leaves open

To: cli (`src/runtime/cli/lint_command.rs`, `src/lint/`).

Ask. For `bun --lint <files>` with stdout and stderr that are no terminal:

1. stdout stays empty.
2. stderr holds diagnostics and nothing else. Each line ends with LF. No empty line, no summary, no code
   frame, no colour, and a text holds no line break.

       <path>(<line>,<column>): <category> <code>: <text>      a diagnostic in a file
       <category> <code>: <text>                                a diagnostic without a file
       <two spaces per level><text>                             a line of the message chain, level 1 and up

   Line and column are 1-based and the column counts UTF-16 code units. The category is one of `error`,
   `warning`, `suggestion`, `message`. The path is absolute or relative to the current directory. Reference:
   `internal/diagnosticwriter/diagnosticwriter.go:555-566` (the head), `:342-360` (the chain, in pre-order),
   `internal/diagnostics/diagnostics.go:29-41` (the category names).
3. The code is `TS` and a number only for a diagnostic that typescript-go has under that number, with its
   text. Every other code (the name of a rule, a syntax error of Bun that has no TypeScript number, an error
   of the binary) matches `[A-Za-z@][A-Za-z0-9@/_-]*` and is not `TS` and digits.
4. Exit code 0 when no diagnostic of category `error` was printed, 2 when one or more were, 1 for a refusal.
   Any other exit code and any signal is read as a crash.
5. The operands of one run are the roots of ONE program, in the order given. 1,562 run instances have more
   than one root.
6. Order and duplicates as the reference has them: sorted with `ast.CompareDiagnostics`
   (`internal/ast/diagnostic.go:458-503`: path, start, END of the span, code, category, message), then
   `compactAndMergeRelatedInfos` (`internal/compiler/program.go:1605-1633`). `cli.md` C2.2 says "file, then
   position, then code". The end has to come before the code: of the 7,027 baselines of the oracle 474 hold
   two diagnostics at one start, in 105 their ends differ, and in 37 the order by code is the reverse of the
   order by end (first: `compiler/TransportStream.ts`, `compiler/arithmeticOnInvalidTypes.ts`).
7. A lint run prints nothing about the `bunfig.toml`, `package.json`, `tsconfig.json` or `jsconfig.json` of the
   current directory. The cases have broken ones on purpose: 73 run instances have a configuration file and
   504 have a `package.json`.
8. For each name of the stand-in log of the run one line without a file, `error internal-stand-in: <name>`,
   and the exit code 2. For a ported panic or assert one line `error internal-error: <text>`. (typecheck
   gives the data: CH-3.)

Unlocks. The probe of the default check (T2.4 of `conformance.md`): with it the runner can tell a linter from
a binary that runs its operand. By itself it lets at most 7 instances pass, all C: the other 12,790 run
instances set a compiler option by a directive (12,786) or have a configuration file (4), and the operand
form has no way to hand an option over. Without point 8 no pass of the operand form is sound: a run that
reached a stand-in prints nothing for a C instance.

Until then. The probe refuses the binary, no instance is handed to it, and the lists of the default check
stay empty. With the operand form and without CH-2 the status of an instance that has options is
"unsupported"; on request the runner compares the first section of its baseline and reports that apart.

### CH-2. The batch form

To: cli (`lint_command.rs`), and one line in `src/bun_core/env_var.rs`, a file that no unit owns.

Ask.

1. The switch. In `pub mod feature_flag` of `src/bun_core/env_var.rs`, beside
   `BUN_INTERNAL_INTERACTIVE_ASSUME_TTY` (line 295):

       new_feature_flag!(pub BUN_INTERNAL_LINT_CONFORMANCE, "BUN_INTERNAL_LINT_CONFORMANCE", {});

   It is read only when the lint flag of C1.2 is accepted. With it `bun --lint <file>` takes its one operand
   as a manifest. More than one operand is a refusal (exit code 1).
2. The manifest: JSON in UTF-8. Every name in it is a real absolute path. `bun_parsers::json::parse_utf8`
   (`src/parsers/json.rs:308`) reads it, no new dependency.

       { "version": 1,
         "libDirectory": "/repo/test/cli/lint/conformance/corpus/tsgo/internal/bundled/libs",
         "instances": [ {
           "id": "0",
           "root": "/tmp/x/0",
           "currentDirectory": "/tmp/x/0/.src",
           "rootNames": ["/tmp/x/0/.src/2dArrays.ts"],
           "compilerOptions": { "noErrorTruncation": true, "newLine": "crlf", "skipDefaultLibCheck": true,
                                "target": "es2015", "strict": false, "lib": ["es2015", "dom"] }
         } ] }

   - `libDirectory`: a directory with the default library files in the form of typescript-go
     (`lib.es5.d.ts`, ...): LB-2.
   - `root`: the real directory that stands for `/` of the instance. Every file of the instance is below it.
   - `compilerOptions`: the form of `"compilerOptions"` in a `tsconfig.json`: declared names; booleans,
     numbers, strings, lists of strings; a value of an enumeration is its name in lower case; a file name is
     absolute. The runner has already merged what the harness sets (`harnessutil.go:97-104`:
     `newLine` CRLF, `skipDefaultLibCheck` true, `noErrorTruncation` true) with the directives.
   - Fields that only some instances have. The binary answers `refused` for an instance with a field that it
     does not implement or does not know:
     `"configFile": "<path>"` with `"defaultOptions": {...}` (73 instances; the order of precedence is the
     one of `harnessutil.go:81-113`: options of the configuration file, then `defaultOptions` where no value
     is set, then `compilerOptions`); `"rootedPaths": true` (175 instances: a text of the instance names a
     file by an absolute path such as `/.lib/react.d.ts`, to be found below `root`);
     `"useCaseSensitiveFileNames": false` (5 instances); `"captureSuggestions": true` (1 instance:
     diagnostics of category `suggestion` are part of the result, `harnessutil.go:670-672`).
3. The report: stdout, one line of JSON per instance, in the order of the manifest. A line is written and
   flushed when its instance is done. Nothing else on stdout. `bun_core::fmt::write_json_string`
   (`src/bun_core/fmt.rs:42`) quotes a string.

       { "id": "0", "diagnostics": [ D, ... ], "standIns": ["name", ...] }
       { "id": "0", "refused": "text" }

       D = { "category": "error" | "warning" | "suggestion" | "message",
             "code": 2322,
             "messageText": "...",
             "next": [ { "messageText": "...", "next": [...] } ],
             "location": { "file": "/tmp/x/0/.src/a.ts", "start": 6, "length": 1, "line": 1, "character": 7 },
             "relatedInformation": [ { "code": 2728, "messageText": "...", "next": [...], "location": {...} } ] }

   - `next` is absent or empty when there is no chain. `location` is absent for a diagnostic without a file.
     `relatedInformation` is always there, empty when there is none.
   - `start` and `length` count UTF-8 bytes of the text of the file, after a byte order mark is removed and
     UTF-16 is converted. `line` and `character` are 1-based, the character in UTF-16 code units. Both pairs
     are given and have to agree.
   - `file` is a file of the instance, or a default library file: then only its last component
     (`lib.<name>.d.ts`) is read.
   - The diagnostics are what the harness of the reference collects (CH-3 point 2). No diagnostic of a lint
     rule: the cases are full of code that the first rules of C3 report (with the configuration of this
     repository, oxlint reports more than 6,900 errors in `tests/cases/compiler` alone).
   - `standIns`: the names of the stand-in log of this instance, each once, in the order of the first reach.
   - A field that is not named here makes the line unreadable.
4. Exit code 0 when every instance has its line. Exit code 1 with a text on stderr when the manifest is
   refused as a whole. stderr is empty otherwise.

Unlocks. Every pass through the binary except the 7 of CH-1. With one root, options, `libDirectory` and no
optional field: 10,570 run instances (E 5,830, C 4,740; Linux). Of the 7,027 E instances 6,870 need what
only this report has: 6,865 the span length, 1,024 the related information. The plain format alone rebuilds
143 baselines. 14 baselines are in the pretty form, which the runner writes itself from the same data.

Until then. The default check uses the operand form of CH-1. A probe with a manifest of two instances tells
the runner whether the binary has the batch form; a refusal is not a failure.

### CH-3. What the batch form needs from the checker crate

To: typecheck (`src/typecheck/`). cli calls it.

Ask.

1. An entry that sets one compiler option from its declared name and a JSON value (boolean, number, string,
   list of strings) and says when it does not know the name: the port of
   `tsoptions.ParseCompilerOptions(key string, value any, allOptions *core.CompilerOptions)`
   (`internal/tsoptions/parsinghelpers.go:268`), which the harness calls at
   `internal/testutil/harnessutil/harnessutil.go:300`. The run instances use 90 declared names (68 booleans,
   11 strings, 6 enumerations, 4 lists, 1 number). Instances whose options are all within the k names used
   most: `target` alone 5,012; with `strict` 6,780; with `module`, `declaration`, `noEmit`, `allowJs`,
   `checkJs`, `lib`, `outDir`, `noEmitHelpers`, `jsx`, `experimentalDecorators` (12 names) 10,461; 30 names
   12,113; 90 names 12,797. An option that is read and not implemented has to refuse the instance, never to
   be dropped in silence.
2. The diagnostics of one program as the harness collects them, not as the command line does:
   configuration file, program, syntactic, semantic and global diagnostics, the declaration diagnostics when
   the options emit declarations, the suggestions on request (`harnessutil.go:661-672`), then
   `compiler.SortAndDeduplicateDiagnostics` (`internal/compiler/program.go:1597`). The command line collects
   the semantic diagnostics only when there is no syntactic one (`program.go:1939-1991`); at least 324
   baselines hold a diagnostic of the parser together with another one. Each diagnostic gives: category,
   code, message text, the chain as a tree, the file, start and length, and the related information with
   the same fields.
3. The stand-in log of one run: the names, each once, in the order of the first reach, and empty again for
   the next program.
4. The default libraries come from a directory that the caller names (K4 does that already), in the form and
   with the names of `internal/bundled/libs`: LB-2.
5. `noErrorTruncation` is honoured: the harness sets it for every instance.

Unlocks: as CH-2. Until then: as CH-2.

### CH-4. K5: the check of the test importer

To: typecheck (`test/cli/lint/typecheck/`).

Ask.

1. K5 implements the `Check` interface of `conformance/API.md` in TypeScript and hands it to the runner. It
   does not go through `bun --lint`. Its input has the texts of the units, the options as in CH-2, the links
   and the path of the default libraries; its output has the diagnostics in the shape D of CH-2 and
   `standIns`. An instance with a non-empty `standIns` is "provisional" and never passes.
2. The list of passing names of K5 is a file of typecheck's own directory. The runner's functions take the
   path of the list and the check as arguments, and typecheck's own test file runs its list. The file
   `test/cli/lint/conformance/expectations.json` is the list of the default check and typecheck does not
   write it.
3. The tree dump has to carry the parse diagnostics of TypeScript: 525 to 837 of the 7,027 E baselines hold a
   diagnostic of the parser or the scanner.
4. An instance with more than one file needs "already resolved inputs" (`typecheck.md`, out of scope). K5
   says which instances it does not take; the runner gives them the status "unsupported", not "fail".

Unlocks: the growth of the list during this work. With one file and no configuration file: 10,723 run
instances (E 5,905, C 4,818). Until then: both lists are empty and the sweep reports zero passes.

### CH-5. What no unit owns: the program layer

To: no owner. `cli.md` and `typecheck.md` both put tsconfig, project discovery, module resolution from disk
and the embedding of the libraries out of scope.

| piece | run instances that need it |
|---|---|
| default libraries | 12,788 (all but the 9 with `noLib`): LB-2 gives a directory until they are embedded |
| module resolution among the files of an instance | 2,073 (E 1,121, C 952) have more than one file or a configuration file |
| parsing of a `tsconfig.json` | 73 |
| a root for absolute paths in the text of a file | 175 (170 of them name `/.lib/`) |
| declaration diagnostics (the declaration transform) | 51 (measured by typecheck: 48 need them, 3 more need the emit to have run) |
| links | 19 |
| file names without case | 5 |
| suggestions | 1 |

Until then: the binary answers `refused` for such an instance (CH-2), and the runner reports "unsupported"
with the text. The instance is in no list.

### CH-6. The parser

To: parser (`src/js_parser/`), for P3.5.

Ask. A syntax error of a lint parse that has a TypeScript code is reported with the text of the reference
for that code, its arguments, and the start and the length that the parser of the reference gives. The code
alone does not make a baseline equal.

Unlocks. 525 E baselines hold a code that only the parser or the scanner of the reference reports, and 837
hold one that they report at all. `parser.md` P3.5 keeps "stops at its first error": at most 141 of the 525
have exactly one diagnostic and can be reached that way. The others need the error recovery of the
reference, which is out of scope. 990 run instances have a JavaScript unit (E 600, C 390) and need JSDoc,
which `parser.md` leaves to a later unit.

Until then: such an instance fails through the binary. Through K5 it can pass, because the tree and its
parse diagnostics come from TypeScript.

## 2. Files of the repository that no unit owns

### RP-1. `test/tsconfig.json`

To: integrator. Ask: one entry in `"exclude"`: `"cli/lint/conformance/corpus"` (and
`"cli/lint/typecheck/fixtures"` for typecheck K2: the entry `"fixtures"` that is there matches only
`test/fixtures`).

Why. `"include"` has `**/*.ts`, `**/*.tsx`, `**/*.mts`, `**/*.cts`. The project has 2,978 such files today;
the corpus adds 12,444. Measured with tsc 6.0.2 on every 62nd case as one project: 181 files give 1,005
errors in 156 files (TS2300, TS2451: the cases are scripts that declare the same names). With the 14 files
of the sample that have a syntax error, tsc prints only their 63 syntax errors and nothing else, so the
corpus would hide every real error of `cd test && bun run typecheck`. No workflow runs that command; it is a
script of `package.json` and the project of the editor.

Until then: nothing in CI changes. The unit cannot work around it, because the names are upstream's.

### RP-2. `oxlint.json`

To: integrator. Ask: one entry in `"ignorePatterns"`: `"test/cli/lint/conformance/corpus"` (and typecheck's
fixtures).

Why. `bun run lint:fix` is `oxlint --config oxlint.json --fix` with no path. Measured on a copy of
`tests/cases/compiler` at the path of the corpus, with the configuration and the plugin of this repository:
`--fix` rewrote 106 of 6,537 files and 6,966 errors were left. CI runs `bun lint`, which names `src/js` only.

Until then: `sync.sh --verify` shows a rewritten file.

### RP-3. `.github/CODEOWNERS`

To: integrator, with the consent of @Jarred-Sumner (`/.github/CODEOWNERS @Jarred-Sumner`). Ask: after the
line `/packages/bun-types/ @alii` one line with a path and no owner:

    /test/cli/lint/conformance/corpus/

Why. `*.d.ts @alii` matches 44 files of the corpus (40 cases, 4 files of `tests/lib`) and 108 more when the
default libraries are vendored (LB-2). Each makes @alii a requested reviewer of the pull request.

Until then: the request for review happens. Nothing fails.

### RP-4. `test/no-validate-leaksan.txt`

To: integrator. No line is asked for now.

Why it is here. For a test file that is not in that list the runner sets
`ASAN_OPTIONS=...:detect_leaks=1:abort_on_error=1` (`scripts/runner.node.ts:2201-2205`), in the ASAN lane and
on a local `bun run test <file>`. `test/harness.ts:95` keeps the value for every child. So a leak on the
lint path aborts the `bun --lint` child of `test/cli/lint/conformance.test.ts`, and the runner reads a
crash. With empty lists no instance is expected to pass and the test stays green. When the first instance is
listed, a leak is a defect of the lint path, to be fixed there; the line
`test/cli/lint/conformance.test.ts` in this file is the stopgap. The same holds for typecheck's test file of
K5, where the checker runs inside the test process.

### RP-5. `test/harness.ts`

To: integrator and cli. Ask: `BUN_INTERNAL_LINT_CONFORMANCE` is never added to `bunEnv`. The runner sets it
for the one spawn that hands a manifest over and removes it for every other spawn, as it sets
`BUN_FEATURE_FLAG_EXPERIMENTAL_LINT=1` and removes `BUN_OPTIONS` itself.

### RP-6. What the corpus does to the repository

To: integrator. For information, no file to change.

- Files: 22,185 (cases 12,444 and 4 of `tests/lib` and the licence files in `corpus/ts`: 21,507 with 9,056
  baselines of TypeScript; `corpus/tsgo`: 678). The repository tracks 19,932 files today.
- The longest path becomes 202 characters (today 159):
  `test/cli/lint/conformance/corpus/tsgo/testdata/baselines/reference/submodule/conformance/ClassAndModuleThatMergeWithModulesExportedGenericFunctionAndNonGenericClassStaticFunctionOfTheSameName.errors.txt`.
- `.gitignore:139` (`*.generated.ts`) hides one case,
  `tests/cases/conformance/parser/ecmascript5/parserSyntaxWalker.generated.ts`. The unit adds it with
  `git add -f`; a later `git add <directory>` by someone else would not.
- No name of the corpus matches the test discovery of `scripts/runner.node.ts:2492-2494` (`\.test|spec\.`),
  so prettier (`test/**/*.{test,spec}.*`) and the CI lanes leave it alone.

## 3. Libraries

### LB-1. `tests/lib`

To: integrator (a decision about the text of `conformance.md`). T1.1 names `tests/cases/conformance`,
`tests/cases/compiler` and the baselines. The harness also mounts `tests/lib` of TypeScript at `/.lib`
(`harnessutil.go:41`, `:144`, `:214-216`, `:267-290`). It is 4 files and 394,949 bytes (`react.d.ts`,
`react16.d.ts`, `react18/react18.d.ts`, `react18/global.d.ts`). 163 case files name `/.lib/`: 170 run
instances (E 86, C 84). The unit copies `tests/lib` with the corpus and says so in its report.

### LB-2. The default libraries: one committed copy

To: typecheck (K4, K5), and integrator for the decision.

Ask. The oracle was made with the library files that typescript-go embeds: `internal/bundled/libs`, 108
files, 3,785,075 bytes, tracked at 89d5d5b, 558,663 bytes as one gzip archive. Each is the copyright notice
of `scripts/CopyrightNotice.txt` (15 lines), then the sources of `src/lib` without CR, under the name
`lib.<name>.d.ts` (`internal/bundled/generate.go:53-70`). `typecheck.md` K4 names
`_submodules/TypeScript/src/lib`: those are the sources (`es5.d.ts`, `dom.generated.d.ts`), with other names.
The names reach the baselines (`lib.es5.d.ts(--,--): error TS2300`), and neither directory is in this
repository, so a test that reads it cannot run in CI.

Proposal: the conformance unit copies `internal/bundled/libs` once, verbatim, to
`test/cli/lint/conformance/corpus/tsgo/internal/bundled/libs/` (one more `copy` record of `UPSTREAM`), and
`API.md` names the path. K4, K5 and the manifest of CH-2 read that directory. There is no second copy until
a later unit embeds the libraries in the binary.

Unlocks: 12,788 run instances load a default library. Until then: the sweep on this machine takes
`--lib-directory /workspace/ref/typescript-go/internal/bundled/libs`; in CI no instance that needs a library
can run.

## 4. Licence

### LC-1. The credit for the ported checker and for the libraries

To: typecheck, the later unit that embeds the libraries, and the maintainers.

The conformance unit owns `LICENSE.md` and `docs/project/license.mdx` for attribution. With T1 it adds the
credit for the test corpus (TypeScript and typescript-go, Apache-2.0, not part of the binary) under
"Additional credits", where the port of esbuild is named, and keeps `LICENSE` and `NOTICE.txt` of
typescript-go and `LICENSE.txt` and `ThirdPartyNoticeText.txt` of TypeScript beside the corpus.

Ask.

1. typecheck: say in its `API.md` which upstream packages `src/typecheck` ports and when K1 is merged. The
   sentence "the type checker of `bun --lint` is a port of typescript-go" is true only from then on, so it is
   a second line, added at that merge.
2. Maintainers: Apache-2.0 section 4(d) asks for the notices of a `NOTICE` file in what is distributed.
   `NOTICE.txt` of typescript-go (48,860 bytes) holds the notices for DefinitelyTyped, Unicode, the Document
   Object Model and others: they belong to the library files (`lib.dom.d.ts`) and to the Unicode tables of
   the scanner. Which file of a Bun release carries them once the checker and the libraries are in the
   binary is a decision that the unit cannot take. `LICENSE.md` has no entry for the React Compiler port
   either (`src/react_compiler/UPSTREAM_PORTED`).

Until then: the corpus line only.

## 5. Another unit that vendors cases

### VN-1. `test/cli/lint/typecheck/fixtures/`

To: typecheck (K2).

Ask. Before the first case is added, a file `test/cli/lint/typecheck/fixtures/.gitattributes` with the line

    * -text

Why. `git check-attr` gives `text: set`, `eol: lf` for `.ts`, `.tsx`, `.d.ts`, `.js` and `.json` there (the
root `.gitattributes`), and nothing for `.symbols` and `.errors.txt`. Of the 12,445 case files 8,879 are CR
LF, 362 mix CR LF and LF, 8 have a lone CR. Of the 215 cases of typecheck's selection 158 hold a CR. Proved in
a scratch repository with the root `.gitattributes`: `git add` of `compiler/ExportAssignment7.ts` (76
bytes, blob 9c8b78da) stores 71 bytes (blob 6d7e2a43) under `typecheck/fixtures/` and upstream's blob under
a directory with `* -text`. Every offset of a tree dump and of a diagnostic after the first line break then
differs from upstream. The conformance corpus has the same line in its own `.gitattributes`.

## 6. The check of the integrator for comments

### CK-1. A path exemption

To: integrator.

`internal/STATE.md` has the integrator check a merged branch for comment runs and for TODO and FIXME. The
corpus is copied byte for byte. With the rule of `.github/workflows/comment-cop.yml` (two or more comment
lines in a row): 8,199 of the 12,445 case files have such a run (8,162 have two `//` lines in a row; 7,875
start with two directive lines such as `// @target: es2015`), 3 of the 4 files of `tests/lib`, 98 of the 108
library files. 29 case files and 2 files of `tests/lib` hold TODO, FIXME or XXX.

Ask: the check leaves out `test/cli/lint/conformance/corpus/` (and `test/cli/lint/typecheck/fixtures/`). The
files of the runner (`test/cli/lint/conformance/runner/`, `sweep.ts`, `conformance.test.ts`) are checked as
any other file. The workflow itself reads only paths that start with `src/`, so CI needs no change.

## 7. What only CI can verify

No Windows machine and no macOS machine was available. Nothing below is verified. Watch the first run of
these lanes for:

- CI-1, long paths (Windows). The longest path of the corpus is 202 characters. With a checkout root of more
  than 56 characters a path passes 259, and `git checkout` fails with "Filename too long" unless
  `core.longpaths` is set. The longest path of the repository today is 159.
- CI-2, line endings (Windows). A checkout with `core.autocrlf=true` has to leave the corpus byte for byte.
  Proved only by simulation (`git -c core.autocrlf=true archive`, `corpus-repo-hazards/prove-corpus.sh`).
- CI-3, links (Windows). 19 run instances make links. Without the right to make links their status has to be
  "unsupported on this platform", not "fail" (5 instances by the count of the materialisation research).
- CI-4, case rules (macOS, Windows). The harness runs every instance with case-sensitive names
  (`harnessutil.go:105`) and the disk is not: an instance with two units whose names differ only by case
  cannot be written, and a check that reads the disk finds `A.ts` for `a.ts`. Predicted, not measured: 182
  run instances cannot be written on macOS, 183 to 188 on Windows, 185 on Linux (mostly the 175 with
  absolute paths). No two paths of the corpus itself differ only by case.
- CI-5, names in the output (Windows). A path in a diagnostic has a drive and may have back slashes; a path
  in a message text has forward slashes. The directory of temporary files may be a short name
  (`RUNNER~1`). The mapping from real to virtual names was tested on Linux only.
- CI-6, time. A process start costs 0.27 s to 0.35 s in the debug build here; process creation on Windows
  and under ASAN in CI is not measured. The first listed instances will show whether the time limit of
  `conformance.test.ts` holds.
- CI-7, LeakSanitizer (ASAN lane): RP-4.
- CI-8, the size of the pull request. More than 22,000 added files: the file list of the GitHub API ends at
  3,000 files, and `comment-cop.yml` reads that list. Paths under `src/` sort before `test/`.
