// Automatic "can this package be bundled at all?" check, run BEFORE bundling so packages that
// can only fail (fonts, icon sets, CSS frameworks, CDN-only builds) are not bundled and are not
// sent to Claude.
//
// It does not guess: it asks webpack's OWN resolver, built from the same settings as the
// bundler (mode "production", the package folder as context, and the bundler's exact loader
// rules — webpack derives some resolve defaults from them, e.g. a .ts rule switches its
// built-in TypeScript support and its "typescript" export condition off), which file
// `import * as pkg0 from '<name>'` — the bundler's entry — would load. A package is skipped only when webpack is certain to fail:
//   no_js_entry      the import cannot be resolved at all (no main/exports ".", missing file)
//   stylesheet_only  it resolves to a non-empty stylesheet, which the faithful config does
//                    not load from node_modules (css-loader excludes node_modules)
// Anything else is bundled as usual — including entries the file-loader rule handles
// (images, fonts) and `browser: false` (an empty module), which webpack bundles fine.
// It never changes a bundle; it only saves attempts that cannot succeed.

import { readFileSync } from "node:fs";
import { relative, extname } from "node:path";

const STYLESHEET = /\.(css|scss|sass|less|styl|stylus|pcss)$/i;

// The bundler's module.rules, verbatim from generate_bundles.py's template (see 03-bundle-and-sbom.mjs).
const BUNDLER_RULES = [
  { test: /\.ts$/, exclude: /node_modules/, use: "ts-loader" },
  { test: /\.css$/, exclude: /node_modules/, use: "css-loader" },
  { test: /\.(ico|jpg|png|gif|eot|otf|webp|svg|ttf|woff|woff2)(\?.*)?$/, loader: "file-loader", options: { name: "static/media/[name].[hash:8].[ext]" } },
];

let webpackP = null;
const loadWebpack = () => (webpackP ??= import("webpack").then((m) => m.default ?? m));

export async function checkBundleable(pkgDir, name) {
  const webpack = await loadWebpack();
  // same mode, context and loader rules as the bundler (03-bundle-and-sbom.mjs), so webpack fills
  // in the same defaults (target, experiments, resolve conditions)
  const compiler = webpack({
    mode: "production", context: pkgDir, entry: "./index.js", infrastructureLogging: { level: "none" },
    module: { rules: BUNDLER_RULES },
  });
  // the resolver webpack itself uses for an ESM import (the bundler's entry is `import * as`)
  const resolver = compiler.resolverFactory.get("normal", { dependencyType: "esm" });
  return await new Promise((done) => {
    resolver.resolve({}, pkgDir, name, {}, (err, file) => {
      if (err) {
        const msg = String(err.message ?? err).split("\n").find((l) => l.trim()) ?? "cannot resolve";
        return done({ bundleable: false, category: "no_js_entry", entry: null, reason: `webpack cannot resolve '${name}': ${msg.trim()}` });
      }
      if (file === false) return done({ bundleable: true, entry: false, reason: "the browser field maps it to an empty module" });
      const entry = relative(pkgDir, file);
      if (STYLESHEET.test(file)) {
        let empty = false;
        try { empty = readFileSync(file, "utf8").trim() === ""; } catch {}
        if (!empty) return done({ bundleable: false, category: "stylesheet_only", entry, reason: `its entry is a ${extname(file)} file (${entry}); the faithful webpack config does not load CSS from node_modules` });
      }
      done({ bundleable: true, entry });
    });
  });
}
