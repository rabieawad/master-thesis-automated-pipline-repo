/**
 * Function collector — the same DEBUN function-collector used by the first
 * pipeline's step 06 (a line-for-line port of
 * src/fingerprint-collector/function-collector.ts), trimmed to what the
 * reference pipeline needs.
 *
 * For the reference dataset there is no source map and the pseudo-bundle is kept
 * un-minified, so LOC can be measured directly on the code that is collected
 * (escodegen LOC of the body — the paper's "> 5 lines" measure). That is exactly
 * what extractFunctions() does here.
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
            functions.push({ id: getId(body), body: { ...node, body: body } });
        else
            functions.push({ id: getId(body), body: { ...node, body: { type: "BlockStatement", body: [body] } } });
        return;
    }
    functions.push({ body });
}

function stripFunctions(node) {
    if (!node) return node;
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
        if (!node.body) return node;
        recordFunction(node);
        return node.type === "FunctionDeclaration"
            ? { type: "EmptyStatement" }
            : { type: node.type, id: null, params: [], generator: false, async: false, body: { type: "BlockStatement", body: [] } };
    }
    Object.entries(node).forEach(([key, value]) => {
        if (value && typeof value === "object") {
            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) if (value[i] && typeof value[i] === "object") value[i] = stripFunctions(value[i]);
            } else {
                node[key] = stripFunctions(value);
            }
        }
    });
    return node;
}

function walk(node, visitors) {
    const visit = visitors[node.type];
    if (visit) visit(node);
    for (const key in node) {
        const value = node[key];
        if (key === "type") continue;
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) { const child = value[i]; if (child?.type) walk(child, visitors); }
        } else if (value?.type) walk(value, visitors);
    }
}

function getId(node) {
    let value;
    walk(node, {
        CallExpression(node) {
            if (node.callee?.type === "Identifier" && node.callee.name === "Symbol" && node.arguments?.[0]?.type === "Literal" && typeof node.arguments[0].value === "string") {
                const v = node.arguments[0].value;
                if (value === undefined && v.startsWith("JSCA_")) value = v;
            }
        },
        TemplateLiteral(node) {
            const v = node.quasis[0]?.value.raw;
            if (value === undefined && v?.startsWith("JSCA_")) value = v;
        },
        Literal(node) {
            if (value === undefined && typeof node.value === "string" && node.value.startsWith("JSCA_")) value = node.value;
        },
    });
    return value || "";
}

/** Every function, no filtering (repo's extractFunctions). */
export function collectFunctions(code) {
    functions = [];
    let ast;
    try { ast = parse(code, { next: true, module: false, loc: true }); }
    catch { ast = parse(code, { next: true, module: true, loc: true }); }
    stripFunctions(ast);
    return functions;
}

/** LOC as measured in the repo's RQ3 evaluation (escodegen body line count). */
export function countLoc(fn) {
    return escodegen.generate(fn.body).split("\n").length;
}

/**
 * Collect + filter by LOC, measured on the code passed in. Because the reference
 * pseudo-bundle is un-minified, this LOC is the real pre-minification line count.
 *
 * @param {string} code
 * @param {object} [opts]  minLoc (default 0; paper library filter = 6)
 */
export function extractFunctions(code, opts = {}) {
    const { minLoc = 0 } = opts;
    const all = collectFunctions(code);
    const kept = [];
    let skippedMinLoc = 0, locErrors = 0;
    for (const fn of all) {
        let loc = null;
        try { loc = countLoc(fn); } catch { locErrors++; }
        if (loc !== null && loc < minLoc) { skippedMinLoc++; continue; }
        kept.push({ ...fn, loc });
    }
    return { functions: kept, stats: { total: all.length, kept: kept.length, skippedMinLoc, locErrors } };
}
