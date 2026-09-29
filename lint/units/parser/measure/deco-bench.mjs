// Fixed work for the DecoratorMetadata sink: the transpiler bench has no decorator, so it never runs it.
//
//   BUN_JSC_useJIT=0 /workspace/tools/vg --tool=cachegrind --cache-sim=no --branch-sim=yes \
//     --cachegrind-out-file=<out>.cg <bun-profile> deco-bench.mjs --iterations=20
//
// Inputs: the unmutated forms of corpus.small.json in the four decorated contexts, and group
// 07-decorator-metadata of corpus.targeted.json. Every input is transformed with
// experimentalDecorators + emitDecoratorMetadata. An input that does not parse counts as rejected.
// Two builds did the same work when they print the same line.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "grammar-diff");
const small = JSON.parse(readFileSync(join(dir, "corpus.small.json"), "utf8"));
const targeted = JSON.parse(readFileSync(join(dir, "corpus.targeted.json"), "utf8"));
const sources = [];
for (const form of small.forms) {
  if (form.mut !== null || form.prod === "junk" || form.prod === "jsdoc") continue;
  for (const ctx of ["field", "param", "ctor", "ret"]) sources.push(small.contexts[ctx].replace("%T%", () => form.t));
}
for (const s of targeted.sources) if (s.prod === "07-decorator-metadata") sources.push(s.src);

const iterations = Number(process.argv.find(a => a.startsWith("--iterations="))?.slice(13) ?? 1);
const transpiler = new Bun.Transpiler({
  loader: "ts",
  define: { "process.env.NODE_ENV": '"development"' },
  tsconfig: { compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } },
});
let accepted = 0;
let rejected = 0;
let length = 0;
for (let i = 0; i < iterations; i++) {
  accepted = rejected = length = 0;
  for (const src of sources) {
    try {
      length += transpiler.transformSync(src).length;
      accepted++;
    } catch {
      rejected++;
    }
  }
}
console.log(`deco-bench sources ${sources.length} accepted ${accepted} rejected ${rejected} output length ${length} passes ${iterations}`);
