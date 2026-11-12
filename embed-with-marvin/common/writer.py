"""One output file per input file: <input name without .json>.<model>.npz, arrays keyed by function index."""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np

from .cache import VectorCache
from .records import FileFunctions


def output_path(input_file: Path, out_dir: Path, model_name: str) -> Path:
    # jquery.payment@1.0.2.functions.json -> jquery.payment@1.0.2.functions.jina-code-0.5b.npz
    return out_dir / f"{input_file.name[:-len('.json')]}.{model_name}.npz"


def write_file(ff: FileFunctions, cache: VectorCache, out_path: Path) -> int:
    """Arrays: index (function index in the input file), embedding (float16, L2-normalised),
    key (dedup key: 'n:'+hashNorm, 't:'+hash or 's:'+sha256), n_tokens, n_chunks (1 = embedded whole)."""
    keys = ff.keys
    tmp = out_path.with_suffix(".tmp")
    with open(tmp, "wb") as fh:
        np.savez(fh,
                 index=np.asarray(ff.indices, dtype=np.int32),
                 embedding=np.stack([cache.vec[k] for k in keys]) if keys else np.zeros((0, cache.dim), np.float16),
                 key=np.asarray(keys, dtype=str),
                 n_tokens=np.asarray([cache.n_tokens[k] for k in keys], dtype=np.int32),
                 n_chunks=np.asarray([cache.n_chunks[k] for k in keys], dtype=np.int16))
    os.replace(tmp, out_path)
    return len(keys)
