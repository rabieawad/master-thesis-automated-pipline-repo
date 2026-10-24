import { File, FingerprintIndex, Region, SharedFingerprint, TokenizedFile } from "@dodona/dolos-lib";

export class SerializableFingerprintIndex extends FingerprintIndex {
    serialize() {
        return {
            kgramLength: this.hashFilter.k,
            kgramsInWindow: this.hashFilter.windowSize,
            index: Array.from(this.index.values()).map(serializeSharedFingerprint),
            files: Array.from(this.files.values()).map((v) => ({
                file: v.file.path,
                kgrams: v.kgrams.length,
                shared: Array.from(v.shared.values())
                    .map(serializeSharedFingerprint)
                    .map((s) => s.hash),
            })),
        };
    }

    deserialize(data) {
        /** @type {Map<string, TokenizedFile>} */
        const cachedFiles = new Map();
        /** @type {Map<number, SharedFingerprint>} */
        const cachedSharedFingerprints = new Map();

        function getFile(f) {
            if (!cachedFiles.has(f)) cachedFiles.set(f, new TokenizedFile(new File(f, ""), [], []));
            return cachedFiles.get(f);
        }

        function getSharedFingerprint(s) {
            if (!cachedSharedFingerprints.has(s.hash))
                cachedSharedFingerprints.set(
                    s.hash,
                    new SerializableSharedFingerpint(
                        s.hash,
                        new Map(
                            s.partMap.map((entry) => [
                                getFile(entry.k),
                                entry.v.map((inner) => ({
                                    file: getFile(entry.k),
                                    side: {
                                        index: inner,
                                    },
                                })),
                            ]),
                        ),
                    ),
                );
            return cachedSharedFingerprints.get(s.hash);
        }

        data.index.forEach((i) => this.index.set(i.hash, getSharedFingerprint(i)));

        data.files.forEach((entry) => {
            const { file, kgrams, shared } = entry;
            this.files.set(getFile(file).id, {
                file: getFile(file),
                kgrams: Array(kgrams),
                shared: new Set(shared.map((hash) => ({ hash })).map(getSharedFingerprint)),
                ignored: new Set(),
                isIgnored: false,
            });
        });
    }
}

export class SerializableSharedFingerpint extends SharedFingerprint {
    constructor(hash, partMap, kgrams = null) {
        super(hash, kgrams);
        this.partMap = partMap;
    }
}

export function deserializeFingerprintIndex(data) {
    const index = new SerializableFingerprintIndex(data.kgramLength, data.kgramsInWindow);
    index.deserialize(data);
    return index;
}

/**
 * @param {SharedFingerprint} sf
 */
export function serializeSharedFingerprint(sf) {
    return {
        hash: sf.hash,
        partMap: Array.from(sf.partMap.entries()).map((kv) => ({
            k: kv[0].path,
            v: kv[1].map((o) => o.side.index),
        })),
    };
}

/**
 * @param {TokenizedFile} tf
 */
export function serializeTf(tf) {
    return {
        file: {
            path: tf.path,
            content: "", // tf.content,
            extra: tf.extra,
        },
        tokens: tf.tokens,
        mapping: tf.mapping.map((r) => ({
            startRow: r.startRow,
            startCol: r.startCol,
            endRow: r.endRow,
            endCol: r.endCol,
        })),
    };
}

export function deserializeTf(data) {
    return new TokenizedFile(
        new File(data.file.path, data.file.content, data.file.extra),
        data.tokens,
        data.mapping.map((r) => new Region(r.startRow, r.startCol, r.endRow, r.endCol)),
    );
}
