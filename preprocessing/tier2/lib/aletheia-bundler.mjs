// Aletheia pseudo-bundler ("rudimentary bundling algorithm", paper Section 3.3).
//
// Extracted verbatim from the study's scripts/identification/aletheia-preprocessor.mjs.
// The functions rewriteImports / readDir / readDirOrFile / minify are unchanged.
// Removed from the original on purpose:
//   - @dodona/dolos-lib and all fingerprint/k-gram/hash/similarity code
//   - the workerpool + Bun HTTP-server scaffolding (main(), the worker proxy)
// Fixed from the original release:
//   - wrapJson(), which was called but never defined in the published archive
//   - the import path for parseLoose (the original pulled it from the bundler-
//     detection module; here it lives in its own ./parse-utils.mjs)
// Note: in the released archive this file was named aletheia-preprocessor.mjs but
// its worker/main guard still referenced the old name "dolos-preprocessor.mjs".

import * as swc from "@swc/core";
import * as walk from "acorn-walk";
import * as astring from "astring";

import fs from "node:fs/promises";
import { fileSelector } from "./file-selector.mjs";
import { parseLoose } from "./parse-utils.mjs";

/**
 * Serialize raw JSON source into a JavaScript expression usable as the value of
 * `_$__e.exports = <expr>`.
 *
 * This helper was referenced but not defined in the published archive; it is
 * reconstructed minimally and faithfully. JSON text is already a valid JS
 * expression, so it is wrapped in parentheses to guarantee object literals are
 * parsed as expressions rather than blocks. A leading BOM is stripped.
 */
export function wrapJson(content) {
    const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    return "(" + text + ")";
}

// KEEP_EXPORTS=1: a deviation from the original, off by default. The original removes every export
// statement together with the exported declaration, so ES-module packages lose most of their code.
export const KEEP_EXPORTS = process.env.KEEP_EXPORTS === "1";

function declaredNames(decl) {
    if (!decl) return [];
    if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") return decl.id ? [decl.id.name] : [];
    if (decl.type === "VariableDeclaration") {
        const out = [];
        const walkPat = (p) => {
            if (!p) return;
            if (p.type === "Identifier") out.push(p.name);
            else if (p.type === "ObjectPattern") p.properties.forEach((q) => walkPat(q.type === "RestElement" ? q.argument : q.value));
            else if (p.type === "ArrayPattern") p.elements.forEach(walkPat);
            else if (p.type === "AssignmentPattern") walkPat(p.left);
            else if (p.type === "RestElement") walkPat(p.argument);
        };
        decl.declarations.forEach((d) => walkPat(d.id));
        return out;
    }
    return [];
}
const exportName = (n) => (n.type === "Literal" ? String(n.value) : n.name);
const setExport = (name, value) => "_$__e.exports[" + JSON.stringify(name) + "]=" + value + ";";

export function keepExport(node, code) {
    const src = (n) => code.slice(n.start, n.end);
    if (node.type === "ExportNamedDeclaration") {
        if (node.declaration) return src(node.declaration) + ";" + declaredNames(node.declaration).map((n) => setExport(n, n)).join("");
        if (node.source) return node.specifiers.map((s) => setExport(exportName(s.exported), "require(" + JSON.stringify(node.source.value) + ")[" + JSON.stringify(exportName(s.local)) + "]")).join("");
        return node.specifiers.map((s) => setExport(exportName(s.exported), exportName(s.local))).join("");
    }
    if (node.type === "ExportDefaultDeclaration") {
        const d = node.declaration;
        if ((d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && d.id) return src(d) + ";" + setExport("default", d.id.name);
        return setExport("default", "(" + src(d) + ")");
    }
    if (node.type === "ExportAllDeclaration") return "require(" + JSON.stringify(node.source.value) + ");";
    return "";
}

export function rewriteImports(code) {
    // Parse AST with acorn
    const ast = parseLoose(code);

    const importsExports = [];

    // Find all imports
    walk.simple(ast, {
        Statement(node) {
            if (
                node.type === "ImportDeclaration" ||
                node.type === "ExportNamedDeclaration" ||
                node.type === "ExportDefaultDeclaration" ||
                node.type === "ExportAllDeclaration"
            ) {
                importsExports.push(node);
            }
        },
    });

    // Replace from back to front
    for (const impExp of importsExports.toReversed()) {
        if (impExp.type.includes("xport") && KEEP_EXPORTS) {
            // KEEP_EXPORTS=1 (not in the original): keep the exported code and make it reachable
            // through _$__e.exports, so swc's dead-code removal keeps it too.
            code = code.slice(0, impExp.start) + keepExport(impExp, code) + code.slice(impExp.end);
        } else if (impExp.type.includes("xport")) {
            const exp = impExp;
            // Faithful to the original aletheia-preprocessor.mjs: remove the whole export
            // statement ("// todo just remove them for now"). Exported declarations are
            // dropped along with the `export` keyword, exactly as in the study's release.
            code = code.slice(0, exp.start) + code.slice(exp.end);
        } else {
            const imp = impExp;
            const namespaceImportCount = imp.specifiers.filter((s) => s.type === "ImportNamespaceSpecifier").length;
            const newNode = {
                type: "VariableDeclaration",
                kind: "var",
                declarations: [],
            };
            // This needs to be separated
            if (namespaceImportCount > 0) {
                newNode.declarations.push({
                    type: "VariableDeclarator",
                    init: {
                        type: "CallExpression",
                        callee: {
                            type: "Identifier",
                            name: "require",
                        },
                        arguments: [imp.source],
                    },
                    id: imp.specifiers.filter((s) => s.type === "ImportNamespaceSpecifier")[0].local,
                });
            }
            if (imp.specifiers.length - namespaceImportCount > 0) {
                newNode.declarations.push({
                    type: "VariableDeclarator",
                    init: {
                        type: "CallExpression",
                        callee: {
                            type: "Identifier",
                            name: "require",
                        },
                        arguments: [imp.source],
                    },
                    id: {
                        type: "ObjectPattern",
                        properties: imp.specifiers
                            .map((specifier) => {
                                if (specifier.type === "ImportNamespaceSpecifier") return;
                                const prop = {
                                    type: "Property",
                                    method: false,
                                    shorthand: false,
                                    computed: false,
                                    kind: "init",
                                    key: specifier.imported ?? {
                                        type: "Identifier",
                                        name: "default",
                                    },
                                    value: specifier.local,
                                };
                                return prop;
                            })
                            .filter((p) => !!p),
                    },
                });
            }
            if (newNode.declarations.length > 0) {
                code = code.slice(0, imp.start) + astring.generate(newNode) + code.slice(imp.end);
            } else {
                code = code.slice(0, imp.start) + code.slice(imp.end);
            }
        }
    }

    return code;
}

/**
 * Parse a package directory and return a single string of
 *
 * @param dirname Name of directory
 * @param opts Options for fs.readFile call
 * @returns {Promise<{filename: string, content: string}>}
 */
export async function readDir(dirname, opts) {
    let { files: selectedFilenames, fallback } = await fileSelector(dirname);

    if (fallback) console.warn(`Warning: Fallback for ${dirname}`);

    // Resilience: a resolved entry can point at a file that isn't actually on disk
    // (complex/invalid `exports` maps, unusual tarball layouts). Skip such files
    // instead of throwing ENOENT and failing the whole package; bundle whatever real
    // source files DO resolve. Only if nothing at all reads do we signal an error.
    const read = await Promise.all(
        selectedFilenames.map((file) =>
            fs.readFile(file, opts).then((c) => ({ file, content: c })).catch((e) => {
                console.warn(`  .. skipping unreadable file ${file}: ${e.code || e.message}`);
                return null;
            }),
        ),
    );
    const readable = read.filter(Boolean);
    if (readable.length === 0) throw new Error(`no readable source files resolved for ${dirname}`);

    const returnObj = await Promise.resolve(readable)
        .then((mc) =>
            mc.reduce(
                (acc, next) => {
                    acc.filenames.push(next.file);
                    acc.contents.push(
                        "(function(_$__e){\n" +
                            (next.file.slice(-5) === ".json"
                                ? "_$__e.exports=" + wrapJson(next.content) + ";"
                                : rewriteImports(next.content)) +
                            "\n})",
                    ); // Wrap as module to catch parsing issues
                    return acc;
                },
                { filenames: [], contents: [] },
            ),
        )
        .then((fc) => ({ filename: dirname, content: "module([" + fc.contents.join("\n,") + "])" })); // The line break is important as the file might end on a comment

    if (returnObj.content.length > 2 ** 20)
        console.warn(
            `Warning: Large source files (${Math.round((returnObj.content.length * 10) / 2 ** 20)}00 KiB) for ${dirname}`,
        );
    return returnObj;
}

/**
 * Minifies source. Make sure top level has some effect, otherwise its eliminated
 *
 * @param source
 * @return {Promise<string>}
 */
export async function minify(source) {
    return await swc
        .transform(source, {
            jsc: {
                minify: {
                    compress: {
                        unsafe: true,
                    },
                },
            },
            minify: true,
            isModule: "unknown",
        })
        .then((o) => o.code);
}

export async function readDirOrFile(name) {
    const opts = { encoding: "utf8" };

    const result = (await fs.stat(name)).isFile()
        ? { filename: name, content: "module([function(_$__e){" + (await fs.readFile(name, opts)) + "}])" }
        : await readDir(name, opts);

    try {
        // await fs.writeFile("/tmp/swc-analysis.js", result.content);
        result.content = await minify(result.content).catch(
            (e) => (console.log(`SWC error for ${name}`, e), result.content),
        );
        return result;
    } catch (e) {
        console.warn("Skipping swc", e);
        return result;
    }
}
