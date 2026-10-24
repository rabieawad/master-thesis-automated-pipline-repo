import * as walk from "acorn-walk";
import { SourceMapConsumer } from "source-map-js";

import identifyBundler, { parse } from "./identify_bundler.mjs";

import fs from "node:fs";

const types = (
    "Statement|Expression|Declaration|ModuleDeclaration|Literal|SwitchCase|CatchClause|Property|Super|SpreadElement|" +
    "TemplateElement|AssignmentProperty|ObjectPattern|ArrayPattern|RestElement|AssignmentPattern|ClassBody|MethodDefinition|MetaProperty|" +
    "ImportSpecifier|ImportDefaultSpecifier|ImportNamespaceSpecifier|ExportSpecifier|AnonymousFunctionDeclaration|AnonymousClassDeclaration|" +
    "PropertyDefinition|PrivateIdentifier|StaticBlock|VariableDeclarator"
).split("|");
const excluded = "VariableDeclaration".split("|");

if (!Set.prototype.intersection) {
    // Polyfill intersection
    /**
     * Returns the intersection of two sets as a new Set
     *
     * @template T
     * @param {Set<T>} other
     * @returns {Set<T>}
     */
    Set.prototype.intersection = (other) => new Set([...other].filter((i) => this.has(i)));
}

function flatten(ast) {
    const l = [];
    walk.simple(
        ast,
        types.reduce((prev, cur) => ((prev[cur] = prev[cur] || ((n) => l.push(n.type))), prev), {}),
    );
    return l.filter((t) => !excluded.includes(t)).join(",");
}

class SourceMapResolver extends SourceMapConsumer {
    constructor(source, rawMap) {
        super(rawMap);

        // SourceMapConsumer is not a real class, hence we need these
        this.constructor = SourceMapResolver;
        this.resolve = SourceMapResolver.prototype.resolve.bind(this);

        /** @type MappingItem[] */
        const mappings = [];
        this.eachMapping((m) => mappings.push(m), undefined, SourceMapConsumer.GENERATED_ORDER);

        let line = 1,
            column = 1,
            offset = 0;

        this.mappingsByOffset = new Map();

        const advance = () => {
            if (source[offset++] === "\n") {
                line++;
                column = 1;
            } else {
                column++;
            }
        };

        for (const mapping of mappings) {
            while (offset < source.length && (mapping.generatedLine > line || mapping.generatedColumn > column)) {
                advance();
            }
            this.mappingsByOffset.set(offset, mapping.source);
        }
    }

    resolve(node) {
        // Map.keys() respects insertion order, which was incremental
        for (const k of this.mappingsByOffset.keys()) {
            if (k < node.start) continue;
            if (k > node.end) break;
            return this.mappingsByOffset.get(k);
        }
        return undefined;
    }
}

export function getNpmName(fullname) {
    const re = /node_modules\/(@[^\/]+\/[^\/]+|[^\/@]+)/g;
    let matches = re.exec(fullname);
    // For paths with multiple node_modules, we take the last one
    while (matches) {
        // Iterating here is weird, idk who designed this API
        const newMatches = re.exec(fullname);
        if (!newMatches) break; // We only want to override if we find another one
        matches = newMatches;
    }
    return matches ? `node:${matches[1]}` : undefined;
}

function resolveNodeName(node, source, map, i) {
    if (!map?.resolve) return i;

    const name = map.resolve(node);
    if (!name) console.warn(`Could not resolve module id ${i} (start ${node.start}, end ${node.end})`);
    return name ?? i;
}

function collectDeclaratedNames(decl) {
    if (!decl) return [];
    switch (decl.type) {
        case "Identifier":
            return [decl.name];
        case "ArrayPattern":
            return decl.elements.map(collectDeclaratedNames).flat();
        case "ObjectPattern":
            return decl.properties.map((p) => collectDeclaratedNames(p.value)).flat();
        case "RestElement":
            return collectDeclaratedNames(decl.argument);
        case "AssignmentPattern":
            return collectDeclaratedNames(decl.left);
        case "Expression":
        // Expressions do not declare new identifiers
    }
    return [];
}

function dependencyRelationsBaseOverrides() {
    const baseOverrides = Object.assign({}, walk.base);
    baseOverrides.Declaration = (_node, _st, _c) => {};
    baseOverrides.FunctionDeclaration = function (node, st, c) {
        c(node, st, "Declaration");
        walk.base.FunctionDeclaration(node, st, c);
    };
    baseOverrides.VariableDeclaration = function (node, st, c) {
        c(node, st, "Declaration");
        walk.base.VariableDeclaration(node, st, c);
    };
    baseOverrides.ClassDeclaration = function (node, st, c) {
        c(node, st, "Declaration");
        walk.base.ClassDeclaration(node, st, c);
    };
    baseOverrides.ArrowFunctionExpression = function (node, st, c) {
        c(node, st, "Declaration");
        walk.base.ArrowFunctionExpression(node, st, c);
    };
    baseOverrides.FunctionExpression = function (node, st, c) {
        c(node, st, "Declaration");
        walk.base.FunctionExpression(node, st, c);
    };
    return baseOverrides;
}

function flagBlocks(node, ancestors, requireFunc, flaggedBlocksList) {
    let flag = false;
    switch (node.type) {
        case "VariableDeclaration":
            if (
                node.declarations
                    .map((decl) => collectDeclaratedNames(decl.id))
                    .flat()
                    .includes(requireFunc)
            )
                flag = true;
            break;
        case "ArrowFunctionExpression":
        case "FunctionExpression":
        case "FunctionDeclaration":
            if (node.params.map(collectDeclaratedNames).flat().includes(requireFunc)) {
                // Lambdas might have no block as body, so we flag the function direct
                // This needs special treatment, so we do it here
                flaggedBlocksList.push(node);
                break;
            }
        // fallthrough
        case "ClassDeclaration":
            if (node.id && node.id.name === requireFunc) flag = true;
            break;
    }
    if (flag) {
        for (let i = ancestors.length - 1; i >= 0; i--) {
            if (ancestors[i].type === "BlockStatement") {
                flaggedBlocksList.push(ancestors[i]);
                break;
            }
        }
    }
}

export function fetchDependencyRelations(modules, source = "", bundler = "") {
    // esbuild (respectively bun) needs to be treated differently, as the require function is replaced by a
    // seperate function for each module.
    if (bundler === "esbuild" || bundler === "bun") return fetchDependencyRelationsEsbuild(modules, source);

    const dependencyGraphList = [];
    const baseOverrides = dependencyRelationsBaseOverrides();

    let requireFunctionIndex;
    switch (bundler) {
        case "webpack":
            requireFunctionIndex = 2;
            break;
        case "browserify":
        case "parcel":
            requireFunctionIndex = 0;
            break;
        default:
            requireFunctionIndex = 2;
            break;
    }

    for (const { id, ast: mod, text } of Object.values(modules)) {
        // Browserify and Parcel modules consist of arrays containing the module code in a function and the requirements
        // in an Object
        let module = mod.type === "ArrayExpression" ? mod.elements[0] : mod;
        if (!module.params) {
            console.error(module);
        }
        if (module.params.length < 3) continue;
        const requireFunc = module.params[requireFunctionIndex].name;
        let flaggedBlocks = []; // If requireFunc is re-defined the corresponding block gets flagged
        let debug = false;
        walk.ancestor(
            module.body,
            {
                Expression(node, _state, ancestors) {
                    if (
                        node.type === "CallExpression" &&
                        node.callee.type === "Identifier" &&
                        node.callee.name === requireFunc
                    ) {
                        // Is RequireFunc overwritten in this scope?
                        if (ancestors.filter((a) => flaggedBlocks.includes(a)).length > 0) return;

                        if (!node.arguments || !node.arguments[0]) {
                            console.log(
                                "Unexpected empty arguments",
                                node.loc.start ?? getPos(source, node.start),
                                source.slice(node.start - 16, node.end + 16).slice(0, 128),
                            );
                            console.log(
                                "Ancestors:",
                                ancestors.map((a) => a.type),
                            );
                            console.log(
                                "Flagged Blocks:",
                                flaggedBlocks.map((a) => `${a.type} ${a.loc.start}`),
                            );
                            console.log("requireFunc:", requireFunc);
                            // console.log("Id:", id);
                            // console.log("text:", text);
                            return;
                        }

                        if (node.arguments[0].type.slice(-7) === "Literal") {
                            dependencyGraphList.push([id, node.arguments[0].value]);
                        }
                    }
                },
                Declaration(node, _state, ancestors) {
                    flagBlocks(node, ancestors, requireFunc, flaggedBlocks);
                },
            },
            baseOverrides,
        );
    }
    return dependencyGraphList;
}

export function fetchDependencyRelationsEsbuild(modules, source = "") {
    let requireFunctionNames = Object.values(modules).map((mod) => mod.identifier);
    const dependencyGraphList = [];
    const baseOverrides = dependencyRelationsBaseOverrides();
    for (const { ast: module, id: id } of Object.values(modules)) {
        let flaggedBlocks = {}; // If a specific requireFunc is re-defined the corresponding block gets flagged
        for (let name of requireFunctionNames) {
            flaggedBlocks[name] = [];
        }
        walk.ancestor(
            module,
            {
                Declaration(node, _state, ancestors) {
                    for (let requireFunc of requireFunctionNames) {
                        flagBlocks(node, ancestors, requireFunc, flaggedBlocks[requireFunc]);
                    }
                },
            },
            baseOverrides,
        );
        walk.ancestor(
            module,
            {
                Expression(node, _state, ancestors) {
                    if (
                        node.type === "CallExpression" &&
                        node.callee.type === "Identifier" &&
                        requireFunctionNames.includes(node.callee.name)
                    ) {
                        const requireFunction = node.callee.name;
                        // Is RequireFunc overwritten in this scope?
                        if (ancestors.filter((a) => flaggedBlocks[requireFunction].includes(a)).length > 0) return;

                        dependencyGraphList.push([id, requireFunction]);
                    }
                },
            },
            baseOverrides,
        );
    }
    return dependencyGraphList;
}

export function extractModulesFromAstNode(objectOrArrayExpression, source, map) {
    const node = objectOrArrayExpression;
    let i = 0;
    return (node.elements ?? node.properties ?? []).reduce((prev, cur) => {
        const key = cur?.key?.value ?? i;
        cur = cur?.value ?? cur;

        if (!cur) {
            i++;
            return prev;
        }

        if (cur.type === "ArrayExpression") {
            cur = cur.elements[0];
        }

        prev[key] = {
            id: key,
            ast: cur,
            text: source.slice(cur.start, cur.end),
            name: resolveNodeName(cur.body, source, map, key) ?? key,
        };
        i++;
        return prev;
    }, {});
}

export function identifyWebpackChunkCompartments(source, sourcemap) {
    const ast = parse(source);
    let map;
    try {
        map = sourcemap ? new SourceMapResolver(source, JSON.parse(sourcemap)) : {};
    } catch (e) {
        map = {};
    }

    let moduleCandidates = new Map();

    walk.ancestor(ast, {
        Expression(node, _state, ancestors) {
            if (node.type === "MemberExpression") {
                if (node.property.type === "Identifier" && node.property.name === "push") {
                    if (
                        flatten(node.object) ===
                        "Identifier,Identifier,MemberExpression,ArrayExpression,LogicalExpression,AssignmentExpression"
                    ) {
                        // We are at the correct position
                        const callExpr = ancestors.slice(-2)[0];
                        if (callExpr.type !== "CallExpression") {
                            console.warn("Fingerprint imprecise, expected CallExpression");
                            return;
                        }

                        if (callExpr.arguments.length === 0) {
                            console.warn("Fingerprint imprecise, CallExpression should have arguments");
                            return;
                        }
                        const pushArray = callExpr.arguments[0];
                        if (!(pushArray.elements?.length > 1)) {
                            console.warn("Fingerprint imprecise, pushArray malformed");
                            return;
                        }
                        const moduleObject = pushArray.elements[1];

                        if (!moduleCandidates.has(moduleObject.end - moduleObject.start)) {
                            moduleCandidates.set(
                                moduleObject.end - moduleObject.start,
                                extractModulesFromAstNode(moduleObject, source, map),
                            );
                        }
                    }
                }
            }
        },
    });

    // Only take largest modules
    const modules = moduleCandidates.get(Math.max(...moduleCandidates.keys())) ?? {};

    return {
        dependencies: fetchDependencyRelations(modules, source, "webpack"),
        modules,
    };
}

export function identifyWebpackCompartments(source, sourcemap) {
    const ast = parse(source);
    let map;
    try {
        map = sourcemap ? new SourceMapResolver(source, JSON.parse(sourcemap)) : {};
    } catch (e) {
        map = {};
    }

    let moduleCandidates = new Map();

    walk.ancestor(ast, {
        Expression(node, _state, ancestors) {
            if (
                (node.type === "ArrayExpression" &&
                    node.elements.length > 0 &&
                    node.elements.reduce(
                        (prev, cur) =>
                            prev &&
                            (cur == null ||
                                cur.type === "FunctionExpression" ||
                                cur.type === "ArrowFunctionExpression"),
                        true,
                    )) ||
                (node.type === "ObjectExpression" &&
                    node.properties.length > 0 &&
                    node.properties.reduce(
                        (prev, cur) =>
                            prev &&
                            cur.type === "Property" &&
                            !cur.method &&
                            (cur.value.type === "FunctionExpression" || cur.value.type === "ArrowFunctionExpression") &&
                            ((!cur.value?.params && console.error("cur.value.params undefined", cur), false) ||
                                cur.value.params.length === 1 ||
                                cur.value.params.length === 2 ||
                                cur.value.params.length === 3),
                        true,
                    ))
            ) {
                if (!moduleCandidates.has(node.end - node.start)) {
                    moduleCandidates.set(node.end - node.start, extractModulesFromAstNode(node, source, map));
                }
            }
        },
    });

    // Only take largest modules
    const modules = moduleCandidates.get(Math.max(...moduleCandidates.keys())) ?? {};

    return {
        dependencies: fetchDependencyRelations(modules, source, "webpack"),
        modules,
    };
}

export function identifyBrowserifyParcelCompartments(source, sourcemap) {
    const ast = parse(source);
    let map;
    try {
        map = sourcemap ? new SourceMapResolver(source, JSON.parse(sourcemap)) : {};
    } catch (e) {
        map = {};
    }

    let dependencyGraphList = [];
    let modules = {};
    walk.ancestor(ast, {
        ObjectExpression(node, _state, ancestors) {
            let ancestor_types = ancestors.map((a) => a.type);
            ancestor_types.pop();
            if (!ancestor_types.includes("ObjectExpression")) {
                if (
                    node.properties.length > 0 &&
                    node.properties.reduce((prev, cur) => {
                        return (
                            prev &&
                            cur.type === "Property" &&
                            !cur.method &&
                            cur.value.type === "ArrayExpression" &&
                            cur.value.elements.length === 2 &&
                            cur.value.elements[0].type === "FunctionExpression" &&
                            cur.value.elements[0].params.length === 3 &&
                            cur.value.elements[1].type === "ObjectExpression"
                        );
                    }, true)
                ) {
                    try {
                        modules = extractModulesFromAstNode(node, source, map);
                    } catch (e) {
                        console.error("DGB ERROR", node);
                        throw e;
                    }
                    dependencyGraphList = fetchDependencyRelations(modules, source, "browserify");
                }
            }
        },
    });
    return {
        dependencies: dependencyGraphList,
        modules,
    };
}

export function identifyEsbuildBunCompartments(source, sourcemap) {
    const ast = parse(source);
    let map;
    try {
        map = sourcemap ? new SourceMapResolver(source, JSON.parse(sourcemap)) : {};
    } catch (e) {
        map = {};
    }
    let modules = {};
    let key = 0;
    let dependencyGraphList = [];

    walk.ancestor(ast, {
        VariableDeclarator(node, state, ancestors) {
            // Identify Top-Level VariableDeclarators. Those contain the individual require functions.
            let ancestorNames = ancestors.map((a) => a.type);
            ancestorNames.pop(); // Pop own type (VariableDeclarator), as otherwise the check always fails (obviously)
            if (!(ancestorNames.includes("VariableDeclarator") || ancestorNames.includes("FunctionDeclaration"))) {
                let init = node.init;
                if (init && init.type == "CallExpression") {
                    modules[key] = {
                        ast: node,
                        id: key,
                        name: resolveNodeName(init, source, map, node.id.name),
                        identifier: node.id.name,
                        text: source.slice(init.start, init.end),
                    };
                    key += 1;
                }
            }
        },
    });

    dependencyGraphList = fetchDependencyRelationsEsbuild(modules, source);
    return {
        dependencies: dependencyGraphList,
        modules,
    };
}
/**
 * Takes a full list of modules and returns for each npm module a new parsable
 * source file that only contains its compartments
 *
 * @param {Record<unknown, { name: string | number, text: string }>} full_modules Module Object as returned by identify*Compartments
 * @returns {Record<string, string>} For each npm module as key: String with extracted source code
 */
export function extractGroupedNpmModules(full_modules) {
    /** @type {Record<string, string[]>} */
    const groupedModules = {};
    for (const { text: source, name } of Object.values(full_modules)) {
        const npmName = getNpmName(name);
        // Only npm modules
        if (!npmName) continue;

        (groupedModules[npmName] = groupedModules[npmName] ?? []).push(source);
    }

    // Strip node: prefix, join contents as an array
    return Object.fromEntries(Object.entries(groupedModules).map((v) => [v[0].slice(5), `[${v[1].join(", ")}]`]));
}

