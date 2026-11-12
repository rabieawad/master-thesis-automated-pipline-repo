"""Vectors of unique function texts, saved in parts while the job runs so a stopped job can resume."""
from __future__ import annotations

import logging
import os
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)


class VectorCache:
    """key -> (float16 vector, n_tokens, n_chunks). New entries are flushed to part-XXXXX.npz files."""

    def __init__(self, folder: Path, dim: int):
        self.folder = folder
        self.dim = dim
        self.vec: dict[str, np.ndarray] = {}
        self.n_tokens: dict[str, int] = {}
        self.n_chunks: dict[str, int] = {}
        self._pending: list[str] = []
        folder.mkdir(parents=True, exist_ok=True)
        self._load()

    def _load(self) -> None:
        parts = sorted(self.folder.glob("part-*.npz"))
        for p in parts:
            with np.load(p, allow_pickle=False) as z:
                if z["embedding"].shape[1] != self.dim:
                    raise SystemExit(f"{p} has dim {z['embedding'].shape[1]}, model has {self.dim}: "
                                     "different model in the same cache folder?")
                for k, v, t, c in zip(z["key"], z["embedding"], z["n_tokens"], z["n_chunks"]):
                    k = str(k)
                    self.vec[k], self.n_tokens[k], self.n_chunks[k] = v, int(t), int(c)
        if parts:
            log.info("resumed %d cached vectors from %d parts in %s", len(self.vec), len(parts), self.folder)

    def __contains__(self, key: str) -> bool:
        return key in self.vec

    def __len__(self) -> int:
        return len(self.vec)

    def add(self, key: str, vector: np.ndarray, n_tokens: int, n_chunks: int) -> None:
        self.vec[key] = vector.astype(np.float16)
        self.n_tokens[key] = n_tokens
        self.n_chunks[key] = n_chunks
        self._pending.append(key)

    def flush(self) -> None:
        if not self._pending:
            return
        n = len(list(self.folder.glob("part-*.npz")))
        path = self.folder / f"part-{n:05d}.npz"
        keys = self._pending
        tmp = path.with_suffix(".tmp")
        with open(tmp, "wb") as fh:
            np.savez(fh,
                     key=np.array(keys),
                     embedding=np.stack([self.vec[k] for k in keys]),
                     n_tokens=np.array([self.n_tokens[k] for k in keys], dtype=np.int32),
                     n_chunks=np.array([self.n_chunks[k] for k in keys], dtype=np.int32))
        os.replace(tmp, path)
        log.info("checkpoint: %d new vectors -> %s (total %d)", len(keys), path.name, len(self.vec))
        self._pending = []
