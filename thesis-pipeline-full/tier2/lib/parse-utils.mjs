// parseLoose is extracted verbatim from Aletheia
// (scripts/identification/identify_bundler.mjs). It is the only piece of that
// file the pseudo-bundler needs; the bundler-fingerprinting / detection code in
// identify_bundler.mjs is intentionally NOT included.

import * as acorn from "acorn";
import * as loose from "acorn-loose";

import { MightBeJsonError } from "./utils.mjs";

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
