/**
 * Pseudo-bundling + minification, after Aletheia's `aletheia-preprocessor.mjs`.
 *
 * Every selected file becomes `(function(_$__e){ <code> })`, all wrappers are
 * collected in one array `module([ ... ])`, and the result is minified with
 * swc (`minify: true`, `compress.unsafe: true`). ESM import statements are
 * rewritten to `require()`. The output is not runnable; it only has to look
 * like what a real bundler emits so that it can be compared with real bundles.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as swc from "@swc/core";
import * as walk from "acorn-walk";
import * as astring from "astring";
import * as acorn from "acorn";
import { parseLoose } from "./parse.mjs";
import { selectFiles } from "./select-files.mjs";

const EMPTY_WRAPPER = "(function(_$__e){\n})";

const requireCall = (source) => ({
    type: "CallExpression",
    callee: { type: "Identifier", name: "require" },
    arguments: [source],
});

/** Names bound by a declaration pattern (identifier, {a, b: [c]}, ...). */
function boundNames(pattern, out = []) {
    if (!pattern) return out;
    switch (pattern.type) {
        case "Identifier":
            out.push(pattern.name);
            break;
        case "ObjectPattern":
            pattern.properties.forEach((p) => boundNames(p.type === "RestElement" ? p.argument : p.value, out));
            break;
        case "ArrayPattern":
            pattern.elements.forEach((e) => boundNames(e, out));
            break;
        case "AssignmentPattern":
            boundNames(pattern.left, out);
            break;
        case "RestElement":
            boundNames(pattern.argument, out);
            break;
    }
    return out;
}

const nameOf = (n) => (n.type === "Identifier" ? n.name : String(n.value));
const prop = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? `_$__e.${name}` : `_$__e[${JSON.stringify(name)}]`);

/**
 * ESM export -> CommonJS-style assignments on the module object `_$__e`.
 * The assignments keep the exported code reachable, otherwise the minifier
 * would delete it as dead code.
 */
function rewriteExport(node, code) {
    const text = (n) => code.slice(n.start, n.end);

    if (node.type === "ExportDefaultDeclaration") {
        // `export default function f(){}` / `class A{}` / any expression
        return `_$__e.exports=${text(node.declaration)};`;
    }

    if (node.type === "ExportAllDeclaration") {
        const req = astring.generate(requireCall(node.source));
        return node.exported ? `${prop(nameOf(node.exported))}=${req};` : `Object.assign(_$__e,${req});`;
    }

    // ExportNamedDeclaration
    if (node.declaration) {
        const d = node.declaration;
        const names =
            d.type === "VariableDeclaration"
                ? d.declarations.flatMap((x) => boundNames(x.id))
                : d.id
                  ? [d.id.name]
                  : [];
        return text(d) + "\n" + names.map((n) => `${prop(n)}=${n};`).join("");
    }
    if (node.source) {
        const req = astring.generate(requireCall(node.source));
        return node.specifiers
            .map((sp) => `${prop(nameOf(sp.exported))}=${req}${/^[A-Za-z_$][\w$]*$/.test(nameOf(sp.local)) ? "." + nameOf(sp.local) : `[${JSON.stringify(nameOf(sp.local))}]`};`)
            .join("");
    }
    return node.specifiers.map((sp) => `${prop(nameOf(sp.exported))}=${nameOf(sp.local)};`).join("");
}

/**
 * Rewrite ESM import/export statements.
 *
 * exportsMode "strip" (what Aletheia's original code does): every export
 *   statement is deleted, including the declaration it carries
 *   (`export function f(){}` disappears completely, so pure-ESM packages
 *   such as arrify end up empty).
 * exportsMode "keep" (default here): exports become assignments on the module
 *   object, like a CommonJS module: `export function f(){}` -> `function f(){}
 *   _$__e.f=f;`, `export default x` -> `_$__e.exports=x;`, `export {a as b}` ->
 *   `_$__e.b=a;`, re-exports go through `require()`.
 */
export function rewriteImports(code, exportsMode = "keep") {
    const ast = parseLoose(code);
    const nodes = [];
    walk.simple(ast, {
        Statement(node) {
            if (
                node.type === "ImportDeclaration" ||
                node.type === "ExportNamedDeclaration" ||
                node.type === "ExportDefaultDeclaration" ||
                node.type === "ExportAllDeclaration"
            ) {
                nodes.push(node);
            }
        },
    });

    // replace from the back so earlier offsets stay valid
    nodes.sort((a, b) => b.start - a.start);

    for (const node of nodes) {
        let replacement = "";

        if (node.type === "ImportDeclaration") {
            const ns = node.specifiers.filter((s) => s.type === "ImportNamespaceSpecifier");
            const named = node.specifiers.filter((s) => s.type !== "ImportNamespaceSpecifier");
            const decls = [];
            if (ns.length > 0) {
                decls.push({ type: "VariableDeclarator", id: ns[0].local, init: requireCall(node.source) });
            }
            if (named.length > 0) {
                decls.push({
                    type: "VariableDeclarator",
                    init: requireCall(node.source),
                    id: {
                        type: "ObjectPattern",
                        properties: named.map((s) => ({
                            type: "Property",
                            method: false,
                            shorthand: false,
                            computed: false,
                            kind: "init",
                            key: s.imported ?? { type: "Identifier", name: "default" },
                            value: s.local,
                        })),
                    },
                });
            }
            if (decls.length > 0) {
                replacement = astring.generate({ type: "VariableDeclaration", kind: "var", declarations: decls });
            }
        } else if (exportsMode === "keep") {
            replacement = rewriteExport(node, code);
        }

        code = code.slice(0, node.start) + replacement + code.slice(node.end);
    }
    return code;
}

/**
 * Minify with the settings used by Aletheia. `target` is an optional swc
 * `jsc.target` (e.g. "es2022"); Aletheia leaves it unset, which makes swc
 * downlevel to ES5 and inject helper functions for modern syntax.
 */
export async function minify(source, target) {
    const out = await swc.transform(source, {
        swcrc: false,
        configFile: false,
        jsc: { ...(target ? { target } : {}), minify: { compress: { unsafe: true } } },
        minify: true,
        isModule: "unknown",
    });
    return out.code;
}

function wrapJson(content) {
    JSON.parse(content); // throws on invalid JSON
    return content;
}

const normalizeSource = (s) => s.replace(/^\uFEFF/, "").replace(/^#!.*/, "");

/** True if every wrapper in the minified bundle has an empty body. */
function isEmptyBundle(minified) {
    try {
        const ast = acorn.parse(minified, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
        let nonEmpty = false;
        walk.simple(ast, {
            FunctionExpression(n) {
                if (n.body.body.length > 0) nonEmpty = true;
            },
            ArrowFunctionExpression(n) {
                if (n.body.type !== "BlockStatement" || n.body.body.length > 0) nonEmpty = true;
            },
        });
        return !nonEmpty;
    } catch {
        return false;
    }
}

/**
 * Build the pseudo-bundle for one package directory.
 *
 * @returns {Promise<{content: string, minified: boolean, files: string[],
 *   fallback: boolean, strategy: string, skipped: {file: string, reason: string}[],
 *   inputBytes: number, empty: boolean}>}
 */
export async function buildPseudoBundle(pkgDir, { exportsMode = "keep", target, log = () => {} } = {}) {
    const selection = await selectFiles(pkgDir, log);
    const { fallback, strategy } = selection;
    // `exports: {"./package.json": ...}` makes package.json a selected "module".
    // Bundlers do not include it, and it would leak the version string, so skip it.
    const files = selection.files.filter((f) => path.basename(f) !== "package.json");

    const wrappers = [];
    const skipped = [];
    let inputBytes = 0;

    for (const file of files) {
        const rel = path.relative(pkgDir, file);
        try {
            const raw = normalizeSource(await fs.readFile(file, "utf8"));
            inputBytes += raw.length;
            const body = file.endsWith(".json") ? `_$__e.exports=${wrapJson(raw)};` : rewriteImports(raw, exportsMode);
            wrappers.push("(function(_$__e){\n" + body + "\n})");
        } catch (e) {
            skipped.push({ file: rel, reason: `rewrite: ${e.message}` });
            wrappers.push(EMPTY_WRAPPER);
        }
    }

    // The line break before "," matters: a file may end in a line comment.
    const assemble = () => "module([" + wrappers.join("\n,") + "])";

    let content = assemble();
    let minified = true;
    try {
        content = await minify(content, target);
    } catch (firstErr) {
        // Isolate files swc cannot parse (TypeScript syntax, top-level await, ...)
        for (let i = 0; i < wrappers.length; i++) {
            if (wrappers[i] === EMPTY_WRAPPER) continue;
            try {
                await minify("module([" + wrappers[i] + "])", target);
            } catch (e) {
                skipped.push({ file: path.relative(pkgDir, files[i]), reason: `swc: ${String(e.message ?? e).split("\n")[0]}` });
                wrappers[i] = EMPTY_WRAPPER;
            }
        }
        try {
            content = await minify(assemble(), target);
        } catch (e) {
            content = assemble();
            minified = false;
            skipped.push({ file: "(whole bundle)", reason: `swc: ${String(e.message ?? e).split("\n")[0]}` });
        }
    }

    return {
        content,
        minified,
        files: files.map((f) => path.relative(pkgDir, f)),
        fallback,
        strategy,
        skipped,
        inputBytes,
        empty: files.length === 0 || (minified && isEmptyBundle(content)),
    };
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
