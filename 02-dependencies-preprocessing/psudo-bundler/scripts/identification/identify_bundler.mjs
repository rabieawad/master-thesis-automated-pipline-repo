import * as acorn from "acorn";
import * as loose from "acorn-loose";
import * as walk from "acorn-walk";

import { MightBeJsonError } from "./utils.mjs";

export function parse(code) {
    const mightBeJson = code.slice(0, 1) === "{";
    try {
        return acorn.parse(code, {
            ecmaVersion: "latest",
            preserveParens: true,
            locations: true,
            allowImportExportEverywhere: true,
        });
    } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        try {
            return acorn.parse(code, {
                ecmaVersion: "latest",
                sourceType: "module",
                preserveParens: true,
                locations: true,
                allowImportExportEverywhere: true,
            });
        } catch (e) {
            if (mightBeJson) throw new MightBeJsonError();
            throw e;
        }
    }
}

export function parseLoose(code) {
    const mightBeJson = code.slice(0, 1) === "{";
    try {
        return acorn.parse(code, {
            ecmaVersion: "latest",
            preserveParens: true,
            locations: true,
            allowImportExportEverywhere: true,
        });
    } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        try {
            return loose.parse(code, {
                ecmaVersion: "latest",
                sourceType: "module",
                preserveParens: true,
                locations: true,
                allowImportExportEverywhere: true,
            });
        } catch (e) {
            if (mightBeJson) throw new MightBeJsonError();
            throw e;
        }
    }
}

// For debugging
function getSerializationFromStr(s, shorten = true) {
    const ast = parse(s);
    const l = [];
    walk.simple(
        ast,
        types.reduce((prev, cur) => ((prev[cur] = (n) => l.push(n.type)), prev), {}),
    );
    return l
        .filter((t) => !excluded.includes(t))
        .map((s) => (shorten ? s.charAt(0) : s))
        .join(shorten ? "" : ",");
}

if (process.argv[1].includes("identify_bundler.mjs")) {
    if (typeof Bun === "undefined") {
        var Bun = (await import("../bun-serve.mjs")).default;
    }

    Bun.serve({
        port: process.env.PORT,
        fetch: async (request, server) => {
            try {
                const body = JSON.parse(await request.text());
                const bundler = identifyBundler(...body);

                return new Response(JSON.stringify(bundler), { status: 200, statusText: "OK" });
            } catch (e) {
                if (e instanceof MightBeJsonError)
                    return new Response(`${e}`, { status: 501, statusText: "JSON parsing not supported" });
                return new Response(`${e}`, { status: 400, statusText: "Bad Request" });
            }
        },
    });
}

export default function identifyBundler(bundle, map) {
    const ast = parse(bundle);

    return matchFPTree(fingerprintTree, ast);
}

function prepareFP(obj) {
    return Object.entries(obj)
        .map((val) => [
            val[0],
            {
                fp: val[1].fp ? parse(val[1].fp) : parse(val[1]),
                discard: val[1].discard ?? 0,
            },
        ])
        .reduce((prev, cur) => ((prev[cur[0]] = cur[1]), prev), {});
}

// Most fingerprints taken from https://github.com/zenoj/BundlerStudy
const fingerprints = {
    webpack: prepareFP({
        Webpack4RequireShuffled: `
    function t(n) {
        if (i[n]) return i[n].exports;
        var r = i[n] = {
        exports: {},
        id: n,
        loaded: !1
        };
        return e[n].call(r.exports, r, r.exports, t), r.loaded = !0, r.exports
    }`,

        Webpack4RequireOriginal: `
function n(e) {
        if (t[e]) return t[e].exports;
        var i = t[e] = {
            i: e,
            l: !1,
            exports: {}
        };
        return r[e].call(i.exports, i, i.exports, n), i.l = !0, i.exports
    }
`,

        CJSRequireFunction: `
function __webpack_require__(moduleId) {
    var cachedModule = __webpack_module_cache__[moduleId];
    if (cachedModule !== undefined) {
        return cachedModule.exports;
    }
    var module = __webpack_module_cache__[moduleId] = {
    exports: {}
    };
    t__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
    return module.exports;
 }`,

        CJSRequireFunction_Minified: `function n(e) {
    var o = r[e];
    if (void 0 !== o) return o.exports;
    var u = r[e] = {
      exports: {}
    };
    return t[e](u, u.exports, n), u.exports
  }`,

        RequireRuntimeGlobal: `
(() => {
__webpack_require__.g = (function() {
    if (typeof globalThis === 'object') return globalThis;
        try {
            return this || new Function('return this')();
        } catch (e) {
            if (typeof window === 'object') return window;
        }
    })();
})();
`,

        RequireRuntimeGlobal_Minified: `
n.g = function () {
    if ("object" == typeof globalThis) return globalThis;
    try {
      return this || new Function("return this")()
    } catch (t) {
      if ("object" == typeof window) return window
    }
  }()
`,

        ES6RuntimeDefine: `
(() => {
    __webpack_require__.d = (exports, definition) => {
        for(var key in definition) {
            if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
                Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
            }
        }
    };
    })();
`,

        ES6RuntimeDefine_Minified: `
for (var e in r) t.o(r, e) && !t.o(n, e) && Object.defineProperty(n, e, {
    enumerable: !0,
    get: r[e]
})
`,

        ES6RuntimeMake: `
(() => {
    __webpack_require__.r = (exports) => {
            if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
                Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
            }
            Object.defineProperty(exports, '__esModule', { value: true });
    };
})();`,

        ES6RuntimeMake_Minified: `
"undefined" != typeof Symbol && Symbol.toStringTag && Object.defineProperty(t, Symbol.toStringTag, {
                    value: "Module"
                }), Object.defineProperty(t, "__esModule", {
                    value: !0
                })
`,

        ES6RuntimeHasOwnProperty: `
(() => {
    __webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
})();
`,

        ES6RuntimeFullMinified: `
var t = {
            d: (n, r) => {
                for (var e in r) t.o(r, e) && !t.o(n, e) && Object.defineProperty(n, e, {
                    enumerable: !0,
                    get: r[e]
                })
            },
            o: (t, n) => Object.prototype.hasOwnProperty.call(t, n),
            r: t => {
                "undefined" != typeof Symbol && Symbol.toStringTag && Object.defineProperty(t, Symbol.toStringTag, {
                    value: "Module"
                }), Object.defineProperty(t, "__esModule", {
                    value: !0
                })
            }
        },
        n = {};
`,
    }),
    webpackChunk: prepareFP({
        WebpackJsonpPushThis: {
            fp: `(this.webpackJsonp=this.webpackJsonp||[]).push([[1]])`,
            discard: 4,
        },
        WebpackJsonpPushWindow: {
            fp: `(window.webpackJsonp=window.webpackJsonp||[]).push([[1]])`,
            discard: 4,
        },
    }),
    browserify: prepareFP({
        RequireP3: `for (var u = "function" == typeof require && require, i = 0; i < t.length; i++) o(t[i]);`,
        RequireHalf: `function o(i, f) {
      if (!n[i]) {
        if (!e[i]) {
          var c = "function" == typeof require && require;
          if (!f && c) return c(i, !0);
          if (u) return u(i, !0);
          var a = new Error("Cannot find module '" + i + "'");
          throw a.code = "MODULE_NOT_FOUND", a
        }
        var p = n[i] = {
          exports: {}
        };
        e[i][0].call(p.exports, function (r) {
          var n = e[i][1][r];
          return o(n || r)
        }, p, p.exports, r, e, n, t)
      }
      return n[i].exports
    }`,
    }),
    esbuild: prepareFP({
        extPkgFull: `var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __markAsModule = (target) => __defProp(target, "__esModule", { value: true });
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined")
      return require.apply(this, arguments);
    throw new Error('Dynamic require of "' + x + '" is not supported');
  });

  var __reExport = (target, module2, desc) => {
    if (module2 && typeof module2 === "object" || typeof module2 === "function") {
      for (let key of __getOwnPropNames(module2))
        if (!__hasOwnProp.call(target, key) && key !== "default")
          __defProp(target, key, { get: () => module2[key], enumerable: !(desc = __getOwnPropDesc(module2, key)) || desc.enumerable });
    }
    return target;
  };

  var __toModule = (module2) => {
    return __reExport(__markAsModule(__defProp(module2 != null ? __create(__getProtoOf(module2)) : {}, "default", module2 && module2.__esModule && "default" in module2 ? { get: () => module2.default, enumerable: true } : { value: module2, enumerable: true })), module2);
  };`,

        extPkgP1: `var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __markAsModule = (target) => __defProp(target, "__esModule", { value: true });`,

        extPkgP2: `var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined")
      return require.apply(this, arguments);
    throw new Error('Dynamic require of "' + x + '" is not supported');
  });`,

        extPkgP3: `var __reExport = (target, module2, desc) => {
    if (module2 && typeof module2 === "object" || typeof module2 === "function") {
      for (let key of __getOwnPropNames(module2))
        if (!__hasOwnProp.call(target, key) && key !== "default")
          __defProp(target, key, { get: () => module2[key], enumerable: !(desc = __getOwnPropDesc(module2, key)) || desc.enumerable });
    }
    return target;
  };

  var __toModule = (module2) => {
    return __reExport(__markAsModule(__defProp(module2 != null ? __create(__getProtoOf(module2)) : {}, "default", module2 && module2.__esModule && "default" in module2 ? { get: () => module2.default, enumerable: true } : { value: module2, enumerable: true })), module2);
  };`,

        extPkgMinFull: `var qj = Object.create;
    var Is = Object.defineProperty;
    var Hj = Object.getOwnPropertyDescriptor;
    var Kj = Object.getOwnPropertyNames;
    var Vj = Object.getPrototypeOf,
        Yj = Object.prototype.hasOwnProperty;
    var Xj = r => Is(r, "__esModule", {
        value: !0
    });

    var $j = (r => typeof require != "undefined" ? require : typeof Proxy != "undefined" ? new Proxy(r, {
        get: (e, t) => (typeof require != "undefined" ? require : e)[t]
    }) : r)(function (r) {
        if (typeof require != "undefined") return require.apply(this, arguments);
        throw new Error('Dynamic require of "' + r + '" is not supported')
    });

    var Zj = (r, e, t) => {
            if (e && typeof e == "object" || typeof e == "function")
                for (let o of Kj(e)) !Yj.call(r, o) && o !== "default" && Is(r, o, {
                    get: () => e[o],
                    enumerable: !(t = Hj(e, o)) || t.enumerable
                });
            return r
        },
        Jj = r => Zj(Xj(Is(r != null ? qj(Vj(r)) : {}, "default", r && r.__esModule && "default" in r ? {
            get: () => r.default,
            enumerable: !0
        } : {
            value: r,
            enumerable: !0
        })), r);`,

        extPkgMinP1: `var qj = Object.create;
    var Is = Object.defineProperty;
    var Hj = Object.getOwnPropertyDescriptor;
    var Kj = Object.getOwnPropertyNames;
    var Vj = Object.getPrototypeOf,
        Yj = Object.prototype.hasOwnProperty;
    var Xj = r => Is(r, "__esModule", {
        value: !0
    });`,

        extPkgMinP2: `var $j = (r => typeof require != "undefined" ? require : typeof Proxy != "undefined" ? new Proxy(r, {
        get: (e, t) => (typeof require != "undefined" ? require : e)[t]
    }) : r)(function (r) {
        if (typeof require != "undefined") return require.apply(this, arguments);
        throw new Error('Dynamic require of "' + r + '" is not supported')
    });`,

        extPkgMinP3: `var Zj = (r, e, t) => {
            if (e && typeof e == "object" || typeof e == "function")
                for (let o of Kj(e)) !Yj.call(r, o) && o !== "default" && Is(r, o, {
                    get: () => e[o],
                    enumerable: !(t = Hj(e, o)) || t.enumerable
                });
            return r
        },
        Jj = r => Zj(Xj(Is(r != null ? qj(Vj(r)) : {}, "default", r && r.__esModule && "default" in r ? {
            get: () => r.default,
            enumerable: !0
        } : {
            value: r,
            enumerable: !0
        })), r);`,

        cjsRequireFull: `var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[Object.keys(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };`,

        cjsRequireFullMinified: `var n = (r, e) => () => (e || r((e = {
        exports: {}
    }).exports, e), e.exports);`,

        es6RequiredPart1: `var __defProp = Object.defineProperty;
var __markAsModule = (target) => __defProp(target, "__esModule", { value: true });
var __esm = (fn, res) => function __init() {
return fn && (res = (0, fn[Object.keys(fn)[0]])(fn = 0)), res;
};`,

        es6RequiredPart2: `var __export = (target, all) => {
    __markAsModule(target);
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };`,

        es6RequireMinPart1: `var lr = Object.defineProperty;
var St = r => lr(r, "__esModule", {
    value: !0
});
var y = (r, t) => () => (r && (t = r(r = 0)), t);`,

        es6RequireMinPart2: `Tt = (r, t) => {
            St(r);
            for (var e in t) 
                lr(r, e, { get: t[e], enumerable: !0
            })
        };`,
    }),
    parcel: prepareFP({
        RequireHalf: `
function newRequire(name, jumped) {
    if (!cache[name]) {
      if (!modules[name]) {
        var currentRequire = typeof parcelRequire === 'function' && parcelRequire;
        if (!jumped && currentRequire) {
          return currentRequire(name, true);
        }

        if (previousRequire) {
          return previousRequire(name, true);
        }

        if (nodeRequire && typeof name === 'string') {
          return nodeRequire(name);
        }

        var err = new Error('Cannot find module \\'' + name + '\\'');
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }

      localRequire.resolve = resolve;
      localRequire.cache = {};

      var module = cache[name] = new newRequire.Module(name);

      modules[name][0].call(module.exports, localRequire, module, module.exports, this);
    }

    return cache[name].exports;

    function localRequire(x){
      return newRequire(localRequire.resolve(x));
    }

    function resolve(x){
      return modules[name][1][x] || x;
    }
  }`,

        RequireP3: `function Module(moduleName) {
    this.id = moduleName;
    this.bundle = newRequire;
    this.exports = {};
  }

  newRequire.isParcelRequire = true;
  newRequire.Module = Module;
  newRequire.modules = modules;
  newRequire.cache = cache;
  newRequire.parent = previousRequire;
  newRequire.register = function (id, exports) {
    modules[id] = [function (require, module) {
      module.exports = exports;
    }, {}];
  };

  var error;
  for (var i = 0; i < entry.length; i++) {
    try {
      newRequire(entry[i]);
    } catch (e) {
      if (!error) {
        error = e;
      }
    }
  }`,

        RequireHalfMinified: `
    function f(t, n) {
        if (!r[t]) {
            if (!e[t]) {
                var i = "function" == typeof parcelRequire && parcelRequire;
                if (!n && i) return i(t, !0);
                if (o) return o(t, !0);
                if (u && "string" == typeof t) return u(t);
                var c = new Error("Cannot find module '" + t + "'");
                throw c.code = "MODULE_NOT_FOUND", c
            }
            p.resolve = function (r) {
                return e[t][1][r] || r
            }, p.cache = {};
            var l = r[t] = new f.Module(t);
            e[t][0].call(l.exports, p, l, l.exports, this)
        }
        return r[t].exports;

        function p(e) {
            return f(p.resolve(e))
        }
    }`,

        RequireP3Minified: `f.isParcelRequire = !0, f.Module = function (e) {
        this.id = e, this.bundle = f, this.exports = {}
    }, f.modules = e, f.cache = r, f.parent = o, f.register = function (r, t) {
        e[r] = [function (e, r) {
            r.exports = t
        }, {}]
    };
    for (var c = 0; c < t.length; c++) try {
        f(t[c])
    } catch (e) {
        i || (i = e)
    }`,
    }),
    rollup: prepareFP({
        RequireFull: `var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};`,

        RequireFullMinified: `var r = "undefined" != typeof globalThis ? globalThis : "undefined" != typeof window ? window : "undefined" != typeof global ? global : "undefined" != typeof self ? self : {};`,

        ES6Required: `function getAugmentedNamespace(n) {
        if (n.__esModule) return n;
        var a = Object.defineProperty({}, '__esModule', {
            value: true
        });
        Object.keys(n).forEach(function (k) {
            var d = Object.getOwnPropertyDescriptor(n, k);
            Object.defineProperty(a, k, d.get ? d : {
                enumerable: true,
                get: function () {
                    return n[k];
                }
            });
        });
        return a;
        }`,

        ES6RequiredMinified: `function t(r) {
            if (r.__esModule) return r;
            var t = Object.defineProperty({}, "__esModule", {
                value: !0
            });
            return Object.keys(r).forEach((function (n) {
                var e = Object.getOwnPropertyDescriptor(r, n);
                Object.defineProperty(t, n, e.get ? e : {
                    enumerable: !0,
                    get: function () {
                        return r[n]
                    }
                })
            })), t
        }`,
    }),
};

const types = (
    "Statement|Expression|Declaration|ModuleDeclaration|Literal|SwitchCase|CatchClause|Property|Super|SpreadElement|" +
    "TemplateElement|AssignmentProperty|ObjectPattern|ArrayPattern|RestElement|AssignmentPattern|ClassBody|MethodDefinition|MetaProperty|" +
    "ImportSpecifier|ImportDefaultSpecifier|ImportNamespaceSpecifier|ExportSpecifier|AnonymousFunctionDeclaration|AnonymousClassDeclaration|" +
    "PropertyDefinition|PrivateIdentifier|StaticBlock|VariableDeclarator"
).split("|");
const excluded = "VariableDeclaration".split("|"); // VariableDeclaration: Disregard other decls in the same decl block
const fingerprintTree = buildFPTree(fingerprints);

export function buildFPTree(fps) {
    const tree = {
        _parent: null,
        _label: null,
        _matches: [],
    };
    const serializedFPs = [];

    function getVisitors(list) {
        return types.reduce((prev, cur) => ((prev[cur] = (n) => list.push(n.type)), prev), {});
    }

    // Serialize tree structures into linear lists
    for (const bundler in fps) {
        for (const [fpname, fp] of Object.entries(fps[bundler])) {
            const serialization = [];
            const visitors = getVisitors(serialization);
            walk.simple(fp.fp, visitors);
            serializedFPs.push([
                bundler,
                fpname,
                serialization.filter((t) => !excluded.includes(t)).slice(0, fp.discard ? -fp.discard : undefined),
            ]);
        }
    }

    // Construct the tree
    for (const [bundler, fpname, serialization] of serializedFPs) {
        let node = tree;
        for (const token of serialization) {
            if (!node[token])
                node[token] = {
                    _parent: node,
                    _label: token,
                    _matches: [],
                };
            node = node[token];
        }
        node._matches.push([bundler, fpname]);
    }

    // Construct backward edges using BFS
    const queue = [];
    tree._backwards = tree;
    Object.keys(tree).forEach((k) => k.slice(0, 1) !== "_" && queue.push(tree[k]));
    while (queue.length > 0) {
        const node = queue.shift();
        Object.entries(node).forEach((kv) => kv[0].slice(0, 1) !== "_" && queue.push(kv[1]));
        // Special case: First level
        if (node._parent._label === null) {
            node._backwards = node._parent;
            continue;
        }
        let backwards = node._parent._backwards;
        while (true) {
            if (backwards[node._label]) {
                backwards = backwards[node._label];
                node._matches.push(...backwards._matches);
                break;
            }
            if (backwards._label === null) break; // We are at the root
            backwards = backwards._backwards;
        }
        node._backwards = backwards;
    }

    return tree;
}

export function matchFPTree(tree, ast) {
    const matches = [];
    let node = tree;

    function getVisitors() {
        return types.reduce(
            (prev, cur) => (
                (prev[cur] = (n) => {
                    if (excluded.includes(n.type)) return;

                    while (true) {
                        if (node[n.type]) {
                            node = node[n.type];
                            if (node._matches) matches.push(...node._matches);
                            break;
                        } else {
                            if (node._label === null) break; // We are stuck in the root
                            node = node._backwards;
                        }
                    }
                }),
                prev
            ),
            {},
        );
    }

    walk.simple(ast, getVisitors());

    return matches;
}
