import { parentPort } from "node:worker_threads";
import fs from "node:fs/promises";
import path from "node:path";
import { extractFunctions } from "./extract-functions.mjs";

parentPort.on("message", async (task) => {
    const t0 = Date.now();
    const result = { id: task.id, name: task.name, version: task.version, bundle: task.file };
    try {
        const code = await fs.readFile(task.file, "utf8");
        result.bundleBytes = Buffer.byteLength(code);
        const { records, stats } = extractFunctions(code, task.opts);
        Object.assign(result, {
            functionsTotal: stats.total,
            functionsKept: stats.kept,
            skippedMinLoc: stats.skippedMinLoc,
            droppedOutsideWrappers: stats.droppedOutsideWrappers,
            byKind: stats.byKind,
        });
        if (task.opts.verify) result.invalid = stats.invalid;
        await fs.mkdir(path.dirname(task.outFile), { recursive: true });
        const body = records.map((r) => JSON.stringify(r)).join("\n");
        await fs.writeFile(task.outFile, body ? body + "\n" : "");
        result.outFile = task.outFile;
        result.outputBytes = Buffer.byteLength(body);
        result.textBytes = records.reduce((n, r) => n + r.bytes, 0);
    } catch (e) {
        result.error = String(e?.stack ?? e);
    }
    result.ms = Date.now() - t0;
    parentPort.postMessage(result);
});
