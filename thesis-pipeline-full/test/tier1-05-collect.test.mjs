import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmp, writeJson, writeText, read, parseCsv, runNode, TIER1 } from "./helpers.mjs";

const SCRIPT = join(TIER1, "05-collect-selected-bundles.mjs");
const key = (n, v) => `${n.replace("/", "+")}@${v}`;

test("selected_dependencies.csv = modules-report keys minus the package itself", () => {
  const t = tmp(); try {
    const bundles = join(t.dir, "bundles"); const out = join(t.dir, "out");
    const selected = [ { name: "side-channel", version: "1.1.1" }, { name: "ms", version: "2.1.3" } ];
    writeJson(join(t.dir, "selected.json"), selected);
    // modules reports: side-channel bundles 2 deps; ms bundles none
    writeJson(join(bundles, "modules", key("side-channel", "1.1.1") + ".json"), {
      "side-channel@1.1.1": ["index.js"], "es-errors@1.3.0": ["index.js"], "object-inspect@1.13.4": ["index.js"],
    });
    writeJson(join(bundles, "modules", key("ms", "2.1.3") + ".json"), { "ms@2.1.3": ["index.js"] });
    // bundle + sbom files so no warnings
    for (const [n, v] of [["side-channel", "1.1.1"], ["ms", "2.1.3"]]) {
      writeText(join(bundles, "bundles", key(n, v) + ".min.js"), "/*bundle*/");
      writeJson(join(bundles, "sbom", key(n, v) + ".cdx.json"), { bomFormat: "CycloneDX", components: [] });
    }
    const r = runNode(SCRIPT, [join(t.dir, "selected.json"), bundles, out]);
    assert.equal(r.code, 0, r.stdout);
    const rows = parseCsv(read(join(out, "selected_dependencies.csv")));
    const byPkg = Object.fromEntries(rows.map((x) => [x.package, JSON.parse(x.bundled_dependencies)]));
    assert.deepEqual(byPkg["side-channel"].sort(), ["es-errors@1.3.0", "object-inspect@1.13.4"]);
    assert.deepEqual(byPkg["ms"], []);
    // bundle files were collected
    assert.ok(read(join(out, "bundles", key("ms", "2.1.3") + ".min.js")).includes("bundle"));
  } finally { t.cleanup(); }
});
