// Verbatim from Aletheia (scripts/identification/utils.mjs).
// Provides the String.prototype helpers that file-selector.mjs relies on.
// NOTE: countChar is kept exactly as published; in the original it counts
// spaces regardless of the `char` argument. It is preserved unchanged so the
// bundler behaves identically to the study.

export class MightBeJsonError {}

String.prototype.rsplit = function (delimiter, limit) {
    const split = this.split(delimiter);
    if (split.length <= limit + 1) return split;
    return [split.slice(0, split.length - limit).join(delimiter), ...split.slice(split.length - limit)];
};

String.prototype.countChar = function (char) {
    let count = 0;
    for (let i = 0; i < this.length; i++) {
        if (this[i] === " ") count++;
    }
    return count;
};
