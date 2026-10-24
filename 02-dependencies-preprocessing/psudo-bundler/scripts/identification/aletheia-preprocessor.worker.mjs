import workerpool from "workerpool";
import { readDirOrFile } from "./dolos-preprocessor.mjs";
import path from "node:path";

async function preprocess(basedir, pkgname, version) {
    return readDirOrFile(path.join(basedir, `${pkgname}@${version}`));
}

console.log("Registering worker");
workerpool.worker({
    preprocess,
});
