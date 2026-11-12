"""The interface every model adapter implements. The shared code (common/, embed.py) only uses these methods."""
from __future__ import annotations

from abc import ABC, abstractmethod

import numpy as np


class Embedder(ABC):
    name: str        # short name used in output file names, e.g. "jina-code-0.5b"
    dim: int         # embedding size
    max_tokens: int  # longest input the model accepts, prefix and special tokens included

    @abstractmethod
    def load(self) -> None:
        """Load weights and tokenizer onto the device."""

    @abstractmethod
    def count_tokens(self, texts: list[str]) -> list[int]:
        """Tokens of each text alone (no prefix, no special tokens)."""

    @abstractmethod
    def overhead_tokens(self) -> int:
        """Tokens the model adds to every input (instruction prefix, special tokens)."""

    @abstractmethod
    def split(self, text: str, window: int, overlap: int) -> list[str]:
        """Cut a text into pieces of at most `window` tokens that overlap by `overlap` tokens."""

    @abstractmethod
    def encode(self, texts: list[str]) -> np.ndarray:
        """float32 array [len(texts), dim], each row L2-normalised."""

    def free_memory(self) -> None:
        """Release cached GPU memory after an out-of-memory error (optional)."""

    def describe(self) -> dict:
        """Settings written to the run manifest."""
        return {"name": self.name, "dim": self.dim, "max_tokens": self.max_tokens}
