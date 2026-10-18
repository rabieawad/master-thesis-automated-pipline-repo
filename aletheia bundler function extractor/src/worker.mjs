import { parentPort } from "node:worker_threads";
import fs from "node:fs/promises";
import path from "node:path";
import { buildPseudoBundle, sha256 } from "./pseudo-bundle.mjs";

parentPort.on("message", async (task) => {
    const t0 = Date.now();
    const result = { id: task.id, name: task.name, version: task.version, dir: task.pkgDir };
    try {
        const r = await buildPseudoBundle(task.pkgDir, { exportsMode: task.exportsMode, target: task.target });
        Object.assign(result, {
            strategy: r.strategy,
            fallback: r.fallback,
            selectedFiles: r.files,
            skipped: r.skipped,
            inputBytes: r.inputBytes,
            minified: r.minified,
            empty: r.empty,
        });
        if (!r.empty) {
            await fs.mkdir(path.dirname(task.outFile), { recursive: true });
            await fs.writeFile(task.outFile, r.content);
            result.outFile = task.outFile;
            result.outputBytes = Buffer.byteLength(r.content);
            result.sha256 = sha256(r.content);
        }
    } catch (e) {
        result.error = String(e?.stack ?? e);
    }
    result.ms = Date.now() - t0;
    parentPort.postMessage(result);
});
