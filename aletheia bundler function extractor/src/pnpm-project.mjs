/**
 * Reading a pnpm-installed project folder (the layout `fetch-each.sh` produces):
 *   <project>/package.json, pnpm-lock.yaml, node_modules/.pnpm/<name>@<ver>[_peers]/node_modules/<name>/
 */
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

const isDir = (p) =>
    fs
        .stat(p)
        .then((s) => s.isDirectory())
        .catch(() => false);

/** Split "name@version" (scoped names allowed) at the last "@". */
export function splitNameVersion(spec) {
    const i = spec.lastIndexOf("@");
    if (i <= 0) return null;
    return { name: spec.slice(0, i), version: spec.slice(i + 1) };
}

/** "@scope+name@1.2.3_peer@4" -> {name:"@scope/name", version:"1.2.3"} */
export function parsePnpmDirName(dirName) {
    const at = dirName.indexOf("@", 1);
    if (at < 0) return null;
    const name = dirName.slice(0, at).replace("+", "/");
    const version = dirName.slice(at + 1).split("_")[0].split("(")[0];
    return { name, version };
}

/** Find project folders below `root`. */
export async function findProjects(root) {
    root = path.resolve(root);
    if (await isDir(path.join(root, "node_modules", ".pnpm"))) return [root];
    const base = (await isDir(path.join(root, "pkgs"))) ? path.join(root, "pkgs") : root;
    const projects = [];
    for (const e of await fs.readdir(base, { withFileTypes: true })) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        const dir = path.join(base, e.name);
        if (await isDir(path.join(dir, "node_modules", ".pnpm"))) projects.push(dir);
    }
    return projects.sort();
}

/**
 * Enumerate installed package versions of a project.
 * @returns {Promise<Map<string, {name, version, dir}>>} key "name@version"
 */
export async function scanInstalled(project) {
    const store = path.join(project, "node_modules", ".pnpm");
    const found = new Map();
    for (const e of await fs.readdir(store, { withFileTypes: true })) {
        if (!e.isDirectory()) continue; // skips lock.yaml
        const nv = parsePnpmDirName(e.name);
        if (!nv) continue;
        const dir = path.join(store, e.name, "node_modules", nv.name);
        // the package itself is a real directory, its dependencies are symlinks
        const st = await fs.lstat(dir).catch(() => null);
        if (!st || !st.isDirectory()) continue;
        const key = `${nv.name}@${nv.version}`;
        if (!found.has(key)) found.set(key, { ...nv, dir });
    }
    return found;
}

/** Parse pnpm-lock.yaml (lockfileVersion 9). Returns null if absent/unreadable. */
export async function readLockfile(project) {
    try {
        return YAML.parse(await fs.readFile(path.join(project, "pnpm-lock.yaml"), "utf8"));
    } catch {
        return null;
    }
}

export async function readJson(file) {
    try {
        return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
        return null;
    }
}
