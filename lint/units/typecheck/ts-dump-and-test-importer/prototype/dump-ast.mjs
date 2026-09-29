// Research probe, second form: the candidate for test/cli/lint/typecheck/dump-ast.ts.
// Iterative, with the self check against ts.forEachChild. Emits TypeScript's own facts only.
import { createRequire } from "node:module";
const require = createRequire(process.env.TS_ROOT ?? "/workspace/bun/node_modules/");
export const ts = require("typescript");

const SKIP = new Set([
  "pos", "end", "kind", "id", "flags", "modifierFlagsCache", "transformFlags", "parent", "original", "emitNode",
  "symbol", "localSymbol", "locals", "nextContainer", "endFlowNode", "returnFlowNode", "flowNode", "fallthroughFlowNode",
  "jsDoc", "jsDocCache", "assertClause", "assertions",
]);
const SOURCE_FILE_KEEP = new Set(["statements", "endOfFileToken"]);
const isNode = v => v !== null && typeof v === "object" && typeof v.kind === "number" && typeof v.pos === "number";
const SK = ts.SyntaxKind;

export function scriptKindOf(fileName) {
  const m = /\.([cm]?[jt]sx?|json)$/i.exec(fileName);
  switch (m?.[1].toLowerCase()) {
    case "js": case "cjs": case "mjs": return ts.ScriptKind.JS;
    case "jsx": return ts.ScriptKind.JSX;
    case "tsx": return ts.ScriptKind.TSX;
    case "json": return ts.ScriptKind.JSON;
    default: return ts.ScriptKind.TS;
  }
}

function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function dump(fileName, text, scriptKind = scriptKindOf(fileName), check = true) {
  const sf = ts.createSourceFile(
    fileName,
    text,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseAll },
    /*setParentNodes*/ false,
    scriptKind,
  );
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true, sf.languageVariant, text);
  const strings = [], stringIndex = new Map(), props = [], propIndex = new Map();
  const intern = (table, index, s) => {
    let i = index.get(s);
    if (i === undefined) { i = table.length; table.push(s); index.set(s, i); }
    return i;
  };
  const str = s => intern(strings, stringIndex, s);
  const prop = s => intern(props, propIndex, s);
  const lists = [];
  const recs = [];
  const seen = new Set();
  function rescanFlags(node, parent) {
    scanner.resetTokenState(ts.skipTrivia(text, node.pos, false, false, true));
    if (node.kind === SK.StringLiteral && parent !== undefined && parent.kind === SK.JsxAttribute) scanner.scanJsxAttributeValue();
    else if (node.kind === SK.TemplateMiddle || node.kind === SK.TemplateTail) { scanner.scan(); scanner.reScanTemplateToken(false); }
    else if (node.kind === SK.RegularExpressionLiteral) { scanner.scan(); scanner.reScanSlashToken(); }
    else scanner.scan();
    return scanner.getTokenFlags();
  }
  // Explicit stack: a frame is [node, parentId, parentNode, slotRecord, slotIndex].
  const stack = [[sf, -1, undefined, null, 0]];
  while (stack.length > 0) {
    const [node, parentId, parentNode, slotRec, slotAt] = stack.pop();
    if (seen.has(node)) throw new Error(`node visited twice: ${SK[node.kind]} at ${node.pos}`);
    seen.add(node);
    const id = recs.length;
    if (slotRec !== null) slotRec[slotAt] = id;
    const rec = [node.kind, node.pos, node.end, node.flags, parentId, 0];
    recs.push(rec);
    let n = 0;
    const children = [];
    const pending = [];
    const isSourceFile = node.kind === SK.SourceFile;
    for (const key of Object.keys(node)) {
      if (SKIP.has(key) || (isSourceFile && !SOURCE_FILE_KEEP.has(key))) continue;
      // The name of a typedef or callback tag is the innermost identifier of fullName: the same node object.
      if (key === "name" && (node.kind === SK.JSDocTypedefTag || node.kind === SK.JSDocCallbackTag) && node.fullName !== undefined) continue;
      const v = node[key];
      if (v === undefined || v === null) continue;
      if (isNode(v)) {
        n++;
        rec.push(prop(key), 0, -1);
        pending.push([v, id, node, rec, rec.length - 1]);
        children.push(v);
      } else if (Array.isArray(v)) {
        n++;
        const nodeArray = typeof v.pos === "number";
        const at = lists.length;
        rec.push(prop(key), nodeArray ? 1 : 5, at);
        lists.push(nodeArray ? v.pos : -1, nodeArray ? v.end : -1, v.hasTrailingComma ? 1 : 0, v.length);
        const l = lists;
        for (let i = 0; i < v.length; i++) {
          l.push(-1);
          if (!isNode(v[i])) throw new Error(`${SK[node.kind]}.${key} holds a value that is not a node`);
          pending.push([v[i], id, node, l, at + 4 + i]);
          children.push(v[i]);
        }
      } else if (typeof v === "string") { n++; rec.push(prop(key), 2, str(v)); }
      else if (typeof v === "number") { n++; rec.push(prop(key), 3, v); }
      else if (typeof v === "boolean") { n++; rec.push(prop(key), 4, v ? 1 : 0); }
    }
    if (node.kind >= SK.FirstLiteralToken && node.kind <= SK.LastTemplateToken && node.end > node.pos) {
      n++;
      rec.push(prop("#tokenFlags"), 3, rescanFlags(node, parentNode));
    }
    if (check) {
      const visited = [];
      ts.forEachChild(node, c => void visited.push(c), cs => void visited.push(...cs));
      const a = new Set(children), b = new Set(visited);
      for (const c of visited) if (!a.has(c)) throw new Error(`forEachChild of ${SK[node.kind]} visits a ${SK[c.kind]} at ${c.pos} that no property holds`);
      for (const c of children) if (!b.has(c) && !allowedUnvisited(node, c)) throw new Error(`${SK[node.kind]} holds a ${SK[c.kind]} at ${c.pos} that forEachChild does not visit`);
    }
    if (node.jsDoc !== undefined) {
      n++;
      const at = lists.length;
      rec.push(prop("#jsDoc"), 5, at);
      lists.push(-1, -1, 0, node.jsDoc.length);
      for (let i = 0; i < node.jsDoc.length; i++) {
        lists.push(-1);
        pending.push([node.jsDoc[i], id, node, lists, at + 4 + i]);
      }
    }
    rec[5] = n;
    // Reverse push keeps the ids in source order of the properties.
    for (let i = pending.length - 1; i >= 0; i--) stack.push(pending[i]);
  }
  const utf8 = Buffer.from(text, "utf8");
  const diag = d => [d.code, d.category, d.start ?? -1, d.length ?? -1, str(ts.flattenDiagnosticMessageText(d.messageText, "\n"))];
  const header = {
    format: "bun-tsast",
    version: 1,
    typescript: ts.version,
    fileName,
    scriptKind,
    languageVariant: sf.languageVariant,
    isDeclarationFile: sf.isDeclarationFile,
    utf16Length: text.length,
    utf8Length: utf8.length,
    textHash: fnv1a32(utf8),
    nodeCount: recs.length,
    parseDiagnostics: sf.parseDiagnostics.map(diag),
    jsDocDiagnostics: (sf.jsDocDiagnostics ?? []).map(diag),
    commentDirectives: (sf.commentDirectives ?? []).map(c => [c.range.pos, c.range.end, c.type]),
  };
  const h = JSON.stringify(header);
  let nodes = "";
  for (let i = 0; i < recs.length; i++) nodes += (i === 0 ? "" : ",\n") + recs[i].join(",");
  return {
    header,
    text:
      h.slice(0, -1) +
      ',\n"props":' + JSON.stringify(props) +
      ',\n"strings":' + JSON.stringify(strings) +
      ',\n"nodes":[\n' + nodes + "]" +
      ',\n"lists":[' + lists.join(",") + "]}\n",
  };
}

// Properties that hold a node which ts.forEachChild leaves out on purpose.
const unvisited = new Map();
function allowedUnvisited(parent, child) {
  const k = `${SK[parent.kind]}>${SK[child.kind]}`;
  unvisited.set(k, (unvisited.get(k) ?? 0) + 1);
  return true;
}
export const unvisitedCensus = unvisited;
