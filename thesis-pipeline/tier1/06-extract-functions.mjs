/**
 * Function collector — a line-for-line JavaScript port of DEBUN's
 * `src/fingerprint-collector/function-collector.ts`
 * (https://github.com/ku-plrg/debun-ase25), plus one addition: a configurable
 * line-of-code filter.
 *
 * Extraction (identical to the repo):
 *   - parse with meriyah 6.0.6 (`next: true`), script mode first, module mode on failure
 *   - every function (declaration, expression, arrow) with a body is recorded,
 *     innermost first, with its own inner functions stripped:
 *       * a function declaration becomes an EmptyStatement (`;`)
 *       * a function expression / arrow becomes an empty function of the same
 *         type (`function () {}` / `() => {}`); nothing else is removed
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
import escodegen from "escodegen";

const FUNC_ID = true;
let functions = [];

function recordFunction(node) {
    if (!node.body) return;
    const body = stripFunctions(node.body);
    if (FUNC_ID) {
        if (node.type === "ArrowFunctionExpression" && node.expression)
            functions.push({
                id: getId(body),
                body: {
                    ...node,
                    body: body,
                },
            });
        else
            functions.push({
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

        return node.type === "FunctionDeclaration"
            ? { type: "EmptyStatement" }
            : {
                  type: node.type,
                  id: null,
                  params: [],
                  generator: false,
                  async: false,
                  body: {
                      type: "BlockStatement",
                      body: [],
                  },
              };
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
    try {
        ast = parse(code, {
            next: true,
            module: false,
        });
    } catch (e) {
        ast = parse(code, {
            next: true,
            module: true,
        });
    }
    stripFunctions(ast);

    return functions;
}

/** LOC as measured in the repo's RQ3 evaluation. */
export function countLoc(fn) {
    return escodegen.generate(fn.body).split("\n").length;
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

// ---------------------------------------------------------------------------
// Command line (pipeline step 06). Everything above is the function collector and is unchanged;
// this part only runs it over a folder of bundles when the file is started directly.
//
//   node 06-extract-functions.mjs [bundlesDir=bundles] [outDir=extracted-functions] [--min-loc 0] [--no-text]
//
// Example (the folders the pipeline uses):
//   node 06-extract-functions.mjs output/05_selected_bundles/bundles output/06_extracted_functions
//
// For every <name>@<version>.min.js in bundlesDir it writes
//   <outDir>/<name>@<version>.functions.json   { bundle, stats, functions: [ { index, id, type, loc, hash, text } ] }
// and one overview for all bundles:
//   <outDir>/summary.csv                       bundle, status, functions kept, total, skipped (too short), bytes
//
// "text" is the function printed back as source (escodegen) with its inner functions stripped, exactly the
// code the collector keeps; "hash" is a short sha256 of that text. Functions are in the collector's order
// (inner functions before their parent).
// --min-loc N  keeps only functions with at least N lines. Default 0 (keep all), as the collector's notes
//              advise for website bundles; the paper's library-database filter is --min-loc 6.
// --no-text    leaves the function source out of the JSON (much smaller files)
// A bundle that cannot be parsed is listed with its error and the run goes on.
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
    const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--min-loc");
    const bundlesDir = resolve(positional[0] ?? "bundles");
    const outDir = resolve(positional[1] ?? "extracted-functions");

    if (!existsSync(bundlesDir)) {
        console.error(`Bundles folder not found: ${bundlesDir}  (run step 05 first)`);
        process.exit(1);
    }
    mkdirSync(outDir, { recursive: true });
    const files = readdirSync(bundlesDir).filter((f) => f.endsWith(".min.js")).sort();
    const csvCell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));
    const rows = [];
    const started = Date.now();

    for (const [i, file] of files.entries()) {
        const key = file.slice(0, -".min.js".length);
        const code = readFileSync(join(bundlesDir, file), "utf8");
        let line;
        try {
            const { functions: kept, stats } = extractFunctions(code, { minLoc });
            let unprintable = 0;
            const records = kept.map((fn, index) => {
                // escodegen 2.1.0 cannot print some newer syntax (e.g. class fields, optional chaining). Such a
                // function is still listed (loc null, text null) instead of failing the whole bundle.
                let text = null;
                try {
                    text = escodegen.generate(fn.body);
                } catch {
                    unprintable++;
                }
                const rec = { index, id: fn.id, type: fn.body.type, loc: fn.loc, hash: text === null ? null : createHash("sha256").update(text).digest("hex").slice(0, 16) };
                if (includeText) rec.text = text;
                return rec;
            });
            writeFileSync(join(outDir, `${key}.functions.json`), JSON.stringify({ bundle: file, stats: { ...stats, unprintable }, functions: records }, null, 1));
            rows.push([key, "ok", stats.kept, stats.total, stats.skippedMinLoc, Buffer.byteLength(code), ""]);
            line = `ok    ${key}  (${stats.kept} functions kept of ${stats.total}${unprintable ? `, ${unprintable} without text` : ""})`;
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
    const failed = rows.filter((r) => r[1] === "FAIL").length;
    console.log(`\nDone. extracted=${rows.length - failed}  failed=${failed}  (see ${join(outDir, "summary.csv")})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await cli();
