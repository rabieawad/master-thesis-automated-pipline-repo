/**
 * CycloneDX 1.5 SBOM for one pnpm project, built from pnpm-lock.yaml
 * (exact versions, integrity hashes, dependency edges) plus the license/author
 * metadata from the installed package.json files.
 */
import path from "node:path";
import crypto from "node:crypto";
import { readJson, splitNameVersion } from "./pnpm-project.mjs";

const TOOL = { type: "application", name: "aletheia-refdb", version: "0.1.0" };

const SPDX_IDS = new Set(
    `0BSD AFL-3.0 AGPL-3.0-only AGPL-3.0-or-later Apache-2.0 Artistic-2.0 BSD-2-Clause BSD-3-Clause BSD-3-Clause-Clear
BlueOak-1.0.0 CC-BY-3.0 CC-BY-4.0 CC0-1.0 EPL-1.0 EPL-2.0 GPL-2.0-only GPL-2.0-or-later GPL-3.0-only GPL-3.0-or-later
ISC LGPL-2.1-only LGPL-2.1-or-later LGPL-3.0-only LGPL-3.0-or-later MIT MIT-0 MPL-2.0 Python-2.0 Unlicense WTFPL Zlib`.split(/\s+/),
);

export function purl(name, version) {
    const n = name.startsWith("@") ? "%40" + name.slice(1) : name;
    return `pkg:npm/${n}@${version}`;
}

/** Strip pnpm's peer-dependency suffix: "1.0.0(react@18)" -> "1.0.0" */
const stripPeers = (v) => String(v).replace(/\(.*$/, "");

/** Resolve a lockfile dependency entry (name -> version spec) to name@version. */
function resolveDep(name, spec) {
    spec = stripPeers(spec);
    if (spec.startsWith("npm:")) return splitNameVersion(spec.slice(4)) ?? { name, version: spec };
    return { name, version: spec };
}

function integrityToHash(integrity) {
    const m = /^(sha1|sha256|sha384|sha512)-(.+)$/.exec(integrity ?? "");
    if (!m) return null;
    const alg = { sha1: "SHA-1", sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" }[m[1]];
    return { alg, content: Buffer.from(m[2], "base64").toString("hex") };
}

function licenses(pkgJson) {
    const raw = pkgJson?.license ?? pkgJson?.licenses;
    const list = [];
    const add = (l) => {
        if (!l) return;
        if (typeof l === "object") l = l.type ?? l.name;
        if (typeof l !== "string") return;
        if (/\s(OR|AND|WITH)\s/.test(l)) list.push({ expression: l.replace(/^\((.*)\)$/, "$1") });
        else if (SPDX_IDS.has(l)) list.push({ license: { id: l } });
        else list.push({ license: { name: l } });
    };
    Array.isArray(raw) ? raw.forEach(add) : add(raw);
    return list;
}

function authorName(a) {
    if (!a) return undefined;
    return typeof a === "string" ? a.replace(/\s*[<(].*$/, "").trim() || undefined : a.name;
}

/**
 * @param {object} p
 * @param {string} p.projectName
 * @param {object|null} p.lock  parsed pnpm-lock.yaml
 * @param {Map<string,{name,version,dir}>} p.installed
 * @param {Map<string,object>} p.results bundle results keyed "name@version"
 * @param {string} p.outRoot  output root (to make bundle paths relative)
 */
export async function buildSbom({ projectName, lock, installed, results, outRoot }) {
    const components = new Map(); // key name@version -> component
    const edges = new Map(); // ref -> Set(ref)

    const ensure = (name, version) => {
        const key = `${name}@${version}`;
        if (!components.has(key)) {
            components.set(key, { type: "library", "bom-ref": purl(name, version), name, version, purl: purl(name, version) });
        }
        return components.get(key);
    };

    // components from the lockfile (authoritative), edges from snapshots
    if (lock?.packages) {
        for (const [spec, info] of Object.entries(lock.packages)) {
            const nv = splitNameVersion(stripPeers(spec).replace(/^\//, ""));
            if (!nv) continue;
            const c = ensure(nv.name, nv.version);
            const h = integrityToHash(info?.resolution?.integrity);
            if (h) c.hashes = [h];
            if (info?.resolution?.tarball) c.externalReferences = [{ type: "distribution", url: info.resolution.tarball }];
        }
    }
    for (const [spec, snap] of Object.entries(lock?.snapshots ?? {})) {
        const nv = splitNameVersion(stripPeers(spec).replace(/^\//, ""));
        if (!nv) continue;
        const ref = purl(nv.name, nv.version);
        const set = edges.get(ref) ?? new Set();
        for (const field of ["dependencies", "optionalDependencies"]) {
            for (const [dn, dv] of Object.entries(snap?.[field] ?? {})) {
                const d = resolveDep(dn, dv);
                ensure(d.name, d.version);
                set.add(purl(d.name, d.version));
            }
        }
        edges.set(ref, set);
    }
    // no lockfile: fall back to what is installed (no edges)
    if (components.size === 0) for (const { name, version } of installed.values()) ensure(name, version);

    // enrich from installed package.json + bundle results
    for (const [key, c] of components) {
        const inst = installed.get(key);
        if (inst) {
            const pj = await readJson(path.join(inst.dir, "package.json"));
            if (pj) {
                const l = licenses(pj);
                if (l.length) c.licenses = l;
                const a = authorName(pj.author);
                if (a) c.author = a;
                if (typeof pj.description === "string" && pj.description) c.description = pj.description;
                if (pj.homepage && typeof pj.homepage === "string") {
                    c.externalReferences = [...(c.externalReferences ?? []), { type: "website", url: pj.homepage }];
                }
            }
        }
        const r = results.get(key);
        if (r) {
            const props = [{ name: "aletheia:strategy", value: String(r.strategy ?? "") }];
            props.push({ name: "aletheia:selectedFiles", value: String(r.selectedFiles?.length ?? 0) });
            props.push({ name: "aletheia:emptyBundle", value: String(Boolean(r.empty)) });
            if (r.outFile) {
                props.push({ name: "aletheia:pseudoBundle", value: path.relative(outRoot, r.outFile) });
                props.push({ name: "aletheia:pseudoBundleSha256", value: r.sha256 });
            }
            if (r.error) props.push({ name: "aletheia:error", value: r.error.split("\n")[0] });
            c.properties = props;
        }
    }

    // root component + its direct dependencies
    const rootRef = `root:${projectName}`;
    const rootDeps = new Set();
    for (const group of ["dependencies", "optionalDependencies"]) {
        for (const [dn, entry] of Object.entries(lock?.importers?.["."]?.[group] ?? {})) {
            const d = resolveDep(dn, typeof entry === "object" ? entry.version : entry);
            ensure(d.name, d.version);
            rootDeps.add(purl(d.name, d.version));
        }
    }

    const dependencies = [{ ref: rootRef, dependsOn: [...rootDeps].sort() }];
    for (const c of components.values()) {
        dependencies.push({ ref: c["bom-ref"], dependsOn: [...(edges.get(c["bom-ref"]) ?? [])].sort() });
    }

    return {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        serialNumber: "urn:uuid:" + crypto.randomUUID(),
        version: 1,
        metadata: {
            timestamp: new Date().toISOString(),
            tools: { components: [TOOL] },
            component: { type: "application", "bom-ref": rootRef, name: projectName },
        },
        components: [...components.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"])),
        dependencies,
    };
}
