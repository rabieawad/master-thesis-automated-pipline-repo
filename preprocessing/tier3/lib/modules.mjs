// Module wrappers in the shape of Aletheia's reference.
//
// A file whose code sits at the top level (no function of its own — gopd, es-errors, …) is matched
// only through the function that wraps the file, and the two sides wrap files differently:
//   webpack     {656: function(e, t, r) { 'use strict'; var n = r(492); …; e.exports = n }}
//   Aletheia    module([function(_$__e) { 'use strict'; var n = require('./gOPD'); …; module.exports = n }])
// (Aletheia leaves module / exports / require free). rewriteWrapper() turns a webpack wrapper into
// Aletheia's form (params module, exports, require renamed to the free names, one _$__e param),
// and canonicalRequire() makes require('./gOPD') and require(492) the same text on both sides.

import { parse } from "meriyah";
import { extractWithFeatures } from "../../tier1/06-extract-functions.mjs";

// require(<string or number literal>) -> require(0), on a function's normalised text
const REQUIRE = /\brequire\((?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\d+)\)/g;
export const canonicalRequire = (text) => (text == null ? text : text.replace(REQUIRE, "require(0)"));

const FUNCS = new Set(["FunctionExpression", "FunctionDeclaration", "ArrowFunctionExpression"]);
const TARGETS = ["module", "exports", "require"];

// the names a scope node declares itself (params, var/let/const/function/class, catch param)
function declares(node) {
  const out = new Set();
  const pat = (p) => {
    if (!p) return;
    if (p.type === "Identifier") out.add(p.name);
    else if (p.type === "ObjectPattern") p.properties.forEach((q) => pat(q.type === "RestElement" ? q.argument : q.value));
    else if (p.type === "ArrayPattern") p.elements.forEach(pat);
    else if (p.type === "AssignmentPattern") pat(p.left);
    else if (p.type === "RestElement") pat(p.argument);
  };
  if (FUNCS.has(node.type)) { node.params.forEach(pat); if (node.type === "FunctionExpression" && node.id) out.add(node.id.name); }
  if (node.type === "CatchClause") pat(node.param);
  const body = FUNCS.has(node.type) ? node.body : node;
  const visit = (n, fnLevel) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "VariableDeclaration" && (n.kind === "var" ? fnLevel : true)) n.declarations.forEach((d) => pat(d.id));
    if ((n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") && n.id) out.add(n.id.name);
    if (FUNCS.has(n.type) || n.type === "ClassExpression") return;
    if (n !== body && (n.type === "BlockStatement" || n.type === "ForStatement" || n.type === "ForInStatement" || n.type === "ForOfStatement")) {
      // nested blocks: their var declarations still belong to the function
      if (fnLevel) for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => c?.type === "VariableDeclaration" && c.kind === "var" && c.declarations.forEach((d) => pat(d.id))); }
    }
    for (const k of Object.keys(n)) { if (k === "loc" || k === "range") continue; const v = n[k]; if (Array.isArray(v)) v.forEach((c) => c?.type && visit(c, fnLevel)); else if (v?.type) visit(v, fnLevel); }
  };
  if (body?.type === "BlockStatement") body.body.forEach((s) => visit(s, FUNCS.has(node.type)));
  else if (node.type === "BlockStatement") node.body.forEach((s) => (s.type === "VariableDeclaration" && s.kind !== "var") || s.type === "FunctionDeclaration" || s.type === "ClassDeclaration" ? visit(s, false) : null);
  return out;
}

// Rewrite the source of one webpack module wrapper `function (e, t, r) {…}` (or an arrow) into
// `(function(_$__e){…})` with e/t/r renamed to module/exports/require. null when it can't.
export function rewriteWrapper(src) {
  let ast;
  try { ast = parse("(" + src + ")", { ranges: true, next: true }); } catch { return null; }
  const fn = ast.body[0]?.expression;
  if (!fn || !FUNCS.has(fn.type) || fn.params.length < 1 || fn.params.length > 3 || fn.params.some((p) => p.type !== "Identifier")) return null;
  const map = new Map(fn.params.map((p, i) => [p.name, TARGETS[i]]));
  if (fn.body.type !== "BlockStatement") return null;
  // the wrapper's own body must not already use the target names
  const edits = [];
  const walk = (n, active, parent, key) => {
    if (!n || typeof n.type !== "string") return;
    let act = active;
    if (n !== fn && (FUNCS.has(n.type) || n.type === "CatchClause" || n.type === "BlockStatement")) {
      const d = declares(n);
      if ([...act.keys()].some((k) => d.has(k))) { act = new Map(act); for (const k of d) act.delete(k); }
      if (!act.size) return;
    }
    if (n.type === "Identifier" && act.has(n.name)) {
      const isProp = (parent?.type === "MemberExpression" && key === "property" && !parent.computed)
        || ((parent?.type === "Property" || parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition") && key === "key" && !parent.computed);
      if (!isProp) {
        if (parent?.type === "Property" && parent.shorthand) edits.push([n.start, n.end, `${n.name}: ${act.get(n.name)}`]);
        else edits.push([n.start, n.end, act.get(n.name)]);
      }
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "range" || k === "start" || k === "end") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c?.type && walk(c, act, n, k)); else if (v?.type) walk(v, act, n, k);
    }
  };
  // names already free in the body that equal a target would be captured: give up then
  const text = "(" + src + ")";
  const bodySrc = text.slice(fn.body.start, fn.body.end);
  if (TARGETS.some((t) => new RegExp(`(^|[^\\w$.])${t}([^\\w$]|$)`).test(bodySrc) && !map.has(t))) return null;
  walk(fn.body, map, fn, "body");
  // shorthand properties appear twice in the AST (key and value): keep one edit per position
  const seen = new Set(), uniq = edits.filter(([a]) => !seen.has(a) && seen.add(a)).sort((x, y) => y[0] - x[0]);
  let body = bodySrc;
  for (const [a, b, rep] of uniq) body = body.slice(0, a - fn.body.start) + rep + body.slice(b - fn.body.start);
  return "(function(_$__e)" + body + ")";
}

// webpack's module wrappers among a bundle's function records: values of numeric keys, 1–3 plain params
export const isModuleWrapper = (r) => r.context === "property" && /^\d+$/.test(String(r.propName ?? "")) && r.params?.count >= 1 && r.params.count <= 3 && !r.params.rest && !r.params.defaults && !r.params.destructured;

// Replace each module wrapper record by the record of its rewritten form (fingerprint fields only;
// index, offsets and tree position stay, so source-map attribution is unchanged). Returns the count.
export function canonicalModules(code, records) {
  let n = 0;
  for (const r of records) {
    if (!isModuleWrapper(r) || r.start == null) continue;
    const re = rewriteWrapper(code.slice(r.start, r.end));
    if (!re) continue;
    let out;
    try { out = extractWithFeatures(re, { minLoc: 0 }).records.find((x) => x.depth === 0); } catch { continue; }
    if (!out) continue;
    for (const k of ["type", "bodyType", "hash", "params", "async", "generator", "metrics", "strings", "numbers", "regexes", "properties", "globals", "text", "textNorm", "hashNorm", "rawText"]) if (k in out) r[k] = out[k];
    r.moduleWrapper = true; n++;
  }
  return n;
}
