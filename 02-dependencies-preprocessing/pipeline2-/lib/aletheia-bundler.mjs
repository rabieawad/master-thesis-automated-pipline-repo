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
        if (impExp.type.includes("xport")) {
            const exp = impExp;
            // Fix (B): keep the declaration, drop only the `export`/`export default` keyword,
            // so exported functions survive (the study's original just deleted the whole
            // statement -- see "// todo just remove them for now"). This realizes the paper's
            // stated "exports are rewritten to CJS style" intent for declarations.
            if (exp.type === "ExportNamedDeclaration" && exp.declaration) {
                // export function foo(){} | export const x = ... | export class C {}
                //   -> function foo(){}   |        const x = ... |        class C {}
                code = code.slice(0, exp.start) + code.slice(exp.declaration.start, exp.declaration.end) + code.slice(exp.end);
            } else if (exp.type === "ExportDefaultDeclaration" && exp.declaration) {
                // export default <decl|expr>  ->  var _$__default = <decl|expr>;
                const d = exp.declaration;
                code = code.slice(0, exp.start) + "var _$__default = " + code.slice(d.start, d.end) + ";" + code.slice(exp.end);
            } else {
                // export { a, b } | export { a } from "x" | export * from "x":
                // no local declaration to keep -> remove (the bound values live elsewhere)
                code = code.slice(0, exp.start) + code.slice(exp.end);
            }
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

    const returnObj = await Promise.all(
        selectedFilenames.map((file) => fs.readFile(file, opts).then((c) => ({ file, content: c }))),
    )
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
