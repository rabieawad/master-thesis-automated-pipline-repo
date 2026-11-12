"""Model-independent embedding loop: token counting, chunking, length-sorted token-budget batches,
out-of-memory fallback, chunk averaging, progress and checkpoints. Works with any models.base.Embedder."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import numpy as np

from models.base import Embedder
from .cache import VectorCache

log = logging.getLogger(__name__)


@dataclass
class EngineConfig:
    window: int = 32768          # max content tokens embedded in one pass; longer functions are chunked
    overlap: int = 256           # tokens shared by neighbouring chunks
    token_budget: int = 131072   # max padded tokens per batch (batch size x longest input)
    max_batch: int = 256         # max inputs per batch
    checkpoint_every: float = 600.0  # seconds between cache flushes
    log_every: float = 60.0          # seconds between progress lines


@dataclass
class _Unit:
    key: str
    text: str
    n_tokens: int   # content tokens of this unit (a whole function or one chunk)


def count_tokens(embedder: Embedder, texts: list[str], step: int = 2048) -> np.ndarray:
    out = np.empty(len(texts), dtype=np.int64)
    t0 = time.time()
    for i in range(0, len(texts), step):
        out[i:i + step] = embedder.count_tokens(texts[i:i + step])
        if time.time() - t0 > 30 and (i // step) % 20 == 0:
            log.info("counted tokens of %d/%d texts", i + step, len(texts))
    return out


def _encode_safe(embedder: Embedder, texts: list[str]) -> np.ndarray:
    """Encode; on CUDA out-of-memory split the batch in halves and retry."""
    try:
        return embedder.encode(texts)
    except RuntimeError as e:  # torch.cuda.OutOfMemoryError is a RuntimeError
        if "out of memory" not in str(e).lower() or len(texts) == 1:
            raise
        embedder.free_memory()
        mid = len(texts) // 2
        log.warning("out of memory on a batch of %d, splitting", len(texts))
        return np.concatenate([_encode_safe(embedder, texts[:mid]), _encode_safe(embedder, texts[mid:])])


def make_batches(units: list[_Unit], overhead: int, cfg: EngineConfig) -> list[list[_Unit]]:
    """Longest first, so a batch that does not fit in memory fails at the start of the job, not the end."""
    units = sorted(units, key=lambda u: u.n_tokens, reverse=True)
    batches, cur, cur_max = [], [], 0
    for u in units:
        length = u.n_tokens + overhead
        new_max = max(cur_max, length)
        if cur and (new_max * (len(cur) + 1) > cfg.token_budget or len(cur) >= cfg.max_batch):
            batches.append(cur)
            cur, new_max = [], length
        cur.append(u)
        cur_max = new_max
    if cur:
        batches.append(cur)
    return batches


def embed_unique(embedder: Embedder, todo: dict[str, str], cache: VectorCache, cfg: EngineConfig,
                 should_stop=lambda: False) -> dict:
    """Embed every key -> text in `todo` into `cache`. Returns run statistics; "stopped": True when
    should_stop() turned true (e.g. the job is near its time limit): finished vectors are saved first."""
    keys = list(todo)
    if not keys:
        return {"functions": 0, "tokens": 0, "seconds": 0.0, "stopped": False}
    window = min(cfg.window, embedder.max_tokens - embedder.overhead_tokens())
    log.info("counting tokens of %d texts", len(keys))
    n_tok = count_tokens(embedder, [todo[k] for k in keys])

    units: list[_Unit] = []
    chunks_of: dict[str, int] = {}
    for k, n in zip(keys, n_tok):
        n = int(n)
        if n <= window:
            units.append(_Unit(k, todo[k], n))
            chunks_of[k] = 1
        else:
            parts = embedder.split(todo[k], window, cfg.overlap)
            lens = embedder.count_tokens(parts)
            units.extend(_Unit(k, t, int(l)) for t, l in zip(parts, lens))
            chunks_of[k] = len(parts)
    n_chunked = sum(1 for c in chunks_of.values() if c > 1)
    total_tokens = int(sum(u.n_tokens for u in units))
    log.info("%d functions, %d chunked (longer than %d tokens), %d inputs, %d tokens",
             len(keys), n_chunked, window, len(units), total_tokens)

    batches = make_batches(units, embedder.overhead_tokens(), cfg)
    tokens_of = {k: int(n) for k, n in zip(keys, n_tok)}
    sums: dict[str, np.ndarray] = {}
    weights: dict[str, float] = {}
    seen: dict[str, int] = {}

    t0 = last_log = last_ckpt = time.time()
    done_tokens = done_funcs = 0
    stopped = False
    for bi, batch in enumerate(batches):
        if should_stop():
            log.warning("stop requested: saving %d finished vectors and stopping", done_funcs)
            stopped = True
            break
        vecs = _encode_safe(embedder, [u.text for u in batch])
        for u, v in zip(batch, vecs):
            if chunks_of[u.key] == 1:
                cache.add(u.key, v, tokens_of[u.key], 1)
                done_funcs += 1
                continue
            # chunked function: token-weighted mean of its chunk vectors, normalised again
            sums[u.key] = sums.get(u.key, 0) + v.astype(np.float32) * u.n_tokens
            weights[u.key] = weights.get(u.key, 0) + u.n_tokens
            seen[u.key] = seen.get(u.key, 0) + 1
            if seen[u.key] == chunks_of[u.key]:
                m = sums.pop(u.key) / weights.pop(u.key)
                cache.add(u.key, m / max(np.linalg.norm(m), 1e-12), tokens_of[u.key], chunks_of[u.key])
                done_funcs += 1
        done_tokens += sum(u.n_tokens for u in batch)
        now = time.time()
        if now - last_log >= cfg.log_every or bi == len(batches) - 1:
            rate = done_tokens / max(now - t0, 1e-9)
            eta = (total_tokens - done_tokens) / max(rate, 1e-9)
            log.info("batch %d/%d  functions %d/%d  %.0f tokens/s  %.1f functions/s  ETA %.1f min",
                     bi + 1, len(batches), done_funcs, len(keys), rate, done_funcs / (now - t0), eta / 60)
            last_log = now
        if now - last_ckpt >= cfg.checkpoint_every:
            cache.flush()
            last_ckpt = now
    cache.flush()
    secs = time.time() - t0
    return {"functions": len(keys), "chunked": n_chunked, "inputs": len(units), "tokens": total_tokens,
            "seconds": round(secs, 1), "tokens_per_s": round(done_tokens / max(secs, 1e-9), 1),
            "functions_per_s": round(done_funcs / max(secs, 1e-9), 2), "embedded": done_funcs, "stopped": stopped}
