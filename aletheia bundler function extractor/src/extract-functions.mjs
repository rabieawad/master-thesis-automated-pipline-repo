/**
 * Function collector, modelled on DEBUN's ("Function Collector", Sec. V):
 *
 *   "It extracts functions from JavaScript files by traversing the abstract
 *    syntax tree (AST) ... To avoid redundancy, inner functions are stripped and
 *    split into separate functions."
 *
 *   function f(x) { var y = x.p; return () => y; }
 *     ->  1) function f(x) { var y = x.p; return; }     2) () => y
 *
 * Applied to a pseudo-bundle produced by `build.mjs`:
 *
 *   [prelude]  code outside every `module([...])` wrapper. In swc output this is
 *              where the injected ES5 helpers (`_array_like_to_array`, ...) live.
 *   [module]   one unit per `function(_$__e){...}` wrapper = one source file.
 *              Its text is the file's top-level code with all functions stripped.
 *   [function] every function at any depth, each with its inner functions stripped.
 *
 * Every function of the bundle ends up in exactly one unit.
 *
 * How an inner function is stripped from its parent (so that the parent's text
 * stays valid JavaScript):
 *   - removed:   function declarations, `return <fn>`, call/new arguments,
 *                array elements, `var/let x = <fn>`
 *   - methods, getters, setters, constructors keep their signature and get an
 *     empty body (`m(a){}`), so class/object shapes stay intact
 *   - everything else (`a.b = <fn>`, `{k: <fn>}`, IIFE callee, ...) is replaced
 *     by the literal `0`, so the property name of the write is kept
 *
 * A unit's own text is a plain function (expression) in all cases; for a method
 * the key and kind are in `label`/`kind`.
 */
import * as acorn from "acorn";
import * as astring from "astring";
import crypto from "node:crypto";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const PRETTY = { indent: "  ", lineEnd: "\n" };
const COMPACT = { indent: "", lineEnd: "" };
const ZERO = () => ({ type: "Literal", value: 0, raw: "0" });

export function parseBundle(code) {
    const base = { ecmaVersion: "latest", allowReturnOutsideFunction: true, allowHashBang: true };
    try {
        return acorn.parse(code, { ...base, sourceType: "script" });
    } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        try {
            return acorn.parse(code, { ...base, sourceType: "module", allowImportExportEverywhere: true });
        } catch {
            throw e; // report the script-mode error
        }
    }
}

function* childNodes(node) {
    for (const key of Object.keys(node)) {
        if (key === "type") continue;
        const v = node[key];
        if (!v || typeof v !== "object") continue;
        if (Array.isArray(v)) {
            for (const c of v) if (c && typeof c.type === "string") yield [key, c];
        } else if (typeof v.type === "string") {
            yield [key, v];
        }
    }
}

function countNodes(root) {
    let n = 0;
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        n++;
        for (const [, c] of childNodes(node)) stack.push(c);
    }
    return n;
}

function keyName(member, code) {
    const k = member.key;
    if (!k) return null;
    if (member.computed) return `[${code.slice(k.start, Math.min(k.end, k.start + 40))}]`;
    if (k.type === "Identifier") return k.name;
    if (k.type === "PrivateIdentifier") return `#${k.name}`;
    if (k.type === "Literal") return String(k.value);
    return null;
}

/** What a function is assigned to / called, as far as it is visible in the code. */
function labelFor(node, parent, key, member, code) {
    if (member) {
        const k = keyName(member, code);
        const prefix = [member.static ? "static" : null, member.kind === "get" || member.kind === "set" ? member.kind : null]
            .filter(Boolean)
            .join(" ");
        return [prefix, k].filter(Boolean).join(" ") || null;
    }
    if (!parent) return null;
    if (parent.type === "VariableDeclarator" && key === "init" && parent.id.type === "Identifier") return parent.id.name;
    if (parent.type === "AssignmentExpression" && key === "right") {
        return code.slice(parent.left.start, Math.min(parent.left.end, parent.left.start + 120));
    }
    if ((parent.type === "Property" || parent.type === "PropertyDefinition") && key === "value") return keyName(parent, code);
    return null;
}

function kindOf(node, member) {
    if (node._fileIndex !== undefined) return "module";
    if (member) {
        if (member.kind === "constructor") return "constructor";
        if (member.kind === "get") return "getter";
        if (member.kind === "set") return "setter";
        return "method";
    }
    if (node.type === "FunctionDeclaration") return "declaration";
    if (node.type === "ArrowFunctionExpression") return "arrow";
    return "expression";
}

/** Take a (fully processed) function unit out of its parent's AST. */
function detach(u) {
    const { node, parent, key } = u;
    if (!parent) return;

    if (u.member) {
        node.body = { type: "BlockStatement", body: [] };
        return;
    }

    const slot = parent[key];
    if (Array.isArray(slot)) {
        const i = slot.indexOf(node);
        if (i < 0) return;
        const removable =
            node.type === "FunctionDeclaration" ||
            ((parent.type === "CallExpression" || parent.type === "NewExpression") && key === "arguments") ||
            (parent.type === "ArrayExpression" && key === "elements");
        if (removable) slot.splice(i, 1);
        else slot[i] = ZERO();
        return;
    }

    if (node.type === "FunctionDeclaration") {
        if (parent.type === "ExportNamedDeclaration") {
            parent.declaration = null;
            parent.specifiers = parent.specifiers ?? [];
        } else if (parent.type === "ExportDefaultDeclaration") {
            parent.declaration = ZERO();
        } else {
            parent[key] = { type: "EmptyStatement" };
        }
    } else if (parent.type === "ReturnStatement" && key === "argument") {
        parent.argument = null;
    } else if (parent.type === "VariableDeclarator" && key === "init" && (parent._dk === "var" || parent._dk === "let")) {
        parent.init = null;
    } else {
        parent[key] = ZERO();
    }
}

const shortHash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Parseable form of a unit's text, for --verify. Function expressions need
 * parentheses; methods/getters/setters/constructors are put back into a class
 * so that `super` is legal.
 */
function verifiable(rec) {
    if (rec.kind === "declaration" || rec.kind === "prelude") return rec.text;
    const prefix = { method: "m", getter: "get m", setter: "set m", constructor: "constructor" }[rec.kind];
    if (prefix) {
        const sig = rec.text.replace(/^(async\s+)?function\s*(\*)?\s*/, (_, a, g) => `${a ?? ""}${g ?? ""}`);
        const asyncStar = /^(async\s*)?(\*)?/.exec(sig)[0];
        return `(class extends Object{${asyncStar}${prefix}${sig.slice(asyncStar.length)}})`;
    }
    return `(${rec.text})`;
}

/**
 * @param {string} code  minified pseudo-bundle
 * @param {object} [opts]
 * @param {number}  [opts.minLoc=6]   keep units whose pretty-printed text has at least this many lines
 *                                    (DEBUN: "line of code greater than five"); 0 keeps everything
 * @param {"pretty"|"compact"} [opts.textMode="pretty"]
 * @param {boolean} [opts.dropHelpers=false] drop everything outside the module wrappers (swc helpers)
 * @param {boolean} [opts.includeText=true]
 * @param {boolean} [opts.verify=false]      re-parse every kept unit and flag the ones that do not parse
 */
export function extractFunctions(code, opts = {}) {
    const { minLoc = 6, textMode = "pretty", dropHelpers = false, includeText = true, verify = false } = opts;
    const ast = parseBundle(code);

    // ---- locate the `module([ ...wrappers ])` call -------------------------
    for (const st of ast.body) {
        const e = st.type === "ExpressionStatement" ? st.expression : null;
        if (e?.type === "CallExpression" && e.callee.type === "Identifier" && e.callee.name === "module" && e.arguments[0]?.type === "ArrayExpression") {
            st._isModuleCall = true;
            e.arguments[0].elements.forEach((el, i) => {
                if (el && FUNCTION_TYPES.has(el.type)) el._fileIndex = i;
            });
        }
    }

    // ---- 1. collect: iterative DFS, no AST changes yet ---------------------
    const root = { isRoot: true, file: -1, depth: -1, inner: [] };
    const units = [];
    const post = []; // children before parents
    const stack = [{ visit: ast, owner: root, parent: null, key: null }];
    while (stack.length) {
        const f = stack.pop();
        if (f.finish) {
            post.push(f.finish);
            continue;
        }
        const node = f.visit;
        let owner = f.owner;
        if (node.type === "VariableDeclaration") for (const d of node.declarations) d._dk = node.kind;
        if (FUNCTION_TYPES.has(node.type)) {
            const p = f.parent;
            const member =
                p && f.key === "value" && (p.type === "MethodDefinition" || (p.type === "Property" && (p.method || p.kind === "get" || p.kind === "set")))
                    ? p
                    : null;
            const u = {
                node,
                parent: p,
                key: f.key,
                member,
                owner,
                inner: [],
                start: node.start,
                end: node.end,
                depth: owner.depth + 1,
                file: node._fileIndex ?? owner.file,
                kind: kindOf(node, member),
                name: node.id?.name ?? null,
                label: labelFor(node, p, f.key, member, code),
            };
            owner.inner.push(u);
            units.push(u);
            stack.push({ finish: u });
            owner = u;
        }
        for (const [key, child] of childNodes(node)) stack.push({ visit: child, owner, parent: node, key });
    }

    // ---- 2. strip + print, innermost first ----------------------------------
    const render = (u, node) => {
        u.nodes = countNodes(node);
        const pretty = astring.generate(node, PRETTY);
        u.loc = pretty.split("\n").length;
        u.text = textMode === "compact" ? astring.generate(node, COMPACT) : pretty;
    };
    for (const u of post) {
        render(u, u.node);
        detach(u);
    }

    // code outside every function (and outside the module(...) call)
    ast.body = ast.body.filter((s) => !s._isModuleCall);
    if (ast.body.length > 0) {
        const u = { node: ast, parent: null, owner: root, inner: [], start: 0, end: code.length, depth: 0, file: -1, kind: "prelude", name: null, label: null, isPrelude: true };
        render(u, ast);
        units.push(u);
    }

    // ---- 3. ids in source order, records ------------------------------------
    units.sort((a, b) => (a.isPrelude ? -1 : b.isPrelude ? 1 : a.start - b.start));
    let n = 0;
    for (const u of units) u.id = u.isPrelude ? "top" : `f${n++}`;

    const stats = { total: units.length, kept: 0, droppedOutsideWrappers: 0, skippedMinLoc: 0, byKind: Object.create(null), invalid: 0 };
    const records = [];
    for (const u of units) {
        if (dropHelpers && u.file === -1) {
            stats.droppedOutsideWrappers++;
            continue;
        }
        if (u.loc < minLoc) {
            stats.skippedMinLoc++;
            continue;
        }
        const rec = {
            id: u.id,
            parent: u.owner.isRoot ? null : u.owner.id,
            depth: u.depth,
            kind: u.kind,
            file: u.file,
            outside: u.file === -1,
            name: u.name,
            label: u.label,
            start: u.start,
            end: u.end,
            nodes: u.nodes,
            loc: u.loc,
            bytes: Buffer.byteLength(u.text),
            hash: shortHash(u.text),
            inner: u.inner.map((c) => c.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
            text: u.text,
        };
        if (verify) {
            try {
                acorn.parse(verifiable(rec), { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
            } catch (e) {
                rec.invalid = String(e.message);
                stats.invalid++;
            }
        }
        if (!includeText) delete rec.text;
        records.push(rec);
        stats.kept++;
        stats.byKind[rec.kind] = (stats.byKind[rec.kind] ?? 0) + 1;
    }
    return { records, stats };
}
