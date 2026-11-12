"""Check a finished run: every input function with text has exactly one vector, in input order, unit length,
and identical texts got identical vectors.

  python check_outputs.py <folder with *.functions.json> <folder with the .npz files>

The .npz folder is e.g. an unpacked <name>.embeddings.tgz (tar -xzf part1.embeddings.tgz).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np


def main(in_dir: str, run_dir: str) -> int:
    run = Path(run_dir)
    problems, files, vectors, by_key = 0, 0, 0, {}
    for f in sorted(Path(in_dir).rglob("*.functions.json")):
        raw = f.read_text(encoding="utf-8")
        if not raw.strip():
            continue
        recs = json.loads(raw)["functions"]
        if not recs:
            continue
        found = sorted(run.rglob(f"{f.name[:-len('.json')]}.*.npz"))
        if len(found) != 1:
            print("MISSING" if not found else "SEVERAL OUTPUTS FOR", f.name); problems += 1; continue
        out = found[0]
        z = np.load(out)
        with_text = [r["index"] for r in recs if any(isinstance(r.get(k), str) and r[k].strip() for k in ("textNorm", "text", "rawText"))]
        if list(z["index"]) != with_text:
            print("INDEX MISMATCH", out.name); problems += 1
        norms = np.linalg.norm(z["embedding"].astype(np.float32), axis=1)
        if len(norms) and (abs(norms - 1) > 1e-2).any():
            print("NOT NORMALISED", out.name); problems += 1
        for k, v in zip(z["key"], z["embedding"]):
            if k in by_key and not np.array_equal(by_key[k], v):
                print("DIFFERENT VECTORS FOR SAME TEXT", k); problems += 1
            by_key[k] = v
        files += 1
        vectors += len(z["index"])
    print(f"checked {files} files, {vectors} vectors, {len(by_key)} unique texts, {problems} problems")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
