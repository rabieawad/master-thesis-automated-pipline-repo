/**
 * File selection for one npm package directory.
 *
 * Port of Aletheia's `file-selector.mjs` (Swierzy et al.). Strategy, in order:
 *   1. `unpkg` / `jsdelivr` / string `browser` field  -> one pre-bundled file
 *   2. `exports` (conditions + subpaths), else `main` / `module` / `index`
 *      -> entry points, then follow relative import()/require() recursively
 *   3. no entry point found -> every index.js/.mjs/.cjs
 *   4. nothing resolvable -> naming heuristics (skip test/example/vendor,
 *      prefer dist/, prefer .min.)
 *
 * Differences from the original (all bug fixes, listed in README.md):
 *   - the "main package.json" is the shallowest one (original `countChar`
 *     counted spaces, so the pick was arbitrary)
 *   - no package.json at all no longer crashes
 *   - unpkg/jsdelivr/browser targets must exist, otherwise we fall through
 *   - self-references (`pkgname`, `pkgname/sub`) resolve against the package root
 */
import fs from "node:fs/promises";
import path from "node:path";
import * as walk from "acorn-walk";
import { parseLoose } from "./parse.mjs";

const CONDITION_PRIORITY = ["browser", "default", "import", "production", "require", "node"];

const isFile = (f) =>
    fs
        .stat(f)
        .then((s) => s.isFile())
        .catch(() => false);
const isDir = (f) =>
    fs
        .stat(f)
        .then((s) => s.isDirectory())
        .catch(() => false);

const hasExt = (p) => path.basename(p).includes(".");

/**
 * @param {string} dirname absolute path of the package root
 * @param {(...a:any[])=>void} [log]
 * @returns {Promise<{files: string[], fallback: boolean, strategy: string}>}
 */
export async function selectFiles(dirname, log = () => {}) {
    dirname = path.resolve(dirname);
    const full = (rel, base = dirname) => path.normalize(path.join(base, rel));

    const entries = await fs.readdir(dirname, { recursive: true, withFileTypes: true });
    const parentOf = (e) => e.parentPath ?? e.path;
    // The package root itself usually lives inside node_modules (pnpm store),
    // so only look at the part of the path below the root.
    const inNodeModules = (p) => path.relative(dirname, p).split(path.sep).includes("node_modules");

    // ---- collect package.json files (never descend into node_modules) -----
    const packageJsons = {};
    await Promise.all(
        entries
            .filter((e) => e.name === "package.json" && e.isFile())
            .filter((e) => !inNodeModules(parentOf(e)))
            .map(async (e) => {
                try {
                    packageJsons[parentOf(e)] = JSON.parse(await fs.readFile(path.join(parentOf(e), e.name), "utf8"));
                } catch (err) {
                    log("Cannot parse package.json", parentOf(e), err.message);
                }
            }),
    );

    const depth = (d) => path.relative(dirname, d).split(path.sep).filter(Boolean).length;
    const mainDir = Object.keys(packageJsons).sort((a, b) => depth(a) - depth(b))[0];
    const mainPackageJson = mainDir !== undefined ? packageJsons[mainDir] : {};
    const pkgname = mainPackageJson.name;

    // ---- 1. pre-bundled artifact -------------------------------------------
    for (const [field, value] of [
        ["unpkg", mainPackageJson.unpkg],
        ["jsdelivr", mainPackageJson.jsdelivr],
        ["browser", mainPackageJson.browser],
    ]) {
        if (typeof value === "string") {
            const f = full(value, mainDir);
            if (await isFile(f)) {
                log("pre-bundled via", field, f);
                return { files: [f], fallback: false, strategy: `prebundled:${field}` };
            }
            log("WARNING", field, "points to missing file", f);
        }
    }

    // ---- module resolution helpers -----------------------------------------
    async function addExt(p) {
        for (const candidate of [p, `${p}.js`, `${p}.mjs`, `${p}.cjs`]) {
            if (await isFile(candidate)) return candidate;
        }
        log("WARNING: could not resolve", p);
        return undefined;
    }

    /**
     * @param {string} filename  file the reference occurs in (or a package.json path)
     * @param {string} importname specifier
     * @param {Record<string,string>} exportsMap resolved subpath exports (absolute -> absolute)
     */
    async function resolveModule(filename, importname, exportsMap) {
        let fullname;
        if (pkgname && importname === pkgname) {
            fullname = dirname; // self reference
        } else if (pkgname && importname.startsWith(`${pkgname}/`)) {
            fullname = full(importname.slice(pkgname.length + 1));
        } else if (importname.startsWith(".")) {
            fullname = path.normalize(path.join(path.dirname(filename), importname));
        } else {
            return undefined; // bare specifier = other package
        }

        const ext = hasExt(fullname) ? path.extname(fullname).slice(1) : undefined;
        const noExt = ext ? fullname.slice(0, -ext.length - 1) : fullname;

        // direct subpath rules
        for (const key in exportsMap) {
            if (key.includes("*")) continue;
            if (hasExt(key) ? key === fullname : key === noExt) {
                fullname = exportsMap[key];
                break;
            }
        }

        // wildcard subpath rules
        for (const key in exportsMap) {
            if (!key.includes("*")) continue;
            let i = 0;
            let j = 0;
            const re = new RegExp(
                "^" +
                    key
                        .replaceAll(".", "\\.")
                        .replaceAll("**/", "(?<doublestar>([^/]+/)*)")
                        .replaceAll("*", "(?<singlestar>[^/]+)")
                        .replaceAll("<doublestar>", () => `<doublestar${i++}>`)
                        .replaceAll("<singlestar>", () => `<singlestar${j++}>`) +
                    "$",
            );
            const m = re.exec(fullname);
            if (!m) continue;
            let k = 0;
            let h = 0;
            let target = exportsMap[key]
                .replaceAll("**/", () => `<doublestar${k++}>/`)
                .replaceAll("*", () => `<singlestar${h++}>`);
            for (let n = 0; n < i; n++) target = target.replace(`<doublestar${n}>`, m.groups[`doublestar${n}`]);
            for (let n = 0; n < j; n++) target = target.replace(`<singlestar${n}>`, m.groups[`singlestar${n}`]);
            log(`wildcard ${key} -> ${exportsMap[key]} gives ${target}`);
            fullname = target;
        }

        const early = await addExt(fullname);
        if (early) return early;

        if (await isDir(fullname)) {
            const nested = packageJsons[fullname];
            if (nested) {
                fullname = path.normalize(path.join(fullname, nested.main || nested.module || "index"));
            } else {
                fullname = path.normalize(path.join(fullname, "index"));
            }
            return addExt(fullname);
        }
        return undefined;
    }

    function evaluateConditionals(cond) {
        for (const key of CONDITION_PRIORITY) {
            if (cond[key] && typeof cond[key] === "string") return cond[key];
            if (cond[key] && typeof cond[key] === "object") return evaluateConditionals(cond[key]);
        }
        return undefined;
    }

    // ---- 2. entry points ----------------------------------------------------
    let selected = [];
    let strategy = "entry";
    const exportsMap = {};
    const push = (...p) => selected.push(...p.filter(Boolean));

    for (const [pjDir, pj] of Object.entries(packageJsons)) {
        const before = selected.length;
        const pjFile = path.join(pjDir, "package.json");

        if (pj.exports) {
            if (typeof pj.exports === "string") {
                push(await resolveModule(pjFile, pj.exports, {}));
            } else if (Array.isArray(pj.exports)) {
                for (const e of pj.exports.filter((x) => typeof x === "string")) push(await resolveModule(pjFile, e, {}));
            } else {
                const rootConditionals = {};
                for (const key in pj.exports) {
                    if (key.startsWith(".")) {
                        let spec = pj.exports[key];
                        if (spec && typeof spec === "object") spec = evaluateConditionals(spec);
                        if (typeof spec === "string") {
                            exportsMap[full(key, pjDir)] = full(spec, pjDir);
                            if (!spec.includes("*")) push(await resolveModule(pjFile, spec, {}));
                        }
                    } else {
                        rootConditionals[key] = pj.exports[key];
                    }
                }
                const root = evaluateConditionals(rootConditionals);
                if (root) push(await resolveModule(pjFile, root, {}));
            }
            if (selected.length === before) log("WARNING: exports present but not evaluable", pj.exports);
        }

        if (selected.length === before) {
            // `main` only if exports gave nothing
            const main = await resolveModule(pjFile, "./" + (pj.main || pj.module || "index"), {});
            if (main) push(main);
        }
    }

    if (selected.length === 0) {
        log("WARNING: no entry point; using all index files");
        strategy = "index-files";
        push(
            ...entries
                .filter((e) => e.isFile() && ["index.js", "index.mjs", "index.cjs"].includes(e.name))
                .map((e) => path.join(parentOf(e), e.name)),
        );
    }

    // ---- follow imports -----------------------------------------------------
    function collectReferences(ast) {
        const refs = [];
        const lit = (n) => n && n.type === "Literal" && typeof n.value === "string" && refs.push(n.value);
        try {
            walk.simple(ast, {
                ImportDeclaration: (n) => lit(n.source),
                ExportAllDeclaration: (n) => lit(n.source),
                ExportNamedDeclaration: (n) => lit(n.source),
                ImportExpression: (n) => lit(n.source),
                CallExpression: (n) => {
                    if (n.callee?.type === "Identifier" && n.callee.name === "require") lit(n.arguments?.[0]);
                },
            });
        } catch (e) {
            log("walk error", e.message);
        }
        return refs;
    }

    const fetched = new Set();
    const queue = [...selected];
    while (queue.length) {
        const file = queue.shift();
        if (fetched.has(file)) continue;
        let content;
        try {
            content = await fs.readFile(file, "utf8");
        } catch (e) {
            log("read error", file, e.message);
            continue;
        }
        if (!file.endsWith(".json")) {
            try {
                for (const ref of collectReferences(parseLoose(content))) {
                    const target = await resolveModule(file, ref, exportsMap);
                    if (target && !fetched.has(target)) queue.push(target);
                }
            } catch (e) {
                log("parse error", file, e.message);
            }
        }
        fetched.add(file);
    }

    if (fetched.size > 0) return { files: [...fetched], fallback: false, strategy };

    // ---- 4. naming heuristics ----------------------------------------------
    log("WARNING: FALLBACK");
    const rel = (f) => f.slice(dirname.length);
    let files = entries
        .filter((e) => e.isFile())
        .map((e) => path.join(parentOf(e), e.name))
        .filter(
            (f) =>
                f.endsWith("js") &&
                !rel(f).includes("test") &&
                !rel(f).includes("example") &&
                !rel(f).includes("vendor") &&
                !inNodeModules(f),
        );
    if (files.some((f) => rel(f).includes("dist"))) files = files.filter((f) => rel(f).includes("dist"));
    if (files.some((f) => rel(f).includes(".min."))) files = files.filter((f) => rel(f).includes(".min."));
    return { files, fallback: true, strategy: "fallback" };
}
