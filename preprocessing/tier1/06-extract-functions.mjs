// v2 of step 06: the DEBUN collector below is unchanged; per-function data that survives minification is added at the end of the file.
/**
 * Function collector — a line-for-line JavaScript port of DEBUN's
 * `src/fingerprint-collector/function-collector.ts`
 * (https://github.com/ku-plrg/debun-ase25), plus one addition: a configurable
 * line-of-code filter.
 *
 * Extraction (identical to the repo):
 *   - parse with meriyah 7.0.0 (`next: true`), trying sourceType 'script', then
 *     'module', then 'commonjs' — the order used by debun-main's function-collector.ts
 *     (one further fallback — acorn-loose — is used only if meriyah cannot parse the
 *     bundle at all, so a single odd bundle is not a hard failure; see collectFunctions)
 *   - every function (declaration, expression, arrow) with a body is recorded,
 *     innermost first, with its own inner functions stripped:
 *       * functions inside a function's parameter list (default values such as
 *         `function g(a = () => 1)`) are recorded too, right after that function,
 *         and stubbed in its signature — as debun-main's estree-walker strip does,
 *         since the walker descends into the stub's `params` after replacing it
 *       * a declaration / expression keeps its own signature (name, params, async,
 *         generator) and only has its body emptied (`function f(a) {}`)
 *       * an arrow with a block body keeps its params and is emptied the same way;
 *         an arrow with an expression body has that expression replaced by `_`
 *       nothing else is removed (this is DEBUN's `{...node, body: emptyBody}` strip)
 *   - a recorded block body is wrapped in one extra BlockStatement, and an arrow
 *     with an expression body keeps its expression body, exactly as the repo does
 *   - `id` is the first `JSCA_...` string found in the body (only used by the
 *     repo's RQ3 evaluation; '' otherwise)
 *
 * Line filter (the paper: "we collect fingerprints of functions whose line of
 * code is greater than five"):
 *   - LOC is measured as in the repo's RQ3 ablation (Table IV, "LOC >= 6"):
 *     `escodegen.generate(record.body).split('\n').length` (escodegen 2.1.0)
 *   - functions with LOC < minLoc are skipped; minLoc = 6 means "greater than five"
 *   - the paper describes this filter for the library database only, applied to
 *     library code. Use `minLoc: 0` for website bundles. (`minLoc: 0` also
 *     reproduces the repo's database code, whose LOC filter has no effect.)
 */
import { parse } from "meriyah";
import * as loose from "acorn-loose";
import escodegen from "escodegen";

const FUNC_ID = true;
let functions = [];
let preStripHook = null; // v2: set by extractWithFeatures()

function recordFunction(node) {
    if (!node.body) return;
    const body = stripFunctions(node.body);
    if (FUNC_ID) {
        if (node.type === "ArrowFunctionExpression" && node.expression)
            functions.push({
                node,
                id: getId(body),
                body: {
                    ...node,
                    body: body,
                },
            });
        else
            functions.push({
                node,
                id: getId(body),
                body: {
                    ...node,
                    body: {
                        type: "BlockStatement",
                        body: [body],
                    },
                },
            });
        return;
    }

    functions.push({
        body,
    });
}

function stripFunctions(node) {
    if (!node) return node;

    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
        if (!node.body) return node;
        recordFunction(node);

        // DEBUN-faithful strip: keep the function node (id, params, async, generator)
        // and only empty its body. Declarations stay named declarations; an arrow with an
        // expression body collapses to `_`. This is the stub the current file leaves behind
        // in the parent, so the parent's emitted text/hash are unchanged.
        const stub = node.type === "ArrowFunctionExpression" && node.expression
            ? { ...node, body: { type: "Identifier", name: "_" } }
            : { ...node, body: { type: "BlockStatement", body: [] } };

        // debun-main parity: estree-walker keeps walking the replacement node, so
        // functions in the parameter list (default values, destructuring defaults)
        // are recorded after this function and stubbed in place. The params array
        // is shared with `node`, exactly as with the walker's in-place replace.
        if (Array.isArray(stub.params)) {
            for (let i = 0; i < stub.params.length; i++) {
                if (stub.params[i] && typeof stub.params[i] === "object") stub.params[i] = stripFunctions(stub.params[i]);
            }
        }
        return stub;
    }

    // Process all child nodes
    Object.entries(node).forEach(([key, value]) => {
        if (value && typeof value === "object") {
            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                    if (value[i] && typeof value[i] === "object") {
                        value[i] = stripFunctions(value[i]);
                    }
                }
            } else {
                node[key] = stripFunctions(value);
            }
        }
    });

    return node;
}

// The repo's `utils/walk.ts`
function walk(node, visitors) {
    const visit = visitors[node.type];
    if (visit) visit(node);

    for (const key in node) {
        const value = node[key];
        if (key === "type") continue;

        if (Array.isArray(value)) {
            const len = value.length;
            for (let i = 0; i < len; i++) {
                const child = value[i];
                if (child?.type) walk(child, visitors);
            }
        } else if (value?.type) {
            walk(value, visitors);
        }
    }
}

// check if JSCA_ id symbol is injected in the function body
function getId(node) {
    let value;
    walk(node, {
        CallExpression(node) {
            if (
                node.type === "CallExpression" &&
                node.callee.type === "Identifier" &&
                node.callee.name === "Symbol" &&
                node.arguments.length > 0 &&
                node.arguments[0].type === "Literal" &&
                typeof node.arguments[0].value === "string"
            ) {
                const symbolValue = node.arguments[0].value;
                if (value === undefined && symbolValue.startsWith("JSCA_")) {
                    value = symbolValue;
                }
            }
        },
        TemplateLiteral(node) {
            if (node.type !== "TemplateLiteral") return;
            const templateValue = node.quasis[0]?.value.raw;
            if (value === undefined && templateValue.startsWith("JSCA_")) {
                value = templateValue;
            }
        },
        Literal(node) {
            if (node.type === "Literal" && value === undefined && typeof node.value === "string" && node.value.startsWith("JSCA_")) {
                value = node.value;
            }
        },
    });
    return value || "";
}

/** Exactly the repo's `extractFunctions`: every function, no filtering. */
export function collectFunctions(code) {
    functions = [];
    let ast;
    // debun-main order: script, module, commonjs (meriyah 7 `sourceType`).
    // `ranges: true` is ours (v2 start/end offsets); it does not change the AST shape.
    for (const sourceType of ["script", "module", "commonjs"]) {
        try {
            ast = parse(code, {
                next: true,
                sourceType,
                ranges: true,
            });
            break;
        } catch (e) {
            // try the next source type
        }
    }
    if (!ast) {
        // Tolerant fallback (acorn-loose never throws): a single bundle meriyah can't
        // parse at all (modern syntax, a stray shebang, non-JS that slipped in) is
        // extracted best-effort instead of failing the whole bundle. Not part of the
        // DEBUN port — only reached when all three meriyah attempts have already failed.
        ast = loose.parse(code, { ecmaVersion: "latest", sourceType: "module", ranges: true });
    }
    if (preStripHook) preStripHook(ast); // v2: function context is read before inner functions are stripped
    stripFunctions(ast);

    return functions;
}

/** LOC as in the current file: the line count of the emitted body text (the stripped body
 *  the `text` field is printed from), not the extra-wrapped function node. Keeping this in
 *  step with `text` means `loc === text.split("\n").length` and that min-LOC filtering uses
 *  the same number the current file does. */
export function countLoc(fn) {
    return escodegen.generate(printedNode(fn)).split("\n").length;
}

/**
 * Repo extraction + the paper's line filter.
 *
 * @param {string} code
 * @param {object} [opts]
 * @param {number} [opts.minLoc=6]  keep functions with LOC >= minLoc (6 = the paper's
 *                                  "greater than five"); 0 keeps everything
 * @returns {{ functions: Array<{id: string, body: object, loc: number|null}>,
 *             stats: { total: number, kept: number, skippedMinLoc: number, locErrors: number } }}
 *   `functions` are in the repo's order (inner functions before their parent);
 *   each `body` is the AST the repo passes on to the POG generator.
 */
export function extractFunctions(code, opts = {}) {
    const { minLoc = 6 } = opts;
    const all = collectFunctions(code);
    const kept = [];
    let skippedMinLoc = 0;
    let locErrors = 0;
    for (const fn of all) {
        let loc = null;
        try {
            loc = countLoc(fn);
        } catch {
            locErrors++; // escodegen cannot print this syntax: keep the function, LOC unknown
        }
        if (loc !== null && loc < minLoc) {
            skippedMinLoc++;
            continue;
        }
        kept.push({ ...fn, loc });
    }
    return { functions: kept, stats: { total: all.length, kept: kept.length, skippedMinLoc, locErrors } };
}

export default extractFunctions;

// ===========================================================================
// v2: extra per-function data that survives minification.
//
// Everything above is the DEBUN collector; v2 only (a) records which AST node each function came from,
// (b) reads that node's context once before inner functions are stripped, and (c) parses with `ranges: true`
// so each function knows its byte offsets. The set of functions, their order and `text`/`hash` are the same
// as before.
//
// What minification (terser: mangle + compress) does to the data, and therefore what is added:
//   - local names are renamed (a, b, c...)      -> no binding names; `textNorm` renames every locally
//                                                  declared name to v0, v1... so mangled and unmangled code agree
//   - property names, string/number/regex       -> kept as lists: `properties`, `strings`, `numbers`, `regexes`
//     literals and true globals survive            and `globals` (identifiers declared nowhere in the bundle)
//   - nesting, parameter counts, where a         -> `depth`, `parentIndex`, `children`, `context`, `propName`,
//     function sits (callback, method, IIFE)       `params`, `async`, `generator`, `isIIFE`
//     mostly survive
//   - compress rewrites statements (if -> &&,    -> `metrics` are coarse counts, useful but not exact across
//     inlining, dead code removal)                 minified / unminified versions
// ===========================================================================

const FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const isFn = (n) => !!n && FN_TYPES.has(n.type);
const SKIP_KEYS = new Set(["type", "start", "end", "range", "loc"]);
const CAP = { strings: 50, numbers: 50, regexes: 20, properties: 100, globals: 50, strLen: 200 };

function eachChild(node, cb) {
    for (const key in node) {
        if (SKIP_KEYS.has(key)) continue;
        const v = node[key];
        if (Array.isArray(v)) {
            for (const c of v) if (c && typeof c.type === "string") cb(c, key);
        } else if (v && typeof v.type === "string") cb(v, key);
    }
}

function patternNames(p, out) {
    if (!p) return;
    switch (p.type) {
        case "Identifier": out.add(p.name); break;
        case "ObjectPattern": for (const q of p.properties) patternNames(q.type === "RestElement" ? q.argument : q.value, out); break;
        case "ArrayPattern": for (const q of p.elements) patternNames(q, out); break;
        case "AssignmentPattern": patternNames(p.left, out); break;
        case "RestElement": patternNames(p.argument, out); break;
    }
}

function keyName(key, computed) {
    if (!key || computed) return null;
    if (key.type === "Identifier") return key.name;
    if (key.type === "PrivateIdentifier") return "#" + key.name;
    if (key.type === "Literal" && (typeof key.value === "string" || typeof key.value === "number")) return String(key.value);
    return null;
}

/** Is this Identifier a variable reference/binding (renamable), rather than a property key or label? */
function isVariableIdentifier(parent, key) {
    if (!parent) return true;
    switch (parent.type) {
        case "MemberExpression": return !(key === "property" && !parent.computed);
        case "Property": case "MethodDefinition": case "PropertyDefinition": case "AccessorProperty":
            return !(key === "key" && !parent.computed);
        case "LabeledStatement": case "BreakStatement": case "ContinueStatement": return key !== "label";
        case "MetaProperty": return false;
        case "ImportSpecifier": return key !== "imported";
        case "ExportSpecifier": return key !== "exported";
        default: return true;
    }
}

/** Where a function sits, read from its parent AST node. */
function functionContext(fn, parent, key, grand) {
    const c = { context: parent ? parent.type : "Program", propName: null, isIIFE: false };
    if (fn.type === "FunctionDeclaration") { c.context = parent && parent.type.startsWith("Export") ? "export" : "declaration"; return c; }
    if (!parent) return c;
    switch (parent.type) {
        case "CallExpression": case "NewExpression":
            if (key === "callee") { c.context = "iife"; c.isIIFE = true; } else c.context = "callback";
            break;
        case "MemberExpression": // (function(){}).call(this) and friends
            if (key === "object" && grand && grand.type === "CallExpression") { c.context = "iife"; c.isIIFE = true; } else c.context = "member";
            break;
        case "VariableDeclarator": c.context = "variable"; break;
        case "Property":
            c.context = parent.kind === "get" ? "getter" : parent.kind === "set" ? "setter" : parent.method ? "method" : "property";
            c.propName = keyName(parent.key, parent.computed);
            break;
        case "MethodDefinition":
            c.context = "class-" + parent.kind; // class-constructor | class-method | class-get | class-set
            c.propName = keyName(parent.key, parent.computed);
            break;
        case "PropertyDefinition": case "AccessorProperty":
            c.context = "class-field"; c.propName = keyName(parent.key, parent.computed); break;
        case "AssignmentExpression": {
            const l = parent.left;
            c.context = "assignment";
            if (l && l.type === "MemberExpression") {
                c.propName = keyName(l.property, l.computed);
                if (l.object && l.object.type === "MemberExpression" && keyName(l.object.property, l.object.computed) === "prototype")
                    c.context = "prototype-assignment";
            }
            break;
        }
        case "ReturnStatement": c.context = "return"; break;
        case "ExportDefaultDeclaration": case "ExportNamedDeclaration": c.context = "export"; break;
        case "ArrayExpression": c.context = "array-element"; break;
        case "ConditionalExpression": case "LogicalExpression": case "SequenceExpression": c.context = "expression"; break;
    }
    return c;
}

/**
 * One pass over the untouched AST: every function's depth, enclosing function, number of direct inner
 * functions, context, and the set of all names declared anywhere in the bundle.
 */
function analyseProgram(ast) {
    const info = new Map(); // function node -> {...}
    const declared = new Set();
    const visit = (node, parent, key, grand, fnStack) => {
        switch (node.type) {
            case "VariableDeclarator": patternNames(node.id, declared); break;
            case "FunctionDeclaration": case "FunctionExpression": case "ClassDeclaration": case "ClassExpression":
                if (node.id) declared.add(node.id.name); break;
            case "CatchClause": patternNames(node.param, declared); break;
            case "ImportSpecifier": case "ImportDefaultSpecifier": case "ImportNamespaceSpecifier": declared.add(node.local.name); break;
        }
        let stack = fnStack;
        if (isFn(node)) {
            for (const p of node.params) patternNames(p, declared);
            const parentFn = fnStack.length ? fnStack[fnStack.length - 1] : null;
            if (parentFn) info.get(parentFn).children++;
            info.set(node, { depth: fnStack.length, parentFn, children: 0, ...functionContext(node, parent, key, grand) });
            stack = [...fnStack, node];
        }
        eachChild(node, (child, k) => visit(child, node, k, parent, stack));
    };
    visit(ast, null, null, null, []);
    return { info, declared };
}

/** The node the old `text` was printed from: the stripped body, without the wrapper the collector adds. */
function printedNode(fn) {
    return fn.node.type === "ArrowFunctionExpression" && fn.node.expression ? fn.body.body : fn.body.body.body[0];
}

const NOISE_NUMBERS = new Set([0, 1, -1]);
const CYCLO = new Set(["IfStatement", "ConditionalExpression", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "CatchClause"]);
const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);

/** Minification-robust content features of one stripped function (inner functions are already empty stubs). */
function bodyFeatures(root, declared) {
    const m = { nodes: 0, statements: 0, cyclomatic: 1, loops: 0, calls: 0, news: 0, returns: 0, throws: 0, awaits: 0, yields: 0, thisRefs: 0, innerStubs: 0 };
    const strings = new Set(), numbers = new Set(), regexes = new Set(), properties = new Set(), globals = new Set();
    const add = (set, v, cap) => { if (set.size < cap) set.add(v); };
    const visit = (node, parent, key) => {
        m.nodes++;
        const t = node.type;
        if (t.endsWith("Statement") || t.endsWith("Declaration")) m.statements++;
        if (CYCLO.has(t) || (t === "SwitchCase" && node.test) || (t === "LogicalExpression")) m.cyclomatic++;
        if (LOOPS.has(t)) m.loops++;
        if (node !== root && isFn(node)) m.innerStubs++;
        switch (t) {
            case "CallExpression": m.calls++; break;
            case "NewExpression": m.news++; break;
            case "ReturnStatement": m.returns++; break;
            case "ThrowStatement": m.throws++; break;
            case "AwaitExpression": m.awaits++; break;
            case "YieldExpression": m.yields++; break;
            case "ThisExpression": m.thisRefs++; break;
            case "Literal":
                if (node.regex) add(regexes, `/${node.regex.pattern}/${node.regex.flags}`, CAP.regexes);
                else if (typeof node.value === "string") { if (parent && key === "key" && !parent.computed) break; if (node.value.length) add(strings, node.value.slice(0, CAP.strLen), CAP.strings); }
                else if (typeof node.value === "number" && !NOISE_NUMBERS.has(node.value)) add(numbers, node.value, CAP.numbers);
                break;
            case "TemplateElement": { const s = node.value && (node.value.cooked ?? node.value.raw); if (s) add(strings, s.slice(0, CAP.strLen), CAP.strings); break; }
            case "MemberExpression": { const n = keyName(node.property, node.computed); if (n) add(properties, n, CAP.properties); break; }
            case "Property": case "MethodDefinition": case "PropertyDefinition": { const n = keyName(node.key, node.computed); if (n) add(properties, n, CAP.properties); break; }
            case "Identifier":
                if (isVariableIdentifier(parent, key) && !declared.has(node.name)) add(globals, node.name, CAP.globals);
                break;
        }
        eachChild(node, (c, k) => visit(c, node, k));
    };
    visit(root, null, null);
    return { metrics: m, strings: [...strings], numbers: [...numbers], regexes: [...regexes], properties: [...properties].sort(), globals: [...globals].sort() };
}

/** Copy of a subtree with every bundle-declared name renamed v0, v1, ... in order of first appearance. */
function normalizeNames(root, declared) {
    const map = new Map();
    const copy = (node, parent, key) => {
        if (Array.isArray(node)) return node.map((n) => (n && typeof n === "object" ? copy(n, parent, key) : n));
        if (!node || typeof node !== "object") return node;
        const out = {};
        for (const k in node) {
            const v = node[k];
            out[k] = v && typeof v === "object" && !SKIP_KEYS.has(k) ? copy(v, node, k) : v;
        }
        if (out.type === "Identifier" && isVariableIdentifier(parent, key) && declared.has(out.name)) {
            if (!map.has(out.name)) map.set(out.name, "v" + map.size);
            out.name = map.get(out.name);
        }
        if (out.type === "Property" && out.shorthand) out.shorthand = false; // `{a}` -> `{a: v0}`
        return out;
    };
    return copy(root, null, null);
}

const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Collector + v2 data for one bundle.
 * @returns {{ records: object[], stats: object }}
 */
export function extractWithFeatures(code, opts = {}) {
    const { minLoc = 0, includeText = true, includeNorm = true } = opts;
    let analysis = null;
    preStripHook = (ast) => { analysis = analyseProgram(ast); };
    let res;
    try { res = extractFunctions(code, { minLoc }); } finally { preStripHook = null; }
    const { info, declared } = analysis;
    const keptIndex = new Map(res.functions.map((fn, i) => [fn.node, i]));
    let unprintable = 0;
    const records = res.functions.map((fn, index) => {
        const ctx = info.get(fn.node) || { depth: null, parentFn: null, children: 0, context: null, propName: null, isIIFE: false };
        let p = ctx.parentFn; // nearest enclosing function that was kept
        while (p && !keptIndex.has(p)) p = info.get(p)?.parentFn ?? null;
        const node = printedNode(fn);
        let text = null;
        try { text = escodegen.generate(node); } catch { unprintable++; }
        const params = fn.node.params || [];
        const rec = {
            index, id: fn.id, type: fn.body.type, bodyType: node ? node.type : null, loc: fn.loc,
            hash: text === null ? null : sha16(text),
            depth: ctx.depth, parentIndex: p ? keptIndex.get(p) : -1, children: ctx.children,
            context: ctx.context, propName: ctx.propName, isIIFE: ctx.isIIFE,
            async: !!fn.node.async, generator: !!fn.node.generator,
            params: {
                count: params.length,
                rest: params.some((q) => q.type === "RestElement"),
                defaults: params.filter((q) => q.type === "AssignmentPattern").length,
                destructured: params.some((q) => q.type === "ObjectPattern" || q.type === "ArrayPattern" || (q.type === "AssignmentPattern" && q.left.type !== "Identifier")),
            },
            start: fn.node.start ?? null, end: fn.node.end ?? null,
            ...bodyFeatures(node, declared),
        };
        if (includeText) {
            rec.text = text;
            // escodegen 2.1.0 cannot print some newer syntax: keep the original source so the function is not lost
            if (text === null && rec.start != null) rec.rawText = code.slice(rec.start, rec.end);
        }
        if (includeNorm) {
            let norm = null;
            try { norm = escodegen.generate(normalizeNames(node, declared)); } catch { /* same syntax limit as text */ }
            if (includeText) rec.textNorm = norm;
            rec.hashNorm = norm === null ? null : sha16(norm);
        }
        return rec;
    });
    return { records, stats: { ...res.stats, unprintable, declaredNames: declared.size, bytes: Buffer.byteLength(code) } };
}

// ---------------------------------------------------------------------------
// Command line (pipeline step 06, v2). Same folders and file names as v1.
//
//   node 06-extract-functions.mjs [bundlesDir=bundles] [outDir=extracted-functions] [--min-loc 0] [--no-text] [--no-norm]
//
// Example (the folders the pipeline uses):
//   node 06-extract-functions.mjs output/05_selected_bundles/bundles output/06_extracted_functions
//
// For every <name>@<version>.min.js (or .js) in bundlesDir it writes <outDir>/<name>@<version>.functions.json:
//   { bundle, version: 2, stats, functions: [ {
//       index, id, type, bodyType, loc, hash, text,        <- as in v1 (text = stripped body)
//       depth            0 = not inside another function
//       parentIndex      index of the nearest enclosing kept function, -1 if none
//       children         number of inner functions that were stripped out of this one
//       context          declaration | export | variable | callback | iife | method | property | getter | setter |
//                        class-constructor | class-method | class-get | class-set | class-field | assignment |
//                        prototype-assignment | return | array-element | expression | member | <AST type>
//       propName         property / method name the function is stored under (survives minification), or null
//       isIIFE, async, generator, params {count, rest, defaults, destructured}
//       start, end       byte offsets in the bundle
//       metrics          {nodes, statements, cyclomatic, loops, calls, news, returns, throws, awaits, yields,
//                         thisRefs, innerStubs}
//       strings, numbers, regexes, properties, globals      literal and name lists that minifiers keep
//       textNorm, hashNorm   text with every bundle-declared name renamed v0, v1, ... (mangling-invariant)
//       rawText          only when escodegen cannot print the function: its original source
//   } ] }
// plus summary.csv as in v1. Empty bundles (EMPTY) and bundles with no functions (NO_FUNCTIONS) are listed
// in summary.csv instead of writing empty files; unparsable bundles (FAIL) are listed and the run goes on.
// --no-text leaves out text/textNorm/rawText; --no-norm skips textNorm/hashNorm.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

async function cli() {
    const args = process.argv.slice(2);
    const option = (name, fallback) => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : fallback;
    };
    const minLoc = Number(option("--min-loc", 0));
    const includeText = !args.includes("--no-text");
    const includeNorm = !args.includes("--no-norm");
    const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--min-loc");
    const bundlesDir = resolve(positional[0] ?? "bundles");
    const outDir = resolve(positional[1] ?? "extracted-functions");

    if (!existsSync(bundlesDir)) {
        console.error(`Bundles folder not found: ${bundlesDir}  (run step 05 first)`);
        process.exit(1);
    }
    mkdirSync(outDir, { recursive: true });
    const files = readdirSync(bundlesDir).filter((f) => f.endsWith(".js")).sort();
    const csvCell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));
    const rows = [];
    const started = Date.now();

    for (const [i, file] of files.entries()) {
        const key = file.replace(/\.min\.js$|\.js$/, "");
        const code = readFileSync(join(bundlesDir, file), "utf8");
        let line;
        if (!code.trim()) {
            rows.push([key, "EMPTY", "", "", "", 0, "empty bundle"]);
            console.log(`[${i + 1}/${files.length}] EMPTY ${key}`);
            continue;
        }
        try {
            const { records, stats } = extractWithFeatures(code, { minLoc, includeText, includeNorm });
            if (records.length === 0) {
                // Parsed fine but held no functions: list it in summary.csv instead of writing an empty file.
                rows.push([key, "NO_FUNCTIONS", stats.kept, stats.total, stats.skippedMinLoc, stats.bytes, ""]);
                line = `NO_FUNCTIONS ${key}  (0 of ${stats.total})`;
            } else {
                writeFileSync(join(outDir, `${key}.functions.json`), JSON.stringify({ bundle: file, version: 2, stats, functions: records }));
                rows.push([key, "ok", stats.kept, stats.total, stats.skippedMinLoc, stats.bytes, ""]);
                line = `ok    ${key}  (${stats.kept} functions kept of ${stats.total}${stats.unprintable ? `, ${stats.unprintable} kept as rawText` : ""})`;
            }
        } catch (e) {
            rows.push([key, "FAIL", "", "", "", Buffer.byteLength(code), String(e.message).slice(0, 200)]);
            line = `FAIL  ${key}  -> ${String(e.message).slice(0, 200)}`;
        }
        console.log(`[${i + 1}/${files.length}] ${line}  (${((Date.now() - started) / 60000).toFixed(1)} min)`);
    }

    writeFileSync(
        join(outDir, "summary.csv"),
        "bundle,status,functions_kept,units_total,skipped_too_short,bundle_bytes,error\n" + rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n",
    );
    const bad = rows.filter((r) => r[1] !== "ok").length;
    console.log(`\nDone. ok=${rows.length - bad}  empty/failed/no-functions=${bad}  (see ${join(outDir, "summary.csv")})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await cli();
