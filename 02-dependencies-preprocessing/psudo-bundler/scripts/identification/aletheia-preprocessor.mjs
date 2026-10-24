import workerpool from "workerpool";

import "./utils.mjs";

import * as swc from "@swc/core";
import * as walk from "acorn-walk";
import * as astring from "astring";

import fs from "node:fs/promises";
import path from "node:path";
import { fileSelector } from "../file-selector.mjs";
import { parseLoose } from "./identify_bundler.mjs";

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
            // todo just remove them for now
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

async function main(basedir) {
    console.log("Worker Script:", import.meta.filename.replace(".mjs", ".worker.mjs"));
    const pool = workerpool.pool(import.meta.filename.replace(".mjs", ".worker.mjs"), {
        minWorkers: "max",
        maxWorkers: Math.ceil(workerpool.cpus * (process.env.LOAD ?? 1)),
        workerType: "process",
    });

    console.log("Environment");
    console.log(`  NPM_DIR=${process.env.NPM_DIR}  -- Directory of npm mirror`);
    console.log(`  INDEX_DIR=${process.env.INDEX_DIR}  -- Target directory for npm index`);
    console.log(`  LOAD=${process.env.LOAD}  -- Ratio of workers to cpu cores (default: 1)`);

    if (typeof Bun === "undefined") {
        var Bun = (await import("../bun-serve.mjs")).default;
    }
    Bun.serve({
        port: process.env.PORT,
        /** @param {Request} request
         *  @param {any} server */
        fetch: async (request, server) => {
            const url = new URL(request.url);
            if (url.pathname !== "/preprocess") return new Response("", { status: 404, statusText: "Not Found" });

            const pkgname = url.searchParams.get("pkg");
            const version = url.searchParams.get("version");

            return new Promise((resolve, reject) =>
                pool
                    .proxy()
                    .then((worker) => worker.preprocess(basedir, pkgname, version))
                    .then((result) =>
                        resolve(
                            new Response(JSON.stringify(result.content), {
                                status: 200,
                                statusText: "OK",
                                headers: { "content-type": "application/json" },
                            }),
                        ),
                    )
                    .catch((err) => {
                        console.warn(err);
                        resolve(
                            new Response(`${err}`, {
                                status: 500,
                                statusText: "Internal Error",
                                headers: { "content-type": "text/plain" },
                            }),
                        );
                    }),
            );
        },
    });
    process.on("beforeExit", () => pool.terminate());
}

if (process.argv[1].includes("dolos-preprocessor.mjs")) {
    if (!process.env.NPM_DIR) {
        console.error("ERROR Missing env variable: NPM_DIR");
        process.exit(1);
    }

    if (!process.env.INDEX_DIR) {
        console.error("ERROR Missing env variable: INDEX_DIR");
        process.exit(1);
    }

    main(process.env.NPM_DIR, process.env.INDEX_DIR).finally(() => console.log("Finished"));
}
