import * as acorn from "acorn";
import * as loose from "acorn-loose";

const OPTS = {
    ecmaVersion: "latest",
    preserveParens: true,
    locations: true,
    allowImportExportEverywhere: true,
};

/**
 * Parse JavaScript the way Aletheia does: strict script first, then the
 * error-tolerant parser as module.
 */
export function parseLoose(code) {
    try {
        return acorn.parse(code, OPTS);
    } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        return loose.parse(code, { ...OPTS, sourceType: "module" });
    }
}
