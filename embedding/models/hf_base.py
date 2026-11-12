"""Shared base for Hugging Face transformer embedders: tokenizer handling, prefix, pooling, dtype and
attention backend. A concrete model only sets its id, sizes, prefix and pooling (see jina_code.py)."""
from __future__ import annotations

import importlib.util
import logging

import numpy as np

from .base import Embedder

log = logging.getLogger(__name__)


class HFEmbedder(Embedder):
    hf_id: str = ""
    prefix: str = ""             # instruction text put in front of every input
    pooling: str = "last"        # "last" (last token) or "mean"
    padding_side: str = "left"
    model_kwargs: dict = {}

    def __init__(self, model_path: str | None = None, device: str = "auto", dtype: str = "bfloat16",
                 attn: str = "auto", prefix: str | None = None):
        self.model_path = model_path or self.hf_id
        self.device_req, self.dtype_name, self.attn_req = device, dtype, attn
        if prefix is not None:
            self.prefix = prefix
        self.tokenizer = self.model = self.torch = None
        self._overhead = None

    # ------------------------------------------------------------------ loading
    def load(self) -> None:
        import torch
        from transformers import AutoModel, AutoTokenizer

        self.torch = torch
        self.device = ("cuda" if torch.cuda.is_available() else "cpu") if self.device_req == "auto" else self.device_req
        dtype = getattr(torch, self.dtype_name)
        if self.device == "cpu" and dtype == torch.float16:
            dtype = torch.float32
        attn = self.attn_req
        if attn == "auto":
            attn = "flash_attention_2" if (self.device == "cuda" and importlib.util.find_spec("flash_attn")) else "sdpa"
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_path, padding_side=self.padding_side)
        self.tokenizer.model_max_length = 10**9  # we count and chunk ourselves; silences length warnings
        kwargs = dict(attn_implementation=attn, **self.model_kwargs)
        try:
            model = AutoModel.from_pretrained(self.model_path, dtype=dtype, **kwargs)
        except TypeError:  # transformers < 4.56 calls it torch_dtype
            model = AutoModel.from_pretrained(self.model_path, torch_dtype=dtype, **kwargs)
        self.model = model.to(self.device).eval()
        self.attn, self.dtype = attn, dtype
        hidden = getattr(model.config, "hidden_size", None)
        if hidden and hidden != self.dim:  # e.g. a local test model; trust the weights over the class default
            log.warning("model hidden size %d differs from the adapter's dim %d; using %d", hidden, self.dim, hidden)
            self.dim = hidden
        log.info("loaded %s on %s (%s, attention=%s)", self.model_path, self.device, str(dtype), attn)

    # --------------------------------------------------------------- tokenizing
    def count_tokens(self, texts: list[str]) -> list[int]:
        ids = self.tokenizer(list(texts), add_special_tokens=False)["input_ids"]
        return [len(x) for x in ids]

    def overhead_tokens(self) -> int:
        if self._overhead is None:
            with_all = len(self.tokenizer(self.prefix + "x")["input_ids"])
            alone = len(self.tokenizer("x", add_special_tokens=False)["input_ids"])
            self._overhead = with_all - alone
        return self._overhead

    def split(self, text: str, window: int, overlap: int) -> list[str]:
        window = max(window - 16, 64)  # re-tokenising a slice can differ by a few tokens
        offsets = self.tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)["offset_mapping"]
        n, step, parts = len(offsets), max(window - overlap, 1), []
        for start in range(0, n, step):
            end = min(start + window, n)
            parts.append(text[offsets[start][0]:offsets[end - 1][1]])
            if end == n:
                break
        return parts

    # ---------------------------------------------------------------- encoding
    def _pool(self, hidden, mask):
        torch = self.torch
        if self.pooling == "mean":
            m = mask.unsqueeze(-1).to(hidden.dtype)
            return (hidden * m).sum(1) / m.sum(1).clamp(min=1)
        if bool((mask[:, -1] == 1).all()):  # left padding: last position is the last real token
            return hidden[:, -1]
        last = mask.sum(dim=1) - 1
        return hidden[torch.arange(hidden.shape[0], device=hidden.device), last]

    def encode(self, texts: list[str]) -> np.ndarray:
        torch = self.torch
        batch = self.tokenizer([self.prefix + t for t in texts], padding=True, truncation=True,
                               max_length=self.max_tokens, return_tensors="pt").to(self.device)
        with torch.inference_mode():
            hidden = self.model(**batch).last_hidden_state
            vec = self._pool(hidden, batch["attention_mask"]).float()
            vec = torch.nn.functional.normalize(vec, p=2, dim=1)
        return vec.cpu().numpy()

    def free_memory(self) -> None:
        if self.torch is not None and self.torch.cuda.is_available():
            self.torch.cuda.empty_cache()

    def describe(self) -> dict:
        d = super().describe()
        d.update(hf_id=self.hf_id, model_path=self.model_path, prefix=self.prefix, pooling=self.pooling,
                 padding_side=self.padding_side, dtype=self.dtype_name, attention=getattr(self, "attn", None))
        return d
