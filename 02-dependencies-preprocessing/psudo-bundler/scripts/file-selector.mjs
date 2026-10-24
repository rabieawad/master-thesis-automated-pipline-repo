import fs from "node:fs/promises";
import path from "node:path";
import * as walk from "acorn-walk";
import "./identification/utils.mjs";
import { parseLoose } from "./identification/identify_bundler.mjs";

/**
 * Select appropriate files from a JavaScript package for further analysis
 *
 * @param {string} dirname Absolute path of the package root
 * @param {(...any) => void} log
 * @returns {Promise<{files: string[], fallback: boolean}>}
 */
export async function fileSelector(dirname, log = () => {}) {
    let fallback = false;

    function fullpath(relative, fulldir = dirname) {
        log(relative, "->", path.normalize(path.join(fulldir, relative)));
        return path.normalize(path.join(fulldir, relative));
    }

    const entries = await fs.readdir(dirname, { recursive: true, withFileTypes: true });

    const packageJsons = {};
    await Promise.all(
        entries
            .filter((e) => e.name === "package.json")
            .filter((e) => !e.parentPath.includes("node_modules"))
            .map(async (e) => {
                try {
                    packageJsons[e.parentPath] = JSON.parse(
                        await fs.readFile(path.join(e.parentPath, e.name), { encoding: "utf8" }),
                    );
                } catch (err) {
                    log("Cannot parse package.json", e.parentPath, e.name, err);
                }
            }),
    );

    log("Found package.jsons:", packageJsons);

    const mainPackageJson = Object.entries(packageJsons).sort(
        (a, b) => a[0].countChar("/") - b[0].countChar("/"),
    )[0][1];
    const pkgname = mainPackageJson.name;

    if (typeof (mainPackageJson.unpkg || mainPackageJson.jsdelivr) === "string") {
        log("unpkg or jsdelivr");
        return {
            fallback,
            files: [fullpath(mainPackageJson.unpkg || mainPackageJson.jsdelivr)],
        };
    }

    if (mainPackageJson.browser && typeof mainPackageJson.browser === "string") {
        log("browser is string");
        return {
            fallback,
            files: [fullpath(mainPackageJson.browser)],
        };
    }

    let selectedFilenames = [];

    /**
     * Evaluates a conditional export dictionary with possibly nested expressions.
     * All subpath keys should be eliminated
     */
    function evaluateConditionals(conditional) {
        const conditionalExportPriority = ["browser", "default", "import", "production", "require", "node"];

        log("Evaluating conditional exports", JSON.stringify(conditional));
        for (const key of conditionalExportPriority) {
            if (conditional[key] && typeof conditional[key] === "string") {
                log("Taking key", key);
                return conditional[key];
            } else if (conditional[key] && typeof conditional[key] === "object") {
                log("Recursion into key", key);
                return evaluateConditionals(conditional[key]);
            }
        }
        log("No suitable conditional found");
        return undefined;
    }

    const exports = {};
    for (const [packageJsonPath, packageJson] of Object.entries(packageJsons)) {
        const previousAmountOfEntrypoints = selectedFilenames.length;
        if (packageJson.exports) {
            log("exports available");
            if (typeof packageJson.exports === "string") {
                log("Selecting entrypoint", packageJson.exports);
                selectedFilenames.push(
                    ...[
                        await resolveModule(path.join(packageJsonPath, "package.json"), packageJson.exports, {}),
                    ].filter((p) => !!p),
                );
            } else if (Array.isArray(packageJson.exports)) {
                log(
                    "Selecting entrypoints",
                    packageJson.exports.filter((e) => typeof e === "string"),
                );
                selectedFilenames.push(
                    ...(
                        await Promise.all(
                            packageJson.exports
                                .filter((e) => typeof e === "string")
                                .map((p) => resolveModule(path.join(packageJsonPath, "package.json"), p, {})),
                        )
                    ).filter((p) => !!p),
                );
            } else {
                const rootConditionals = {};
                for (const key in packageJson.exports) {
                    if (key.startsWith(".")) {
                        // Case 1: Subpath export
                        let exportSpec = packageJson.exports[key];
                        if (exportSpec && typeof exportSpec === "object") exportSpec = evaluateConditionals(exportSpec);

                        if (typeof exportSpec === "string") {
                            // Strings
                            log("Storing subpath export", key, "->", exportSpec);
                            exports[fullpath(key)] = fullpath(exportSpec);

                            // Add to queue if not wildcard
                            if (!exportSpec.includes("*"))
                                selectedFilenames.push(
                                    ...[
                                        await resolveModule(path.join(packageJsonPath, "package.json"), exportSpec, {}),
                                    ].filter((p) => !!p),
                                );
                        }
                    } else {
                        // Case 2: Conditional root export
                        log("Collecting root conditional", key);
                        rootConditionals[key] = packageJson.exports[key];
                    }
                }

                const rootEntrypoint = evaluateConditionals(rootConditionals);
                if (rootEntrypoint) {
                    log("Selecting entrypoint", rootEntrypoint);
                    selectedFilenames.push(
                        ...[await resolveModule(path.join(packageJsonPath, "package.json"), rootEntrypoint, {})].filter(
                            (p) => !!p,
                        ),
                    );
                }
            }

            // structure: "browser": {
            //   "pkgname": False, // disabled, but we can ignore as its not resolved for us anyway
            //   "filename": "replacement", // We should consider replaced/redirected file resolutions
            // }
            if (typeof packageJson.browser === "object") {
                log("browser is object");
                for (const [key, value] of Object.entries(packageJson.browser)) {
                    if (typeof value === "string") {
                        // todo rewrite exports object
                    }
                }
            }
        }

        if (packageJson.exports && previousAmountOfEntrypoints === selectedFilenames.length) {
            log("WARNING: Could not evaluate exports although present", packageJson.exports);
        }

        if (previousAmountOfEntrypoints === selectedFilenames.length) {
            // Check main only if we could not evaluate exports
            // todo handle empty index.js
            const mainfile = await resolveModule(
                path.join(packageJsonPath, "package.json"),
                "./" + (packageJson.main || packageJson.module || "index"),
                {},
            );
            if (mainfile) {
                log(
                    "No exports available. Using field",
                    (packageJson.main && "main") || (packageJson.module && "module") || "(default)",
                    "with value",
                    mainfile,
                );
                selectedFilenames.push(mainfile);
            }
        }
    }

    function hasExt(filepath) {
        return filepath.split("/").slice(-1)[0].includes(".");
    }

    /**
     * Resolve the extension of a file
     *
     * @param fullpath
     * @return {Promise<string | undefined>}
     */
    async function addExt(fullpath) {
        /** @type {(string) => Promise<string | false>} */
        const exists = (f) =>
            fs
                .stat(f)
                .then((stat) => stat.isFile() && f)
                .catch(() => false);
        return Promise.all([
            exists(`${fullpath}`),
            exists(`${fullpath}.js`),
            exists(`${fullpath}.mjs`),
            exists(`${fullpath}.cjs`),
        ])
            .then((avail) => avail.filter((f) => !!f)[0])
            .then((v) => (v || log("WARNING: Could not resolve", fullpath), v));
    }

    /**
     * Resolves the target of a package-level import
     *
     * @param {string} filename Fullpath of the current source file
     * @param {string} importname Name of imported module
     * @param {Record<string, string>} exportsArray exports array specification
     * @return {Promise<string | undefined>}
     */
    async function resolveModule(filename, importname, exportsArray) {
        // Check if package-level reference
        // https://nodejs.org/api/packages.html#self-referencing-a-package-using-its-name
        if (pkgname) {
            if (importname === pkgname) {
                importname = path.relative(path.basename(filename), dirname);
                log("Self reference found. Resolving", pkgname, "->", importname);
            } else if (importname.startsWith(`${pkgname}/`)) {
                const old = importname;
                importname = path.relative(
                    path.basename(filename),
                    path.join(dirname, importname.slice(importname.length)),
                );
                log("Self reference found. Resolving", old, "->", importname);
            }
        }

        if (!importname.startsWith(".")) return undefined;

        let fullname = path.normalize(path.join(path.dirname(filename), importname));
        // ext is the file extension if one is available, else undefined
        const ext = hasExt(fullname) ? fullname.split("/").slice(-1)[0].split(".").slice(-1)[0] : undefined;
        const fullnameNoExt = ext ? fullname.slice(0, -ext.length - 1) : fullname;

        // First match direct rules
        for (const key in exportsArray) {
            if (!key.includes("*")) {
                if (hasExt(key)) {
                    if (key === fullname) {
                        fullname = exportsArray[key];
                        break;
                    }
                } else if (key === fullnameNoExt) {
                    fullname = exportsArray[key];
                    break;
                }
            }
        }

        // Then match wildcards
        for (const key in exportsArray) {
            if (key.includes("*")) {
                let i = 0,
                    j = 0;
                const globRegex = new RegExp(
                    key
                        .replaceAll(".", "\\.")
                        .replaceAll("**/", "(?<doublestar>([^/]+/)*)")
                        .replaceAll("*", "(?<singlestar>[^/]+)")
                        .replaceAll("<doublestar>", () => `<doublestar${i++}>`)
                        .replaceAll("<singlestar>", () => `<singlestar${j++}>`),
                );
                const matches = globRegex.exec(fullname);

                if (matches) {
                    let k = 0,
                        h = 0;
                    let target = exportsArray[key]
                        .replaceAll("**/", () => `<doublestar${k++}>/`)
                        .replaceAll("*", () => `<singlestar${h++}>`);

                    for (let ii = 0; ii < i; ii++)
                        target = target.replace(`<doublestar${ii}>`, matches.groups[`doublestar${ii}`]);

                    for (let jj = 0; jj < j; jj++)
                        target = target.replace(`<singlestar${jj}>`, matches.groups[`singlestar${jj}`]);

                    log(`Applying wildcard ${key} -> ${exportsArray[key]}`);
                    log(`with values ${fullname} -> ${target}`);
                    fullname = target;
                }
            }
        }

        const earlyResolve = await addExt(fullname);

        if (earlyResolve) {
            // Early return if file
            return earlyResolve;
        } else if (
            await fs
                .stat(fullname)
                .then((stat) => stat.isDirectory())
                .catch(() => false)
        ) {
            log("Detected directory at", fullname);
            // Check for nested package.jsons here
            if (packageJsons[fullname]) {
                if (packageJsons[fullname].exports) {
                    // todo we should evaluate nested "exports": {} here
                    log(new Error("ERROR exports available in nested package.json but unused"));
                }

                const old = fullname;
                fullname = path.normalize(
                    path.join(fullname, packageJsons[fullname].main || packageJsons[fullname].module || "index"),
                );
                log("Resolved with nested package json:", old, "->", fullname);
            } else {
                fullname = path.normalize(path.join(fullname, "index"));
                log("Resolved with default:", fullname);
            }
            return addExt(fullname);
        } else {
            return undefined;
        }
    }

    /**
     * Fetch all package-level imports from a given source file
     *
     * @param {string} filename
     * @param {Program} ast Top-Level AST node
     * @return {Promise<*[]>}
     */
    async function fetchImports(filename, ast) {
        const base = walk.base;
        base.ImportDeclaration = function (node, st, c) {
            c(node, st, "HasSourceReference");
            for (let i = 0, list = node.specifiers; i < list.length; i += 1) {
                c(list[i], st);
            }
            c(node.source, st, "Expression");
        };
        base.ExportDeclaration = function (node, st, c) {
            c(node, st, "HasSourceReference");
        };
        base.ExportAllDeclaration = function (node, st, c) {
            c(node, st, "HasSourceReference");
            if (node.exported) {
                c(node.exported, st);
            }
            c(node.source, st, "Expression");
        };
        base.ExportNamedDeclaration = function (node, st, c) {
            c(node, st, "HasSourceReference");
            if (node.declaration) {
                c(
                    node.declaration,
                    st,
                    node.type === "ExportNamedDeclaration" || node.declaration.id ? "Statement" : "Expression",
                );
            }
            if (node.source) {
                c(node.source, st, "Expression");
            }
        };
        base.CallExpression = function (node, st, c) {
            if (node.callee && node.callee.type === "Identifier" && node.callee.name === "require") {
                if (node.arguments && node.arguments.length && node.arguments[0].type === "Literal") {
                    node.source = node.arguments[0];
                    c(node, st, "HasSourceReference");
                }
            }
            c(node.callee, st, "Expression");
            if (node.arguments) {
                for (let i = 0, list = node.arguments; i < list.length; i += 1) {
                    c(list[i], st, "Expression");
                }
            }
        };
        base.HasSourceReference = (..._) => {};

        const imports = [];

        walk.simple(
            ast,
            {
                HasSourceReference(node) {
                    if (node.source) {
                        const referencePromise = resolveModule(filename, node.source.value, exports);
                        imports.push(referencePromise);
                    }
                },
            },
            base,
        );

        return Promise.all(imports);
    }

    if (selectedFilenames.length === 0) {
        log("WARNING: No entry point found. Using all index files we find");
        selectedFilenames.push(
            ...entries
                .filter((e) => e.isFile() && ["index.js", "index.mjs", "index.cjs"].includes(e.name))
                .map((e) => fullpath(e.name, e.parentPath)),
        );
    }

    const fetched = new Set();
    const stack = selectedFilenames;
    while (stack.length > 0) {
        const file = stack.shift();
        if (fetched.has(file)) continue;

        log(`Taking unfetched file ${file} from stack`);

        await fs
            .readFile(file, { encoding: "utf8" })
            .then(async (contents) => {
                try {
                    const imports = await fetchImports(file, parseLoose(contents));
                    stack.push(...imports.filter((i) => i && !fetched.has(i)));
                } catch (e) {
                    // Probably JSON
                    log(e);
                }

                fetched.add(file);
            })
            .catch(log);
    }

    if (fetched.size > 0) {
        return {
            fallback,
            files: [...fetched],
        };
    }

    fallback = true;
    log("WARNING: FALLBACK");
    // Fallback
    const filenames = entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)); // path relative to dirname

    selectedFilenames = filenames.filter(
        (file) =>
            file.slice(-2) === "js" &&
            !file.slice(dirname.length).includes("test") &&
            !file.slice(dirname.length).includes("example") &&
            !file.slice(dirname.length).includes("vendor"),
    );

    if (selectedFilenames.filter((file) => file.slice(dirname.length).includes("dist")).length > 0) {
        // Only dist if available
        selectedFilenames = selectedFilenames.filter((file) => file.slice(dirname.length).includes("dist"));
    }

    if (selectedFilenames.filter((file) => file.slice(dirname.length).includes(".min.")).length > 0) {
        // Only minified if available
        selectedFilenames = selectedFilenames.filter((file) => file.slice(dirname.length).includes(".min."));
    }

    return {
        fallback,
        files: selectedFilenames,
    };
}

if (process.argv[1].includes("file-selector")) {
    fileSelector(process.cwd(), console.debug).then(console.log);
}
