"""Model registry. To add a model: write an adapter (usually a small HFEmbedder subclass) and add a line here."""
from __future__ import annotations

from .base import Embedder
from .jina_code import JinaCode05B

MODELS: dict[str, type[Embedder]] = {
    JinaCode05B.name: JinaCode05B,
}


def get_model(name: str, **kwargs) -> Embedder:
    if name not in MODELS:
        raise SystemExit(f"unknown model {name!r}; available: {', '.join(sorted(MODELS))}")
    return MODELS[name](**kwargs)
