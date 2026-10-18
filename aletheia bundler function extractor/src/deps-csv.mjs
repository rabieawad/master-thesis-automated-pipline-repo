#!/usr/bin/env node
/**
 * node src/deps-csv.mjs [<dataset>] [--dataset DIR] [--out dependencies.csv] [--direct] [--stable]
 *                       [--cache DIR] [--concurrency N] [--refresh] [--offline] [--registry URL]
 *
 * <dataset> is the folder that contains one pnpm-installed project folder per package (the layout
 * fetch-each.sh produces), or a single project folder:
 *
 *   <dataset>/<package>/package.json, pnpm-lock.yaml, node_modules/.pnpm/<name>@<version>/...
 *
 * If no folder is given and the terminal is interactive, the script asks for it.
 *
 * For every dependency the script asks the npm registry which versions exist, and reports for the
 * INSTALLED version how many versions were published in total, how many before it and how many after it.
 *
 * Output
 *   dependencies.csv          one line per package folder:
 *                               package, dependencies
 *                               express,"{""accepts"": 37, ""body-parser"": 85, ..., ""express"": 289, ...}"
 *   dependencies-counts.json  {"package": total number of versions on npm, ...} for every package and dependency
 *                             (--counts FILE); packages npm does not know are left out
 *   dependencies-versions.csv one line per distinct dependency@installed-version (the same numbers, as a table;
 *                             its name is the --out name with "-versions" added, or --table FILE)
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import semver from "semver";
import { findProjects, parsePnpmDirName, readJson, readLockfile } from "./pnpm-project.mjs";

const USAGE =
    "usage: node src/deps-csv.mjs [<dataset>] [--dataset DIR] [--out dependencies.csv] [--direct] [--stable]\n" +
    "                             [--cache DIR] [--concurrency N] [--refresh] [--offline] [--registry URL]";

const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        dataset: { type: "string" },
        out: { type: "string", default: "dependencies.csv" },
        table: { type: "string" },
        counts: { type: "string" },
        direct: { type: "boolean", default: false },
        stable: { type: "boolean", default: false },
        cache: { type: "string", default: ".npm-versions-cache" },
        concurrency: { type: "string", default: "8" },
        refresh: { type: "boolean", default: false },
        offline: { type: "boolean", default: false },
        registry: { type: "string", default: "https://registry.npmjs.org" },
        help: { type: "boolean", short: "h", default: false },
    },
});
if (o.help) {
    console.log(USAGE);
    process.exit(0);
}

// ------------------------------------------------------------- which folder?
let datasetArg = o.dataset ?? positionals[0];
if (!datasetArg) {
    if (!process.stdin.isTTY) {
        console.error("No dataset folder given.\n" + USAGE);
        process.exit(1);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    datasetArg = (await rl.question("Folder that contains the package folders: ")).trim().replace(/^["']|["']$/g, "");
    rl.close();
}
if (datasetArg === "~" || datasetArg.startsWith("~/")) datasetArg = path.join(os.homedir(), datasetArg.slice(1));
const dataset = path.resolve(datasetArg);

const isDir = (p) =>
    fs
        .stat(p)
        .then((s) => s.isDirectory())
        .catch(() => false);
if (!(await isDir(dataset))) {
    console.error(`Not a folder: ${dataset}`);
    process.exit(1);
}

const outFile = path.resolve(o.out);
const tableFile = path.resolve(o.table ?? path.join(path.dirname(outFile), `${path.basename(outFile, ".csv")}-versions.csv`));
const countsFile = path.resolve(o.counts ?? path.join(path.dirname(outFile), `${path.basename(outFile, ".csv")}-counts.json`));
const cacheDir = path.resolve(o.cache);
const concurrency = Math.max(1, Number.parseInt(o.concurrency, 10) || 8);
const registry = o.registry.replace(/\/+$/, "");

// ----------------------------------------------------------- scan every folder
const projects = await findProjects(dataset);
if (projects.length === 0) {
    console.error(`No pnpm-installed project folders found under ${dataset} (looking for <folder>/node_modules/.pnpm)`);
    process.exit(1);
}

const stripPeers = (v) => String(v ?? "").split("(")[0].split("_")[0];

/** installed: name -> Map(version -> dir name in .pnpm), read from the directory names only */
async function scanNames(project) {
    const store = path.join(project, "node_modules", ".pnpm");
    const installed = new Map();
    for (const e of await fs.readdir(store, { withFileTypes: true })) {
        if (!e.isDirectory()) continue; // lock.yaml
        const nv = parsePnpmDirName(e.name);
        if (!nv) continue; // node_modules
        if (!installed.has(nv.name)) installed.set(nv.name, new Map());
        if (!installed.get(nv.name).has(nv.version)) installed.get(nv.name).set(nv.version, e.name);
    }
    return installed;
}

/** The package(s) a folder was made for: [{name, version|null}] */
async function rootsOf(project, folder, installed, lock) {
    const pkg = await readJson(path.join(project, "package.json"));
    const declared = Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}), ...(pkg?.optionalDependencies ?? {}) });
    const importer = lock?.importers?.["."] ?? {};
    const resolved = { ...(importer.devDependencies ?? {}), ...(importer.optionalDependencies ?? {}), ...(importer.dependencies ?? {}) };

    let names = declared.filter((n) => installed.has(n));
    if (names.length === 0) {
        // no usable package.json: fall back to the folder name ("@scope+name" / "@scope__name" are scoped names)
        names = [folder, folder.replace("+", "/"), folder.replace("__", "/")].filter((n) => installed.has(n));
    }
    return names.map((name) => {
        const r = resolved[name];
        return { name, version: r ? stripPeers(typeof r === "string" ? r : r.version) : null };
    });
}

/** Direct dependencies of a root package with the versions pnpm resolved for them (lockfile snapshot). */
function directFromLock(lock, root, installed) {
    const snapKey = Object.keys(lock?.snapshots ?? {}).find((k) => k === `${root.name}@${root.version}` || k.startsWith(`${root.name}@${root.version}(`));
    if (!snapKey) return null;
    const snap = lock.snapshots[snapKey];
    const out = [];
    for (const [depName, depSpec] of Object.entries({ ...(snap.dependencies ?? {}), ...(snap.optionalDependencies ?? {}) })) {
        let name = depName;
        let version = stripPeers(depSpec);
        const alias = /^(@?[^@]+)@(\d.*)$/.exec(version); // "npm:" aliases are stored as "real-name@1.2.3"
        if (alias) [, name, version] = alias;
        if (installed.get(name)?.has(version)) out.push({ name, version });
    }
    return out;
}

const folders = []; // {folder, entries: [{name, version}]}
for (const project of projects) {
    const folder = path.basename(project);
    const installed = await scanNames(project);
    const lock = await readLockfile(project);
    const roots = await rootsOf(project, folder, installed, lock);
    const isRoot = (name, version) => roots.some((r) => r.name === name && (r.version === null || r.version === version));

    const entries = new Map(); // "name@version" -> {name, version}
    const add = (name, version) => entries.set(`${name}@${version}`, { name, version });

    if (o.direct) {
        for (const r of roots) {
            const fromLock = r.version ? directFromLock(lock, r, installed) : null;
            if (fromLock) {
                for (const d of fromLock) add(d.name, d.version);
                continue;
            }
            // no lockfile: names from the package's own package.json, every installed version of them
            const versions = installed.get(r.name);
            const dirName = versions && (versions.get(r.version) ?? [...versions.values()][0]);
            if (!dirName) continue;
            const pkg = await readJson(path.join(project, "node_modules", ".pnpm", dirName, "node_modules", r.name, "package.json"));
            for (const depName of Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.optionalDependencies ?? {}) })) {
                for (const v of installed.get(depName)?.keys() ?? []) add(depName, v);
            }
        }
    } else {
        for (const [name, versions] of installed) {
            for (const version of versions.keys()) if (!isRoot(name, version)) add(name, version);
        }
    }
    folders.push({ folder, roots: roots.map((r) => r.name), entries: [...entries.values()] });
}
folders.sort((a, b) => a.folder.localeCompare(b.folder));

// distinct dependency@version over the whole dataset
const distinct = new Map(); // key -> {name, version, usedBy:Set}
for (const f of folders) {
    for (const e of f.entries) {
        const key = `${e.name}@${e.version}`;
        if (!distinct.has(key)) distinct.set(key, { ...e, usedBy: new Set() });
        distinct.get(key).usedBy.add(f.folder);
    }
}
const names = [
    ...new Set([...distinct.values()].filter((d) => semver.valid(d.version)).map((d) => d.name).concat(folders.flatMap((f) => f.roots))),
].sort();
console.log(`${folders.length} package folder(s), ${distinct.size} distinct dependency versions of ${new Set([...distinct.values()].map((d) => d.name)).size} packages`);

// ------------------------------------------------- versions on npm (with disk cache)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await fs.mkdir(cacheDir, { recursive: true });
const stats = { cached: 0, fetched: 0, missing: 0, failed: 0 };

/** -> {versions:[...]} | {missing:true} | {failed:"reason"} */
async function loadVersions(name) {
    const file = path.join(cacheDir, name.replace("/", "__") + ".json");
    if (!o.refresh) {
        try {
            const c = JSON.parse(await fs.readFile(file, "utf8"));
            stats.cached++;
            return c.missing ? { missing: true } : { versions: c.versions };
        } catch {
            /* not cached */
        }
    }
    if (o.offline) {
        stats.failed++;
        return { failed: "not in cache (--offline)" };
    }
    const url = `${registry}/${name.replace("/", "%2F")}`;
    let reason = "";
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*" },
                signal: AbortSignal.timeout(60_000),
            });
            if (res.status === 404) {
                await fs.writeFile(file, JSON.stringify({ name, missing: true }));
                stats.missing++;
                return { missing: true };
            }
            if (res.status === 429 || res.status >= 500) {
                reason = `HTTP ${res.status}`;
                const wait = Number(res.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
                await sleep(Math.min(wait, 30_000));
                continue;
            }
            if (!res.ok) {
                reason = `HTTP ${res.status}`;
                break;
            }
            const doc = await res.json();
            const versions = Object.keys(doc.versions ?? {});
            await fs.writeFile(file, JSON.stringify({ name, fetched: new Date().toISOString(), versions }));
            stats.fetched++;
            return { versions };
        } catch (e) {
            reason = String(e?.message ?? e);
            await sleep(1000 * 2 ** attempt);
        }
    }
    stats.failed++;
    return { failed: reason || "unknown error" };
}

const registryInfo = new Map();
{
    let next = 0;
    let done = 0;
    const worker = async () => {
        while (next < names.length) {
            const name = names[next++];
            registryInfo.set(name, await loadVersions(name));
            done++;
            if (done % 25 === 0 || done === names.length) process.stdout.write(`\r  npm lookups ${done}/${names.length}`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
    if (names.length) process.stdout.write("\n");
}

// ----------------------------------------------------- numbers per installed version
const allVersionsOf = new Map(); // name -> sorted valid versions (after the --stable filter)
for (const [name, info] of registryInfo) {
    if (!info.versions) continue;
    const list = info.versions.filter((v) => semver.valid(v) && (!o.stable || !semver.prerelease(v)));
    allVersionsOf.set(name, list.sort(semver.compare));
}

for (const d of distinct.values()) {
    const info = registryInfo.get(d.name);
    if (!semver.valid(d.version)) d.status = "non_registry_version";
    else if (info?.failed) d.status = "lookup_failed";
    else if (info?.missing) d.status = "not_on_npm";
    else {
        const list = allVersionsOf.get(d.name) ?? [];
        d.total = list.length;
        d.before = list.filter((v) => semver.lt(v, d.version)).length;
        d.after = list.filter((v) => semver.gt(v, d.version)).length;
        d.status = list.includes(semver.clean(d.version)) ? "ok" : "installed_version_not_on_npm";
    }
}

// ------------------------------------------- package -> total number of versions on npm
const counts = {};
for (const name of [...allVersionsOf.keys()].sort((a, b) => a.localeCompare(b))) counts[name] = allVersionsOf.get(name).length;

// ---------------------------------------------------------------------- write CSVs
const csvCell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replaceAll('"', '""')}"` : String(s));
const byNameVersion = (a, b) => a.name.localeCompare(b.name) || (semver.valid(a.version) && semver.valid(b.version) ? semver.compare(a.version, b.version) : a.version.localeCompare(b.version));

// one line per package folder: the package name and a map  dependency -> total versions on npm
// (the package itself included, sorted by name; null where npm gave no count)
const mapCell = (names) =>
    "{" +
    [...new Set(names)]
        .sort((x, y) => x.localeCompare(y))
        .map((n) => `${JSON.stringify(n)}: ${n in counts ? counts[n] : "null"}`)
        .join(", ") +
    "}";

const wide = ["package,dependencies"];
for (const f of folders) {
    wide.push(`${csvCell(f.folder)},${csvCell(mapCell([...f.roots, ...f.entries.map((e) => e.name)]))}`);
}
await fs.mkdir(path.dirname(outFile), { recursive: true });
await fs.writeFile(outFile, wide.join("\n") + "\n");

const table = ["dependency,installed_version,npm_versions_total,npm_versions_before,npm_versions_after,status,used_by_packages"];
for (const d of [...distinct.values()].sort(byNameVersion)) {
    table.push([csvCell(d.name), csvCell(d.version), d.total ?? "", d.before ?? "", d.after ?? "", d.status, d.usedBy.size].join(","));
}
await fs.mkdir(path.dirname(tableFile), { recursive: true });
await fs.writeFile(tableFile, table.join("\n") + "\n");

// -------------------------------------------- package -> total number of versions on npm
await fs.mkdir(path.dirname(countsFile), { recursive: true });
await fs.writeFile(countsFile, JSON.stringify(counts, null, 2) + "\n");

// ------------------------------------------------------------------------- console
const totals = [...allVersionsOf.entries()].map(([name, list]) => [name, list.length]);
const sumAll = totals.reduce((n, [, c]) => n + c, 0);
const top = totals.sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`\nwrote ${outFile}\nwrote ${tableFile}\nwrote ${countsFile}`);
console.log(o.direct ? "dependencies = direct dependencies" : "dependencies = all installed dependencies (every level)", o.stable ? "| stable releases only" : "| all published versions");
console.log(`registry: ${stats.fetched} fetched, ${stats.cached} from cache, ${stats.missing} not on npm, ${stats.failed} failed`);
console.log(`all published versions of the ${allVersionsOf.size} distinct dependencies together: ${sumAll}`);
if (top.length) console.log(`most versions: ${top.map(([n, c]) => `${n} (${c})`).join(", ")}`);
if (stats.failed) console.log(`WARNING: ${stats.failed} lookup(s) failed; run again to retry them (successful ones are cached in ${cacheDir})`);

const noCount = names.filter((n) => !(n in counts));
if (noCount.length) console.log(`no count for ${noCount.length} package(s) (not on npm or lookup failed): ${noCount.slice(0, 10).join(", ")}${noCount.length > 10 ? ", ..." : ""}`);

const skipped = [];
for (const e of await fs.readdir(dataset, { withFileTypes: true })) {
    const dir = path.join(dataset, e.name);
    if ((e.isDirectory() || e.isSymbolicLink()) && !projects.includes(dir) && e.name !== "pkgs" && projects[0] !== dataset && !(await isDir(path.join(dir, "node_modules", ".pnpm")))) {
        skipped.push(e.name);
    }
}
if (skipped.length) {
    console.log(`WARNING: ${skipped.length} folder(s) have no node_modules/.pnpm (install failed?) and are not in the CSV: ${skipped.slice(0, 20).join(", ")}${skipped.length > 20 ? ", ..." : ""}`);
}
